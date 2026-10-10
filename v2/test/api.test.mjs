import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { cleanup, makeImages, startTestServer, tempDir, waitForImport } from './helpers.mjs';

let src, libDir, app, base, sources;

before(async () => {
  src = tempDir('apisrc');
  libDir = tempDir('apilib');
  sources = await makeImages(src, 5, { width: 1600, height: 900 });
  ({ app, base } = await startTestServer(libDir));
});

after(async () => { await app.close(); cleanup(src, libDir); });

const json = async (res) => ({ status: res.status, body: await res.json() });
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('listens on 127.0.0.1 only', () => {
  assert.equal(app.server.address().address, '127.0.0.1');
});

test('POST /api/import runs a job; GET /api/import reports result', async () => {
  const { status } = await json(await post(`${base}/api/import`, { path: src }));
  assert.equal(status, 202);
  const job = await waitForImport(base);
  assert.equal(job.state, 'done');
  assert.equal(job.result.imported, 5);
});

test('POST /api/import rejects bad paths with 400', async () => {
  assert.equal((await post(`${base}/api/import`, { path: 'rel' })).status, 400);
  assert.equal((await post(`${base}/api/import`, { path: libDir })).status, 400);
  assert.equal((await post(`${base}/api/import`, {})).status, 400);
});

test('GET /api/assets lists ids in requested order', async () => {
  const { body } = await json(await fetch(`${base}/api/assets?sort=name&order=asc`));
  assert.equal(body.total, 5);
  const names = await Promise.all(body.ids.map(async (id) => (await json(await fetch(`${base}/api/assets/${id}`))).body.filename));
  assert.deepEqual(names, sources.map((f) => path.basename(f)));
  const desc = (await json(await fetch(`${base}/api/assets?sort=name&order=desc`))).body.ids;
  assert.deepEqual(desc, [...body.ids].reverse());
});

test('GET /media/original/:id streams the exact bytes', async () => {
  const { body } = await json(await fetch(`${base}/api/assets?sort=name&order=asc`));
  const res = await fetch(`${base}/media/original/${body.ids[0]}`);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const got = crypto.createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
  const want = crypto.createHash('sha256').update(fs.readFileSync(sources[0])).digest('hex');
  assert.equal(got, want);
});

test('GET /media/thumb/:id returns a WebP within the size bound, cached on disk', async () => {
  const { body } = await json(await fetch(`${base}/api/assets`));
  for (const size of [256, 1024]) {
    const res = await fetch(`${base}/media/thumb/${body.ids[0]}?size=${size}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(Math.max(meta.width, meta.height), size);
  }
  const cached = fs.readdirSync(path.join(libDir, 'thumbs'), { recursive: true }).filter((f) => String(f).endsWith('.webp'));
  assert.equal(cached.length, 2);
  assert.equal((await fetch(`${base}/media/thumb/${body.ids[0]}?size=999`)).status, 400);
});

test('id validation: non-numeric 400, unknown 404, traversal attempt 400/404', async () => {
  assert.equal((await fetch(`${base}/api/assets/abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/assets/999999`)).status, 404);
  assert.equal((await fetch(`${base}/media/original/1abc`)).status, 400);
  const trav = await fetch(`${base}/media/original/..%2F..%2Flibrary.db`);
  assert.ok([400, 404].includes(trav.status), `got ${trav.status}`);
});

test('concurrent import returns 409 while one is running', async () => {
  const big = tempDir('apibig');
  try {
    await makeImages(big, 40, { offset: 500 });
    const first = await post(`${base}/api/import`, { path: big });
    const second = await post(`${base}/api/import`, { path: big });
    assert.equal(first.status, 202);
    assert.equal(second.status, 409);
    const job = await waitForImport(base);
    assert.equal(job.result.imported, 40);
  } finally { cleanup(big); }
});
