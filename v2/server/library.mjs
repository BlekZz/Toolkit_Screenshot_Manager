import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, now } from './db.mjs';

export const MANAGED_ROOT = 'originals';

/**
 * Resolves the library directory: explicit arg > PHOTO_LIBRARY env > ~/PhotoLibrary.
 *
 * @param {string} [explicit]
 * @returns {string} Absolute library directory.
 */
export function resolveLibraryDir(explicit) {
  return path.resolve(explicit || process.env.PHOTO_LIBRARY || path.join(os.homedir(), 'PhotoLibrary'));
}

/**
 * Creates the library layout if missing and opens its database.
 *
 * @param {string} dir Absolute library directory.
 * @returns {{dir: string, db: import('node:sqlite').DatabaseSync, managedRootId: number,
 *   originalsDir: string, thumbsDir: string}}
 */
export function openLibrary(dir) {
  const originalsDir = path.join(dir, MANAGED_ROOT);
  const thumbsDir = path.join(dir, 'thumbs');
  for (const d of [dir, originalsDir, thumbsDir, path.join(dir, 'exports')]) fs.mkdirSync(d, { recursive: true });

  const db = openDb(path.join(dir, 'library.db'));
  db.prepare("INSERT OR IGNORE INTO library_roots (path, mode, created_at) VALUES (?, 'managed', ?)")
    .run(MANAGED_ROOT, now());
  const managedRootId = db.prepare("SELECT id FROM library_roots WHERE path = ? AND mode = 'managed'")
    .get(MANAGED_ROOT).id;

  return { dir, db, managedRootId, originalsDir, thumbsDir };
}

/**
 * Absolute file path of an asset row.
 *
 * @param {ReturnType<typeof openLibrary>} lib
 * @param {{root_id: number, rel_path: string}} asset
 * @returns {string}
 */
export function assetFilePath(lib, asset) {
  const root = lib.db.prepare('SELECT path, mode FROM library_roots WHERE id = ?').get(asset.root_id);
  const base = root.mode === 'managed' ? path.join(lib.dir, root.path) : root.path;
  return path.join(base, ...asset.rel_path.split('/'));
}
