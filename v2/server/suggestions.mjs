import { logEvent, now, tx } from './db.mjs';

/** Label `purpose` value → tag path. `unsure` (and anything unknown) yields no suggestion. */
export const PURPOSE_TAG = {
  'text-note': 'purpose/text-note',
  chat: 'purpose/chat',
  translate: 'purpose/translate',
  'visual-ref': 'purpose/visual-ref',
  receipt: 'purpose/receipt',
  junk: 'purpose/ephemeral', // labels from before the rename (Sprint §2.1)
  ephemeral: 'purpose/ephemeral',
};
export const CONTEXT_TAG = { work: 'context/work', personal: 'context/personal' };
/** Top-level tags that are pure folders: only their descendants are scored. */
export const CONTAINER_ROOTS = ['purpose', 'context', 'custom'];
/** Top-level tags that are labels themselves (scored even if the user adds child tags under them). */
export const LABEL_ROOTS = ['sensitive'];

/**
 * Masks things that look like personal data in model-written text: runs of
 * 4+ digits (card/account/phone fragments), emails, and @handles.
 *
 * @param {unknown} text
 * @returns {string|null}
 */
export function sanitizeReason(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/@[A-Za-z0-9_.]{2,}/g, '@[handle]')
    .replace(/\d[\d\s-]{2,}\d/g, (m) => (m.replace(/\D/g, '').length >= 4 ? '[數字]' : m))
    .trim()
    .slice(0, 200);
}

/** Resolves "a/b" to a tag id, or null when any segment is missing. */
export function tagIdByPath(db, path) {
  const stmt = db.prepare('SELECT id FROM tags WHERE COALESCE(parent_id, 0) = ? AND name = ?');
  let parent = 0;
  for (const seg of path.split('/')) {
    const row = stmt.get(parent, seg);
    if (!row) return null;
    parent = row.id;
  }
  return parent || null;
}

/** Custom tags whose name or description terms (split on 、,，) equal one of the keywords. */
function customMatcher(db) {
  const root = tagIdByPath(db, 'custom');
  if (!root) return () => [];
  const tags = db.prepare('SELECT id, name, description FROM tags WHERE parent_id = ?').all(root).map((t) => ({
    id: t.id,
    terms: new Set([t.name, ...(t.description || '').split(/[、,，]/).map((s) => s.trim()).filter(Boolean)].map((s) => s.toLowerCase())),
  }));
  return (keywords) => {
    const kws = (Array.isArray(keywords) ? keywords : []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
    return tags.filter((t) => kws.some((k) => t.terms.has(k))).map((t) => t.id);
  };
}

/**
 * Finds the asset a label row refers to by original filename. When several
 * assets share the filename, the one imported from a folder named `Input`
 * wins; otherwise the row is ambiguous.
 */
function assetMatcher(db) {
  const byName = new Map();
  for (const a of db.prepare("SELECT id, filename, source_path FROM assets WHERE status != 'trashed'").all()) {
    const k = a.filename.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(a);
  }
  return (file) => {
    const hits = byName.get(String(file).toLowerCase()) || [];
    if (hits.length <= 1) return { id: hits[0]?.id ?? null, ambiguous: false };
    const fromInput = hits.filter((a) => /[\\/]Input[\\/][^\\/]+$/i.test(a.source_path || ''));
    return fromInput.length === 1 ? { id: fromInput[0].id, ambiguous: false } : { id: null, ambiguous: true };
  };
}

/**
 * Imports label rows (Claude/VLM JSON, one object per image) as pending suggestions.
 * Idempotent: the same (asset, tag, stage, model, prompt_hash) is never inserted twice.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} rows Each `{file, purpose, context, sensitive, confidence, reason, keywords}`.
 * @param {{stage?: string, model?: string, promptHash?: string, dryRun?: boolean}} [opts]
 *   `dryRun` computes the same counts inside a transaction that is rolled back.
 * @returns {{rows: number, matched: number, unmatched: string[], ambiguous: string[], invalid: string[],
 *   inserted: number, skipped: number}}
 */
export function importLabels(db, rows, { stage = 'import', model = '', promptHash = '', dryRun = false } = {}) {
  const match = assetMatcher(db);
  const customFor = customMatcher(db);
  const ids = {
    sensitive: tagIdByPath(db, 'sensitive'),
    ...Object.fromEntries([...Object.values(PURPOSE_TAG), ...Object.values(CONTEXT_TAG)].map((p) => [p, tagIdByPath(db, p)])),
  };
  const missingTags = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);
  if (missingTags.length) throw new Error(`missing tags (migration 003 not applied?): ${missingTags.join(', ')}`);

  const ins = db.prepare(`INSERT OR IGNORE INTO asset_suggestions
    (asset_id, tag_id, stage, confidence, reason, model, prompt_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const out = { rows: rows.length, matched: 0, unmatched: [], ambiguous: [], invalid: [], inserted: 0, skipped: 0 };
  const ts = now();

  const DRY = Symbol('dry-run');
  try {
    tx(db, () => {
      body();
      if (dryRun) throw DRY;
    });
  } catch (err) {
    if (err !== DRY) throw err;
  }
  return out;

  function body() {
    for (const r of rows) {
      const conf = Number(r?.confidence);
      if (!r || typeof r.file !== 'string' || !(conf >= 0 && conf <= 1)) { out.invalid.push(String(r?.file)); continue; }
      const { id, ambiguous } = match(r.file);
      if (ambiguous) { out.ambiguous.push(r.file); continue; }
      if (!id) { out.unmatched.push(r.file); continue; }
      out.matched++;
      const tagIds = [];
      if (PURPOSE_TAG[r.purpose]) tagIds.push(ids[PURPOSE_TAG[r.purpose]]);
      if (CONTEXT_TAG[r.context]) tagIds.push(ids[CONTEXT_TAG[r.context]]);
      if (r.sensitive === true) tagIds.push(ids.sensitive);
      tagIds.push(...customFor(r.keywords));
      const reason = sanitizeReason(r.reason);
      for (const tagId of new Set(tagIds)) {
        const res = ins.run(id, tagId, stage, conf, reason, model, promptHash, ts);
        if (res.changes) out.inserted++; else out.skipped++;
      }
    }
    logEvent(db, 'suggestions.import', { stage, model, rows: out.rows, matched: out.matched, inserted: out.inserted });
  }
}

/** Deterministic PRNG (LCG) so samples are reproducible from a seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
}

/**
 * Picks a stratified review sample: assets grouped by their highest-confidence
 * pending purpose suggestion, each group gets ⌈n / groups⌉ (capped by size),
 * leftovers are filled round-robin. Sampled assets go into `albumName` and
 * get their pending suggestions applied as tags (source 'ai') so the user
 * can confirm by leaving them or correct by removing/adding tags.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{n?: number, seed?: number, albumName?: string}} [opts]
 * @returns {{albumId: number, picked: number, byPurpose: Record<string, number>, tagsApplied: number}}
 */
export function sampleForReview(db, { n = 50, seed = 1, albumName = 'AI 確認樣本' } = {}) {
  const purposeRoot = tagIdByPath(db, 'purpose');
  const top = db.prepare(`
    SELECT s.asset_id, t.name AS purpose
    FROM asset_suggestions s JOIN tags t ON t.id = s.tag_id
    JOIN assets a ON a.id = s.asset_id AND a.status = 'active'
    WHERE s.status = 'pending' AND t.parent_id = ?
    ORDER BY s.asset_id, s.confidence DESC, s.id`).all(purposeRoot);
  const groups = new Map();
  const seen = new Set();
  for (const r of top) {
    if (seen.has(r.asset_id)) continue; // first row per asset = top purpose
    seen.add(r.asset_id);
    if (!groups.has(r.purpose)) groups.set(r.purpose, []);
    groups.get(r.purpose).push(r.asset_id);
  }

  return tx(db, () => {
    let album = db.prepare('SELECT id FROM albums WHERE name = ?').get(albumName);
    if (!album) {
      const res = db.prepare("INSERT INTO albums (name, sort_mode, created_at) VALUES (?, 'manual', ?)").run(albumName, now());
      album = { id: Number(res.lastInsertRowid) };
    }
    const already = new Set(db.prepare('SELECT asset_id FROM album_items WHERE album_id = ?').all(album.id).map((r) => r.asset_id));

    const rand = rng(seed);
    const pools = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([purpose, ids]) => {
      const pool = ids.filter((id) => !already.has(id));
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      return { purpose, pool, taken: [] };
    });
    const quota = Math.ceil(n / Math.max(pools.length, 1));
    let left = n;
    for (const p of pools) { const k = Math.min(quota, p.pool.length, left); p.taken.push(...p.pool.splice(0, k)); left -= k; }
    for (let progress = true; left > 0 && progress;) {
      progress = false;
      for (const p of pools) if (left > 0 && p.pool.length) { p.taken.push(p.pool.shift()); left--; progress = true; }
    }

    const picked = pools.flatMap((p) => p.taken);
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM album_items WHERE album_id = ?').get(album.id).m;
    const addItem = db.prepare('INSERT OR IGNORE INTO album_items (album_id, asset_id, position, added_at) VALUES (?, ?, ?, ?)');
    const applyTags = db.prepare(`INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, source, added_at)
      SELECT asset_id, tag_id, 'ai', ? FROM asset_suggestions WHERE asset_id = ? AND status = 'pending'`);
    const ts = now();
    let tagsApplied = 0;
    picked.forEach((id, i) => {
      addItem.run(album.id, id, maxPos + i + 1, ts);
      tagsApplied += applyTags.run(ts, id).changes;
    });
    logEvent(db, 'suggestions.sample', { album_id: album.id, picked: picked.length, seed });
    return { albumId: album.id, picked: picked.length, byPurpose: Object.fromEntries(pools.map((p) => [p.purpose, p.taken.length])), tagsApplied };
  });
}

/**
 * Scores suggestions against the user's final tags for every asset in an album.
 * Scored tags: descendants of CONTAINER_ROOTS, plus LABEL_ROOTS and their descendants.
 * A tag counts as present when it or any descendant is on the asset (so a
 * user-made `sensitive/Adult` confirms `sensitive`). Suggested & present = TP,
 * suggested & absent = FP, present (any source) & not suggested = FN. With `finalize`, suggestions get
 * status accepted/rejected so later runs can tell reviewed from pending.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{albumName?: string, finalize?: boolean}} [opts]
 * @returns {{assets: number, perTag: Record<string, {tp: number, fp: number, fn: number, precision: number|null, recall: number|null}>}}
 */
export function evaluate(db, { albumName = 'AI 確認樣本', finalize = false } = {}) {
  const album = db.prepare('SELECT id FROM albums WHERE name = ?').get(albumName);
  if (!album) throw new Error(`album not found: ${albumName}`);
  const assets = db.prepare('SELECT asset_id FROM album_items WHERE album_id = ?').all(album.id).map((r) => r.asset_id);

  const containers = new Set(CONTAINER_ROOTS.map((r) => tagIdByPath(db, r)).filter(Boolean));
  const labelRoots = new Set(LABEL_ROOTS.map((r) => tagIdByPath(db, r)).filter(Boolean));
  const inScope = new Map(); // tag id → path label
  const rows = db.prepare('SELECT id, name, parent_id FROM tags').all();
  const byId = new Map(rows.map((t) => [t.id, t]));
  const label = (id) => { const p = []; for (let t = byId.get(id); t; t = byId.get(t.parent_id)) p.unshift(t.name); return p.join('/'); };
  const rootOf = (id) => { let t = byId.get(id); while (t?.parent_id) t = byId.get(t.parent_id); return t?.id; };
  for (const t of rows) {
    const r = rootOf(t.id);
    if ((containers.has(r) && t.id !== r) || labelRoots.has(r)) inScope.set(t.id, label(t.id));
  }
  /** Asset tag ids expanded with their in-scope ancestors. */
  const withAncestors = (ids) => {
    const out = new Set();
    for (const id of ids) for (let t = byId.get(id); t; t = byId.get(t.parent_id)) if (inScope.has(t.id)) out.add(t.id);
    return out;
  };

  const perTag = {};
  const bump = (id, k) => { const l = inScope.get(id); (perTag[l] ??= { tp: 0, fp: 0, fn: 0 })[k]++; };
  const sugg = db.prepare("SELECT id, tag_id FROM asset_suggestions WHERE asset_id = ? AND status IN ('pending', 'accepted', 'rejected')");
  const tags = db.prepare('SELECT tag_id FROM asset_tags WHERE asset_id = ?');
  const setStatus = db.prepare('UPDATE asset_suggestions SET status = ?, decided_at = ? WHERE id = ?');
  const ts = now();

  const run = () => {
    for (const a of assets) {
      const have = withAncestors(tags.all(a).map((r) => r.tag_id));
      const suggested = new Set();
      for (const s of sugg.all(a)) {
        if (!inScope.has(s.tag_id) || suggested.has(s.tag_id)) continue;
        suggested.add(s.tag_id);
        bump(s.tag_id, have.has(s.tag_id) ? 'tp' : 'fp');
      }
      for (const id of have) if (!suggested.has(id)) bump(id, 'fn');
      if (finalize) for (const s of sugg.all(a)) if (inScope.has(s.tag_id)) setStatus.run(have.has(s.tag_id) ? 'accepted' : 'rejected', ts, s.id);
    }
  };
  if (finalize) tx(db, () => { run(); logEvent(db, 'suggestions.evaluate', { album_id: album.id, assets: assets.length }); });
  else run();

  for (const v of Object.values(perTag)) {
    v.precision = v.tp + v.fp ? v.tp / (v.tp + v.fp) : null;
    v.recall = v.tp + v.fn ? v.tp / (v.tp + v.fn) : null;
  }
  return { assets: assets.length, perTag };
}
