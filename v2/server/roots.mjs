import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { logEvent, now, tx } from './db.mjs';
import { SUPPORTED_EXT, UNSUPPORTED_IMAGE_EXT, sha256File } from './importer.mjs';
import { assetFilePath } from './library.mjs';
import { ensureThumb } from './thumbs.mjs';

/*
 * Referenced ("in-place") library roots (Sprint §1.1 D1, §4).
 *
 * Invariant: this module only ever READS inside a referenced root. Every write
 * goes to library.db or the library's own thumbs/ cache. There is no code path
 * here that creates, moves, renames or deletes a file under a root.
 */

const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });

/** True when child is parent itself or lies underneath it (case-insensitive on Windows). */
function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

/** Absolute directory of a root row. */
function rootDir(lib, root) {
  return root.mode === 'managed' ? path.join(lib.dir, root.path) : root.path;
}

/**
 * Lists every library root with its asset counts per status.
 *
 * @param {ReturnType<import('./library.mjs').openLibrary>} lib
 * @returns {{id: number, path: string, mode: string, created_at: string, abs_path: string,
 *   counts: {active: number, trashed: number, missing: number}}[]}
 */
export function listRoots(lib) {
  const roots = lib.db.prepare('SELECT id, path, mode, created_at FROM library_roots ORDER BY id').all();
  const counts = lib.db.prepare('SELECT root_id, status, count(*) AS n FROM assets GROUP BY root_id, status').all();
  return roots.map((r) => {
    const c = { active: 0, trashed: 0, missing: 0 };
    for (const row of counts) if (row.root_id === r.id) c[row.status] = row.n;
    return { ...r, abs_path: rootDir(lib, r), counts: c };
  });
}

/**
 * Registers an existing folder as a referenced root (files stay where they are).
 *
 * @param {ReturnType<import('./library.mjs').openLibrary>} lib
 * @param {string} absPath Absolute directory.
 * @returns {{id: number, path: string, mode: 'referenced', created_at: string}}
 * @throws {Error} `.statusCode = 400` when the path is relative, not a directory,
 *   inside/containing the library, or inside/containing an existing root.
 */
export function addRoot(lib, absPath) {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) throw bad('path must be an absolute directory');
  const resolved = path.resolve(absPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw bad(`not a directory: ${resolved}`);
  const real = fs.realpathSync.native(resolved);
  const libReal = fs.realpathSync.native(lib.dir);
  if (isWithin(libReal, real)) throw bad('root cannot be inside the library directory');
  if (isWithin(real, libReal)) throw bad('root cannot contain the library directory');
  for (const r of lib.db.prepare('SELECT id, path, mode FROM library_roots').all()) {
    const other = rootDir(lib, r);
    if (isWithin(other, real) || isWithin(real, other)) throw bad(`overlaps existing root #${r.id}: ${other}`);
  }
  const createdAt = now();
  const { lastInsertRowid } = lib.db.prepare("INSERT INTO library_roots (path, mode, created_at) VALUES (?, 'referenced', ?)")
    .run(real, createdAt);
  const id = Number(lastInsertRowid);
  logEvent(lib.db, 'root_add', { root_id: id, path: real });
  return { id, path: real, mode: 'referenced', created_at: createdAt };
}

/** Recursively lists regular files under dir (relative, forward slashes), sorted. */
function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** rel_path value that frees a (root_id, rel_path) slot while keeping the original for audit. ':' cannot occur in a Windows filename. */
const tombstone = (id, rel) => `:missing:${id}:${rel}`;

/**
 * Rescans a referenced root, reconciling the DB with what is on disk.
 *
 * Per file (sha256): unknown → add a referenced asset (no copy) + 256px thumb in
 * the library; known and its recorded location no longer holds it → relink
 * (root_id/rel_path/filename/ext; missing → active, trashed stays trashed; all
 * tags/albums/crops kept since the row id never changes); known and still at its
 * recorded location → duplicate (skipped). Afterwards active rows of this root
 * whose file is gone are marked `missing` (metadata kept). All DB writes happen
 * in one transaction; dryRun computes the same plan and writes nothing.
 *
 * @param {ReturnType<import('./library.mjs').openLibrary>} lib
 * @param {number} rootId
 * @param {{dryRun?: boolean, onProgress?: (p: object) => void}} [opts]
 * @returns {Promise<{root_id: number, dry_run: boolean, scanned: number, added: number, relinked: number,
 *   duplicates: number, missing: number, revived: number, unchanged: number, unsupported: number,
 *   errors: {file: string, error: string}[]}>}
 */
export async function scanRoot(lib, rootId, { dryRun = false, onProgress } = {}) {
  const root = lib.db.prepare('SELECT * FROM library_roots WHERE id = ?').get(rootId);
  if (!root) throw Object.assign(new Error('root not found'), { statusCode: 404 });
  if (root.mode !== 'referenced') throw bad('only referenced roots can be scanned');
  const dir = root.path;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw bad(`root directory unavailable: ${dir}`);

  const result = { root_id: rootId, dry_run: Boolean(dryRun), scanned: 0, added: 0, relinked: 0, duplicates: 0,
    missing: 0, revived: 0, unchanged: 0, unsupported: 0, errors: [] };

  // ---- pass 1: hash everything on disk (read-only) ----
  const candidates = [];
  for (const rel of walk(dir).sort((a, b) => a.localeCompare(b))) {
    const ext = path.extname(rel).toLowerCase();
    if (SUPPORTED_EXT.has(ext)) candidates.push(rel);
    else if (UNSUPPORTED_IMAGE_EXT.has(ext)) result.unsupported++;
  }
  result.scanned = candidates.length;
  /** rel → sha256 for every readable candidate. */
  const onDisk = new Map();
  let done = 0;
  for (const rel of candidates) {
    try { onDisk.set(rel, await sha256File(path.join(dir, ...rel.split('/')))); }
    catch (err) { result.errors.push({ file: rel, error: err.message }); }
    onProgress?.({ phase: 'hash', done: ++done, total: candidates.length });
  }

  // ---- pass 2: plan ----
  const findSha = lib.db.prepare('SELECT * FROM assets WHERE sha256 = ?');
  const rowsHere = lib.db.prepare('SELECT * FROM assets WHERE root_id = ?').all(rootId);
  /** Does the row's recorded location still hold its content? */
  const stillThere = (row) => {
    if (row.root_id === rootId) return onDisk.get(row.rel_path) === row.sha256;
    if (row.status === 'missing') return false;
    const file = assetFilePath(lib, row);
    // Other roots are not rehashed (cost); existence + size is the check there.
    return fs.existsSync(file) && fs.statSync(file).size === row.bytes;
  };

  const adds = [];      // {rel, sha}
  const relinks = [];   // {row, rel}
  const revives = [];   // row
  /** sha256s already claimed by an add or relink in this scan (later copies are duplicates). */
  const claimedSha = new Set();
  for (const [rel, sha] of onDisk) {
    if (claimedSha.has(sha)) { result.duplicates++; continue; }
    const row = findSha.get(sha);
    if (!row) { claimedSha.add(sha); adds.push({ rel, sha }); continue; }
    // Content at its recorded home: order-independent of any copies elsewhere in the root.
    if (row.root_id === rootId && row.rel_path === rel) {
      if (row.status === 'missing') revives.push(row);
      else result.unchanged++;
      continue;
    }
    if (stillThere(row)) { result.duplicates++; continue; }
    claimedSha.add(sha);
    relinks.push({ row, rel });
  }

  // Rows of this root that keep their slot: content still at their rel_path.
  const relinkedIds = new Set(relinks.map((r) => r.row.id));
  const claimed = new Set([...adds.map((a) => a.rel), ...relinks.map((r) => r.rel)]);
  const gone = rowsHere.filter((row) => !relinkedIds.has(row.id) && onDisk.get(row.rel_path) !== row.sha256);
  const toMissing = gone.filter((row) => row.status === 'active');
  // A gone row whose rel_path is needed by an add/relink (file replaced in place / swapped) gets a tombstone path.
  const displaced = gone.filter((row) => claimed.has(row.rel_path));

  // Image metadata for new files (read-only, before the transaction).
  const addRows = [];
  for (const a of adds) {
    const file = path.join(dir, ...a.rel.split('/'));
    try {
      const stat = fs.statSync(file);
      const meta = await sharp(file).metadata();
      if (!meta.width || !meta.height) throw new Error('unreadable image dimensions');
      const swap = meta.orientation >= 5;
      addRows.push({ ...a, file, stat, width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height });
    } catch (err) {
      result.errors.push({ file: a.rel, error: err.message });
    }
  }

  result.added = addRows.length;
  result.relinked = relinks.length;
  result.revived = revives.length;
  result.missing = toMissing.length;

  if (dryRun) {
    onProgress?.({ phase: 'done', done, total: candidates.length });
    return result;
  }

  // ---- pass 3: apply (DB only) ----
  const setRel = lib.db.prepare('UPDATE assets SET rel_path = ? WHERE id = ?');
  const insert = lib.db.prepare(`INSERT INTO assets
    (root_id, rel_path, sha256, filename, ext, width, height, bytes, file_mtime, imported_at, source_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const added = [];
  tx(lib.db, () => {
    // Free every slot that is about to be reassigned, so swaps / in-place replacements never hit UNIQUE(root_id, rel_path).
    for (const { row } of relinks) setRel.run(`:relinking:${row.id}`, row.id);
    for (const row of displaced) setRel.run(tombstone(row.id, row.rel_path), row.id);
    for (const { row, rel } of relinks) {
      const filename = rel.split('/').pop();
      lib.db.prepare(`UPDATE assets SET root_id = ?, rel_path = ?, filename = ?, ext = ?,
          status = CASE status WHEN 'missing' THEN 'active' ELSE status END WHERE id = ?`)
        .run(rootId, rel, filename, path.extname(filename).toLowerCase().slice(1), row.id);
      logEvent(lib.db, 'relink', { asset_id: row.id, from: { root_id: row.root_id, rel_path: row.rel_path, status: row.status },
        to: { root_id: rootId, rel_path: rel } });
    }
    for (const row of revives) {
      lib.db.prepare("UPDATE assets SET status = 'active' WHERE id = ? AND status = 'missing'").run(row.id);
      logEvent(lib.db, 'revive', { asset_id: row.id, root_id: rootId, rel_path: row.rel_path });
    }
    for (const row of toMissing) {
      lib.db.prepare("UPDATE assets SET status = 'missing' WHERE id = ?").run(row.id);
      logEvent(lib.db, 'missing', { asset_id: row.id, root_id: rootId, rel_path: row.rel_path });
    }
    for (const a of addRows) {
      const filename = a.rel.split('/').pop();
      const { lastInsertRowid } = insert.run(rootId, a.rel, a.sha, filename, path.extname(filename).toLowerCase().slice(1),
        a.width, a.height, a.stat.size, a.stat.mtime.toISOString(), now(), a.file);
      added.push(a);
      logEvent(lib.db, 'import', { asset_id: Number(lastInsertRowid), root_id: rootId, rel_path: a.rel, referenced: true });
    }
    const { errors, ...counts } = result;
    logEvent(lib.db, 'root_scan', { ...counts, errors: errors.length });
  });

  // Thumbnails live in the library (content-addressed), never in the root.
  let t = 0;
  for (const a of added) {
    try { await ensureThumb(lib.thumbsDir, a.file, a.sha, 256); }
    catch (err) { result.errors.push({ file: a.rel, error: `thumbnail: ${err.message}` }); }
    onProgress?.({ phase: 'thumbs', done: ++t, total: added.length });
  }
  return result;
}
