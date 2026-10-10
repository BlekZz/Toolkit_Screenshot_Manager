import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openLibrary } from '../server/library.mjs';
import { parseQuery } from '../server/query.mjs';
import { cleanup, startTestServer, tempDir } from './helpers.mjs';

// Fixture (known answer sets): assets 1..12 active, 13 trashed.
//   album 客戶A = {1..6}   album B = {5,6,7,8}   album X = {9,10}
//   tag 類型/收據 = {2,5,7,11}   類型/發票 = {3,8}   地點 = {1,9}   13 has 收據 but is trashed
const ALL_ACTIVE = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

let libDir, app, base;
const ids = {};

async function call(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const ok = async (...args) => {
  const r = await call(...args);
  assert.ok(r.status < 300, `${args[0]} ${args[1]} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const sorted = (arr) => [...arr].sort((a, b) => a - b);
const queryQ = async (q) => sorted((await ok('POST', '/api/query', { q })).ids);
const queryAst = async (ast) => sorted((await ok('POST', '/api/query', { ast })).ids);

before(async () => {
  libDir = tempDir('catalog');
  const lib = openLibrary(libDir);
  const ins = lib.db.prepare(`INSERT INTO assets (id, root_id, rel_path, sha256, filename, ext, width, height, bytes,
    file_mtime, imported_at, status) VALUES (?, ?, ?, ?, ?, 'png', 100, 100, 1, ?, ?, ?)`);
  for (let i = 1; i <= 13; i++) {
    const name = i === 4 ? 'report_100%.png' : i === 6 ? 'report_1000.png' : `shot_${i}.png`;
    const mtime = i <= 6 ? '2026-08-15T04:00:00.000Z' : '2026-09-20T04:00:00.000Z';
    ins.run(i, lib.managedRootId, `x/${i}.png`, String(i).padStart(64, '0'), name, mtime, mtime, i === 13 ? 'trashed' : 'active');
  }
  lib.db.close();
  ({ app, base } = await startTestServer(libDir));

  ids.receipt = (await ok('POST', '/api/tags', { name: '類型/收據' })).id;
  ids.invoice = (await ok('POST', '/api/tags', { name: '類型/發票' })).id;
  ids.place = (await ok('POST', '/api/tags', { name: '地點' })).id;
  ids.type = (await ok('GET', '/api/tags')).find((t) => t.name === '類型' && t.parent_id == null).id;
  ids.A = (await ok('POST', '/api/albums', { name: '客戶A' })).id;
  ids.B = (await ok('POST', '/api/albums', { name: 'B' })).id;
  ids.X = (await ok('POST', '/api/albums', { name: 'X' })).id;
  await ok('POST', `/api/albums/${ids.A}/add`, { asset_ids: [1, 2, 3, 4, 5, 6] });
  await ok('POST', `/api/albums/${ids.B}/add`, { asset_ids: [5, 6, 7, 8] });
  await ok('POST', `/api/albums/${ids.X}/add`, { asset_ids: [9, 10] });
  await ok('POST', '/api/tags/apply', { asset_ids: [2, 5, 7, 11, 13], add: [ids.receipt] });
  await ok('POST', '/api/tags/apply', { asset_ids: [3, 8], add: [ids.invoice] });
  await ok('POST', '/api/tags/apply', { asset_ids: [1, 9], add: [ids.place] });
});

after(async () => { await app.close(); cleanup(libDir); });

describe('§5.2 user scenarios (exact result sets)', () => {
  test('all photos except album X', async () => {
    assert.deepEqual(await queryQ('NOT album:X'), [1, 2, 3, 4, 5, 6, 7, 8, 11, 12]);
    assert.deepEqual(await queryQ('-album:X'), [1, 2, 3, 4, 5, 6, 7, 8, 11, 12]);
  });
  test('only tag 收據 inside album 客戶A', async () => {
    assert.deepEqual(await queryQ('album:客戶A AND tag:類型/收據'), [2, 5]);
    assert.deepEqual(await queryQ('album:客戶A tag:類型/收據'), [2, 5]); // implicit AND
  });
  test('tag 收據 across albums', async () => {
    assert.deepEqual(await queryQ('tag:類型/收據'), [2, 5, 7, 11]);
  });
  test('unfiled (no album, no tag)', async () => {
    assert.deepEqual(await queryQ('NOT has:album AND NOT has:tag'), [12]);
  });
  test('same answers via AST', async () => {
    assert.deepEqual(await queryAst({ op: 'not', arg: { op: 'album', id: ids.X } }), [1, 2, 3, 4, 5, 6, 7, 8, 11, 12]);
    assert.deepEqual(await queryAst({ op: 'and', args: [{ op: 'album', id: ids.A }, { op: 'tag', id: ids.receipt }] }), [2, 5]);
  });
});

describe('query semantics', () => {
  test('empty query = every active asset; trashed hidden', async () => {
    assert.deepEqual(await queryQ(''), ALL_ACTIVE);
  });
  test('status: opts into trashed', async () => {
    assert.deepEqual(await queryQ('status:trashed'), [13]);
    assert.deepEqual(await queryQ('status:trashed tag:類型/收據'), [13]);
  });
  test('tag subtree inheritance vs exact', async () => {
    assert.deepEqual(await queryQ('tag:類型'), [2, 3, 5, 7, 8, 11]);
    assert.deepEqual(await queryQ('tag:=類型'), []);
  });
  test('precedence: NOT > AND > OR, parentheses', async () => {
    assert.deepEqual(await queryQ('(tag:類型/收據 OR tag:類型/發票) AND NOT album:X'), [2, 3, 5, 7, 8, 11]);
    // AND binds tighter than OR: album:X OR (album:B AND tag:類型/發票)
    assert.deepEqual(await queryQ('album:X OR album:B tag:類型/發票'), [8, 9, 10]);
  });
  test('date prefixes use local calendar dates', async () => {
    assert.deepEqual(await queryQ('date:2026-08'), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(await queryQ('date:2026-09-01..2026-09-30'), [7, 8, 9, 10, 11, 12]);
    assert.deepEqual(await queryQ('date:2026'), ALL_ACTIVE);
  });
  test('text search treats % and _ literally', async () => {
    assert.deepEqual(await queryQ('"100%"'), [4]);
    assert.deepEqual(await queryQ('report_'), [4, 6]);
    assert.deepEqual(await queryQ('shot_1'), [1, 10, 11, 12]);
  });
  test('id references #n', async () => {
    assert.deepEqual(await queryQ(`album:#${ids.B}`), [5, 6, 7, 8]);
  });
  test('errors are 400 with a message', async () => {
    for (const q of ['tag:不存在', 'album:nope', 'foo:bar', '(album:X', 'has:nothing', 'date:2026-13-99x', 'album:"open']) {
      const r = await call('POST', '/api/query', { q });
      assert.equal(r.status, 400, q);
      assert.ok(r.body.message, q);
    }
    assert.equal((await call('POST', '/api/query', { ast: { op: 'drop' } })).status, 400);
    assert.equal((await call('POST', '/api/query', { ast: { op: 'tag', id: 'x' } })).status, 400);
  });
  test('GET /api/assets?q= shares the same engine', async () => {
    const r = await ok('GET', `/api/assets?q=${encodeURIComponent('album:客戶A tag:類型/收據')}`);
    assert.deepEqual(sorted(r.ids), [2, 5]);
  });
});

describe('injection safety', () => {
  test('hostile album/tag names are just data', async () => {
    const evil = (await ok('POST', '/api/albums', { name: "x'); DROP TABLE assets; --" })).id;
    const quote = (await ok('POST', '/api/albums', { name: 'say "hi"' })).id;
    const evilTag = (await ok('POST', '/api/tags', { name: "t' OR 1=1 --" })).id;
    await ok('POST', `/api/albums/${evil}/add`, { asset_ids: [12] });
    await ok('POST', `/api/albums/${quote}/add`, { asset_ids: [11] });
    await ok('POST', '/api/tags/apply', { asset_ids: [4], add: [evilTag] });
    assert.deepEqual(await queryQ(`album:"x'); DROP TABLE assets; --"`), [12]);
    assert.deepEqual(await queryAst({ op: 'album', id: quote }), [11]);
    assert.deepEqual(await queryQ(`tag:"t' OR 1=1 --"`), [4]);
    assert.deepEqual(await queryQ(''), ALL_ACTIVE); // assets table intact
    await ok('DELETE', `/api/albums/${evil}`);
    await ok('DELETE', `/api/albums/${quote}`);
    await ok('DELETE', `/api/tags/${evilTag}`);
  });
});

describe('facets', () => {
  test('facet counts equal the corresponding filtered result sizes', async () => {
    const f = await ok('POST', '/api/facets', { q: `album:客戶A` });
    assert.equal(f.total, 6);
    for (const [tagId, q] of [[ids.receipt, 'tag:類型/收據'], [ids.invoice, 'tag:類型/發票'], [ids.place, 'tag:地點'], [ids.type, 'tag:類型']]) {
      const n = (await queryQ(`album:客戶A ${q}`)).length;
      assert.equal(f.tags[tagId] ?? 0, n, q);
    }
    for (const [albumId, name] of [[ids.A, '客戶A'], [ids.B, 'B'], [ids.X, 'X']]) {
      const n = (await queryQ(`album:客戶A album:${name}`)).length;
      assert.equal(f.albums[albumId] ?? 0, n, name);
    }
  });
  test('parent tag facet counts distinct assets across its subtree', async () => {
    const f = await ok('POST', '/api/facets', {});
    assert.equal(f.tags[ids.type], 6);
    assert.equal(f.tags[ids.receipt], 4); // trashed #13 excluded
  });
});

describe('smart albums', () => {
  test('re-evaluated live: newly tagged photo appears', async () => {
    const s = await ok('POST', '/api/smart', { name: '收據', q: 'tag:類型/收據' });
    assert.deepEqual(await queryQ(`smart:#${s.id}`), [2, 5, 7, 11]);
    await ok('POST', '/api/tags/apply', { asset_ids: [12], add: [ids.receipt] });
    assert.deepEqual(await queryQ(`smart:收據`), [2, 5, 7, 11, 12]);
    await ok('POST', '/api/tags/apply', { asset_ids: [12], remove: [ids.receipt] });
    assert.deepEqual(await queryQ(`smart:收據`), [2, 5, 7, 11]);
  });
  test('cannot reference itself', async () => {
    const s = await ok('POST', '/api/smart', { name: 'self', q: 'has:tag' });
    const r = await call('PATCH', `/api/smart/${s.id}`, { q: `smart:#${s.id}` });
    assert.equal(r.status, 400);
  });
});

describe('tag management', () => {
  test('path creation is idempotent and builds ancestors', async () => {
    const a = await ok('POST', '/api/tags', { name: '專案/甲/設計' });
    const b = await call('POST', '/api/tags', { name: '專案/甲/設計' });
    assert.equal(b.status, 200);
    assert.equal(b.body.id, a.id);
    assert.equal(b.body.created, false);
  });
  test('system tags cannot be renamed or deleted', async () => {
    const sensitive = (await ok('GET', '/api/tags')).find((t) => t.name === 'sensitive');
    assert.equal(sensitive.is_system, true);
    assert.equal((await call('PATCH', `/api/tags/${sensitive.id}`, { name: 'x' })).status, 403);
    assert.equal((await call('DELETE', `/api/tags/${sensitive.id}`)).status, 403);
  });
  test('cannot move a tag under its own descendant', async () => {
    const parent = await ok('POST', '/api/tags', { name: '迴圈/子' });
    const top = (await ok('GET', '/api/tags')).find((t) => t.name === '迴圈').id;
    assert.equal((await call('PATCH', `/api/tags/${top}`, { parent_id: parent.id })).status, 400);
  });
  test('deleting a tag removes its subtree and links, never photos', async () => {
    const t = await ok('POST', '/api/tags', { name: '暫時/子' });
    const top = (await ok('GET', '/api/tags')).find((x) => x.name === '暫時').id;
    await ok('POST', '/api/tags/apply', { asset_ids: [1, 2], add: [t.id] });
    const r = await ok('DELETE', `/api/tags/${top}`);
    assert.deepEqual(r, { deleted_tags: 2, removed_links: 2 });
    assert.deepEqual(await queryQ(''), ALL_ACTIVE);
  });
  test('apply validates ids', async () => {
    assert.equal((await call('POST', '/api/tags/apply', { asset_ids: [999], add: [ids.place] })).status, 404);
    assert.equal((await call('POST', '/api/tags/apply', { asset_ids: [], add: [ids.place] })).status, 400);
    assert.equal((await call('POST', '/api/tags/apply', { asset_ids: [1] })).status, 400);
  });
});

describe('albums', () => {
  test('membership is many-to-many and shows on asset detail', async () => {
    const d = await ok('GET', '/api/assets/5');
    assert.deepEqual(sorted(d.albums), sorted([ids.A, ids.B]));
    assert.ok(d.tags.some((t) => t.id === ids.receipt));
  });
  test('album order + reorder', async () => {
    const al = (await ok('POST', '/api/albums', { name: '排序' })).id;
    await ok('POST', `/api/albums/${al}/add`, { asset_ids: [3, 1, 2] });
    const order = async () => (await ok('POST', '/api/query', { q: `album:#${al}`, sort: 'album', album_id: al, order: 'asc' })).ids;
    assert.deepEqual(await order(), [3, 1, 2]);
    await ok('POST', `/api/albums/${al}/reorder`, { asset_ids: [2], before_asset_id: 3 });
    assert.deepEqual(await order(), [2, 3, 1]);
    await ok('POST', `/api/albums/${al}/remove`, { asset_ids: [3] });
    assert.deepEqual(await order(), [2, 1]);
  });
  test('deleting an album keeps the photos; deleting a folder keeps its albums', async () => {
    const folder = await ok('POST', '/api/folders', { name: '工作' });
    const al = await ok('POST', '/api/albums', { name: '暫存', folder_id: folder.id });
    await ok('POST', `/api/albums/${al.id}/add`, { asset_ids: [1, 2] });
    await ok('DELETE', `/api/folders/${folder.id}`);
    const kept = (await ok('GET', '/api/albums')).find((a) => a.id === al.id);
    assert.equal(kept.folder_id, null);
    assert.equal(kept.count, 2);
    assert.deepEqual(await ok('DELETE', `/api/albums/${al.id}`), { removed_items: 2 });
    assert.deepEqual(await queryQ(''), ALL_ACTIVE);
  });
});

describe('parser (unit)', () => {
  const r = { resolveTag: (p) => (p === 'a' ? [1] : []), resolveAlbum: (n) => (n === 'b c' ? [2] : []), resolveSmart: () => [] };
  test('quoted values, negation shorthand, bare words', () => {
    assert.deepEqual(parseQuery('album:"b c" -tag:a hello', r), {
      op: 'and', args: [{ op: 'album', id: 2 }, { op: 'not', arg: { op: 'tag', id: 1 } }, { op: 'text', q: 'hello' }],
    });
  });
  test('keywords are case-insensitive; quoted keyword is text', () => {
    assert.deepEqual(parseQuery('tag:a or "and"', r), { op: 'or', args: [{ op: 'tag', id: 1 }, { op: 'text', q: 'and' }] });
  });
});

describe('acceptance follow-ups', () => {
  test('parent facet counts an asset once even with two tags in its subtree', async () => {
    const x = await ok('POST', '/api/tags', { name: '去重/x' });
    const y = await ok('POST', '/api/tags', { name: '去重/y' });
    const top = (await ok('GET', '/api/tags')).find((t) => t.name === '去重').id;
    await ok('POST', '/api/tags/apply', { asset_ids: [1], add: [x.id, y.id, top] });
    const fc = await ok('POST', '/api/facets', {});
    assert.equal(fc.tags[top], 1);
    await ok('DELETE', `/api/tags/${top}`);
  });

  test('deleting a tag really removes its descendants', async () => {
    const leaf = await ok('POST', '/api/tags', { name: '串/中/葉' });
    const top = (await ok('GET', '/api/tags')).find((t) => t.name === '串').id;
    await ok('DELETE', `/api/tags/${top}`);
    const left = (await ok('GET', '/api/tags')).filter((t) => ['串', '中', '葉'].includes(t.name) || t.id === leaf.id);
    assert.deepEqual(left, []);
  });

  test('smart albums nested beyond the depth limit are rejected', async () => {
    let prev = await ok('POST', '/api/smart', { name: 'd0', q: 'has:tag' });
    const made = [prev];
    let rejected = null;
    for (let i = 1; i <= 10 && !rejected; i++) {
      const r = await call('POST', '/api/smart', { name: `d${i}`, q: `smart:#${prev.id}` });
      if (r.status === 400) rejected = i;
      else { prev = r.body; made.push(prev); }
    }
    assert.equal(rejected, 9, 'a chain of 8 smart references saves; the 9th exceeds MAX_SMART_DEPTH');
    for (const s of made.reverse()) await ok('DELETE', `/api/smart/${s.id}`);
  });

  test('a smart album referenced by another cannot be deleted', async () => {
    const base = await ok('POST', '/api/smart', { name: 'base', q: 'has:tag' });
    const user = await ok('POST', '/api/smart', { name: 'user', q: `smart:#${base.id} -album:X` });
    const r = await call('DELETE', `/api/smart/${base.id}`);
    assert.equal(r.status, 409);
    assert.match(r.body.message, /user/);
    await ok('DELETE', `/api/smart/${user.id}`);
    await ok('DELETE', `/api/smart/${base.id}`);
  });

  test('quoted names support \\" and \\\\ escapes', async () => {
    const al = await ok('POST', '/api/albums', { name: 'say "hi" \\ bye' });
    await ok('POST', `/api/albums/${al.id}/add`, { asset_ids: [3] });
    assert.deepEqual(await queryQ('album:"say \\"hi\\" \\\\ bye"'), [3]);
    await ok('DELETE', `/api/albums/${al.id}`);
  });
});
