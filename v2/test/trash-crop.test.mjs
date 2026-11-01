import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { assetFilePath } from '../server/library.mjs';
import { cleanRect, pixelRegion } from '../server/triage.mjs';
import { cleanup, makeImages, startTestServer, tempDir, waitForImport } from './helpers.mjs';

// P2a：trash／restore、非破壞 crop、bundle、快捷槽、依相簿分組（真實 HTTP＋真實圖檔）。

let src, libDir, app, base, db, ids;

before(async () => {
  src = tempDir('tcsrc');
  libDir = tempDir('tclib');
  await makeImages(src, 3, { width: 1001, height: 667 });
  // EXIF orientation 6 (stored 300×200, displayed 200×300)
  await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 10, b: 10 } } })
    .jpeg().withMetadata({ orientation: 6 }).toFile(path.join(src, 'rot.jpg'));
  ({ app, base } = await startTestServer(libDir));
  db = app.lib.db;
  await send('POST', '/api/import', { path: src });
  await waitForImport(base);
  ids = (await send('GET', '/api/assets?sort=name&order=asc')).body.ids;
});
after(async () => { await app.close(); cleanup(src, libDir); });

async function send(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
}
const ok = async (...args) => {
  const r = await send(...args);
  assert.ok(r.status < 300, `${args[0]} ${args[1]} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const row = (id) => db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
const listFiles = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

describe('trash / restore (HTTP)', () => {
  test('active ↔ trashed only; missing untouched and counted; unknown ids 404; never deletes files or rows', async () => {
    const [a, b, c] = ids;
    db.prepare("UPDATE assets SET status = 'missing' WHERE id = ?").run(c);
    const files = listFiles(app.lib.originalsDir);
    const tr = await ok('POST', '/api/assets/trash', { ids: [a, b, c] });
    assert.deepEqual([tr.trashed, tr.skipped_missing, tr.skipped], [2, 1, 0]);
    assert.deepEqual([row(a).status, row(b).status, row(c).status], ['trashed', 'trashed', 'missing']);
    const again = await ok('POST', '/api/assets/trash', { ids: [a] });
    assert.deepEqual([again.trashed, again.skipped], [0, 1]);
    const rs = await ok('POST', '/api/assets/restore', { ids: [a, c] });
    assert.deepEqual([rs.restored, rs.skipped_missing], [1, 1]);
    assert.deepEqual([row(a).status, row(c).status], ['active', 'missing']);
    await ok('POST', '/api/undo', { event_id: rs.event_id });
    assert.equal(row(a).status, 'trashed');
    await ok('POST', '/api/assets/restore', { ids: [a, b] });
    db.prepare("UPDATE assets SET status = 'active' WHERE id = ?").run(c);
    assert.deepEqual(listFiles(app.lib.originalsDir), files);
    assert.equal(db.prepare('SELECT count(*) AS n FROM assets').get().n, 4);
    assert.equal((await send('POST', '/api/assets/trash', { ids: [999999] })).status, 404);
    assert.equal((await send('POST', '/api/assets/trash', { ids: [] })).status, 400);
    assert.equal((await send('POST', '/api/assets/trash', {})).status, 400);
  });
});

describe('non-destructive crops (HTTP)', () => {
  test('validation: range, w/h > 0, x+w ≤ 1, y+h ≤ 1, types, unknown asset', async () => {
    const a = ids[0];
    const bad = [
      { x: -0.1, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 1.2, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0, h: 0.5 },
      { x: 0, y: 0, w: 0.5, h: -1 }, { x: 0.6, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0.7, w: 0.5, h: 0.31 },
      { x: '0', y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0.5 }, { x: 0, y: 0, w: 0.0001, h: 0.5 },
    ];
    for (const b of bad) assert.equal((await send('POST', `/api/assets/${a}/crops`, b)).status, 400, JSON.stringify(b));
    assert.equal((await send('POST', '/api/assets/999999/crops', { x: 0, y: 0, w: 1, h: 1 })).status, 404);
    assert.equal(db.prepare('SELECT count(*) AS n FROM crops').get().n, 0);
    // float slack: 0.1 + 0.9 is accepted
    const c = await ok('POST', `/api/assets/${a}/crops`, { x: 0.1, y: 0, w: 0.9, h: 1 });
    await ok('DELETE', `/api/crops/${c.id}`);
  });

  test('original sha256 unchanged by create / render; output size = round(w·W)×round(h·H); cache under thumbs/crops', async () => {
    const a = ids[1];
    const file = assetFilePath(app.lib, row(a));
    const before = sha(file);
    assert.equal(before, row(a).sha256);
    const rect = { x: 0.123, y: 0.456, w: 0.5, h: 0.333, ratio_label: 'free' };
    const c = await ok('POST', `/api/assets/${a}/crops`, rect);
    assert.equal(c.ratio_label, 'free');
    const list = await ok('GET', `/api/assets/${a}/crops`);
    assert.deepEqual(list.map((x) => x.id), [c.id]);
    for (let i = 0; i < 2; i++) { // second request comes from the cache
      const r = await send('GET', `/media/crop/${c.id}`);
      assert.equal(r.status, 200);
      assert.equal(r.type, 'image/png');
      const meta = await sharp(r.body).metadata();
      assert.deepEqual([meta.width, meta.height], [Math.round(0.5 * 1001), Math.round(0.333 * 667)]);
    }
    assert.equal(sha(file), before);
    const cached = listFiles(path.join(app.lib.thumbsDir, 'crops')).filter((f) => f.endsWith('.png'));
    assert.equal(cached.length, 1);
    assert.equal((await send('GET', '/media/crop/999999')).status, 404);
    await ok('DELETE', `/api/crops/${c.id}`);
    assert.equal(sha(file), before);
    assert.ok(fs.existsSync(file));
    assert.equal((await send('DELETE', `/api/crops/${c.id}`)).status, 404);
  });

  test('crop pixels come from the right region; edge crop never overflows; EXIF-rotated image uses display axes', async () => {
    const [a] = ids;
    const file = assetFilePath(app.lib, row(a));
    const full = await ok('POST', `/api/assets/${a}/crops`, { x: 0.999, y: 0.5, w: 0.001, h: 0.5 });
    const r = await send('GET', `/media/crop/${full.id}`);
    const meta = await sharp(r.body).metadata();
    assert.deepEqual([meta.width, meta.height], [1, 334]);
    // 0.5·667 rounds to 334 → origin shifted inward so the size stays exact
    const want = await sharp(file).extract({ left: 1000, top: 333, width: 1, height: 334 }).raw().toBuffer();
    const got = await sharp(r.body).removeAlpha().raw().toBuffer();
    assert.ok(got.equals(want));

    const rot = ids[3];
    assert.deepEqual([row(rot).width, row(rot).height], [200, 300]);
    const rc = await ok('POST', `/api/assets/${rot}/crops`, { x: 0, y: 0, w: 0.5, h: 1 });
    const rm = await sharp((await send('GET', `/media/crop/${rc.id}`)).body).metadata();
    assert.deepEqual([rm.width, rm.height], [100, 300]);
  });

  test('pixelRegion / cleanRect units', () => {
    assert.deepEqual(pixelRegion({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 3, 3), { left: 1, top: 1, width: 2, height: 2 });
    assert.deepEqual(pixelRegion({ x: 0, y: 0, w: 1, h: 1 }, 640, 400), { left: 0, top: 0, width: 640, height: 400 });
    assert.throws(() => cleanRect({ x: 0, y: 0, w: 1, h: 1.01 }, { width: 10, height: 10 }), /exceeds/);
    assert.throws(() => cleanRect({ x: NaN, y: 0, w: 1, h: 1 }, { width: 10, height: 10 }), /finite/);
  });
});

describe('bundles (HTTP)', () => {
  test('create (optional name), add asset / crop in order, remove, list, get, close; closed rejects items', async () => {
    const [a, b] = ids;
    const crop = await ok('POST', `/api/assets/${b}/crops`, { x: 0, y: 0, w: 0.5, h: 0.5 });
    const named = await ok('POST', '/api/bundles', { name: '  文章  ' });
    assert.equal(named.name, '文章');
    const bundle = await ok('POST', '/api/bundles');
    assert.match(bundle.name, /^Bundle \d{4}-/);
    assert.equal(bundle.status, 'open');
    const i1 = await ok('POST', `/api/bundles/${bundle.id}/items`, { asset_id: a });
    const i2 = await ok('POST', `/api/bundles/${bundle.id}/items`, { crop_id: crop.id });
    const i3 = await ok('POST', `/api/bundles/${bundle.id}/items`, { asset_id: b });
    assert.equal(i2.asset_id, b);
    assert.ok(i1.position < i2.position && i2.position < i3.position);
    assert.equal((await send('POST', `/api/bundles/${bundle.id}/items`, { asset_id: a, crop_id: crop.id })).status, 400);
    assert.equal((await send('POST', `/api/bundles/${bundle.id}/items`, {})).status, 400);
    assert.equal((await send('POST', `/api/bundles/${bundle.id}/items`, { crop_id: 999999 })).status, 404);
    await ok('DELETE', `/api/bundles/${bundle.id}/items/${i2.id}`);
    assert.equal((await send('DELETE', `/api/bundles/${named.id}/items/${i1.id}`)).status, 404);
    const got = await ok('GET', `/api/bundles/${bundle.id}`);
    assert.deepEqual(got.items.map((x) => [x.id, x.asset_id, x.crop_id]), [[i1.id, a, null], [i3.id, b, null]]);
    const open = await ok('GET', '/api/bundles?status=open');
    assert.ok(open.some((x) => x.id === bundle.id && x.item_count === 2));
    const closed = await ok('PATCH', `/api/bundles/${bundle.id}`, { status: 'closed' });
    assert.equal(closed.status, 'closed');
    assert.equal((await send('POST', `/api/bundles/${bundle.id}/items`, { asset_id: a })).status, 409);
    assert.equal((await send('PATCH', `/api/bundles/${bundle.id}`, { status: 'deleted' })).status, 400);
    assert.equal((await send('GET', '/api/bundles/999999')).status, 404);
    assert.equal((await send('GET', '/api/bundles?status=nope')).status, 400);
  });
});

describe('triage slots (HTTP)', () => {
  test('default 9 nulls; PUT validates length, kind, existence, rejects smart; GET resolves names', async () => {
    assert.deepEqual(await ok('GET', '/api/settings/triage-slots'), Array(9).fill(null));
    const tag = await ok('POST', '/api/tags', { name: 'slot-tag' });
    const album = await ok('POST', '/api/albums', { name: 'slot-album' });
    const smart = await ok('POST', '/api/smart', { name: 'slot-smart', q: 'tag:slot-tag' });
    const empty = Array(9).fill(null);
    const withAt = (i, v) => empty.map((x, j) => (j === i ? v : x));
    assert.equal((await send('PUT', '/api/settings/triage-slots', empty.slice(1))).status, 400);
    assert.equal((await send('PUT', '/api/settings/triage-slots', withAt(0, { kind: 'smart', id: smart.id }))).status, 400);
    assert.equal((await send('PUT', '/api/settings/triage-slots', withAt(0, { kind: 'folder', id: 1 }))).status, 400);
    assert.equal((await send('PUT', '/api/settings/triage-slots', withAt(0, { kind: 'album', id: 999999 }))).status, 404);
    assert.equal((await send('PUT', '/api/settings/triage-slots', withAt(0, { kind: 'tag', id: 'x' }))).status, 400);
    assert.equal((await send('PUT', '/api/settings/triage-slots', withAt(0, 5))).status, 400);
    const put = await ok('PUT', '/api/settings/triage-slots', withAt(0, { kind: 'tag', id: tag.id }).map((x, i) => (i === 8 ? { kind: 'album', id: album.id } : x)));
    assert.deepEqual(put[0], { kind: 'tag', id: tag.id, name: 'slot-tag' });
    assert.deepEqual(put[8], { kind: 'album', id: album.id, name: 'slot-album' });
    assert.deepEqual(await ok('GET', '/api/settings/triage-slots'), put);
    const stored = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'triage_slots'").get().value);
    assert.deepEqual(stored[0], { kind: 'tag', id: tag.id });
    // also accepted as {slots: [...]}
    await ok('PUT', '/api/settings/triage-slots', { slots: empty });
  });
});

describe('album grouping (HTTP)', () => {
  test('POST /api/assets/albums → {assetId: [{id, name}]}, every id present, 5,000 cap, batched', async () => {
    const [a, b, c] = ids;
    const x = await ok('POST', '/api/albums', { name: 'G-x' });
    const y = await ok('POST', '/api/albums', { name: 'G-y' });
    await ok('POST', `/api/albums/${x.id}/add`, { asset_ids: [a, b] });
    await ok('POST', `/api/albums/${y.id}/add`, { asset_ids: [a] });
    const many = Array.from({ length: 5000 }, (_, i) => i + 1);
    const out = await ok('POST', '/api/assets/albums', { ids: many });
    assert.equal(Object.keys(out).length, 5000);
    assert.deepEqual(out[a], [{ id: x.id, name: 'G-x' }, { id: y.id, name: 'G-y' }]);
    assert.deepEqual(out[b], [{ id: x.id, name: 'G-x' }]);
    assert.deepEqual(out[c], []);
    assert.equal((await send('POST', '/api/assets/albums', { ids: [...many, 5001] })).status, 400);
    assert.equal((await send('POST', '/api/assets/albums', { ids: [] })).status, 400);
  });
});

describe('crop render under a long library path (Windows MAX_PATH)', () => {
  test('ensureCrop writes the cache even when the full path exceeds 260 characters', async () => {
    const { ensureCrop } = await import('../server/crops.mjs');
    const root = tempDir('crop-longpath');
    try {
      const [src] = await makeImages(path.join(root, 'src'), 1, { width: 300, height: 200 });
      const deep = path.join(root, ...Array.from({ length: 6 }, (_, i) => `deep-directory-segment-${i}-xxxxxxxxxx`), 'thumbs');
      const sha = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
      assert.ok(path.join(deep, 'crops', sha.slice(0, 2), `${sha}_0_0_150x100.png`).length > 260, 'fixture must exceed MAX_PATH');
      const r = await ensureCrop(deep, src, sha, { x: 0, y: 0, w: 0.5, h: 0.5 });
      const meta = await sharp(fs.readFileSync(r.file)).metadata();
      assert.deepEqual([meta.width, meta.height], [150, 100]);
    } finally {
      cleanup(root);
    }
  });
});
