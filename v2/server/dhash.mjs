/**
 * S0 near-duplicate detection (Sprint_Screenshot_AI_Triage §3): 64-bit dHash per
 * asset, grouping by Hamming distance, one `dup` suggestion (purpose/ephemeral)
 * for every member of a group except the earliest-imported one.
 *
 * Search: multi-index hashing. The 64 bits are split into maxDistance+1
 * segments; by pigeonhole, two hashes within distance d share at least one
 * identical segment, so only same-bucket pairs are verified. Exact for any d,
 * near-linear for realistic data (50k assets ≈ 50k × bucket size, not n²).
 */
import fs from 'node:fs';
import sharp from 'sharp';
import { now, tx } from './db.mjs';
import { assetFilePath } from './library.mjs';
import { recordRun, suggestionWriter, tagIdByPath } from './suggestions.mjs';

export const DUP_MODEL = 'dhash';
const DUP_TAG = 'purpose/ephemeral';
const DUP_CONFIDENCE = 0.9;
/** 9×8 grey range at or below this ⇒ "flat" image (blank screen); its hash carries no information. */
const FLAT_RANGE = 2;

/**
 * dHash of an image: greyscale, resize to 9×8 (ignoring aspect), bit = left pixel > right pixel.
 *
 * @param {string|Buffer} input File path or image buffer.
 * @returns {Promise<{hash: string, flat: boolean}>} 16-char lowercase hex, row-major MSB first.
 */
export async function dhash(input) {
  const px = await sharp(input).rotate().greyscale().resize(9, 8, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  let bits = 0n;
  let lo = 255;
  let hi = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const l = px[y * 9 + x];
      const r = px[y * 9 + x + 1];
      bits = (bits << 1n) | (l > r ? 1n : 0n);
    }
    for (let x = 0; x < 9; x++) { lo = Math.min(lo, px[y * 9 + x]); hi = Math.max(hi, px[y * 9 + x]); }
  }
  return { hash: bits.toString(16).padStart(16, '0'), flat: hi - lo <= FLAT_RANGE };
}

/** Hamming distance between two 16-hex-char hashes. */
export function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) { x &= x - 1n; n++; }
  return n;
}

/**
 * Groups hashes whose distance ≤ maxDistance (connected components; transitive).
 *
 * @param {{id: number, hash: string}[]} items
 * @param {number} maxDistance
 * @returns {number[][]} Groups of ≥2 ids (input order preserved inside a group).
 */
export function groupNear(items, maxDistance) {
  const k = maxDistance + 1;
  const bounds = Array.from({ length: k + 1 }, (_, i) => Math.round((64 * i) / k));
  const big = items.map((it) => BigInt(`0x${it.hash}`));
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const checked = new Set();
  for (let s = 0; s < k; s++) {
    const width = BigInt(bounds[s + 1] - bounds[s]);
    const shift = BigInt(64 - bounds[s + 1]);
    const mask = (1n << width) - 1n;
    const buckets = new Map();
    big.forEach((h, i) => {
      const key = (h >> shift) & mask;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    });
    for (const members of buckets.values()) {
      for (let x = 0; x < members.length; x++) {
        for (let y = x + 1; y < members.length; y++) {
          const i = members[x];
          const j = members[y];
          const key = i * items.length + j;
          if (checked.has(key)) continue;
          checked.add(key);
          if (hamming(items[i].hash, items[j].hash) <= maxDistance) parent[find(i)] = find(j);
        }
      }
    }
  }
  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it.id);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Thousands separators keep sanitizeReason (masks 4+ digit runs) from erasing asset ids. */
const fmtId = (id) => `#${Number(id).toLocaleString('en-US')}`;

/**
 * Hashes active assets that have no hash yet, then (re)detects near-duplicates over
 * every hashed active asset. Idempotent: hashes are computed once; suggestions are
 * INSERT OR IGNORE; `asset_hashes.dup_of` is recomputed each run.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ReturnType<import('./library.mjs').openLibrary>} lib
 * @param {{maxDistance?: number, dryRun?: boolean, limit?: number, concurrency?: number}} [opts]
 *   `limit` caps how many new hashes are computed this run. `dryRun` rolls back all writes.
 * @returns {Promise<{hashed: number, errors: {asset_id: number, error: string}[], flat: number,
 *   groups: number, duplicates: number, inserted: number, skipped: number}>}
 */
export async function detectDuplicates(db, lib, { maxDistance = 4, dryRun = false, limit = Infinity, concurrency = 4 } = {}) {
  if (!Number.isInteger(maxDistance) || maxDistance < 0 || maxDistance > 16) throw new Error('maxDistance must be an integer 0..16');
  const tagId = tagIdByPath(db, DUP_TAG);
  if (!tagId) throw new Error(`missing tag ${DUP_TAG} (migration 003 not applied?)`);

  const todo = db.prepare(`SELECT a.* FROM assets a LEFT JOIN asset_hashes h ON h.asset_id = a.id
    WHERE a.status = 'active' AND h.asset_id IS NULL ORDER BY a.id`).all().slice(0, limit);

  // Hash outside any transaction (async); write synchronously afterwards.
  const computed = [];
  const errors = [];
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const a = todo[next++];
      const t0 = Date.now();
      try {
        const file = assetFilePath(lib, a);
        if (!fs.existsSync(file)) throw new Error('original file missing');
        computed.push({ asset: a, ...(await dhash(file)), ms: Date.now() - t0 });
      } catch (err) {
        errors.push({ asset_id: a.id, error: String(err.message || err).slice(0, 300), ms: Date.now() - t0 });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const out = { hashed: computed.length, errors: errors.map(({ asset_id, error }) => ({ asset_id, error })), flat: 0, groups: 0, duplicates: 0, inserted: 0, skipped: 0 };
  const DRY = Symbol('dry-run');
  try {
    tx(db, () => {
      const ts = now();
      const insHash = db.prepare('INSERT OR REPLACE INTO asset_hashes (asset_id, dhash, flat, computed_at) VALUES (?, ?, ?, ?)');
      for (const c of computed) {
        insHash.run(c.asset.id, c.hash, c.flat ? 1 : 0, ts);
        recordRun(db, { assetId: c.asset.id, stage: 'dup', model: DUP_MODEL, status: 'ok', ms: c.ms });
      }
      for (const e of errors) recordRun(db, { assetId: e.asset_id, stage: 'dup', model: DUP_MODEL, status: 'error', detail: e.error, ms: e.ms });

      const rows = db.prepare(`SELECT h.asset_id AS id, h.dhash AS hash, h.flat FROM asset_hashes h
        JOIN assets a ON a.id = h.asset_id WHERE a.status = 'active' ORDER BY a.imported_at, a.id`).all();
      out.flat = rows.filter((r) => r.flat).length;
      const usable = rows.filter((r) => !r.flat);
      const hashOf = new Map(usable.map((r) => [r.id, r.hash]));
      const groups = groupNear(usable, maxDistance);

      db.prepare('UPDATE asset_hashes SET dup_of = NULL, dup_distance = NULL').run();
      const setDup = db.prepare('UPDATE asset_hashes SET dup_of = ?, dup_distance = ? WHERE asset_id = ?');
      const write = suggestionWriter(db, { stage: 'dup', model: DUP_MODEL });
      for (const g of groups) {
        // `usable` is sorted by (imported_at, id) and groupNear keeps input order ⇒ g[0] is the earliest import.
        const [keeper, ...dups] = g;
        out.groups++;
        for (const id of dups) {
          const d = hamming(hashOf.get(id), hashOf.get(keeper));
          setDup.run(keeper, d, id);
          const r = write(id, [{ tagId, confidence: DUP_CONFIDENCE, reason: `與 ${fmtId(keeper)} 近重複（距離 ${d}）` }]);
          out.duplicates++;
          out.inserted += r.inserted;
          out.skipped += r.skipped;
        }
      }
      if (dryRun) throw DRY;
    });
  } catch (err) {
    if (err !== DRY) throw err;
  }
  return out;
}
