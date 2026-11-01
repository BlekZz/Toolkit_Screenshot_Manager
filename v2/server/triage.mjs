import { logEvent, now, tx } from './db.mjs';

// P2a 核心後端（dev/Sprint_Photo_Library_v2.md §6、§7、§10 P2）：trash／restore、非破壞 crop、
// bundle 最小資料層、Triage 快捷槽、依相簿分組資料。
// 不變式：這裡沒有任何刪檔或硬刪 assets 列的路徑；trash 只在 active ↔ trashed 之間切換。

const bad = (msg, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const MAX_BATCH = 100000;
const MAX_ALBUM_LOOKUP = 5000;
const CHUNK = 900;
export const SLOT_COUNT = 9;
export const SLOTS_KEY = 'triage_slots';
export const BUNDLE_STATUSES = ['open', 'closed', 'cancelled'];
/** Float slack for x + w ≤ 1 checks (UI sends values like 0.1 + 0.9). */
const EPS = 1e-9;

function idList(ids, what = 'ids', max = MAX_BATCH) {
  if (!Array.isArray(ids) || !ids.length) throw bad(`${what} must be a non-empty array`);
  if (ids.length > max) throw bad(`${what}: at most ${max}`);
  const out = [...new Set(ids.map(Number))];
  if (out.some((n) => !Number.isInteger(n) || n <= 0)) throw bad(`${what} must be positive integers`);
  return out;
}

function chunked(ids, fn) {
  for (let i = 0; i < ids.length; i += CHUNK) fn(ids.slice(i, i + CHUNK));
}

const marks = (part) => part.map(() => '?').join(',');

/**
 * Validates a relative crop rectangle against an asset's display size.
 *
 * @param {{x: unknown, y: unknown, w: unknown, h: unknown}} rect
 * @param {{width: number, height: number}} asset
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function cleanRect({ x, y, w, h }, asset) {
  const r = { x, y, w, h };
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${k} must be a finite number`);
  }
  if (r.x < 0 || r.y < 0 || r.x > 1 || r.y > 1) throw bad('x and y must be within 0..1');
  if (r.w <= 0 || r.h <= 0) throw bad('w and h must be > 0');
  if (r.x + r.w > 1 + EPS || r.y + r.h > 1 + EPS) throw bad('crop exceeds the image (x + w and y + h must be ≤ 1)');
  if (Math.round(r.w * asset.width) < 1 || Math.round(r.h * asset.height) < 1) throw bad('crop is smaller than one pixel');
  return r;
}

/**
 * Pixel extract region for a relative crop on an image of size W×H. Size is
 * round(w·W)×round(h·H); the origin is shifted inward if rounding would
 * overflow the edge, so the size is always exact.
 *
 * @param {{x: number, y: number, w: number, h: number}} crop
 * @param {number} W
 * @param {number} H
 * @returns {{left: number, top: number, width: number, height: number}}
 */
export function pixelRegion(crop, W, H) {
  const width = Math.min(W, Math.max(1, Math.round(crop.w * W)));
  const height = Math.min(H, Math.max(1, Math.round(crop.h * H)));
  const left = Math.min(Math.round(crop.x * W), W - width);
  const top = Math.min(Math.round(crop.y * H), H - height);
  return { left, top, width, height };
}

/**
 * Triage-mode data operations over one library database.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createTriage(db) {
  const q = {
    asset: db.prepare('SELECT * FROM assets WHERE id = ?'),
    crop: db.prepare('SELECT * FROM crops WHERE id = ?'),
    cropsOf: db.prepare('SELECT * FROM crops WHERE asset_id = ? ORDER BY id'),
    bundle: db.prepare('SELECT * FROM bundles WHERE id = ?'),
    item: db.prepare('SELECT * FROM bundle_items WHERE id = ?'),
    itemsOf: db.prepare('SELECT * FROM bundle_items WHERE bundle_id = ? ORDER BY position, id'),
    tag: db.prepare('SELECT id, name FROM tags WHERE id = ?'),
    album: db.prepare('SELECT id, name FROM albums WHERE id = ?'),
    setting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  };

  function requireAsset(id) {
    const a = q.asset.get(Number(id));
    if (!a) throw bad('asset not found', 404);
    return a;
  }

  function requireAssets(ids) {
    const found = new Map();
    chunked(ids, (part) => {
      for (const r of db.prepare(`SELECT id, status FROM assets WHERE id IN (${marks(part)})`).all(...part)) found.set(r.id, r.status);
    });
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw bad(`unknown asset ids: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`, 404);
    return found;
  }

  // ---- trash ---------------------------------------------------------------

  /**
   * Switches assets between active and trashed. Only rows in `from` move;
   * missing (and already-switched) rows are counted, never touched.
   */
  function switchStatus(rawIds, from, to, action) {
    const ids = idList(rawIds);
    return tx(db, () => {
      const status = requireAssets(ids);
      const upd = db.prepare('UPDATE assets SET status = ? WHERE id = ? AND status = ?');
      const changed = [];
      for (const id of ids) if (upd.run(to, id, from).changes) changed.push(id);
      const skippedMissing = ids.filter((id) => status.get(id) === 'missing').length;
      const out = { [to === 'trashed' ? 'trashed' : 'restored']: changed.length,
        skipped_missing: skippedMissing, skipped: ids.length - changed.length - skippedMissing };
      const eventId = logEvent(db, action, { requested: ids.length, ...out }, { op: action, ids: changed, from, to });
      return { ...out, event_id: eventId };
    });
  }

  const trashAssets = (ids) => switchStatus(ids, 'active', 'trashed', 'assets.trash');
  const restoreAssets = (ids) => switchStatus(ids, 'trashed', 'active', 'assets.restore');

  // ---- crops ---------------------------------------------------------------

  function listCrops(assetId) {
    return q.cropsOf.all(requireAsset(assetId).id);
  }

  function createCrop(assetId, input = {}) {
    const asset = requireAsset(assetId);
    const r = cleanRect(input, asset);
    let label = input.ratio_label ?? null;
    if (label != null) {
      if (typeof label !== 'string' || label.trim().length > 32) throw bad('ratio_label must be a string (≤32 chars)');
      label = label.trim() || null;
    }
    return tx(db, () => {
      const id = Number(db.prepare('INSERT INTO crops (asset_id, x, y, w, h, ratio_label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(asset.id, r.x, r.y, r.w, r.h, label, now()).lastInsertRowid);
      const crop = q.crop.get(id);
      const eventId = logEvent(db, 'crop.create', { id, asset_id: asset.id }, { op: 'crop.delete', crop });
      return { ...crop, event_id: eventId };
    });
  }

  /** Deletes a crop row (never a file); rows that cascade with it are kept in the undo record. */
  function deleteCrop(cropId) {
    const crop = q.crop.get(Number(cropId));
    if (!crop) throw bad('crop not found', 404);
    return tx(db, () => {
      const bundleItems = db.prepare('SELECT * FROM bundle_items WHERE crop_id = ? ORDER BY id').all(crop.id);
      const ocr = db.prepare('SELECT * FROM ocr_results WHERE crop_id = ? ORDER BY id').all(crop.id);
      db.prepare('DELETE FROM crops WHERE id = ?').run(crop.id);
      const eventId = logEvent(db, 'crop.delete', { id: crop.id, asset_id: crop.asset_id, bundle_items: bundleItems.length },
        { op: 'crop.restore', crop, bundle_items: bundleItems, ocr_results: ocr });
      return { deleted: true, removed_bundle_items: bundleItems.length, event_id: eventId };
    });
  }

  /** Crop row joined with its asset (for rendering). */
  function cropWithAsset(cropId) {
    const crop = q.crop.get(Number(cropId));
    if (!crop) throw bad('crop not found', 404);
    return { crop, asset: q.asset.get(crop.asset_id) };
  }

  // ---- bundles -------------------------------------------------------------

  function bundleOut(b) {
    return { ...b, items: q.itemsOf.all(b.id) };
  }

  function requireBundle(id) {
    const b = q.bundle.get(Number(id));
    if (!b) throw bad('bundle not found', 404);
    return b;
  }

  function cleanBundleName(name) {
    if (name == null || (typeof name === 'string' && !name.trim())) return null;
    if (typeof name !== 'string') throw bad('name must be a string');
    if (name.trim().length > 200) throw bad('bundle name too long');
    return name.trim();
  }

  function createBundle({ name } = {}) {
    const ts = now();
    const n = cleanBundleName(name) ?? `Bundle ${ts.slice(0, 19).replace('T', ' ')}`;
    return tx(db, () => {
      const id = Number(db.prepare("INSERT INTO bundles (name, status, created_at, updated_at) VALUES (?, 'open', ?, ?)")
        .run(n, ts, ts).lastInsertRowid);
      const eventId = logEvent(db, 'bundle.create', { id, name: n }, { op: 'bundle.delete', id });
      return { ...bundleOut(q.bundle.get(id)), event_id: eventId };
    });
  }

  function listBundles({ status } = {}) {
    if (status != null && !BUNDLE_STATUSES.includes(status)) throw bad(`status must be one of: ${BUNDLE_STATUSES.join(', ')}`);
    const sql = `SELECT b.*, (SELECT count(*) FROM bundle_items i WHERE i.bundle_id = b.id) AS item_count
      FROM bundles b ${status ? 'WHERE b.status = ?' : ''} ORDER BY b.updated_at DESC, b.id DESC`;
    return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  }

  const getBundle = (id) => bundleOut(requireBundle(id));

  /** Renames and/or sets status (G = closed, Shift+G = cancelled). Never deletes. */
  function updateBundle(id, { name, status } = {}) {
    const b = requireBundle(id);
    const next = { name: b.name, status: b.status };
    if (name !== undefined) {
      next.name = cleanBundleName(name);
      if (next.name == null) throw bad('name cannot be empty');
    }
    if (status !== undefined) {
      if (!BUNDLE_STATUSES.includes(status)) throw bad(`status must be one of: ${BUNDLE_STATUSES.join(', ')}`);
      next.status = status;
    }
    return tx(db, () => {
      db.prepare('UPDATE bundles SET name = ?, status = ?, updated_at = ? WHERE id = ?').run(next.name, next.status, now(), b.id);
      const eventId = logEvent(db, 'bundle.update', { id: b.id, ...next },
        { op: 'bundle.update', id: b.id, name: b.name, status: b.status, updated_at: b.updated_at });
      return { ...bundleOut(q.bundle.get(b.id)), event_id: eventId };
    });
  }

  /** Appends an asset or a crop (asset derived from the crop) to an open bundle. */
  function addBundleItem(bundleId, { asset_id, crop_id } = {}) {
    const b = requireBundle(bundleId);
    if (b.status !== 'open') throw bad(`bundle is ${b.status}; only open bundles accept items`, 409);
    let assetId;
    let cropId = null;
    if (crop_id != null) {
      const crop = q.crop.get(Number(crop_id));
      if (!crop) throw bad('crop not found', 404);
      if (asset_id != null && Number(asset_id) !== crop.asset_id) throw bad('crop does not belong to asset_id');
      assetId = crop.asset_id;
      cropId = crop.id;
    } else if (asset_id != null) {
      assetId = requireAsset(asset_id).id;
    } else {
      throw bad('asset_id or crop_id is required');
    }
    return tx(db, () => {
      const pos = db.prepare('SELECT COALESCE(max(position), 0) + 1 AS p FROM bundle_items WHERE bundle_id = ?').get(b.id).p;
      const id = Number(db.prepare('INSERT INTO bundle_items (bundle_id, position, asset_id, crop_id) VALUES (?, ?, ?, ?)')
        .run(b.id, pos, assetId, cropId).lastInsertRowid);
      db.prepare('UPDATE bundles SET updated_at = ? WHERE id = ?').run(now(), b.id);
      const eventId = logEvent(db, 'bundle.add', { bundle_id: b.id, item_id: id, asset_id: assetId, crop_id: cropId },
        { op: 'bundle.remove', item: q.item.get(id), updated_at: b.updated_at });
      return { ...q.item.get(id), event_id: eventId };
    });
  }

  function removeBundleItem(bundleId, itemId) {
    const b = requireBundle(bundleId);
    const item = q.item.get(Number(itemId));
    if (!item || item.bundle_id !== b.id) throw bad('bundle item not found', 404);
    return tx(db, () => {
      db.prepare('DELETE FROM bundle_items WHERE id = ?').run(item.id);
      db.prepare('UPDATE bundles SET updated_at = ? WHERE id = ?').run(now(), b.id);
      const eventId = logEvent(db, 'bundle.remove', { bundle_id: b.id, item_id: item.id },
        { op: 'bundle.add', item, updated_at: b.updated_at });
      return { removed: true, event_id: eventId };
    });
  }

  // ---- triage slots --------------------------------------------------------

  function readSlots() {
    const row = q.setting.get(SLOTS_KEY);
    return row ? JSON.parse(row.value) : Array(SLOT_COUNT).fill(null);
  }

  /** Slots with the target's current name (null when the tag/album no longer exists). */
  function getSlots() {
    return readSlots().map((s) => {
      if (!s) return null;
      const row = (s.kind === 'tag' ? q.tag : q.album).get(s.id);
      return { kind: s.kind, id: s.id, name: row?.name ?? null };
    });
  }

  function cleanSlot(slot, i) {
    if (slot === null) return null;
    if (typeof slot !== 'object' || Array.isArray(slot)) throw bad(`slot ${i + 1}: must be null or {kind, id}`);
    if (slot.kind === 'smart') throw bad(`slot ${i + 1}: smart albums cannot be slot targets`);
    if (!['tag', 'album'].includes(slot.kind)) throw bad(`slot ${i + 1}: kind must be 'tag' or 'album'`);
    const id = Number(slot.id);
    if (!Number.isInteger(id) || id <= 0) throw bad(`slot ${i + 1}: id must be a positive integer`);
    if (!(slot.kind === 'tag' ? q.tag : q.album).get(id)) throw bad(`slot ${i + 1}: ${slot.kind} #${id} not found`, 404);
    return { kind: slot.kind, id };
  }

  function putSlots(slots) {
    if (!Array.isArray(slots) || slots.length !== SLOT_COUNT) throw bad(`slots must be an array of length ${SLOT_COUNT}`);
    const clean = slots.map(cleanSlot);
    return tx(db, () => {
      const prev = q.setting.get(SLOTS_KEY)?.value ?? null;
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(SLOTS_KEY, JSON.stringify(clean));
      logEvent(db, 'settings.update', { key: SLOTS_KEY }, { op: 'settings.update', key: SLOTS_KEY, value: prev });
      return getSlots();
    });
  }

  // ---- album grouping ------------------------------------------------------

  /** {assetId: [{id, name}]} for every requested id (unknown ids map to []). */
  function albumsOf(rawIds) {
    const ids = idList(rawIds, 'ids', MAX_ALBUM_LOOKUP);
    const out = Object.fromEntries(ids.map((id) => [id, []]));
    chunked(ids, (part) => {
      const rows = db.prepare(`SELECT i.asset_id, al.id, al.name FROM album_items i JOIN albums al ON al.id = i.album_id
        WHERE i.asset_id IN (${marks(part)}) ORDER BY al.name COLLATE NOCASE, al.id`).all(...part);
      for (const r of rows) out[r.asset_id].push({ id: r.id, name: r.name });
    });
    return out;
  }

  return {
    trashAssets, restoreAssets,
    listCrops, createCrop, deleteCrop, cropWithAsset,
    createBundle, listBundles, getBundle, updateBundle, addBundleItem, removeBundleItem,
    getSlots, putSlots,
    albumsOf,
  };
}
