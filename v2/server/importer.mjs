import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { logEvent, now } from './db.mjs';

export const SUPPORTED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
/** Image formats we recognise but cannot ingest (sharp prebuilt lacks BMP; GIF/HEIC out of scope). */
export const UNSUPPORTED_IMAGE_EXT = new Set(['.bmp', '.gif', '.heic', '.heif', '.tif', '.tiff', '.avif']);

/**
 * Streams a file through SHA-256.
 *
 * @param {string} file
 * @returns {Promise<string>} Lowercase hex digest.
 */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Lists files under dir (recursively when asked), sorted for deterministic order.
 *
 * @param {string} dir
 * @param {boolean} recursive
 * @returns {string[]} Absolute file paths.
 */
function walk(dir, recursive) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (recursive) out.push(...walk(full, true)); }
    else if (entry.isFile()) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function uniqueDest(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem}__${n}${ext}`);
  return candidate;
}

/**
 * Validates an import source directory against the library.
 *
 * @param {ReturnType<import('./library.mjs').openLibrary>} lib
 * @param {string} srcDir
 * @returns {string} Resolved absolute source dir.
 * @throws {Error} With `.statusCode = 400` on invalid input.
 */
export function validateSource(lib, srcDir) {
  const bad = (msg) => Object.assign(new Error(msg), { statusCode: 400 });
  if (typeof srcDir !== 'string' || !path.isAbsolute(srcDir)) throw bad('path must be an absolute directory');
  const resolved = path.resolve(srcDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw bad(`not a directory: ${resolved}`);
  const rel = path.relative(lib.dir, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw bad('cannot import from inside the library');
  return resolved;
}

/**
 * Imports every supported image under srcDir into the managed library.
 *
 * Per file: hash source → skip if sha256 already known → copy to
 * originals/<yyyy>/<mm>/<sha[0:2]>/ via tmp+rename → re-hash copy → insert row.
 * Source files are never modified or deleted.
 *
 * @param {ReturnType<import('./library.mjs').openLibrary>} lib
 * @param {string} srcDir Absolute source directory.
 * @param {{recursive?: boolean, onProgress?: (p: object) => void}} [opts]
 * @returns {Promise<{scanned: number, imported: number, duplicates: number,
 *   unsupported: string[], errors: {file: string, error: string}[]}>}
 */
export async function importFolder(lib, srcDir, { recursive = true, onProgress } = {}) {
  const source = validateSource(lib, srcDir);
  const files = walk(source, recursive);
  const candidates = [];
  const result = { scanned: files.length, imported: 0, duplicates: 0, unsupported: [], errors: [] };
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (SUPPORTED_EXT.has(ext)) candidates.push(f);
    else if (UNSUPPORTED_IMAGE_EXT.has(ext)) result.unsupported.push(f);
  }

  const findSha = lib.db.prepare('SELECT id FROM assets WHERE sha256 = ?');
  const insert = lib.db.prepare(`INSERT INTO assets
    (root_id, rel_path, sha256, filename, ext, width, height, bytes, file_mtime, imported_at, source_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let done = 0;
  for (const file of candidates) {
    try {
      const sha = await sha256File(file);
      if (findSha.get(sha)) {
        result.duplicates++;
      } else {
        const stat = fs.statSync(file);
        const meta = await sharp(file).metadata();
        if (!meta.width || !meta.height) throw new Error('unreadable image dimensions');
        const mtime = stat.mtime;
        const dir = path.join(lib.originalsDir, String(mtime.getFullYear()),
          String(mtime.getMonth() + 1).padStart(2, '0'), sha.slice(0, 2));
        fs.mkdirSync(dir, { recursive: true });
        const dest = uniqueDest(dir, path.basename(file));
        const tmp = `${dest}.importing`;
        fs.copyFileSync(file, tmp);
        fs.utimesSync(tmp, stat.atime, stat.mtime);
        if (await sha256File(tmp) !== sha) {
          fs.rmSync(tmp, { force: true });
          throw new Error('hash mismatch after copy');
        }
        fs.renameSync(tmp, dest);
        const relPath = path.relative(lib.originalsDir, dest).split(path.sep).join('/');
        // EXIF orientation 5–8 swaps axes; store display dimensions.
        const swap = meta.orientation >= 5;
        let lastInsertRowid;
        try {
          ({ lastInsertRowid } = insert.run(lib.managedRootId, relPath, sha, path.basename(dest),
            path.extname(dest).toLowerCase().slice(1), swap ? meta.height : meta.width,
            swap ? meta.width : meta.height, stat.size, mtime.toISOString(), now(), file));
        } catch (err) {
          fs.rmSync(dest, { force: true }); // no DB row ⇒ don't leave an orphan original
          throw err;
        }
        logEvent(lib.db, 'import', { asset_id: Number(lastInsertRowid), source: file, rel_path: relPath });
        result.imported++;
      }
    } catch (err) {
      result.errors.push({ file, error: err.message });
    }
    done++;
    onProgress?.({ done, total: candidates.length, ...result });
  }
  logEvent(lib.db, 'import_summary', { source, recursive, ...result, unsupported: result.unsupported.length });
  return result;
}
