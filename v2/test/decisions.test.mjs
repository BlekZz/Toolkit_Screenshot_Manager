import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createActionRunner } from '../server/decisions.mjs';
import { tagIdByPath } from '../server/suggestions.mjs';
import { cleanup, startTestServer, tempDir } from './helpers.mjs';

let dir, app, base, db;
beforeEach(async () => {
  dir = tempDir('decide');
  ({ app, base } = await startTestServer(dir));
  db = app.lib.db;
});
afterEach(async () => { await app.close(); cleanup(dir); });

const send = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const post = (url, body) => send('POST', url, body);
const get = (url) => send('GET', url);

let seq = 0;
/** Inserts an asset row (no file needed). */
function asset(status = 'active') {
  seq++;
  return Number(db.prepare(`INSERT INTO assets (root_id, rel_path, sha256, filename, ext, width, height, bytes,
    file_mtime, imported_at, status) VALUES (?, ?, ?, ?, 'png', 100, 100, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`)
    .run(app.lib.managedRootId, `x/${seq}.png`, String(seq).padStart(64, '0'), `IMG_${seq}.PNG`, status).lastInsertRowid);
}
const tid = (p) => tagIdByPath(db, p);
/** Inserts a pending suggestion; returns its id. */
function sugg(assetId, path, { stage = 'vlm', confidence = 0.8, model = 'm' } = {}) {
  return Number(db.prepare(`INSERT INTO asset_suggestions (asset_id, tag_id, stage, confidence, reason, model, created_at)
    VALUES (?, ?, ?, ?, 'r', ?, '2026-10-01T00:00:00.000Z')`).run(assetId, tid(path), stage, confidence, model).lastInsertRowid);
}
const status = (id) => db.prepare('SELECT status FROM asset_suggestions WHERE id = ?').get(id).status;
const tagRow = (a, path) => db.prepare('SELECT source FROM asset_tags WHERE asset_id = ? AND tag_id = ?').get(a, tid(path));
const album = (name) => db.prepare('SELECT * FROM albums WHERE name = ?').get(name);
const inAlbum = (albumId, a) => !!db.prepare('SELECT 1 FROM album_items WHERE album_id = ? AND asset_id = ?').get(albumId, a);
const snapshot = (sql) => JSON.stringify(db.prepare(sql).all());

describe('accept (HTTP)', () => {
  test('lists pending by confidence; accept writes source=ai, cascades stages, supersedes other purpose, runs receipt album', async () => {
    const a = asset();
    const vlm = sugg(a, 'purpose/receipt', { confidence: 0.9 });
    const rule = sugg(a, 'purpose/receipt', { stage: 'rule', confidence: 0.7 });
    const eph = sugg(a, 'purpose/ephemeral', { confidence: 0.4 });
    const ctx = sugg(a, 'context/work', { confidence: 0.8 });

    const list = await get(`/api/assets/${a}/suggestions`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((s) => s.id), [vlm, ctx, rule, eph]);
    assert.equal(list.body[0].tag_path, 'purpose/receipt');
    assert.equal(list.body[0].stage, 'vlm');
    assert.equal(list.body[0].model, 'm');
    assert.equal((await get('/api/assets/999999/suggestions')).status, 404);

    const res = await post('/api/suggestions/accept', { ids: [vlm] });
    assert.equal(res.status, 200);
    assert.equal(tagRow(a, 'purpose/receipt').source, 'ai');
    assert.equal(status(vlm), 'accepted');
    assert.equal(status(rule), 'accepted');
    assert.equal(status(eph), 'superseded');
    assert.equal(status(ctx), 'pending');
    assert.equal(res.body.accepted, 2);
    assert.equal(res.body.superseded, 1);
    assert.equal(res.body.tagsAdded, 1);
    const receipts = album('收據');
    assert.ok(receipts, 'album 收據 created');
    assert.ok(inAlbum(receipts.id, a));
    assert.deepEqual(res.body.actions, [{ kind: 'album', target: '收據', asset_id: a, result: 'added', created: true }]);
    assert.ok(Number.isInteger(res.body.event_id));
    assert.deepEqual((await get(`/api/assets/${a}/suggestions`)).body.map((s) => s.id), [ctx]);
  });

  test('ephemeral accept adds triage/later as source=ai', async () => {
    const a = asset();
    const s = sugg(a, 'purpose/ephemeral');
    const res = await post('/api/suggestions/accept', { ids: [s] });
    assert.equal(res.status, 200);
    assert.equal(tagRow(a, 'triage/later').source, 'ai');
    assert.deepEqual(res.body.actions, [{ kind: 'tag', target: 'triage/later', asset_id: a, result: 'added' }]);
  });

  test('only pending can be accepted: decided → 409, unknown → 404, mixed batch rolls back', async () => {
    const a = asset();
    const s1 = sugg(a, 'context/work');
    const s2 = sugg(a, 'context/personal');
    assert.equal((await post('/api/suggestions/reject', { ids: [s2] })).status, 200);
    const tagsBefore = snapshot('SELECT * FROM asset_tags');
    const mixed = await post('/api/suggestions/accept', { ids: [s1, s2] });
    assert.equal(mixed.status, 409);
    assert.match(mixed.body.message, /only pending/);
    assert.equal(status(s1), 'pending');
    assert.equal(status(s2), 'rejected');
    assert.equal(snapshot('SELECT * FROM asset_tags'), tagsBefore);
    assert.equal((await post('/api/suggestions/accept', { ids: [999999] })).status, 404);
    assert.equal((await post('/api/suggestions/accept', { ids: [] })).status, 400);
  });

  test('two purpose tags for one asset in one batch → 400', async () => {
    const a = asset();
    const r = sugg(a, 'purpose/receipt');
    const c = sugg(a, 'purpose/chat');
    assert.equal((await post('/api/suggestions/accept', { ids: [r, c] })).status, 400);
    assert.equal(status(r), 'pending');
  });

  test('binding whose target tag no longer exists is recorded as skipped, not a crash', async () => {
    const tmp = await post('/api/tags', { name: 'custom/暫時' });
    const action = await post('/api/tag-actions', { tag_id: tid('purpose/chat'), kind: 'tag', target: 'custom/暫時' });
    assert.equal(action.status, 201);
    assert.equal((await send('DELETE', `/api/tags/${tmp.body.id}`)).status, 200);
    const a = asset();
    const res = await post('/api/suggestions/accept', { ids: [sugg(a, 'purpose/chat')] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.actions, [{ kind: 'tag', target: 'custom/暫時', asset_id: a, result: 'skipped' }]);
    assert.equal(tagRow(a, 'purpose/chat').source, 'ai');
  });

  test('disabled bindings do not run', async () => {
    const seed = (await get('/api/tag-actions')).body.find((x) => x.target === 'triage/later');
    assert.equal((await send('PATCH', `/api/tag-actions/${seed.id}`, { enabled: false })).status, 200);
    const a = asset();
    const res = await post('/api/suggestions/accept', { ids: [sugg(a, 'purpose/ephemeral')] });
    assert.deepEqual(res.body.actions, []);
    assert.equal(tagRow(a, 'triage/later'), undefined);
  });
});

describe('reject (HTTP)', () => {
  test('pending → rejected, asset_tags untouched; undo restores pending', async () => {
    const a = asset();
    db.prepare("INSERT INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'manual', 'x')").run(a, tid('context/work'));
    const s = sugg(a, 'purpose/receipt');
    const tagsBefore = snapshot('SELECT * FROM asset_tags');
    const res = await post('/api/suggestions/reject', { ids: [s] });
    assert.equal(res.status, 200);
    assert.equal(res.body.rejected, 1);
    assert.equal(status(s), 'rejected');
    assert.equal(snapshot('SELECT * FROM asset_tags'), tagsBefore);
    assert.equal(album('收據'), undefined);
    assert.equal((await post('/api/suggestions/reject', { ids: [s] })).status, 409);
    assert.equal((await post('/api/suggestions/undo', { event_id: res.body.event_id })).status, 200);
    assert.equal(status(s), 'pending');
  });
});

describe('undo (HTTP)', () => {
  test('undo accept restores statuses, AI tags, album items and the emptied created album; second undo → 409', async () => {
    const a = asset();
    const vlm = sugg(a, 'purpose/receipt');
    const rule = sugg(a, 'purpose/receipt', { stage: 'rule' });
    const eph = sugg(a, 'purpose/ephemeral');
    const tagsBefore = snapshot('SELECT * FROM asset_tags ORDER BY asset_id, tag_id');
    const acc = await post('/api/suggestions/accept', { ids: [vlm] });
    assert.ok(album('收據'));
    const undo = await post('/api/suggestions/undo', { event_id: acc.body.event_id });
    assert.equal(undo.status, 200);
    assert.deepEqual([status(vlm), status(rule), status(eph)], ['pending', 'pending', 'pending']);
    assert.equal(db.prepare('SELECT decided_at FROM asset_suggestions WHERE id = ?').get(vlm).decided_at, null);
    assert.equal(snapshot('SELECT * FROM asset_tags ORDER BY asset_id, tag_id'), tagsBefore);
    assert.equal(album('收據'), undefined, 'created album removed once empty');
    assert.equal(undo.body.albums_removed, 1);
    const again = await post('/api/suggestions/undo', { event_id: acc.body.event_id });
    assert.equal(again.status, 409);
  });

  test('undo keeps a created album that gained other items, removes only its own item', async () => {
    const a = asset();
    const b = asset();
    const acc = await post('/api/suggestions/accept', { ids: [sugg(a, 'purpose/receipt')] });
    const al = album('收據');
    await post(`/api/albums/${al.id}/add`, { asset_ids: [b] });
    const undo = await post('/api/suggestions/undo', { event_id: acc.body.event_id });
    assert.equal(undo.body.albums_kept, 1);
    assert.ok(album('收據'));
    assert.ok(!inAlbum(al.id, a));
    assert.ok(inAlbum(al.id, b));
  });

  test('pre-existing album is reused and never deleted by undo', async () => {
    const pre = await post('/api/albums', { name: '收據' });
    const a = asset();
    const acc = await post('/api/suggestions/accept', { ids: [sugg(a, 'purpose/receipt')] });
    assert.equal(acc.body.actions[0].created, undefined);
    assert.ok(inAlbum(pre.body.id, a));
    await post('/api/suggestions/undo', { event_id: acc.body.event_id });
    assert.ok(album('收據'));
    assert.ok(!inAlbum(pre.body.id, a));
  });

  test('manual tag that existed before accept survives undo', async () => {
    const a = asset();
    db.prepare("INSERT INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'manual', 'x')").run(a, tid('purpose/ephemeral'));
    db.prepare("INSERT INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'manual', 'x')").run(a, tid('triage/later'));
    const acc = await post('/api/suggestions/accept', { ids: [sugg(a, 'purpose/ephemeral')] });
    assert.equal(acc.body.tagsAdded, 0);
    await post('/api/suggestions/undo', { event_id: acc.body.event_id });
    assert.equal(tagRow(a, 'purpose/ephemeral').source, 'manual');
    assert.equal(tagRow(a, 'triage/later').source, 'manual');
  });

  test('AI tag that became non-ai after accept is not deleted by undo', async () => {
    const a = asset();
    const acc = await post('/api/suggestions/accept', { ids: [sugg(a, 'context/work')] });
    db.prepare("UPDATE asset_tags SET source = 'manual' WHERE asset_id = ? AND tag_id = ?").run(a, tid('context/work'));
    const undo = await post('/api/suggestions/undo', { event_id: acc.body.event_id });
    assert.equal(undo.body.tags_kept, 1);
    assert.equal(tagRow(a, 'context/work').source, 'manual');
  });

  test('status changed after the decision is left alone and counted', async () => {
    const a = asset();
    const s = sugg(a, 'context/work');
    const acc = await post('/api/suggestions/accept', { ids: [s] });
    db.prepare("UPDATE asset_suggestions SET status = 'rejected' WHERE id = ?").run(s);
    const undo = await post('/api/suggestions/undo', { event_id: acc.body.event_id });
    assert.equal(undo.body.statuses_skipped, 1);
    assert.equal(status(s), 'rejected');
  });

  test('undo only accepts suggestion decision events', async () => {
    const t = await post('/api/tags', { name: 'custom/x' });
    const ev = db.prepare("SELECT id FROM events WHERE action = 'tag.create' ORDER BY id DESC").get().id;
    assert.ok(t.body.id);
    assert.equal((await post('/api/suggestions/undo', { event_id: ev })).status, 400);
    assert.equal((await post('/api/suggestions/undo', { event_id: 999999 })).status, 404);
    assert.equal((await post('/api/suggestions/undo', {})).status, 400);
  });
});

describe('tag actions', () => {
  test('seeds: receipt → album 收據, ephemeral → tag triage/later', async () => {
    const list = (await get('/api/tag-actions')).body;
    assert.deepEqual(list.map((x) => [x.tag_path, x.kind, x.target, x.is_seed, x.enabled]).sort(), [
      ['purpose/ephemeral', 'tag', 'triage/later', true, true],
      ['purpose/receipt', 'album', '收據', true, true],
    ]);
  });

  test('CRUD with validation; trash kind refused at API (400) and DB (CHECK)', async () => {
    const tag = tid('purpose/text-note');
    const trash = await post('/api/tag-actions', { tag_id: tag, kind: 'trash', target: 'x' });
    assert.equal(trash.status, 400);
    assert.match(trash.body.message, /not allowed/);
    assert.throws(() => db.prepare("INSERT INTO tag_actions (tag_id, kind, target, created_at) VALUES (?, 'trash', 'x', 'x')").run(tag),
      /CHECK constraint failed/);
    assert.throws(() => db.prepare("INSERT INTO tag_actions (tag_id, kind, target, created_at) VALUES (?, 'status', 'trashed', 'x')").run(tag),
      /CHECK constraint failed/);
    assert.equal((await post('/api/tag-actions', { tag_id: tag, kind: 'tag', target: 'no/such' })).status, 400);
    assert.equal((await post('/api/tag-actions', { tag_id: tag, kind: 'album', target: '   ' })).status, 400);
    assert.equal((await post('/api/tag-actions', { tag_id: tag, kind: 'album', target: 'x'.repeat(101) })).status, 400);
    assert.equal((await post('/api/tag-actions', { tag_id: 999999, kind: 'album', target: 'x' })).status, 404);

    const c = await post('/api/tag-actions', { tag_id: tag, kind: 'album', target: '  筆記  ' });
    assert.equal(c.status, 201);
    assert.equal(c.body.target, '筆記');
    assert.equal((await post('/api/tag-actions', { tag_id: tag, kind: 'album', target: '筆記' })).status, 409);
    const bad = await send('PATCH', `/api/tag-actions/${c.body.id}`, { kind: 'delete' });
    assert.equal(bad.status, 400);
    const up = await send('PATCH', `/api/tag-actions/${c.body.id}`, { kind: 'tag', target: 'triage/later' });
    assert.equal(up.status, 200);
    assert.equal(up.body.kind, 'tag');
    assert.equal((await send('DELETE', `/api/tag-actions/${c.body.id}`)).status, 200);
    assert.equal((await send('DELETE', `/api/tag-actions/${c.body.id}`)).status, 404);
  });

  test('action runner throws on unknown kinds instead of skipping', () => {
    const undo = { asset_tags: [], album_items: [], albums_created: [] };
    const run = createActionRunner(db, undo);
    const a = asset();
    for (const kind of ['trash', 'status', 'delete', '']) assert.throws(() => run({ kind, target: 'x' }, a), /unknown tag action kind/);
    assert.deepEqual(undo, { asset_tags: [], album_items: [], albums_created: [] });
  });
});

describe('invariant: no AI decision changes assets.status', () => {
  test('bindings of every kind + accepting every suggestion in the library leaves all statuses identical', async () => {
    const statuses = ['active', 'trashed', 'missing'];
    const assets = Array.from({ length: 9 }, (_, i) => asset(statuses[i % 3]));
    const purposes = ['text-note', 'chat', 'translate', 'visual-ref', 'receipt', 'ephemeral'].map((p) => `purpose/${p}`);
    for (const p of purposes) {
      await post('/api/tag-actions', { tag_id: tid(p), kind: 'album', target: `綁定-${p}` });
      await post('/api/tag-actions', { tag_id: tid(p), kind: 'tag', target: 'triage/later' });
    }
    await post('/api/tag-actions', { tag_id: tid('context/work'), kind: 'tag', target: 'purpose/ephemeral' });
    await post('/api/tag-actions', { tag_id: tid('sensitive'), kind: 'album', target: '敏感' });
    for (const a of assets) {
      for (const p of [...purposes, 'context/work', 'context/personal', 'sensitive']) {
        sugg(a, p, { stage: 'vlm' });
        sugg(a, p, { stage: 'rule', model: '' });
      }
    }
    const before = snapshot('SELECT id, status FROM assets ORDER BY id');
    let accepted = 0;
    for (let s = db.prepare("SELECT id FROM asset_suggestions WHERE status = 'pending' ORDER BY id LIMIT 1").get(); s;
      s = db.prepare("SELECT id FROM asset_suggestions WHERE status = 'pending' ORDER BY id LIMIT 1").get()) {
      const res = await post('/api/suggestions/accept', { ids: [s.id] });
      assert.equal(res.status, 200);
      accepted += res.body.accepted;
    }
    assert.ok(accepted > assets.length * 3);
    assert.equal(db.prepare("SELECT count(*) AS n FROM asset_suggestions WHERE status = 'pending'").get().n, 0);
    assert.ok(db.prepare("SELECT count(*) AS n FROM album_items").get().n > 0);
    assert.equal(snapshot('SELECT id, status FROM assets ORDER BY id'), before);
  });
});
