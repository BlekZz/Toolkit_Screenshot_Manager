import { logEvent, now, tx } from './db.mjs';
import { parseQuery, whereClause } from './query.mjs';

const bad = (msg, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const MAX_BATCH = 100000;

function cleanName(name, what) {
  if (typeof name !== 'string' || !name.trim()) throw bad(`${what} name is required`);
  const n = name.trim();
  if (n.length > 200) throw bad(`${what} name too long`);
  return n;
}

function cleanColor(color) {
  if (color == null || color === '') return null;
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw bad('color must be #rrggbb');
  return color.toLowerCase();
}

function idList(ids, what = 'asset_ids') {
  if (!Array.isArray(ids) || !ids.length) throw bad(`${what} must be a non-empty array`);
  if (ids.length > MAX_BATCH) throw bad(`${what}: at most ${MAX_BATCH}`);
  const out = [...new Set(ids.map(Number))];
  if (out.some((n) => !Number.isInteger(n) || n <= 0)) throw bad(`${what} must be positive integers`);
  return out;
}

/** Runs fn over ids in chunks small enough for SQLite's parameter limit. */
function chunked(ids, size, fn) {
  for (let i = 0; i < ids.length; i += size) fn(ids.slice(i, i + size));
}

/**
 * Catalogue operations (tags, albums, folders, smart albums, assignment,
 * queries, facets) over one library database.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createCatalog(db) {
  const q = {
    tag: db.prepare('SELECT * FROM tags WHERE id = ?'),
    tagChild: db.prepare('SELECT id FROM tags WHERE COALESCE(parent_id, 0) = ? AND name = ?'),
    album: db.prepare('SELECT * FROM albums WHERE id = ?'),
    folder: db.prepare('SELECT * FROM album_folders WHERE id = ?'),
    smart: db.prepare('SELECT * FROM smart_albums WHERE id = ?'),
    subtree: db.prepare(`WITH RECURSIVE s(id) AS (SELECT ? UNION ALL SELECT t.id FROM tags t JOIN s ON t.parent_id = s.id)
      SELECT id FROM s`),
    folderSubtree: db.prepare(`WITH RECURSIVE s(id) AS (SELECT ? UNION ALL SELECT f.id FROM album_folders f JOIN s ON f.parent_id = s.id)
      SELECT id FROM s`),
  };

  const tagSubtree = (id) => q.subtree.all(id).map((r) => r.id);

  function requireRow(stmt, id, what) {
    const row = stmt.get(Number(id));
    if (!row) throw bad(`${what} not found`, 404);
    return row;
  }

  function existingAssets(ids) {
    const found = new Set();
    chunked(ids, 900, (part) => {
      for (const r of db.prepare(`SELECT id FROM assets WHERE id IN (${part.map(() => '?').join(',')})`).all(...part)) found.add(r.id);
    });
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw bad(`unknown asset ids: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`, 404);
  }

  // ---- query ---------------------------------------------------------------

  /** Path "a/b/c" → id of the exact node, or [] if any segment is missing. */
  function resolveTagPath(path) {
    let parent = 0;
    let id = null;
    for (const seg of path.split('/').map((s) => s.trim()).filter(Boolean)) {
      const row = q.tagChild.get(parent, seg);
      if (!row) return [];
      id = row.id;
      parent = id;
    }
    return id == null ? [] : [id];
  }

  const resolver = {
    resolveTag: resolveTagPath,
    resolveAlbum: (name) => db.prepare('SELECT id FROM albums WHERE name = ?').all(name).map((r) => r.id),
    resolveSmart: (name) => db.prepare('SELECT id FROM smart_albums WHERE name = ?').all(name).map((r) => r.id),
  };

  const compileCtx = {
    tagSubtree,
    smartAst: (id) => {
      const row = q.smart.get(id);
      return row ? JSON.parse(row.query_json) : null;
    },
  };

  /** Accepts {ast} or {q: string} (or both, ANDed). */
  function toAst({ ast, q: text } = {}) {
    const parts = [];
    if (ast) parts.push(ast);
    if (typeof text === 'string' && text.trim()) parts.push(parseQuery(text, resolver));
    if (!parts.length) return { op: 'all' };
    return parts.length === 1 ? parts[0] : { op: 'and', args: parts };
  }

  const SORTS = { imported: 'a.imported_at', mtime: 'a.file_mtime', name: 'a.filename COLLATE NOCASE' };

  function query(input = {}) {
    const ast = toAst(input);
    const { sql, params } = whereClause(ast, compileCtx);
    const order = input.order === 'asc' ? 'ASC' : 'DESC';
    let orderBy;
    if (input.sort === 'album' && Number.isInteger(input.album_id)) {
      orderBy = `(SELECT position FROM album_items p WHERE p.album_id = ${Number(input.album_id)} AND p.asset_id = a.id) ${order}, a.id ${order}`;
    } else {
      orderBy = `${SORTS[input.sort] ?? SORTS.imported} ${order}, a.id ${order}`;
    }
    const ids = db.prepare(`SELECT a.id FROM assets a WHERE ${sql} ORDER BY ${orderBy}`).all(...params).map((r) => r.id);
    return { total: ids.length, ids, ast };
  }

  /** Per-tag (subtree-rolled-up) and per-album counts within the query result. */
  function facets(input = {}) {
    const { sql, params } = whereClause(toAst(input), compileCtx);
    const scope = `SELECT a.id FROM assets a WHERE ${sql}`;
    const tags = db.prepare(`WITH RECURSIVE clo(anc, des) AS (
        SELECT id, id FROM tags UNION ALL SELECT clo.anc, t.id FROM clo JOIN tags t ON t.parent_id = clo.des)
      SELECT clo.anc AS id, count(DISTINCT at.asset_id) AS n
      FROM clo JOIN asset_tags at ON at.tag_id = clo.des
      WHERE at.asset_id IN (${scope}) GROUP BY clo.anc`).all(...params);
    const albums = db.prepare(`SELECT album_id AS id, count(*) AS n FROM album_items
      WHERE asset_id IN (${scope}) GROUP BY album_id`).all(...params);
    const total = db.prepare(`SELECT count(*) AS n FROM (${scope})`).get(...params).n;
    return {
      total,
      tags: Object.fromEntries(tags.map((r) => [r.id, r.n])),
      albums: Object.fromEntries(albums.map((r) => [r.id, r.n])),
    };
  }

  // ---- tags ----------------------------------------------------------------

  function listTags() {
    return db.prepare(`SELECT t.id, t.parent_id, t.name, t.color, t.is_system,
        (SELECT count(*) FROM asset_tags at JOIN assets a ON a.id = at.asset_id
          WHERE at.tag_id = t.id AND a.status = 'active') AS direct_count
      FROM tags t ORDER BY t.is_system DESC, t.name COLLATE NOCASE`).all().map((r) => ({ ...r, is_system: !!r.is_system }));
  }

  /** Creates a tag; `name` may be a path "a/b/c" which creates missing ancestors. */
  function createTag({ name, parent_id = null, color = null }) {
    const segs = cleanName(name, 'tag').split('/').map((s) => s.trim()).filter(Boolean);
    if (!segs.length) throw bad('tag name is required');
    if (parent_id != null) requireRow(q.tag, parent_id, 'parent tag');
    return tx(db, () => {
      let parent = parent_id == null ? null : Number(parent_id);
      let created = false;
      for (const [i, seg] of segs.entries()) {
        const existing = q.tagChild.get(parent ?? 0, seg);
        if (existing) { parent = existing.id; continue; }
        const last = i === segs.length - 1;
        const { lastInsertRowid } = db.prepare('INSERT INTO tags (parent_id, name, color) VALUES (?, ?, ?)')
          .run(parent, seg, last ? cleanColor(color) : null);
        parent = Number(lastInsertRowid);
        created = true;
      }
      if (created) logEvent(db, 'tag.create', { id: parent, name });
      return { ...q.tag.get(parent), created };
    });
  }

  function updateTag(id, { name, color, parent_id }) {
    const tag = requireRow(q.tag, id, 'tag');
    if (tag.is_system) throw bad('system tags cannot be modified', 403);
    const next = { name: tag.name, color: tag.color, parent_id: tag.parent_id };
    if (name !== undefined) {
      next.name = cleanName(name, 'tag');
      if (next.name.includes('/')) throw bad('tag name cannot contain "/" (use parent_id to nest)');
    }
    if (color !== undefined) next.color = cleanColor(color);
    if (parent_id !== undefined) {
      next.parent_id = parent_id == null ? null : Number(parent_id);
      if (next.parent_id != null) {
        requireRow(q.tag, next.parent_id, 'parent tag');
        if (tagSubtree(tag.id).includes(next.parent_id)) throw bad('cannot move a tag under itself');
      }
    }
    const clash = q.tagChild.get(next.parent_id ?? 0, next.name);
    if (clash && clash.id !== tag.id) throw bad('a sibling tag with this name already exists', 409);
    db.prepare('UPDATE tags SET name = ?, color = ?, parent_id = ? WHERE id = ?').run(next.name, next.color, next.parent_id, tag.id);
    logEvent(db, 'tag.update', { id: tag.id, ...next }, { op: 'tag.update', id: tag.id, name: tag.name, color: tag.color, parent_id: tag.parent_id });
    return q.tag.get(tag.id);
  }

  function deleteTag(id) {
    const tag = requireRow(q.tag, id, 'tag');
    const subtree = tagSubtree(tag.id);
    const marks = subtree.map(() => '?').join(',');
    if (db.prepare(`SELECT 1 FROM tags WHERE id IN (${marks}) AND is_system = 1`).get(...subtree)) {
      throw bad('system tags cannot be deleted', 403);
    }
    return tx(db, () => {
      const tags = db.prepare(`SELECT * FROM tags WHERE id IN (${marks})`).all(...subtree);
      const links = db.prepare(`SELECT * FROM asset_tags WHERE tag_id IN (${marks})`).all(...subtree);
      db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id); // children + links cascade
      logEvent(db, 'tag.delete', { id: tag.id, name: tag.name, subtree: subtree.length, links: links.length },
        { op: 'tag.restore', tags, links });
      return { deleted_tags: subtree.length, removed_links: links.length };
    });
  }

  /** Adds / removes tags on many assets in one transaction. */
  function applyTags({ asset_ids, add = [], remove = [] }) {
    const ids = idList(asset_ids);
    const addIds = add.length ? idList(add, 'add') : [];
    const removeIds = remove.length ? idList(remove, 'remove') : [];
    if (!addIds.length && !removeIds.length) throw bad('nothing to add or remove');
    for (const t of [...addIds, ...removeIds]) requireRow(q.tag, t, `tag #${t}`);
    existingAssets(ids);
    return tx(db, () => {
      const ins = db.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'manual', ?)");
      const del = db.prepare('DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?');
      const ts = now();
      let added = 0;
      let removed = 0;
      const undoAdd = [];
      const undoRemove = [];
      for (const a of ids) {
        for (const t of addIds) if (ins.run(a, t, ts).changes) { added++; undoAdd.push([a, t]); }
        for (const t of removeIds) if (del.run(a, t).changes) { removed++; undoRemove.push([a, t]); }
      }
      logEvent(db, 'tags.apply', { assets: ids.length, add: addIds, remove: removeIds, added, removed },
        { op: 'tags.apply', added: undoAdd, removed: undoRemove });
      return { added, removed };
    });
  }

  // ---- album folders -------------------------------------------------------

  const listFolders = () => db.prepare('SELECT * FROM album_folders ORDER BY name COLLATE NOCASE').all();

  function createFolder({ name, parent_id = null }) {
    if (parent_id != null) requireRow(q.folder, parent_id, 'parent folder');
    const { lastInsertRowid } = db.prepare('INSERT INTO album_folders (parent_id, name) VALUES (?, ?)')
      .run(parent_id == null ? null : Number(parent_id), cleanName(name, 'folder'));
    logEvent(db, 'folder.create', { id: Number(lastInsertRowid), name });
    return q.folder.get(Number(lastInsertRowid));
  }

  function updateFolder(id, { name, parent_id }) {
    const f = requireRow(q.folder, id, 'folder');
    const next = { name: name === undefined ? f.name : cleanName(name, 'folder'), parent_id: f.parent_id };
    if (parent_id !== undefined) {
      next.parent_id = parent_id == null ? null : Number(parent_id);
      if (next.parent_id != null) {
        requireRow(q.folder, next.parent_id, 'parent folder');
        if (q.folderSubtree.all(f.id).some((r) => r.id === next.parent_id)) throw bad('cannot move a folder under itself');
      }
    }
    db.prepare('UPDATE album_folders SET name = ?, parent_id = ? WHERE id = ?').run(next.name, next.parent_id, f.id);
    logEvent(db, 'folder.update', { id: f.id, ...next });
    return q.folder.get(f.id);
  }

  /** Deletes a folder (and sub-folders); its albums move to the top level, never deleted. */
  function deleteFolder(id) {
    const f = requireRow(q.folder, id, 'folder');
    db.prepare('DELETE FROM album_folders WHERE id = ?').run(f.id);
    logEvent(db, 'folder.delete', { id: f.id, name: f.name });
    return { deleted: true };
  }

  // ---- albums --------------------------------------------------------------

  function listAlbums() {
    return db.prepare(`SELECT al.*, (SELECT count(*) FROM album_items i JOIN assets a ON a.id = i.asset_id
        WHERE i.album_id = al.id AND a.status = 'active') AS count,
        COALESCE(al.cover_asset_id, (SELECT i.asset_id FROM album_items i WHERE i.album_id = al.id
          ORDER BY i.position LIMIT 1)) AS cover_id
      FROM albums al ORDER BY al.name COLLATE NOCASE`).all();
  }

  function createAlbum({ name, folder_id = null }) {
    if (folder_id != null) requireRow(q.folder, folder_id, 'folder');
    const { lastInsertRowid } = db.prepare('INSERT INTO albums (folder_id, name, created_at) VALUES (?, ?, ?)')
      .run(folder_id == null ? null : Number(folder_id), cleanName(name, 'album'), now());
    logEvent(db, 'album.create', { id: Number(lastInsertRowid), name });
    return q.album.get(Number(lastInsertRowid));
  }

  function updateAlbum(id, { name, folder_id, cover_asset_id }) {
    const al = requireRow(q.album, id, 'album');
    const next = { name: al.name, folder_id: al.folder_id, cover_asset_id: al.cover_asset_id };
    if (name !== undefined) next.name = cleanName(name, 'album');
    if (folder_id !== undefined) {
      next.folder_id = folder_id == null ? null : Number(folder_id);
      if (next.folder_id != null) requireRow(q.folder, next.folder_id, 'folder');
    }
    if (cover_asset_id !== undefined) {
      next.cover_asset_id = cover_asset_id == null ? null : Number(cover_asset_id);
      if (next.cover_asset_id != null) existingAssets([next.cover_asset_id]);
    }
    db.prepare('UPDATE albums SET name = ?, folder_id = ?, cover_asset_id = ? WHERE id = ?')
      .run(next.name, next.folder_id, next.cover_asset_id, al.id);
    logEvent(db, 'album.update', { id: al.id, ...next }, { op: 'album.update', id: al.id, name: al.name, folder_id: al.folder_id, cover_asset_id: al.cover_asset_id });
    return q.album.get(al.id);
  }

  /** Deletes the album only — photos stay in the library. */
  function deleteAlbum(id) {
    const al = requireRow(q.album, id, 'album');
    return tx(db, () => {
      const items = db.prepare('SELECT * FROM album_items WHERE album_id = ?').all(al.id);
      db.prepare('DELETE FROM albums WHERE id = ?').run(al.id);
      logEvent(db, 'album.delete', { id: al.id, name: al.name, items: items.length }, { op: 'album.restore', album: al, items });
      return { removed_items: items.length };
    });
  }

  function addToAlbum(albumId, assetIds) {
    const al = requireRow(q.album, albumId, 'album');
    const ids = idList(assetIds);
    existingAssets(ids);
    return tx(db, () => {
      let pos = db.prepare('SELECT COALESCE(max(position), 0) AS p FROM album_items WHERE album_id = ?').get(al.id).p;
      const ins = db.prepare('INSERT OR IGNORE INTO album_items (album_id, asset_id, position, added_at) VALUES (?, ?, ?, ?)');
      const ts = now();
      const added = [];
      for (const a of ids) if (ins.run(al.id, a, ++pos, ts).changes) added.push(a);
      logEvent(db, 'album.add', { album_id: al.id, requested: ids.length, added: added.length },
        { op: 'album.remove', album_id: al.id, asset_ids: added });
      return { added: added.length };
    });
  }

  function removeFromAlbum(albumId, assetIds) {
    const al = requireRow(q.album, albumId, 'album');
    const ids = idList(assetIds);
    return tx(db, () => {
      const del = db.prepare('DELETE FROM album_items WHERE album_id = ? AND asset_id = ? RETURNING position');
      const removed = [];
      for (const a of ids) {
        const row = del.get(al.id, a);
        if (row) removed.push([a, row.position]);
      }
      logEvent(db, 'album.remove', { album_id: al.id, requested: ids.length, removed: removed.length },
        { op: 'album.add', album_id: al.id, items: removed });
      return { removed: removed.length };
    });
  }

  /** Moves assets to a new position: placed (in given order) before `before_asset_id`, or at the end. */
  function reorderAlbum(albumId, { asset_ids, before_asset_id = null }) {
    const al = requireRow(q.album, albumId, 'album');
    const ids = idList(asset_ids);
    return tx(db, () => {
      const order = db.prepare('SELECT asset_id FROM album_items WHERE album_id = ? ORDER BY position').all(al.id).map((r) => r.asset_id);
      const moving = new Set(ids);
      const inAlbum = new Set(order);
      const missing = ids.filter((id) => !inAlbum.has(id));
      if (missing.length) throw bad(`assets not in album: ${missing.slice(0, 5).join(', ')}`);
      const rest = order.filter((id) => !moving.has(id));
      let at = before_asset_id == null ? rest.length : rest.indexOf(Number(before_asset_id));
      if (at < 0) throw bad('before_asset_id is not in the album (or is being moved)');
      rest.splice(at, 0, ...ids);
      const upd = db.prepare('UPDATE album_items SET position = ? WHERE album_id = ? AND asset_id = ?');
      rest.forEach((id, i) => upd.run(i + 1, al.id, id));
      logEvent(db, 'album.reorder', { album_id: al.id, moved: ids.length });
      return { ok: true };
    });
  }

  // ---- smart albums --------------------------------------------------------

  const listSmart = () => db.prepare('SELECT * FROM smart_albums ORDER BY name COLLATE NOCASE').all()
    .map((s) => ({ ...s, query: JSON.parse(s.query_json), query_json: undefined }));

  function validateSmart(ast, selfId = null) {
    // Compiling proves the AST is well-formed and references resolve; smart:self would loop.
    const probe = { ...compileCtx, smartAst: (id) => (id === selfId ? null : compileCtx.smartAst(id)) };
    whereClause(ast, probe);
  }

  function createSmart({ name, ast, q: text, folder_id = null }) {
    const query = toAst({ ast, q: text });
    validateSmart(query);
    const { lastInsertRowid } = db.prepare('INSERT INTO smart_albums (folder_id, name, query_json, created_at) VALUES (?, ?, ?, ?)')
      .run(folder_id == null ? null : Number(folder_id), cleanName(name, 'smart album'), JSON.stringify(query), now());
    logEvent(db, 'smart.create', { id: Number(lastInsertRowid), name });
    return listSmart().find((s) => s.id === Number(lastInsertRowid));
  }

  function updateSmart(id, { name, ast, q: text, folder_id }) {
    const s = requireRow(q.smart, id, 'smart album');
    const next = { name: s.name, query_json: s.query_json, folder_id: s.folder_id };
    if (name !== undefined) next.name = cleanName(name, 'smart album');
    if (ast !== undefined || text !== undefined) {
      const query = toAst({ ast, q: text });
      validateSmart(query, s.id);
      next.query_json = JSON.stringify(query);
    }
    if (folder_id !== undefined) next.folder_id = folder_id == null ? null : Number(folder_id);
    db.prepare('UPDATE smart_albums SET name = ?, query_json = ?, folder_id = ? WHERE id = ?')
      .run(next.name, next.query_json, next.folder_id, s.id);
    logEvent(db, 'smart.update', { id: s.id, name: next.name });
    return listSmart().find((x) => x.id === s.id);
  }

  function deleteSmart(id) {
    const s = requireRow(q.smart, id, 'smart album');
    const refersTo = (node) => node && typeof node === 'object' && (
      (node.op === 'smart' && Number(node.id) === s.id)
      || (Array.isArray(node.args) && node.args.some(refersTo))
      || refersTo(node.arg));
    const users = listSmart().filter((o) => o.id !== s.id && refersTo(o.query)).map((o) => o.name);
    if (users.length) throw bad(`smart album is used by: ${users.join(', ')}`, 409);
    db.prepare('DELETE FROM smart_albums WHERE id = ?').run(s.id);
    logEvent(db, 'smart.delete', { id: s.id, name: s.name, query_json: s.query_json });
    return { deleted: true };
  }

  // ---- per-asset membership ------------------------------------------------

  function assetMembership(assetId) {
    return {
      tags: db.prepare('SELECT tag_id AS id, source FROM asset_tags WHERE asset_id = ?').all(assetId),
      albums: db.prepare('SELECT album_id AS id FROM album_items WHERE asset_id = ?').all(assetId).map((r) => r.id),
    };
  }

  return {
    query, facets, toAst,
    listTags, createTag, updateTag, deleteTag, applyTags,
    listFolders, createFolder, updateFolder, deleteFolder,
    listAlbums, createAlbum, updateAlbum, deleteAlbum, addToAlbum, removeFromAlbum, reorderAlbum,
    listSmart, createSmart, updateSmart, deleteSmart,
    assetMembership,
  };
}
