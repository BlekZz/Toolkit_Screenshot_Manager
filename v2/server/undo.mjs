import { logEvent, tx } from './db.mjs';

// 通用 undo 引擎（dev/Sprint_Photo_Library_v2.md §7 Z 鍵、§10.1 P2「undo 20 步全部還原」）。
// 每種寫 undo_json 的 action 恰有一個 handler；未知 action 一律 400，不靜默略過。
// 撤銷本身記一筆 `undo` 事件（undo_json 為 NULL → 不可再 undo，不做 redo），並把被撤銷事件的
// undone_by 設為該事件 id。狀態已被後續操作改變而無法精確還原時 → 409，整筆 rollback。

const bad = (msg, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const conflict = (msg) => bad(msg, 409);
export const UNDO_LIST_LIMIT = 30;

/** Whether a query AST references smart album `id`. */
const refersToSmart = (node, id) => !!node && typeof node === 'object' && (
  (node.op === 'smart' && Number(node.id) === id)
  || (Array.isArray(node.args) && node.args.some((n) => refersToSmart(n, id)))
  || refersToSmart(node.arg, id));

/** Actions whose reversal is owned by decisions.mjs (it logs its own suggestions.undo event). */
const DELEGATED = new Set(['suggestions.accept', 'suggestions.reject']);

/**
 * Generic undo over one library database.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{undoDecisionInTx: (id: number) => object}} decisions
 */
export function createUndo(db, decisions) {
  const q = {
    event: db.prepare('SELECT * FROM events WHERE id = ?'),
    latest: db.prepare('SELECT * FROM events WHERE undo_json IS NOT NULL AND undone_by IS NULL ORDER BY id DESC LIMIT 1'),
    recent: db.prepare(`SELECT id, ts, action, payload_json FROM events
      WHERE undo_json IS NOT NULL AND undone_by IS NULL ORDER BY id DESC LIMIT ?`),
    markUndone: db.prepare('UPDATE events SET undone_by = ? WHERE id = ? AND undone_by IS NULL'),
    tag: db.prepare('SELECT * FROM tags WHERE id = ?'),
    folder: db.prepare('SELECT * FROM album_folders WHERE id = ?'),
    album: db.prepare('SELECT * FROM albums WHERE id = ?'),
    smart: db.prepare('SELECT * FROM smart_albums WHERE id = ?'),
    crop: db.prepare('SELECT * FROM crops WHERE id = ?'),
    bundle: db.prepare('SELECT * FROM bundles WHERE id = ?'),
    item: db.prepare('SELECT * FROM bundle_items WHERE id = ?'),
    tagSubtree: db.prepare(`WITH RECURSIVE s(id) AS (SELECT ? UNION ALL SELECT t.id FROM tags t JOIN s ON t.parent_id = s.id)
      SELECT id FROM s`),
    folderSubtree: db.prepare(`WITH RECURSIVE s(id) AS (SELECT ? UNION ALL SELECT f.id FROM album_folders f JOIN s ON f.parent_id = s.id)
      SELECT id FROM s`),
  };

  const RESTORABLE = new Set(['tags', 'asset_tags', 'asset_suggestions', 'tag_actions', 'tag_matchers', 'album_folders',
    'albums', 'album_items', 'smart_albums', 'crops', 'bundle_items', 'ocr_results']);

  /** Re-inserts a row exactly as snapshotted (same id and column values). */
  function insertRow(table, row) {
    if (!RESTORABLE.has(table)) throw new Error(`table not restorable: ${table}`);
    const cols = Object.keys(row);
    if (cols.some((c) => !/^[a-z_]+$/.test(c))) throw new Error('bad column name in undo record');
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => row[c]));
  }

  /** Inserts self-referencing rows parents-first (parent_id outside the set counts as present). */
  function insertTree(table, rows) {
    const ids = new Set(rows.map((r) => r.id));
    const done = new Set();
    let pending = [...rows];
    while (pending.length) {
      const ready = pending.filter((r) => r.parent_id == null || !ids.has(r.parent_id) || done.has(r.parent_id));
      if (!ready.length) throw conflict(`${table}: cyclic parent links in undo record`);
      for (const r of ready) { insertRow(table, r); done.add(r.id); }
      pending = pending.filter((r) => !done.has(r.id));
    }
  }

  const exists = (sql, ...params) => !!db.prepare(sql).get(...params);
  const run = (sql, ...params) => Number(db.prepare(sql).run(...params).changes);

  // ---- handlers: action → (undo record) → result counts -------------------

  const HANDLERS = {
    // tags
    'tags.apply': (u) => {
      let removed = 0;
      for (const [a, t] of u.added ?? []) removed += run('DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?', a, t);
      for (const [a, t, source = 'manual', addedAt = new Date().toISOString()] of u.removed ?? []) {
        insertRow('asset_tags', { asset_id: a, tag_id: t, source, added_at: addedAt });
      }
      return { links_removed: removed, links_restored: (u.removed ?? []).length };
    },
    'tag.create': (u) => {
      const ids = [...u.ids].reverse();
      const own = new Set(ids);
      for (const id of ids) {
        if (!q.tag.get(id)) throw conflict(`tag #${id} no longer exists`);
        if (exists(`SELECT 1 FROM tags WHERE parent_id = ? AND id NOT IN (${[...own].map(() => '?').join(',')})`, id, ...own)) {
          throw conflict(`tag #${id} has child tags created later`);
        }
        for (const t of ['asset_tags', 'asset_suggestions', 'tag_actions', 'tag_matchers']) {
          if (exists(`SELECT 1 FROM ${t} WHERE tag_id = ?`, id)) throw conflict(`tag #${id} is in use (${t}); undo those first`);
        }
      }
      let removed = 0;
      for (const id of ids) removed += run('DELETE FROM tags WHERE id = ?', id);
      return { tags_removed: removed };
    },
    'tag.update': (u) => {
      if (!q.tag.get(u.id)) throw conflict(`tag #${u.id} no longer exists`);
      if (u.parent_id != null && q.tagSubtree.all(u.id).some((r) => r.id === u.parent_id)) throw conflict('would create a tag cycle');
      run('UPDATE tags SET name = ?, color = ?, parent_id = ?, description = ? WHERE id = ?',
        u.name, u.color, u.parent_id, u.description ?? null, u.id);
      return { tags_updated: 1 };
    },
    'tag.delete': (u) => {
      insertTree('tags', u.tags);
      for (const l of u.links ?? []) insertRow('asset_tags', l);
      for (const t of ['asset_suggestions', 'tag_actions', 'tag_matchers']) for (const r of u[t] ?? []) insertRow(t, r);
      return { tags_restored: u.tags.length, links_restored: (u.links ?? []).length };
    },

    // album folders
    'folder.create': (u) => {
      if (!q.folder.get(u.id)) throw conflict(`folder #${u.id} no longer exists`);
      if (exists('SELECT 1 FROM album_folders WHERE parent_id = ?', u.id)
        || exists('SELECT 1 FROM albums WHERE folder_id = ?', u.id)
        || exists('SELECT 1 FROM smart_albums WHERE folder_id = ?', u.id)) throw conflict(`folder #${u.id} is not empty`);
      return { folders_removed: run('DELETE FROM album_folders WHERE id = ?', u.id) };
    },
    'folder.update': (u) => {
      if (!q.folder.get(u.id)) throw conflict(`folder #${u.id} no longer exists`);
      if (u.parent_id != null && q.folderSubtree.all(u.id).some((r) => r.id === u.parent_id)) throw conflict('would create a folder cycle');
      run('UPDATE album_folders SET name = ?, parent_id = ? WHERE id = ?', u.name, u.parent_id, u.id);
      return { folders_updated: 1 };
    },
    'folder.delete': (u) => {
      insertTree('album_folders', u.folders);
      let moved = 0;
      for (const a of u.albums ?? []) moved += run('UPDATE albums SET folder_id = ? WHERE id = ? AND folder_id IS NULL', a.folder_id, a.id);
      for (const s of u.smart ?? []) moved += run('UPDATE smart_albums SET folder_id = ? WHERE id = ? AND folder_id IS NULL', s.folder_id, s.id);
      return { folders_restored: u.folders.length, members_restored: moved };
    },

    // albums
    'album.create': (u) => {
      if (!q.album.get(u.id)) throw conflict(`album #${u.id} no longer exists`);
      if (exists('SELECT 1 FROM album_items WHERE album_id = ?', u.id)) throw conflict(`album #${u.id} is not empty`);
      return { albums_removed: run('DELETE FROM albums WHERE id = ?', u.id) };
    },
    'album.update': (u) => {
      if (!q.album.get(u.id)) throw conflict(`album #${u.id} no longer exists`);
      run('UPDATE albums SET name = ?, folder_id = ?, cover_asset_id = ? WHERE id = ?', u.name, u.folder_id, u.cover_asset_id, u.id);
      return { albums_updated: 1 };
    },
    'album.delete': (u) => {
      insertRow('albums', u.album);
      for (const it of u.items ?? []) insertRow('album_items', it);
      return { albums_restored: 1, items_restored: (u.items ?? []).length };
    },
    'album.add': (u) => {
      let removed = 0;
      for (const a of u.asset_ids ?? []) removed += run('DELETE FROM album_items WHERE album_id = ? AND asset_id = ?', u.album_id, a);
      return { items_removed: removed };
    },
    'album.remove': (u) => {
      for (const [a, position, addedAt = new Date().toISOString()] of u.items ?? []) {
        insertRow('album_items', { album_id: u.album_id, asset_id: a, position, added_at: addedAt });
      }
      return { items_restored: (u.items ?? []).length };
    },
    'album.reorder': (u) => {
      let moved = 0;
      for (const [a, position] of u.positions ?? []) {
        moved += run('UPDATE album_items SET position = ? WHERE album_id = ? AND asset_id = ?', position, u.album_id, a);
      }
      return { positions_restored: moved };
    },

    // smart albums
    'smart.create': (u) => {
      if (!q.smart.get(u.id)) throw conflict(`smart album #${u.id} no longer exists`);
      const users = db.prepare('SELECT query_json FROM smart_albums WHERE id <> ?').all(u.id)
        .filter((s) => refersToSmart(JSON.parse(s.query_json), u.id));
      if (users.length) throw conflict(`smart album #${u.id} is referenced by other smart albums`);
      return { smart_removed: run('DELETE FROM smart_albums WHERE id = ?', u.id) };
    },
    'smart.update': (u) => {
      if (!q.smart.get(u.id)) throw conflict(`smart album #${u.id} no longer exists`);
      run('UPDATE smart_albums SET name = ?, query_json = ?, folder_id = ? WHERE id = ?', u.name, u.query_json, u.folder_id, u.id);
      return { smart_updated: 1 };
    },
    'smart.delete': (u) => {
      insertRow('smart_albums', u.smart);
      return { smart_restored: 1 };
    },

    // tag → action bindings (decisions.mjs)
    'tag_action.create': (u) => {
      if (!exists('SELECT 1 FROM tag_actions WHERE id = ?', u.action.id)) throw conflict(`tag action #${u.action.id} no longer exists`);
      return { actions_removed: run('DELETE FROM tag_actions WHERE id = ?', u.action.id) };
    },
    'tag_action.update': (u) => {
      if (!exists('SELECT 1 FROM tag_actions WHERE id = ?', u.id)) throw conflict(`tag action #${u.id} no longer exists`);
      run('UPDATE tag_actions SET tag_id = ?, kind = ?, target = ?, enabled = ? WHERE id = ?', u.tag_id, u.kind, u.target, u.enabled, u.id);
      return { actions_updated: 1 };
    },
    'tag_action.delete': (u) => {
      insertRow('tag_actions', u.action);
      return { actions_restored: 1 };
    },

    // trash / restore: flip back only rows still in the state this event set
    'assets.trash': (u) => flipBack(u),
    'assets.restore': (u) => flipBack(u),

    // crops
    'crop.create': (u) => {
      const cur = q.crop.get(u.crop.id);
      if (!cur || cur.asset_id !== u.crop.asset_id || cur.created_at !== u.crop.created_at) throw conflict(`crop #${u.crop.id} no longer matches`);
      if (exists('SELECT 1 FROM bundle_items WHERE crop_id = ?', cur.id) || exists('SELECT 1 FROM ocr_results WHERE crop_id = ?', cur.id)) {
        throw conflict(`crop #${cur.id} is used by a bundle or OCR result; undo those first`);
      }
      return { crops_removed: run('DELETE FROM crops WHERE id = ?', cur.id) };
    },
    'crop.delete': (u) => {
      insertRow('crops', u.crop);
      for (const it of u.bundle_items ?? []) insertRow('bundle_items', it);
      for (const r of u.ocr_results ?? []) insertRow('ocr_results', r);
      return { crops_restored: 1, bundle_items_restored: (u.bundle_items ?? []).length };
    },

    // bundles
    'bundle.create': (u) => {
      if (!q.bundle.get(u.id)) throw conflict(`bundle #${u.id} no longer exists`);
      if (exists('SELECT 1 FROM bundle_items WHERE bundle_id = ?', u.id) || exists('SELECT 1 FROM bundle_revisions WHERE bundle_id = ?', u.id)) {
        throw conflict(`bundle #${u.id} is not empty`);
      }
      return { bundles_removed: run('DELETE FROM bundles WHERE id = ?', u.id) };
    },
    'bundle.update': (u) => {
      if (!q.bundle.get(u.id)) throw conflict(`bundle #${u.id} no longer exists`);
      run('UPDATE bundles SET name = ?, status = ?, updated_at = ? WHERE id = ?', u.name, u.status, u.updated_at, u.id);
      return { bundles_updated: 1 };
    },
    'bundle.add': (u) => {
      const cur = q.item.get(u.item.id);
      if (!cur || cur.bundle_id !== u.item.bundle_id || cur.asset_id !== u.item.asset_id || cur.crop_id !== u.item.crop_id) {
        throw conflict(`bundle item #${u.item.id} no longer matches`);
      }
      run('DELETE FROM bundle_items WHERE id = ?', cur.id);
      run('UPDATE bundles SET updated_at = ? WHERE id = ?', u.updated_at, u.item.bundle_id);
      return { items_removed: 1 };
    },
    'bundle.remove': (u) => {
      insertRow('bundle_items', u.item);
      run('UPDATE bundles SET updated_at = ? WHERE id = ?', u.updated_at, u.item.bundle_id);
      return { items_restored: 1 };
    },

    // settings (triage slots)
    'settings.update': (u) => {
      if (u.value == null) run('DELETE FROM settings WHERE key = ?', u.key);
      else run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', u.key, u.value);
      return { settings_restored: 1 };
    },
  };

  function flipBack(u) {
    let flipped = 0;
    for (const id of u.ids ?? []) flipped += run('UPDATE assets SET status = ? WHERE id = ? AND status = ?', u.from, id, u.to);
    return { assets_reverted: flipped, assets_skipped: (u.ids ?? []).length - flipped };
  }

  /** Actions this engine can reverse. */
  const supported = (action) => DELEGATED.has(action) || Object.hasOwn(HANDLERS, action);

  /**
   * Undoes one event: the given id, or (no id) the most recent undoable,
   * not-yet-undone event.
   *
   * @param {number} [eventId]
   * @returns {{undone_event_id: number, action: string, event_id: number, result: object}}
   */
  function undo(eventId) {
    let id = null;
    if (eventId !== undefined && eventId !== null) {
      id = Number(eventId);
      if (!Number.isInteger(id) || id <= 0) throw bad('event_id must be a positive integer');
    }
    return tx(db, () => {
      const ev = id == null ? q.latest.get() : q.event.get(id);
      if (!ev) throw bad(id == null ? 'nothing to undo' : 'event not found', 404);
      if (ev.undo_json == null) throw bad(`event #${ev.id} (${ev.action}) is not undoable`);
      if (ev.undone_by != null) throw conflict(`event #${ev.id} has already been undone (by #${ev.undone_by})`);
      if (DELEGATED.has(ev.action)) {
        const result = decisions.undoDecisionInTx(ev.id);
        return { undone_event_id: ev.id, action: ev.action, event_id: result.event_id, result };
      }
      const handler = HANDLERS[ev.action];
      if (!handler) throw bad(`no undo handler for action "${ev.action}" (event #${ev.id})`);
      let result;
      try {
        result = handler(JSON.parse(ev.undo_json));
      } catch (err) {
        if (err.statusCode == null && /constraint failed/i.test(err.message)) {
          throw conflict(`cannot undo event #${ev.id}: library changed since (${err.message})`);
        }
        throw err;
      }
      const undoId = logEvent(db, 'undo', { event_id: ev.id, action: ev.action, ...result });
      q.markUndone.run(undoId, ev.id);
      return { undone_event_id: ev.id, action: ev.action, event_id: undoId, result };
    });
  }

  /** The most recent undoable, not-yet-undone events, newest first. */
  function listUndoable(limit = UNDO_LIST_LIMIT) {
    return q.recent.all(limit).map((e) => {
      const payload = JSON.parse(e.payload_json);
      return { id: e.id, action: e.action, ts: e.ts, summary: describe(e.action, payload), supported: supported(e.action) };
    });
  }

  return { undo, listUndoable, supported, actions: [...DELEGATED, ...Object.keys(HANDLERS)] };
}

/** One-line human summary of an event payload for the undo list. */
export function describe(action, p) {
  const n = (v) => (v == null ? '?' : v);
  switch (action) {
    case 'tags.apply': return `標籤：${n(p.assets)} 張，+${n(p.added)} −${n(p.removed)}`;
    case 'tag.create': return `建立標籤「${p.name}」`;
    case 'tag.update': return `修改標籤「${p.name}」`;
    case 'tag.delete': return `刪除標籤「${p.name}」（${n(p.links)} 個連結）`;
    case 'folder.create': return `建立相簿資料夾「${p.name}」`;
    case 'folder.update': return `修改相簿資料夾「${p.name}」`;
    case 'folder.delete': return `刪除相簿資料夾「${p.name}」`;
    case 'album.create': return `建立相簿「${p.name}」`;
    case 'album.update': return `修改相簿「${p.name}」`;
    case 'album.delete': return `刪除相簿「${p.name}」（${n(p.items)} 張）`;
    case 'album.add': return `加入相簿 #${p.album_id}：${n(p.added)} 張`;
    case 'album.remove': return `移出相簿 #${p.album_id}：${n(p.removed)} 張`;
    case 'album.reorder': return `相簿 #${p.album_id} 重新排序 ${n(p.moved)} 張`;
    case 'smart.create': return `建立智慧相簿「${p.name}」`;
    case 'smart.update': return `修改智慧相簿「${p.name}」`;
    case 'smart.delete': return `刪除智慧相簿「${p.name}」`;
    case 'tag_action.create': return `新增標籤動作 ${p.kind} → ${p.target}`;
    case 'tag_action.update': return `修改標籤動作 #${p.id}`;
    case 'tag_action.delete': return `刪除標籤動作 #${p.id}`;
    case 'suggestions.accept': return `接受建議 ${n(p.accepted)} 筆`;
    case 'suggestions.reject': return `拒絕建議 ${n(p.rejected)} 筆`;
    case 'assets.trash': return `移入垃圾桶 ${n(p.trashed)} 張`;
    case 'assets.restore': return `從垃圾桶還原 ${n(p.restored)} 張`;
    case 'crop.create': return `建立裁剪（圖 #${p.asset_id}）`;
    case 'crop.delete': return `刪除裁剪 #${p.id}（圖 #${p.asset_id}）`;
    case 'bundle.create': return `建立 bundle「${p.name}」`;
    case 'bundle.update': return `bundle #${p.id} → ${p.status}`;
    case 'bundle.add': return `加入 bundle #${p.bundle_id}${p.crop_id ? `（裁剪 #${p.crop_id}）` : `（圖 #${p.asset_id}）`}`;
    case 'bundle.remove': return `移出 bundle #${p.bundle_id}`;
    case 'settings.update': return `修改設定 ${p.key}`;
    default: return action;
  }
}
