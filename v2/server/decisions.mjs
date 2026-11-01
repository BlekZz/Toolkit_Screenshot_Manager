import { logEvent, now, tx } from './db.mjs';
import { tagIdByPath } from './suggestions.mjs';

// AI 分流 A4（dev/Sprint_Screenshot_AI_Triage.md §5、§7.1）：人對建議的決定（接受／拒絕／undo）
// 與「用途 → 動作」綁定。不變式：這裡沒有任何路徑會改 assets.status 或刪檔——
// 動作白名單只有 album／tag，未知 kind 一律 throw。

const bad = (msg, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const MAX_BATCH = 100000;
/** The only action kinds that exist. Deliberately no trash / status / delete kinds. */
export const ACTION_KINDS = ['album', 'tag'];
const MAX_TARGET = 100;

function idList(ids, what = 'ids') {
  if (!Array.isArray(ids) || !ids.length) throw bad(`${what} must be a non-empty array`);
  if (ids.length > MAX_BATCH) throw bad(`${what}: at most ${MAX_BATCH}`);
  const out = [...new Set(ids.map(Number))];
  if (out.some((n) => !Number.isInteger(n) || n <= 0)) throw bad(`${what} must be positive integers`);
  return out;
}

const lastId = (db) => Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);

/**
 * Builds the executor for bound actions. Records every row it creates into
 * `undo` so the accept event can be reversed exactly.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{asset_tags: number[][], album_items: number[][], albums_created: number[]}} undo
 * @param {string} ts Timestamp for created rows.
 * @returns {(action: {kind: string, target: string}, assetId: number) => {result: string, created?: boolean}}
 */
export function createActionRunner(db, undo, ts = now()) {
  const findAlbum = db.prepare('SELECT id FROM albums WHERE name = ? ORDER BY id LIMIT 1');
  const insAlbum = db.prepare('INSERT INTO albums (folder_id, name, created_at) VALUES (NULL, ?, ?)');
  const maxPos = db.prepare('SELECT COALESCE(max(position), 0) AS p FROM album_items WHERE album_id = ?');
  const insItem = db.prepare('INSERT OR IGNORE INTO album_items (album_id, asset_id, position, added_at) VALUES (?, ?, ?, ?)');
  const insTag = db.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'ai', ?)");

  function addToAlbum(name, assetId) {
    let created = false;
    let albumId = findAlbum.get(name)?.id;
    if (albumId == null) {
      albumId = Number(insAlbum.run(name, ts).lastInsertRowid);
      undo.albums_created.push(albumId);
      created = true;
    }
    if (!insItem.run(albumId, assetId, maxPos.get(albumId).p + 1, ts).changes) return { result: 'exists', created };
    undo.album_items.push([albumId, assetId]);
    return { result: 'added', created };
  }

  function addTag(path, assetId) {
    const tagId = tagIdByPath(db, path);
    if (tagId == null) return { result: 'skipped' }; // tag deleted/renamed since the binding was made
    if (!insTag.run(assetId, tagId, ts).changes) return { result: 'exists' };
    undo.asset_tags.push([assetId, tagId]);
    return { result: 'added' };
  }

  return (action, assetId) => {
    switch (action.kind) {
      case 'album': return addToAlbum(action.target, assetId);
      case 'tag': return addTag(action.target, assetId);
      default: throw new Error(`unknown tag action kind: ${action.kind}`);
    }
  };
}

/**
 * Suggestion decisions and tag → action bindings over one library database.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createDecisions(db) {
  const q = {
    asset: db.prepare('SELECT id FROM assets WHERE id = ?'),
    tag: db.prepare('SELECT id, parent_id, name FROM tags WHERE id = ?'),
    sugg: db.prepare('SELECT * FROM asset_suggestions WHERE id = ?'),
    setStatus: db.prepare("UPDATE asset_suggestions SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'"),
    sameTagPending: db.prepare("SELECT id FROM asset_suggestions WHERE asset_id = ? AND tag_id = ? AND status = 'pending'"),
    otherPurposePending: db.prepare(`SELECT s.id FROM asset_suggestions s JOIN tags t ON t.id = s.tag_id
      WHERE s.asset_id = ? AND t.parent_id = ? AND s.tag_id <> ? AND s.status = 'pending'`),
    insAiTag: db.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'ai', ?)"),
    actionsFor: db.prepare('SELECT * FROM tag_actions WHERE tag_id = ? AND enabled = 1 ORDER BY id'),
    action: db.prepare('SELECT * FROM tag_actions WHERE id = ?'),
    event: db.prepare('SELECT * FROM events WHERE id = ?'),
    undone: db.prepare("SELECT 1 FROM events WHERE action = 'suggestions.undo' AND json_extract(payload_json, '$.event_id') = ?"),
  };

  /** Full "a/b/c" path of a tag id. */
  function tagPath(id) {
    const segs = [];
    for (let t = q.tag.get(id); t; t = t.parent_id == null ? null : q.tag.get(t.parent_id)) segs.unshift(t.name);
    return segs.join('/');
  }

  /** Loads suggestions by id; 404 for unknown, 409 for any that is not pending. */
  function pendingRows(ids) {
    const rows = ids.map((id) => q.sugg.get(id));
    const missing = ids.filter((id, i) => !rows[i]);
    if (missing.length) throw bad(`unknown suggestion ids: ${missing.slice(0, 5).join(', ')}`, 404);
    const decided = rows.filter((r) => r.status !== 'pending');
    if (decided.length) {
      throw bad(`only pending suggestions can be decided; already decided: ${decided.slice(0, 5)
        .map((r) => `#${r.id}=${r.status}`).join(', ')}`, 409);
    }
    return rows;
  }

  // ---- suggestions ---------------------------------------------------------

  /** Pending suggestions of one asset, highest confidence first. */
  function listSuggestions(assetId) {
    if (!q.asset.get(Number(assetId))) throw bad('asset not found', 404);
    return db.prepare(`SELECT id, asset_id, tag_id, stage, model, confidence, reason, created_at
      FROM asset_suggestions WHERE asset_id = ? AND status = 'pending' ORDER BY confidence DESC, id`)
      .all(Number(assetId)).map((r) => ({ ...r, tag_path: tagPath(r.tag_id) }));
  }

  /**
   * Accepts pending suggestions: writes asset_tags(source='ai'), cascades to
   * same-tag suggestions of other stages, supersedes other purpose/* pending
   * suggestions (purpose is single-choice), and runs the tag's enabled actions.
   */
  function acceptSuggestions(rawIds) {
    const ids = idList(rawIds);
    const purposeRoot = tagIdByPath(db, 'purpose');
    return tx(db, () => {
      const rows = pendingRows(ids);
      const pairs = new Map();
      for (const r of rows) pairs.set(`${r.asset_id}:${r.tag_id}`, { asset_id: r.asset_id, tag_id: r.tag_id });
      const purposeByAsset = new Map();
      for (const p of pairs.values()) {
        if (purposeRoot == null || q.tag.get(p.tag_id)?.parent_id !== purposeRoot) continue;
        const seen = purposeByAsset.get(p.asset_id);
        if (seen != null && seen !== p.tag_id) throw bad(`asset #${p.asset_id}: cannot accept two purpose tags at once (purpose is single-choice)`);
        purposeByAsset.set(p.asset_id, p.tag_id);
      }

      const ts = now();
      const undo = { op: 'suggestions.accept', statuses: [], asset_tags: [], album_items: [], albums_created: [] };
      const setStatus = (id, next) => {
        if (q.setStatus.run(next, ts, id).changes) undo.statuses.push([id, 'pending', next]);
      };
      const run = createActionRunner(db, undo, ts);
      const actions = [];

      for (const r of rows) setStatus(r.id, 'accepted');
      for (const { asset_id, tag_id } of pairs.values()) {
        if (q.insAiTag.run(asset_id, tag_id, ts).changes) undo.asset_tags.push([asset_id, tag_id]);
        for (const s of q.sameTagPending.all(asset_id, tag_id)) setStatus(s.id, 'accepted');
        if (purposeRoot != null && purposeByAsset.get(asset_id) === tag_id) {
          for (const s of q.otherPurposePending.all(asset_id, purposeRoot, tag_id)) setStatus(s.id, 'superseded');
        }
        for (const a of q.actionsFor.all(tag_id)) {
          const out = run(a, asset_id);
          actions.push({ kind: a.kind, target: a.target, asset_id, result: out.result, ...(out.created ? { created: true } : {}) });
        }
      }

      const count = (s) => undo.statuses.filter((x) => x[2] === s).length;
      const summary = { accepted: count('accepted'), superseded: count('superseded'), tagsAdded: undo.asset_tags.length };
      logEvent(db, 'suggestions.accept', { ids, ...summary, actions: actions.length }, undo);
      return { ...summary, actions, event_id: lastId(db) };
    });
  }

  /** Rejects pending suggestions; asset_tags are never touched. */
  function rejectSuggestions(rawIds) {
    const ids = idList(rawIds);
    return tx(db, () => {
      pendingRows(ids);
      const ts = now();
      const undo = { op: 'suggestions.reject', statuses: [] };
      for (const id of ids) if (q.setStatus.run('rejected', ts, id).changes) undo.statuses.push([id, 'pending', 'rejected']);
      logEvent(db, 'suggestions.reject', { ids, rejected: undo.statuses.length }, undo);
      return { rejected: undo.statuses.length, event_id: lastId(db) };
    });
  }

  /**
   * Reverses one accept/reject event exactly, at most once. Status rows are
   * restored only if they still hold the state this decision set; tags are
   * removed only if still source='ai'; created albums are removed only if empty.
   */
  function undoDecision(eventId) {
    const id = Number(eventId);
    if (!Number.isInteger(id) || id <= 0) throw bad('event_id must be a positive integer');
    return tx(db, () => {
      const ev = q.event.get(id);
      if (!ev) throw bad('event not found', 404);
      if (!['suggestions.accept', 'suggestions.reject'].includes(ev.action)) throw bad(`event #${id} is not a suggestion decision`);
      if (q.undone.get(id)) throw bad(`event #${id} has already been undone`, 409);
      const undo = JSON.parse(ev.undo_json ?? '{}');
      const out = { statuses: 0, statuses_skipped: 0, tags_removed: 0, tags_kept: 0, album_items_removed: 0, albums_removed: 0, albums_kept: 0 };
      const restore = db.prepare('UPDATE asset_suggestions SET status = ?, decided_at = NULL WHERE id = ? AND status = ?');
      for (const [sid, prev, next] of undo.statuses ?? []) {
        if (restore.run(prev, sid, next).changes) out.statuses++; else out.statuses_skipped++;
      }
      const delTag = db.prepare("DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ? AND source = 'ai'");
      for (const [a, t] of undo.asset_tags ?? []) {
        if (delTag.run(a, t).changes) out.tags_removed++; else out.tags_kept++;
      }
      const delItem = db.prepare('DELETE FROM album_items WHERE album_id = ? AND asset_id = ?');
      for (const [al, a] of undo.album_items ?? []) out.album_items_removed += Number(delItem.run(al, a).changes);
      for (const al of undo.albums_created ?? []) {
        if (db.prepare('SELECT 1 FROM album_items WHERE album_id = ? LIMIT 1').get(al)) { out.albums_kept++; continue; }
        out.albums_removed += Number(db.prepare('DELETE FROM albums WHERE id = ?').run(al).changes);
      }
      logEvent(db, 'suggestions.undo', { event_id: id, action: ev.action, ...out });
      return { ...out, event_id: lastId(db) };
    });
  }

  // ---- tag actions ---------------------------------------------------------

  const withPath = (a) => ({ ...a, enabled: !!a.enabled, is_seed: !!a.is_seed, tag_path: tagPath(a.tag_id) });

  function listTagActions() {
    return db.prepare('SELECT * FROM tag_actions ORDER BY tag_id, id').all().map(withPath);
  }

  /** Validates a full action spec; returns the cleaned values. */
  function cleanAction({ tag_id, kind, target, enabled }) {
    if (!q.tag.get(Number(tag_id))) throw bad('tag not found', 404);
    if (!ACTION_KINDS.includes(kind)) {
      throw bad(`kind must be one of: ${ACTION_KINDS.join(', ')} (trash / status-changing actions are not allowed)`);
    }
    if (typeof target !== 'string' || !target.trim()) throw bad('target is required');
    const t = target.trim();
    if (t.length > MAX_TARGET) throw bad(`target too long (max ${MAX_TARGET})`);
    if (kind === 'tag' && tagIdByPath(db, t) == null) throw bad(`target tag not found: ${t}`);
    return { tag_id: Number(tag_id), kind, target: t, enabled: enabled === undefined ? 1 : (enabled ? 1 : 0) };
  }

  function assertUnique(a, selfId = null) {
    const clash = db.prepare('SELECT id FROM tag_actions WHERE tag_id = ? AND kind = ? AND target = ?').get(a.tag_id, a.kind, a.target);
    if (clash && clash.id !== selfId) throw bad('an identical action already exists for this tag', 409);
  }

  function createTagAction(input = {}) {
    const a = cleanAction(input);
    assertUnique(a);
    db.prepare('INSERT INTO tag_actions (tag_id, kind, target, enabled, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(a.tag_id, a.kind, a.target, a.enabled, now());
    const created = q.action.get(lastId(db));
    logEvent(db, 'tag_action.create', { id: created.id, tag_id: a.tag_id, kind: a.kind, target: a.target });
    return withPath(created);
  }

  function updateTagAction(id, input = {}) {
    const cur = q.action.get(Number(id));
    if (!cur) throw bad('tag action not found', 404);
    const pick = (k) => (input[k] === undefined ? cur[k] : input[k]);
    const a = cleanAction({ tag_id: pick('tag_id'), kind: pick('kind'), target: pick('target'), enabled: pick('enabled') });
    assertUnique(a, cur.id);
    db.prepare('UPDATE tag_actions SET tag_id = ?, kind = ?, target = ?, enabled = ? WHERE id = ?')
      .run(a.tag_id, a.kind, a.target, a.enabled, cur.id);
    logEvent(db, 'tag_action.update', { id: cur.id, ...a },
      { op: 'tag_action.update', id: cur.id, tag_id: cur.tag_id, kind: cur.kind, target: cur.target, enabled: cur.enabled });
    return withPath(q.action.get(cur.id));
  }

  function deleteTagAction(id) {
    const cur = q.action.get(Number(id));
    if (!cur) throw bad('tag action not found', 404);
    db.prepare('DELETE FROM tag_actions WHERE id = ?').run(cur.id);
    logEvent(db, 'tag_action.delete', { id: cur.id }, { op: 'tag_action.restore', action: cur });
    return { deleted: true };
  }

  return {
    listSuggestions, acceptSuggestions, rejectSuggestions, undoDecision,
    listTagActions, createTagAction, updateTagAction, deleteTagAction,
  };
}
