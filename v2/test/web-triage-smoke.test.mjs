import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { cleanup, makeImages, startTestServer, tempDir, waitForImport } from './helpers.mjs';
import { fitRect, orientedSize, outputSize, toRelative } from '../web/src/lib/crop.js';
import { UNFILED_AST } from '../web/src/lib/filter.js';
import { buildGroups } from '../web/src/lib/groups.js';
import { nextIndex, planUndo } from '../web/src/lib/triageKeys.js';

// P2c 真實入口冒煙：temp library ＋ 真實 server（非 3040 的 ephemeral port）。
// 1) build 後的頁面與靜態資源可由 server 取得；2) Triage 會用到的 API 照 UI 的呼叫順序跑一輪
//    Q／W／E／R／1–9／G／Shift+G／Z，並用前端同一套純函式（crop.js、triageKeys.js、groups.js）算參數與游標。

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

let src, libDir, app, base;

before(async () => {
  src = tempDir('p2csrc');
  libDir = tempDir('p2clib');
  await makeImages(src, 6, { width: 800, height: 600 });
  await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 200, b: 10 } } })
    .jpeg().withMetadata({ orientation: 6 }).toFile(path.join(src, 'rot.jpg'));
  ({ app, base } = await startTestServer(libDir));
  await call('POST', '/api/import', { path: src });
  await waitForImport(base);
});
after(async () => { await app.close(); cleanup(src, libDir); });

async function call(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
const ok = async (...args) => {
  const r = await call(...args);
  assert.ok(r.status < 300, `${args[0]} ${args[1]} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
/** Same request the Triage view's source uses: POST /api/query with the 未歸類 AST. */
const unfiled = async () => (await ok('POST', '/api/query', { ast: UNFILED_AST, q: '', sort: 'name', order: 'asc' })).ids;

describe('built web UI is served', { skip: !fs.existsSync(path.join(DIST, 'index.html')) && 'dist/ missing — run npm run build' }, () => {
  test('index.html and every referenced asset return 200 with the right type', async () => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.some((r) => r.endsWith('.js')) && refs.some((r) => r.endsWith('.css')), refs.join(','));
    for (const r of refs) {
      const res = await fetch(`${base}${r}`);
      assert.equal(res.status, 200, r);
      assert.match(res.headers.get('content-type'), r.endsWith('.js') ? /javascript/ : /css/);
      const text = await res.text();
      if (r.endsWith('.js')) {
        // The bundle carries the P2c views (Triage keys + crop stage + grouping).
        for (const marker of ['triage-slots', 'crop-overlay', 'grouped-grid', '/api/settings/triage-slots', '/api/undo']) {
          assert.ok(text.includes(marker), `bundle lacks ${marker}`);
        }
      }
    }
  });
});

describe('Triage API round, in UI call order', () => {
  const history = [];
  const undoOnce = async () => {
    // App.undoLast: GET /api/undo → planUndo → POST /api/undo (by event ids, or plain).
    const list = await ok('GET', '/api/undo');
    const plan = planUndo(history, list);
    if (plan.eventIds) for (const ev of plan.eventIds) await ok('POST', '/api/undo', { event_id: ev });
    else await ok('POST', '/api/undo', {});
    history.splice(0, history.length, ...plan.rest);
    return plan;
  };

  test('full round: Q (crop → auto bundle), W, E, R, slot toggle, G, Shift+G, Z', async () => {
    let ids = await unfiled();
    assert.equal(ids.length, 7);
    const catalog = await ok('GET', '/api/catalog');
    const byId = new Map(catalog.tags.map((t) => [t.id, t]));
    const later = catalog.tags.find((t) => t.name === 'later' && byId.get(t.parent_id)?.name === 'triage');
    assert.ok(later, 'system tag triage/later');

    // --- Q on image 0: no open bundle → create, crop, add (3 events) -----------------
    assert.deepEqual(await ok('GET', '/api/bundles?status=open'), []);
    let index = 0;
    const qId = ids[index];
    const asset = await ok('GET', `/api/assets/${qId}`);
    const stage = fitRect(asset.width, asset.height, 1200, 700, 2);
    const rel = toRelative({ x: stage.width * 0.25, y: stage.height * 0.25, width: stage.width / 2, height: stage.height / 2 }, stage.width, stage.height);
    const events = [];
    const bundle = await ok('POST', '/api/bundles', {});
    events.push(bundle.event_id);
    const crop = await ok('POST', `/api/assets/${qId}/crops`, { ...rel, ratio_label: null });
    events.push(crop.event_id);
    const item = await ok('POST', `/api/bundles/${bundle.id}/items`, { crop_id: crop.id });
    events.push(item.event_id);
    history.push({ label: 'Q', eventIds: events });
    let before = ids;
    ids = await unfiled();
    index = nextIndex(before, ids, index, true);
    assert.equal(ids[index], before[1], 'Q advances to the next image (crop does not file the photo)');

    // Crop render matches the box.
    const png = await call('GET', `/media/crop/${crop.id}`);
    assert.equal(png.status, 200);
    assert.match(png.type, /image\/png/);
    const meta = await sharp(png.body).metadata();
    assert.deepEqual([meta.width, meta.height], Object.values(outputSize(rel, asset.width, asset.height)));
    assert.equal((await ok('GET', `/api/assets/${qId}/crops`)).length, 1);
    const open = await ok('GET', '/api/bundles?status=open');
    assert.deepEqual([open.length, open[0].item_count], [1, 1]);

    // --- Z: undoes the whole Q (3 events) in one go --------------------------------
    const plan = await undoOnce();
    assert.deepEqual(plan.eventIds, [...events].sort((a, b) => b - a));
    assert.equal((await ok('GET', `/api/assets/${qId}/crops`)).length, 0);
    assert.deepEqual(await ok('GET', '/api/bundles?status=open'), []);

    // --- W on the rotated image: crop in display (EXIF-oriented) coordinates --------
    const rot = (await ok('POST', '/api/query', { ast: { op: 'all' }, q: 'rot' })).ids[0];
    const rotAsset = await ok('GET', `/api/assets/${rot}`);
    assert.deepEqual([rotAsset.width, rotAsset.height], Object.values(orientedSize(300, 200, 6)));
    const rs = fitRect(rotAsset.width, rotAsset.height, 1000, 1000, 2);
    const rrel = toRelative({ x: 0, y: 0, width: rs.width, height: rs.height / 3 }, rs.width, rs.height);
    const wcrop = await ok('POST', `/api/assets/${rot}/crops`, { ...rrel, ratio_label: null });
    history.push({ label: 'W', eventIds: [wcrop.event_id] });
    const wpng = await sharp((await call('GET', `/media/crop/${wcrop.id}`)).body).metadata();
    assert.deepEqual([wpng.width, wpng.height], [200, 100]);

    // --- E: triage/later → leaves 未歸類 -------------------------------------------
    before = ids;
    const eId = ids[index];
    await ok('POST', '/api/tags/apply', { asset_ids: [eId], add: [later.id] });
    history.push({ label: 'E', eventIds: [] });
    ids = await unfiled();
    assert.ok(!ids.includes(eId));
    index = nextIndex(before, ids, index, true);
    assert.equal(ids[index], before[before.indexOf(eId) + 1], 'E lands on the next image');

    // --- R: trash → leaves the source; Z restores it ---------------------------------
    before = ids;
    const rId = ids[index];
    const tr = await ok('POST', '/api/assets/trash', { ids: [rId] });
    assert.equal(tr.trashed, 1);
    history.push({ label: 'R', eventIds: [tr.event_id] });
    ids = await unfiled();
    assert.ok(!ids.includes(rId));
    assert.equal((await ok('GET', `/api/assets/${rId}`)).status, 'trashed');
    const zr = await undoOnce();
    assert.deepEqual(zr.eventIds, [tr.event_id]);
    assert.equal((await ok('GET', `/api/assets/${rId}`)).status, 'active');
    ids = await unfiled();
    assert.ok(ids.includes(rId));

    // --- 1–9 slots: bind slot 1 to an album, toggle on (leaves 未歸類) and off ---------
    const album = await ok('POST', '/api/albums', { name: '收據' });
    const slots = Array(9).fill(null);
    slots[0] = { kind: 'album', id: album.id };
    slots[8] = { kind: 'tag', id: later.id };
    const saved = await ok('PUT', '/api/settings/triage-slots', slots);
    assert.deepEqual(saved[0], { kind: 'album', id: album.id, name: '收據' });
    assert.equal(saved[8].kind, 'tag');
    assert.deepEqual(await ok('GET', '/api/settings/triage-slots'), saved);
    const sId = rId;
    await ok('POST', `/api/albums/${album.id}/add`, { asset_ids: [sId] });
    assert.ok(!(await unfiled()).includes(sId));
    assert.deepEqual((await ok('GET', `/api/assets/${sId}`)).albums, [album.id]);
    await ok('POST', `/api/albums/${album.id}/remove`, { asset_ids: [sId] });
    assert.ok((await unfiled()).includes(sId));
    await ok('POST', `/api/albums/${album.id}/add`, { asset_ids: [sId] });

    // --- 依相簿分組 data for the grid ---------------------------------------------------
    const all = (await ok('POST', '/api/query', { ast: { op: 'all' }, q: '', sort: 'name', order: 'asc' })).ids;
    const groups = buildGroups(all, await ok('POST', '/api/assets/albums', { ids: all }));
    assert.deepEqual(groups.map((g) => [g.title, g.ids.length]), [['收據', 1], ['未在任何相簿', all.length - 1]]);

    // --- G: start, add whole image, close; Shift+G cancels a fresh one --------------
    const g = await ok('POST', '/api/bundles', {});
    await ok('POST', `/api/bundles/${g.id}/items`, { asset_id: ids[0] });
    const closed = await ok('PATCH', `/api/bundles/${g.id}`, { status: 'closed' });
    assert.deepEqual([closed.status, closed.items.length], ['closed', 1]);
    assert.equal((await call('POST', `/api/bundles/${g.id}/items`, { asset_id: ids[0] })).status, 409, 'closed bundles reject items');
    const c = await ok('POST', '/api/bundles', {});
    assert.equal((await ok('PATCH', `/api/bundles/${c.id}`, { status: 'cancelled' })).status, 'cancelled');
    assert.deepEqual(await ok('GET', '/api/bundles?status=open'), []);

    // --- Loupe: delete a crop, Z restores it -------------------------------------------
    const del = await ok('DELETE', `/api/crops/${wcrop.id}`);
    assert.equal(del.deleted, true);
    assert.equal((await ok('GET', `/api/assets/${rot}/crops`)).length, 0);
    await ok('POST', '/api/undo', { event_id: del.event_id });
    assert.equal((await ok('GET', `/api/assets/${rot}/crops`)).length, 1);
  });

  test('undo with nothing left → 404 (UI shows 沒有可撤銷的操作)', async () => {
    for (let i = 0; i < 200; i++) {
      const r = await call('POST', '/api/undo', {});
      if (r.status === 404) return;
      assert.ok(r.status < 300 || r.status === 409, `unexpected ${r.status} ${JSON.stringify(r.body)}`);
      if (r.status === 409) return; // a conflict also stops the UI; message is shown instead
    }
    assert.fail('undo stack never emptied');
  });
});
