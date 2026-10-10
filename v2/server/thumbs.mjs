import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const THUMB_SIZES = new Set([256, 1024]);
const CONCURRENCY = 4;

let active = 0;
const waiting = [];
const inflight = new Map();

async function limited(fn) {
  if (active >= CONCURRENCY) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/**
 * Returns the path of a cached WebP thumbnail, generating it on first request.
 *
 * Thumbnails are keyed by content hash, so they never go stale; concurrent
 * requests for the same key share one render, and renders are capped at
 * CONCURRENCY to keep a fast-scrolling grid from saturating the CPU.
 *
 * @param {string} thumbsDir
 * @param {string} sourceFile Absolute original path.
 * @param {string} sha256
 * @param {number} size Long-edge bound; must be in THUMB_SIZES.
 * @returns {Promise<string>} Absolute thumbnail path.
 */
export function ensureThumb(thumbsDir, sourceFile, sha256, size) {
  const out = path.join(thumbsDir, sha256.slice(0, 2), `${sha256}_${size}.webp`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (inflight.has(out)) return inflight.get(out);
  const job = limited(async () => {
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`;
    await sharp(sourceFile).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: size > 256 ? 82 : 75 }).toFile(tmp);
    fs.renameSync(tmp, out);
    return out;
  }).finally(() => inflight.delete(out));
  inflight.set(out, job);
  return job;
}
