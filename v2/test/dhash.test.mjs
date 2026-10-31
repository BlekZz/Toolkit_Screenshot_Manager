import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { detectDuplicates, dhash, groupNear, hamming } from '../server/dhash.mjs';
import { importFolder } from '../server/importer.mjs';
import { openLibrary } from '../server/library.mjs';
import { tagIdByPath } from '../server/suggestions.mjs';
import { cleanup, makeImages, tempDir } from './helpers.mjs';

/** Deterministic block pattern (16×10 random grey blocks) scaled up — has real structure for dHash. */
function pattern(seed) {
  let s = seed >>> 0;
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const raw = Buffer.alloc(16 * 10);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(rnd() * 256);
  return sharp(raw, { raw: { width: 16, height: 10, channels: 1 } }).resize(640, 400, { kernel: 'nearest' });
}

let dir, lib;
beforeEach(() => {
  dir = tempDir('dhash');
  lib = openLibrary(path.join(dir, 'lib'));
});
afterEach(() => {
  try { lib.db.close(); } catch { /* closed */ }
  cleanup(dir);
});

/** Imports the fixture: original A, its resized + recompressed copies, an unrelated B. Returns ids by filename. */
async function seedFixture() {
  const first = path.join(dir, 'src1');
  const later = path.join(dir, 'src2');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(later, { recursive: true });
  await pattern(1).png().toFile(path.join(first, 'a_orig.png'));
  await pattern(1).resize(320, 200).png().toFile(path.join(later, 'a_small.png'));
  await pattern(1).jpeg({ quality: 35 }).toFile(path.join(later, 'a_recompressed.jpg'));
  await pattern(2).png().toFile(path.join(later, 'b_other.png'));
  await importFolder(lib, first);
  await importFolder(lib, later);
  const ids = {};
  for (const r of lib.db.prepare('SELECT id, filename FROM assets').all()) ids[r.filename] = r.id;
  return ids;
}
const dupRows = () => lib.db.prepare(`SELECT asset_id, tag_id, confidence, reason, status FROM asset_suggestions
  WHERE stage = 'dup' ORDER BY asset_id`).all();

describe('dhash', () => {
  test('resized and recompressed copies stay within distance 4; an unrelated image is far', async () => {
    const a = (await dhash(await pattern(1).png().toBuffer())).hash;
    const small = (await dhash(await pattern(1).resize(320, 200).png().toBuffer())).hash;
    const jpg = (await dhash(await pattern(1).jpeg({ quality: 35 }).toBuffer())).hash;
    const b = (await dhash(await pattern(2).png().toBuffer())).hash;
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.ok(hamming(a, small) <= 4, `small ${hamming(a, small)}`);
    assert.ok(hamming(a, jpg) <= 4, `jpg ${hamming(a, jpg)}`);
    assert.ok(hamming(a, b) > 12, `other ${hamming(a, b)}`);
  });

  test('solid-colour images are flagged flat', async () => {
    const solid = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#808080' } }).png().toBuffer();
    assert.equal((await dhash(solid)).flat, true);
    assert.equal((await dhash(await pattern(3).png().toBuffer())).flat, false);
  });

  test('groupNear (multi-index buckets) equals brute-force grouping', () => {
    let s = 99;
    const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0);
    const base = Array.from({ length: 60 }, () => (BigInt(rnd()) << 32n) | BigInt(rnd()));
    const items = [];
    base.forEach((h, i) => {
      items.push({ id: items.length + 1, hash: h.toString(16).padStart(16, '0') });
      // near copies with 1..6 flipped bits
      for (let k = 0; k < 2; k++) {
        let x = h;
        const flips = 1 + ((i + k) % 6);
        for (let f = 0; f < flips; f++) x ^= 1n << BigInt(rnd() % 64);
        items.push({ id: items.length + 1, hash: x.toString(16).padStart(16, '0') });
      }
    });
    for (const d of [0, 2, 4, 6]) {
      const parent = items.map((_, i) => i);
      const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        if (hamming(items[i].hash, items[j].hash) <= d) parent[find(i)] = find(j);
      }
      const brute = new Map();
      items.forEach((it, i) => { const r = find(i); brute.set(r, [...(brute.get(r) ?? []), it.id]); });
      const norm = (gs) => gs.filter((g) => g.length > 1).map((g) => [...g].sort((x, y) => x - y).join(',')).sort();
      assert.deepEqual(norm(groupNear(items, d)), norm([...brute.values()]), `d=${d}`);
    }
  });
});

describe('detectDuplicates', () => {
  test('copies get a dup suggestion (purpose/ephemeral, 0.9) pointing at the earliest import; keeper and unrelated get none', async () => {
    const ids = await seedFixture();
    // Give the keeper a 4-digit id: the reason must survive sanitizeReason's digit masking.
    lib.db.prepare('UPDATE assets SET id = 1234 WHERE id = ?').run(ids['a_orig.png']);
    ids['a_orig.png'] = 1234;
    const r = await detectDuplicates(lib.db, lib);
    assert.equal(r.hashed, 4);
    assert.equal(r.groups, 1);
    assert.equal(r.duplicates, 2);
    const rows = dupRows();
    assert.deepEqual(rows.map((x) => x.asset_id).sort(), [ids['a_small.png'], ids['a_recompressed.jpg']].sort());
    for (const row of rows) {
      assert.equal(row.tag_id, tagIdByPath(lib.db, 'purpose/ephemeral'));
      assert.equal(row.confidence, 0.9);
      assert.equal(row.status, 'pending');
      assert.match(row.reason, /^與 #1,234 近重複（距離 \d）$/);
    }
    const h = lib.db.prepare('SELECT dup_of FROM asset_hashes WHERE asset_id = ?');
    assert.equal(h.get(ids['a_small.png']).dup_of, 1234);
    assert.equal(h.get(ids['a_orig.png']).dup_of, null);
    assert.equal(h.get(ids['b_other.png']).dup_of, null);
  });

  test('keeper is the earliest imported_at, not the lowest id', async () => {
    const ids = await seedFixture();
    lib.db.prepare("UPDATE assets SET imported_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(ids['a_recompressed.jpg']);
    await detectDuplicates(lib.db, lib);
    assert.deepEqual(dupRows().map((x) => x.asset_id).sort(), [ids['a_orig.png'], ids['a_small.png']].sort());
    assert.ok(dupRows().every((x) => x.reason.includes(`#${ids['a_recompressed.jpg']}`)));
  });

  test('idempotent: a second run hashes nothing and inserts nothing; one ok run per asset', async () => {
    await seedFixture();
    const first = await detectDuplicates(lib.db, lib);
    assert.equal(first.inserted, 2);
    const again = await detectDuplicates(lib.db, lib);
    assert.equal(again.hashed, 0);
    assert.equal(again.inserted, 0);
    assert.equal(again.skipped, 2);
    assert.equal(dupRows().length, 2);
    assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM suggestion_runs WHERE stage = 'dup' AND status = 'ok'").get().n, 4);
  });

  test('a later import that duplicates an existing asset is caught on the next run', async () => {
    const ids = await seedFixture();
    await detectDuplicates(lib.db, lib);
    const src3 = path.join(dir, 'src3');
    fs.mkdirSync(src3);
    await pattern(2).resize(500, 300).png().toFile(path.join(src3, 'b_copy.png'));
    await importFolder(lib, src3);
    const r = await detectDuplicates(lib.db, lib);
    assert.equal(r.hashed, 1);
    assert.equal(r.inserted, 1);
    const copy = lib.db.prepare("SELECT id FROM assets WHERE filename = 'b_copy.png'").get().id;
    assert.match(dupRows().find((x) => x.asset_id === copy).reason, new RegExp(`#${ids['b_other.png']} `));
  });

  test('flat images are never grouped; missing originals are recorded as errors', async () => {
    const src = path.join(dir, 'flat');
    await makeImages(src, 2); // solid colours ⇒ flat
    await importFolder(lib, src);
    const victim = lib.db.prepare('SELECT * FROM assets ORDER BY id LIMIT 1').get();
    fs.rmSync(path.join(lib.originalsDir, ...victim.rel_path.split('/')));
    const r = await detectDuplicates(lib.db, lib);
    assert.equal(r.groups, 0);
    assert.equal(r.flat, 1);
    assert.deepEqual(r.errors.map((e) => e.asset_id), [victim.id]);
    assert.equal(lib.db.prepare("SELECT status FROM suggestion_runs WHERE asset_id = ? AND stage = 'dup'").get(victim.id).status, 'error');
  });

  test('dry run writes nothing', async () => {
    await seedFixture();
    const r = await detectDuplicates(lib.db, lib, { dryRun: true });
    assert.equal(r.inserted, 2);
    assert.equal(dupRows().length, 0);
    assert.equal(lib.db.prepare('SELECT COUNT(*) AS n FROM asset_hashes').get().n, 0);
  });
});
