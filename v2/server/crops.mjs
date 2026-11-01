import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { pixelRegion } from './triage.mjs';

/**
 * Returns the path of a cached PNG render of a crop, generating it on first
 * request. The original is only ever read; the render goes under
 * `<thumbsDir>/crops/`, keyed by content hash + pixel region so it never goes
 * stale. Coordinates are relative to the EXIF-oriented (display) image.
 *
 * @param {string} thumbsDir Library thumbs directory (cache root).
 * @param {string} sourceFile Absolute original path (read-only).
 * @param {string} sha256 Original content hash.
 * @param {{x: number, y: number, w: number, h: number}} crop Relative 0..1 box.
 * @returns {Promise<{file: string, width: number, height: number}>}
 */
export async function ensureCrop(thumbsDir, sourceFile, sha256, crop) {
  const meta = await sharp(sourceFile).metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const W = swap ? meta.height : meta.width;
  const H = swap ? meta.width : meta.height;
  const r = pixelRegion(crop, W, H);
  const cacheRoot = path.resolve(thumbsDir, 'crops');
  const out = path.join(cacheRoot, sha256.slice(0, 2), `${sha256}_${r.left}_${r.top}_${r.width}x${r.height}.png`);
  if (!path.resolve(out).startsWith(cacheRoot + path.sep) || path.resolve(out) === path.resolve(sourceFile)) {
    throw new Error('refusing to write a crop render outside the crop cache');
  }
  if (!fs.existsSync(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await sharp(sourceFile).rotate().extract(r).png().toFile(tmp);
    fs.renameSync(tmp, out);
  }
  return { file: out, width: r.width, height: r.height };
}
