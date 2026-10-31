import fs from 'node:fs';
import path from 'node:path';
import { logEvent, now, tx } from './db.mjs';
import { importFolder, sha256File, SUPPORTED_EXT } from './importer.mjs';
import { tagIdByPath } from './suggestions.mjs';

/**
 * Legacy tool folder → tags recording the decision made there (Sprint_Photo_Library_v2 P2.5).
 * Paths are relative to the legacy tool root.
 */
export const LEGACY_FOLDERS = [
  { dir: 'staging/keep', tags: ['migration/keep'] },
  { dir: 'staging/review-later', tags: ['migration/review-later', 'triage/later'] },
  { dir: 'staging/trash-candidate', tags: ['migration/trash-candidate'] },
  { dir: 'staging/extract-text', tags: ['migration/extract-text'] },
  { dir: 'staging/low-yield', tags: ['migration/low-yield'] },
  { dir: 'output/pending-delete', tags: ['migration/text-extracted'] },
  { dir: 'archive/originals', tags: ['migration/original'] },
];

function listImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return listImages(full);
    return e.isFile() && SUPPORTED_EXT.has(path.extname(e.name).toLowerCase()) ? [full] : [];
  });
}

/** Ensures a tag path exists (creating non-system nodes as needed) and returns its id. */
function ensureTag(db, tagPath) {
  const existing = tagIdByPath(db, tagPath);
  if (existing) return existing;
  let parent = null;
  for (const seg of tagPath.split('/')) {
    const row = db.prepare('SELECT id FROM tags WHERE COALESCE(parent_id, 0) = ? AND name = ?').get(parent ?? 0, seg);
    parent = row ? row.id : Number(db.prepare('INSERT INTO tags (parent_id, name, is_system) VALUES (?, ?, 0)').run(parent, seg).lastInsertRowid);
  }
  return parent;
}

/**
 * Imports the legacy tool's decided folders into the library and tags every
 * image with the decision its folder represents. Source files are never
 * moved or deleted. Idempotent: re-running imports nothing new and adds no tags.
 *
 * An image present in several folders (same SHA-256) is one asset carrying
 * every matching tag.
 *
 * @param {ReturnType<import('./library.mjs').openLibrary>} lib
 * @param {string} legacyRoot Absolute path of the legacy tool root.
 * @param {{dryRun?: boolean}} [opts] dryRun only counts files per folder.
 * @returns {Promise<{folders: {dir: string, files: number, imported: number, duplicates: number,
 *   tagged: number, errors: object[]}[]}>}
 */
export async function migrateLegacy(lib, legacyRoot, { dryRun = false } = {}) {
  const folders = [];
  for (const spec of LEGACY_FOLDERS) {
    const abs = path.join(legacyRoot, ...spec.dir.split('/'));
    const files = listImages(abs);
    const entry = { dir: spec.dir, files: files.length, imported: 0, duplicates: 0, tagged: 0, errors: [] };
    folders.push(entry);
    if (dryRun || !files.length) continue;

    const res = await importFolder(lib, abs, { recursive: true });
    entry.imported = res.imported;
    entry.duplicates = res.duplicates;
    entry.errors = res.errors;

    const shas = [];
    for (const f of files) shas.push(await sha256File(f));
    tx(lib.db, () => {
      const tagIds = spec.tags.map((t) => ensureTag(lib.db, t));
      const bySha = lib.db.prepare('SELECT id FROM assets WHERE sha256 = ?');
      const add = lib.db.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'migration', ?)");
      const ts = now();
      for (const sha of shas) {
        const asset = bySha.get(sha);
        if (!asset) continue; // import error, already reported
        for (const id of tagIds) entry.tagged += add.run(asset.id, id, ts).changes;
      }
      logEvent(lib.db, 'migrate_legacy', { dir: spec.dir, files: entry.files, imported: entry.imported, tagged: entry.tagged });
    });
  }
  return { folders };
}
