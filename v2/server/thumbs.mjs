import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const THUMB_SIZES = new Set([256, 1024]);
const CONCURRENCY = 4;

let active = 0;
/** LIFO wait stack: the newest request (what the user is looking at now) renders first. */
const waiting = [];
const inflight = new Map();

function release() {
  active--;
  while (waiting.length) {
    const next = waiting.pop();
    if (next.alive()) { active++; next.resolve(true); return; }
    next.resolve(false); // every requester went away while queued — skip the render
  }
}

async function acquire(alive) {
  if (active < CONCURRENCY) { active++; return true; }
  return new Promise((resolve) => waiting.push({ resolve, alive }));
}

/**
 * Returns the path of a cached WebP thumbnail, generating it on first request.
 *
 * Thumbnails are keyed by content hash, so they never go stale. Concurrent
 * requests for the same key share one render; renders are capped at
 * CONCURRENCY and queued LIFO, and a queued render whose requests have all
 * been abandoned (client scrolled past and dropped the connection) is skipped.
 *
 * @param {string} thumbsDir
 * @param {string} sourceFile Absolute original path.
 * @param {string} sha256
 * @param {number} size Long-edge bound; must be in THUMB_SIZES.
 * @param {() => boolean} [alive] Whether the requester still wants the result.
 * @returns {Promise<string|null>} Absolute thumbnail path, or null if skipped.
 */
export function ensureThumb(thumbsDir, sourceFile, sha256, size, alive = () => true) {
  const out = path.join(thumbsDir, sha256.slice(0, 2), `${sha256}_${size}.webp`);
  if (fs.existsSync(out)) return Promise.resolve(out);

  let entry = inflight.get(out);
  if (entry) {
    entry.waiters.push(alive);
    return entry.promise;
  }
  entry = { waiters: [alive] };
  const anyAlive = () => entry.waiters.some((w) => w());
  entry.promise = (async () => {
    const granted = await acquire(anyAlive);
    if (!granted) return null;
    try {
      if (fs.existsSync(out)) return out;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await sharp(sourceFile).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: size > 256 ? 82 : 75 }).toFile(tmp);
      fs.renameSync(tmp, out);
      return out;
    } finally {
      release();
    }
  })().finally(() => inflight.delete(out));
  inflight.set(out, entry);
  return entry.promise;
}
