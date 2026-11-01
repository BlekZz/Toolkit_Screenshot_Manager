import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openDb } from '../server/db.mjs';
import { tagIdByPath } from '../server/suggestions.mjs';
import { cleanup, startTestServer, tempDir } from './helpers.mjs';

// P2a 通用 undo（Sprint §7 Z 鍵、§10.1 P2「undo 20 步全部還原」）：全部走真實 HTTP。

let dir, app, base, db;
beforeEach(async () => {
  dir = tempDir('undo');
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
const ok = async (method, url, body) => {
  const r = await send(method, url, body);
  assert.ok(r.status < 300, `${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

let seq = 0;
function asset(status = 'active') {
  seq++;
  return Number(db.prepare(`INSERT INTO assets (root_id, rel_path, sha256, filename, ext, width, height, bytes,
    file_mtime, imported_at, status) VALUES (?, ?, ?, ?, 'png', 400, 300, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?)`)
    .run(app.lib.managedRootId, `u/${seq}.png`, `u${String(seq).padStart(63, '0')}`, `U_${seq}.PNG`, status).lastInsertRowid);
}

const TABLES = ['assets', 'tags', 'asset_tags', 'album_folders', 'albums', 'album_items', 'smart_albums', 'crops',
  'bundles', 'bundle_items', 'settings', 'asset_suggestions', 'tag_actions', 'tag_matchers', 'ocr_results'];
/** Complete content of every catalogue table, order-independent. */
const snapshot = () => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all().map((r) => JSON.stringify(r)).sort()]));

describe('20+ mixed steps, undone one by one, each undo restores the exact pre-step state', () => {
  test('tag / album / folder / smart / crop / bundle / trash / slots / suggestion accept', async () => {
    const [a1, a2, a3, a4] = [asset(), asset(), asset(), asset('missing')];
    const migrationTag = Number(db.prepare("INSERT INTO tags (parent_id, name) VALUES (NULL, 'legacy')").run().lastInsertRowid);
    db.prepare("INSERT INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'migration', '2026-09-01T00:00:00.000Z')").run(a3, migrationTag);
    const sugg = Number(db.prepare(`INSERT INTO asset_suggestions (asset_id, tag_id, stage, confidence, model, created_at)
      VALUES (?, ?, 'vlm', 0.9, 'm', '2026-10-01T00:00:00.000Z')`).run(a1, tagIdByPath(db, 'purpose/receipt')).lastInsertRowid);
    const start = snapshot();

    const steps = [];
    const before = []; // before[i] = full snapshot taken right before step i
    const step = async (label, method, url, b) => {
      before.push(snapshot());
      const r = await ok(method, url, b);
      steps.push(label);
      return r;
    };

    const tag = await step('tag.create', 'POST', '/api/tags', { name: 'p2/sub' });
    await step('tags.apply add', 'POST', '/api/tags/apply', { asset_ids: [a1, a2], add: [tag.id] });
    const album = await step('album.create', 'POST', '/api/albums', { name: 'Triage' });
    await step('album.add', 'POST', `/api/albums/${album.id}/add`, { asset_ids: [a1, a2, a3] });
    await step('album.reorder', 'POST', `/api/albums/${album.id}/reorder`, { asset_ids: [a3], before_asset_id: a1 });
    await step('album.remove', 'POST', `/api/albums/${album.id}/remove`, { asset_ids: [a2] });
    const c1 = await step('crop.create', 'POST', `/api/assets/${a1}/crops`, { x: 0.1, y: 0.1, w: 0.5, h: 0.5, ratio_label: '1:1' });
    await step('crop.create', 'POST', `/api/assets/${a2}/crops`, { x: 0, y: 0, w: 1, h: 0.25 });
    const bundle = await step('bundle.create', 'POST', '/api/bundles', {});
    await step('bundle.add crop', 'POST', `/api/bundles/${bundle.id}/items`, { crop_id: c1.id });
    const item = await step('bundle.add asset', 'POST', `/api/bundles/${bundle.id}/items`, { asset_id: a3 });
    await step('crop.delete (cascades bundle item)', 'DELETE', `/api/crops/${c1.id}`);
    await step('bundle.remove', 'DELETE', `/api/bundles/${bundle.id}/items/${item.id}`);
    const tr = await step('assets.trash', 'POST', '/api/assets/trash', { ids: [a2, a4] });
    assert.deepEqual([tr.trashed, tr.skipped_missing], [1, 1]);
    await step('tags.apply remove migration tag', 'POST', '/api/tags/apply', { asset_ids: [a3], remove: [migrationTag] });
    await step('tag.update', 'PATCH', `/api/tags/${tag.id}`, { name: 'renamed', color: '#112233' });
    await step('slots', 'PUT', '/api/settings/triage-slots', [{ kind: 'tag', id: tag.id }, { kind: 'album', id: album.id }, ...Array(7).fill(null)]);
    await step('bundle.update', 'PATCH', `/api/bundles/${bundle.id}`, { status: 'closed', name: 'done' });
    await step('assets.restore', 'POST', '/api/assets/restore', { ids: [a2] });
    const folder = await step('folder.create', 'POST', '/api/folders', { name: 'F' });
    await step('album.update', 'PATCH', `/api/albums/${album.id}`, { folder_id: folder.id, cover_asset_id: a3 });
    const smart = await step('smart.create', 'POST', '/api/smart', { name: 'S', q: 'tag:p2' });
    await step('smart.update', 'PATCH', `/api/smart/${smart.id}`, { name: 'S2' });
    await step('folder.update', 'PATCH', `/api/folders/${folder.id}`, { name: 'F2' });
    await step('folder.delete', 'DELETE', `/api/folders/${folder.id}`);
    await step('suggestions.accept', 'POST', '/api/suggestions/accept', { ids: [sugg] });
    await step('smart.delete', 'DELETE', `/api/smart/${smart.id}`);
    await step('album.delete', 'DELETE', `/api/albums/${album.id}`);
    await step('tag.delete subtree', 'DELETE', `/api/tags/${tagIdByPath(db, 'p2')}`);
    assert.ok(steps.length >= 20, `only ${steps.length} steps`);
    assert.notDeepEqual(snapshot(), start);

    const list = await ok('GET', '/api/undo');
    assert.equal(list.length, steps.length);
    assert.ok(list.every((e) => e.supported && typeof e.summary === 'string' && e.ts));
    assert.equal(list[0].action, 'tag.delete');

    for (let i = steps.length - 1; i >= 0; i--) {
      const r = await send('POST', '/api/undo');
      assert.equal(r.status, 200, `undo of step ${i} (${steps[i]}): ${JSON.stringify(r.body)}`);
      assert.deepEqual(snapshot(), before[i], `state after undoing step ${i} (${steps[i]}) differs from the state before it`);
    }
    assert.deepEqual(snapshot(), start);
    const none = await send('POST', '/api/undo');
    assert.equal(none.status, 404);
    assert.deepEqual(await ok('GET', '/api/undo'), []);
    // every user event is now marked undone, by an undo event that is itself not undoable
    const open = db.prepare("SELECT count(*) AS n FROM events WHERE undo_json IS NOT NULL AND undone_by IS NULL").get().n;
    assert.equal(open, 0);
  });
});

describe('undo engine rules (HTTP)', () => {
  test('tag/album apply returns event_id; no-op applies log no undoable event', async () => {
    const a = asset();
    const tag = await ok('POST', '/api/tags', { name: 'noop-check' });
    const al = await ok('POST', '/api/albums', { name: 'noop-album' });
    const count = () => db.prepare("SELECT COUNT(*) AS n FROM events WHERE action IN ('tags.apply', 'album.add', 'album.remove')").get().n;

    const t1 = await ok('POST', '/api/tags/apply', { asset_ids: [a], add: [tag.id] });
    assert.ok(Number.isInteger(t1.event_id));
    const a1 = await ok('POST', `/api/albums/${al.id}/add`, { asset_ids: [a] });
    assert.ok(Number.isInteger(a1.event_id));
    const before = count();
    const t2 = await ok('POST', '/api/tags/apply', { asset_ids: [a], add: [tag.id] }); // already tagged
    const a2 = await ok('POST', `/api/albums/${al.id}/add`, { asset_ids: [a] }); // already in album
    const r2 = await ok('POST', `/api/albums/${al.id}/remove`, { asset_ids: [asset()] }); // not in album
    assert.deepEqual([t2.event_id, a2.event_id, r2.event_id], [null, null, null]);
    assert.equal(count(), before);
    const u = await ok('POST', '/api/undo');
    assert.equal(u.undone_event_id, a1.event_id, 'Z undoes the last real change, not a no-op');
  });

  test('trash → undo restores active; restore of a since-missing asset is skipped, not forced', async () => {
    const [a, b, m] = [asset(), asset(), asset('missing')];
    const tr = await ok('POST', '/api/assets/trash', { ids: [a, b, m] });
    assert.deepEqual([tr.trashed, tr.skipped_missing, tr.skipped], [2, 1, 0]);
    db.prepare("UPDATE assets SET status = 'missing' WHERE id = ?").run(b); // file vanished meanwhile
    const u = await ok('POST', '/api/undo', { event_id: tr.event_id });
    assert.deepEqual([u.result.assets_reverted, u.result.assets_skipped], [1, 1]);
    const st = (id) => db.prepare('SELECT status FROM assets WHERE id = ?').get(id).status;
    assert.deepEqual([st(a), st(b), st(m)], ['active', 'missing', 'missing']);
  });

  test('undo of an already undone event → 409; the undo event itself is not undoable → 400', async () => {
    const a = asset();
    const tr = await ok('POST', '/api/assets/trash', { ids: [a] });
    const u = await ok('POST', '/api/undo', { event_id: tr.event_id });
    const again = await send('POST', '/api/undo', { event_id: tr.event_id });
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already been undone/);
    assert.equal(db.prepare('SELECT undone_by FROM events WHERE id = ?').get(tr.event_id).undone_by, u.event_id);
    assert.equal((await send('POST', '/api/undo', { event_id: u.event_id })).status, 400);
  });

  test('unknown action with undo_json → 400 (explicit and as the latest event), never silently skipped', async () => {
    const a = asset();
    await ok('POST', '/api/assets/trash', { ids: [a] });
    const ev = Number(db.prepare(`INSERT INTO events (ts, actor, action, payload_json, undo_json)
      VALUES ('2026-11-01T00:00:00.000Z', 'user', 'mystery.op', '{}', '{"op":"x"}')`).run().lastInsertRowid);
    const byId = await send('POST', '/api/undo', { event_id: ev });
    assert.equal(byId.status, 400);
    assert.match(byId.body.message, /no undo handler for action "mystery\.op"/);
    assert.equal((await send('POST', '/api/undo')).status, 400);
    assert.equal(db.prepare("SELECT status FROM assets WHERE id = ?").get(a).status, 'trashed');
    assert.equal(db.prepare('SELECT undone_by FROM events WHERE id = ?').get(ev).undone_by, null);
    const listed = (await ok('GET', '/api/undo')).find((e) => e.id === ev);
    assert.equal(listed.supported, false);
  });

  test('bad / unknown event ids', async () => {
    assert.equal((await send('POST', '/api/undo', { event_id: 'x' })).status, 400);
    assert.equal((await send('POST', '/api/undo', { event_id: 999999 })).status, 404);
    assert.equal((await send('POST', '/api/undo')).status, 404); // nothing to undo
  });

  test('out-of-order undo that would lose later work → 409 and nothing changes', async () => {
    const a = asset();
    const crop = await ok('POST', `/api/assets/${a}/crops`, { x: 0, y: 0, w: 0.5, h: 0.5 });
    const b = await ok('POST', '/api/bundles', { name: 'B' });
    await ok('POST', `/api/bundles/${b.id}/items`, { crop_id: crop.id });
    const before = snapshot();
    const r = await send('POST', '/api/undo', { event_id: crop.event_id });
    assert.equal(r.status, 409);
    assert.deepEqual(snapshot(), before);
    const al = await ok('POST', '/api/albums', { name: 'A' });
    await ok('POST', `/api/albums/${al.id}/add`, { asset_ids: [a] });
    const ev = db.prepare("SELECT id FROM events WHERE action = 'album.create' ORDER BY id DESC").get().id;
    assert.equal((await send('POST', '/api/undo', { event_id: ev })).status, 409);
  });

  test('A4 decisions: generic undo delegates, sets undone_by; /api/suggestions/undo then 409 and vice versa', async () => {
    const a = asset();
    const s1 = Number(db.prepare(`INSERT INTO asset_suggestions (asset_id, tag_id, stage, confidence, model, created_at)
      VALUES (?, ?, 'vlm', 0.9, 'm', '2026-10-01T00:00:00.000Z')`).run(a, tagIdByPath(db, 'context/work')).lastInsertRowid);
    const acc = await ok('POST', '/api/suggestions/accept', { ids: [s1] });
    const u = await ok('POST', '/api/undo');
    assert.equal(u.undone_event_id, acc.event_id);
    assert.equal(db.prepare('SELECT action FROM events WHERE id = ?').get(u.event_id).action, 'suggestions.undo');
    assert.equal(db.prepare('SELECT status FROM asset_suggestions WHERE id = ?').get(s1).status, 'pending');
    assert.equal((await send('POST', '/api/suggestions/undo', { event_id: acc.event_id })).status, 409);

    const rej = await ok('POST', '/api/suggestions/reject', { ids: [s1] });
    const viaA4 = await ok('POST', '/api/suggestions/undo', { event_id: rej.event_id });
    assert.equal(db.prepare('SELECT undone_by FROM events WHERE id = ?').get(rej.event_id).undone_by, viaA4.event_id);
    assert.equal((await send('POST', '/api/undo', { event_id: rej.event_id })).status, 409);
  });

  test('legacy catalog undo records (pre-007 shapes) still undo', async () => {
    const a = asset();
    const t = await ok('POST', '/api/tags', { name: 'old' });
    const al = await ok('POST', '/api/albums', { name: 'Old' });
    db.prepare("INSERT INTO events (ts, actor, action, payload_json, undo_json) VALUES ('t', 'user', 'tags.apply', '{}', ?)")
      .run(JSON.stringify({ op: 'tags.apply', added: [], removed: [[a, t.id]] }));
    await ok('POST', '/api/undo');
    assert.equal(db.prepare('SELECT source FROM asset_tags WHERE asset_id = ? AND tag_id = ?').get(a, t.id).source, 'manual');
    db.prepare("INSERT INTO events (ts, actor, action, payload_json, undo_json) VALUES ('t', 'user', 'album.remove', '{}', ?)")
      .run(JSON.stringify({ op: 'album.add', album_id: al.id, items: [[a, 3]] }));
    await ok('POST', '/api/undo');
    assert.equal(db.prepare('SELECT position FROM album_items WHERE album_id = ? AND asset_id = ?').get(al.id, a).position, 3);
  });
});

describe('migration 007', () => {
  test('backfills undone_by from existing suggestions.undo events; bundle_items gets an id', () => {
    const d = tempDir('mig7');
    try {
      const file = path.join(d, 'library.db');
      const raw = new DatabaseSync(file);
      const migDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'migrations');
      for (const f of fs.readdirSync(migDir).filter((x) => /^00[1-6]_/.test(x)).sort()) raw.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
      raw.exec('PRAGMA user_version = 6');
      const ins = raw.prepare("INSERT INTO events (ts, actor, action, payload_json, undo_json) VALUES ('t', 'user', ?, ?, ?)");
      const acc = Number(ins.run('suggestions.accept', '{}', '{"statuses":[]}').lastInsertRowid);
      const rej = Number(ins.run('suggestions.reject', '{}', '{"statuses":[]}').lastInsertRowid);
      const und = Number(ins.run('suggestions.undo', JSON.stringify({ event_id: acc }), null).lastInsertRowid);
      raw.close();
      const db2 = openDb(file);
      const by = (id) => db2.prepare('SELECT undone_by FROM events WHERE id = ?').get(id).undone_by;
      assert.equal(by(acc), und);
      assert.equal(by(rej), null);
      assert.ok(db2.prepare('PRAGMA table_info(bundle_items)').all().some((c) => c.name === 'id' && c.pk === 1));
      db2.close();
    } finally { cleanup(d); }
  });
});
