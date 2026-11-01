import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { now } from '../server/db.mjs';
import { importFolder } from '../server/importer.mjs';
import { openLibrary } from '../server/library.mjs';
import { addRoot, listRoots, scanRoot } from '../server/roots.mjs';
import { cleanup, makeImages, startTestServer, tempDir } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'roots.mjs');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every file and directory under dir with its sha256 — the "user's files" fingerprint. */
function snapshot(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => {
      const full = path.join(e.parentPath, e.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      return e.isFile() ? `${rel} ${sha(full)}` : `${rel}/`;
    })
    .sort();
}

/** Scans and proves the root is byte-for-byte untouched by the scan. */
async function scan(lib, rootDir, rootId, opts) {
  const beforeSnap = snapshot(rootDir);
  const r = await scanRoot(lib, rootId, opts);
  assert.deepEqual(snapshot(rootDir), beforeSnap, 'scan must not touch files under the root');
  return r;
}

const assetBy = (lib, where, ...p) => lib.db.prepare(`SELECT * FROM assets WHERE ${where}`).get(...p);
const tagsOf = (lib, id) => lib.db.prepare('SELECT t.name FROM asset_tags x JOIN tags t ON t.id = x.tag_id WHERE x.asset_id = ? ORDER BY t.name')
  .all(id).map((r) => r.name);
const albumsOf = (lib, id) => lib.db.prepare('SELECT al.name FROM album_items i JOIN albums al ON al.id = i.album_id WHERE i.asset_id = ?')
  .all(id).map((r) => r.name);
const cropsOf = (lib, id) => lib.db.prepare('SELECT count(*) AS n FROM crops WHERE asset_id = ?').get(id).n;

function decorate(lib, assetId, label) {
  const tagId = Number(lib.db.prepare('INSERT INTO tags (name) VALUES (?)').run(`tag-${label}`).lastInsertRowid);
  lib.db.prepare('INSERT INTO asset_tags (asset_id, tag_id, added_at) VALUES (?, ?, ?)').run(assetId, tagId, now());
  const albumId = Number(lib.db.prepare('INSERT INTO albums (name, created_at) VALUES (?, ?)').run(`album-${label}`, now()).lastInsertRowid);
  lib.db.prepare('INSERT INTO album_items (album_id, asset_id, position, added_at) VALUES (?, ?, 1, ?)').run(albumId, assetId, now());
  lib.db.prepare('INSERT INTO crops (asset_id, x, y, w, h, created_at) VALUES (?, 0, 0, 0.5, 0.5, ?)').run(assetId, now());
}

describe('referenced roots: scan / relink / missing (library level)', () => {
  let rootDir, libDir, lib, root;

  before(async () => {
    rootDir = tempDir('root');
    libDir = tempDir('rootlib');
    await makeImages(path.join(rootDir, 'a'), 4);
    await makeImages(path.join(rootDir, 'b'), 2, { ext: 'jpg', offset: 50 });
    fs.writeFileSync(path.join(rootDir, 'notes.txt'), 'not an image');
    lib = openLibrary(libDir);
  });

  after(() => { lib.db.close(); cleanup(rootDir, libDir); });

  test('addRoot registers an absolute referenced root', () => {
    root = addRoot(lib, rootDir);
    assert.equal(root.mode, 'referenced');
    assert.ok(path.isAbsolute(root.path));
    const listed = listRoots(lib).find((r) => r.id === root.id);
    assert.equal(listed.mode, 'referenced');
  });

  test('first scan adds every image in place, thumbnails go to the library', async () => {
    const r = await scan(lib, rootDir, root.id);
    assert.deepEqual({ added: r.added, relinked: r.relinked, duplicates: r.duplicates, missing: r.missing, errors: r.errors },
      { added: 6, relinked: 0, duplicates: 0, missing: 0, errors: [] });
    const row = assetBy(lib, 'root_id = ? AND rel_path = ?', root.id, 'a/img_0000.png');
    assert.ok(row, 'rel_path is relative to the root with forward slashes');
    assert.equal(row.status, 'active');
    assert.equal(row.sha256, sha(path.join(rootDir, 'a', 'img_0000.png')));
    assert.ok(fs.existsSync(path.join(lib.thumbsDir, row.sha256.slice(0, 2), `${row.sha256}_256.webp`)));
    // Nothing was copied into the managed originals.
    assert.equal(fs.readdirSync(lib.originalsDir).length, 0);
  });

  test('rescan with no changes is a no-op', async () => {
    const r = await scan(lib, rootDir, root.id);
    assert.deepEqual([r.added, r.relinked, r.duplicates, r.missing, r.revived, r.unchanged], [0, 0, 0, 0, 0, 6]);
  });

  test('moved file is relinked: same id, tags/albums/crops kept', async () => {
    const row = assetBy(lib, 'rel_path = ?', 'a/img_0000.png');
    decorate(lib, row.id, 'moved');
    fs.mkdirSync(path.join(rootDir, 'c', 'deep'), { recursive: true });
    fs.renameSync(path.join(rootDir, 'a', 'img_0000.png'), path.join(rootDir, 'c', 'deep', 'renamed.png'));
    const r = await scan(lib, rootDir, root.id);
    assert.equal(r.relinked, 1);
    assert.equal(r.added, 0);
    assert.equal(r.missing, 0);
    const after = assetBy(lib, 'id = ?', row.id);
    assert.equal(after.rel_path, 'c/deep/renamed.png');
    assert.equal(after.filename, 'renamed.png');
    assert.equal(after.status, 'active');
    assert.deepEqual(tagsOf(lib, row.id), ['tag-moved']);
    assert.deepEqual(albumsOf(lib, row.id), ['album-moved']);
    assert.equal(cropsOf(lib, row.id), 1);
    assert.equal(lib.db.prepare('SELECT count(*) AS n FROM assets').get().n, 6);
  });

  test('a byte-identical copy while the original stays is a duplicate, not a relink', async () => {
    const row = assetBy(lib, 'rel_path = ?', 'a/img_0001.png');
    fs.copyFileSync(path.join(rootDir, 'a', 'img_0001.png'), path.join(rootDir, 'a', '0copy.png'));
    const r = await scan(lib, rootDir, root.id);
    assert.equal(r.duplicates, 1);
    assert.equal(r.relinked, 0);
    assert.equal(r.added, 0);
    assert.equal(assetBy(lib, 'id = ?', row.id).rel_path, 'a/img_0001.png');
    assert.equal(lib.db.prepare('SELECT count(*) AS n FROM assets').get().n, 6);
  });

  test('deleted file → missing with metadata kept; restored → active', async () => {
    const row = assetBy(lib, 'rel_path = ?', 'a/img_0002.png');
    decorate(lib, row.id, 'deleted');
    const file = path.join(rootDir, 'a', 'img_0002.png');
    const bytes = fs.readFileSync(file);
    fs.rmSync(file);
    let r = await scan(lib, rootDir, root.id);
    assert.equal(r.missing, 1);
    let cur = assetBy(lib, 'id = ?', row.id);
    assert.equal(cur.status, 'missing');
    assert.deepEqual(tagsOf(lib, row.id), ['tag-deleted']);
    assert.deepEqual(albumsOf(lib, row.id), ['album-deleted']);
    assert.equal(cropsOf(lib, row.id), 1);

    // Already-missing rows are not re-counted.
    r = await scan(lib, rootDir, root.id);
    assert.equal(r.missing, 0);

    fs.writeFileSync(file, bytes);
    r = await scan(lib, rootDir, root.id);
    assert.equal(r.revived, 1);
    cur = assetBy(lib, 'id = ?', row.id);
    assert.equal(cur.status, 'active');
    assert.equal(cur.rel_path, 'a/img_0002.png');
  });

  test('missing file reappearing elsewhere is relinked back to active', async () => {
    const row = assetBy(lib, 'rel_path = ?', 'a/img_0003.png');
    const file = path.join(rootDir, 'a', 'img_0003.png');
    const bytes = fs.readFileSync(file);
    fs.rmSync(file);
    await scan(lib, rootDir, root.id);
    assert.equal(assetBy(lib, 'id = ?', row.id).status, 'missing');
    fs.writeFileSync(path.join(rootDir, 'b', 'back.png'), bytes);
    const r = await scan(lib, rootDir, root.id);
    assert.equal(r.relinked, 1);
    const cur = assetBy(lib, 'id = ?', row.id);
    assert.deepEqual([cur.status, cur.rel_path], ['active', 'b/back.png']);
  });

  test('trashed asset is relinked but stays trashed; deleting its file does not mark it missing', async () => {
    const row = assetBy(lib, 'rel_path = ?', 'b/img_0050.jpg');
    lib.db.prepare("UPDATE assets SET status = 'trashed' WHERE id = ?").run(row.id);
    fs.renameSync(path.join(rootDir, 'b', 'img_0050.jpg'), path.join(rootDir, 'c', 'trashed-moved.jpg'));
    let r = await scan(lib, rootDir, root.id);
    assert.equal(r.relinked, 1);
    let cur = assetBy(lib, 'id = ?', row.id);
    assert.deepEqual([cur.status, cur.rel_path], ['trashed', 'c/trashed-moved.jpg']);
    const bytes = fs.readFileSync(path.join(rootDir, 'c', 'trashed-moved.jpg'));
    fs.rmSync(path.join(rootDir, 'c', 'trashed-moved.jpg'));
    r = await scan(lib, rootDir, root.id);
    assert.equal(r.missing, 0);
    assert.equal(assetBy(lib, 'id = ?', row.id).status, 'trashed');
    fs.writeFileSync(path.join(rootDir, 'b', 'img_0050.jpg'), bytes);
    await scan(lib, rootDir, root.id);
    cur = assetBy(lib, 'id = ?', row.id);
    assert.deepEqual([cur.status, cur.rel_path], ['trashed', 'b/img_0050.jpg']);
  });

  test('two files swapping names are both relinked without UNIQUE conflicts', async () => {
    const x = assetBy(lib, 'rel_path = ?', 'a/img_0001.png');
    const y = assetBy(lib, 'rel_path = ?', 'a/img_0002.png');
    const px = path.join(rootDir, 'a', 'img_0001.png');
    const py = path.join(rootDir, 'a', 'img_0002.png');
    fs.renameSync(px, `${px}.swap`);
    fs.renameSync(py, px);
    fs.renameSync(`${px}.swap`, py);
    const r = await scan(lib, rootDir, root.id);
    assert.deepEqual(r.errors, []);
    // img_0001 also has a/0copy.png (sorted before the original, so the in-root "still there" guard is exercised); a/img_0001.png now holds y's bytes, so x relinks to the copy or to img_0002.
    assert.equal(assetBy(lib, 'id = ?', y.id).rel_path, 'a/img_0001.png');
    assert.equal(assetBy(lib, 'id = ?', x.id).status, 'active');
    assert.equal(sha(path.join(rootDir, ...assetBy(lib, 'id = ?', x.id).rel_path.split('/'))), x.sha256);
  });

  test('pure two-way swap (no other copies) relinks both rows onto each other\'s slot', async () => {
    const [p0, p1] = await makeImages(path.join(rootDir, 'e'), 2, { offset: 800 });
    await scan(lib, rootDir, root.id);
    const x = assetBy(lib, 'rel_path = ?', 'e/img_0800.png');
    const y = assetBy(lib, 'rel_path = ?', 'e/img_0801.png');
    fs.renameSync(p0, `${p0}.swap`);
    fs.renameSync(p1, p0);
    fs.renameSync(`${p0}.swap`, p1);
    const r = await scan(lib, rootDir, root.id);
    assert.deepEqual([r.relinked, r.added, r.missing, r.errors.length], [2, 0, 0, 0]);
    assert.equal(assetBy(lib, 'id = ?', x.id).rel_path, 'e/img_0801.png');
    assert.equal(assetBy(lib, 'id = ?', y.id).rel_path, 'e/img_0800.png');
  });

  test('file overwritten in place: old asset → missing (metadata kept), new content added', async () => {
    const old = assetBy(lib, 'rel_path = ?', 'b/img_0051.jpg');
    decorate(lib, old.id, 'overwritten');
    const [fresh] = await makeImages(tempDir('fresh'), 1, { ext: 'jpg', offset: 900 });
    fs.copyFileSync(fresh, path.join(rootDir, 'b', 'img_0051.jpg'));
    cleanup(path.dirname(fresh));
    const r = await scan(lib, rootDir, root.id);
    assert.deepEqual([r.added, r.missing, r.errors.length], [1, 1, 0]);
    const cur = assetBy(lib, 'id = ?', old.id);
    assert.equal(cur.status, 'missing');
    assert.deepEqual(tagsOf(lib, old.id), ['tag-overwritten']);
    assert.equal(assetBy(lib, 'root_id = ? AND rel_path = ?', root.id, 'b/img_0051.jpg').sha256,
      sha(path.join(rootDir, 'b', 'img_0051.jpg')));
  });

  test('dry-run reports the plan but writes nothing (DB, events, thumbnails)', async () => {
    await makeImages(path.join(rootDir, 'd'), 2, { offset: 700 });
    // Two copies of brand-new content in one scan → one row, one duplicate.
    fs.copyFileSync(path.join(rootDir, 'd', 'img_0700.png'), path.join(rootDir, 'd', 'twin.png'));
    fs.renameSync(path.join(rootDir, 'c', 'deep', 'renamed.png'), path.join(rootDir, 'd', 'renamed-again.png'));
    fs.rmSync(path.join(rootDir, 'b', 'back.png'));
    const dump = () => JSON.stringify({
      assets: lib.db.prepare('SELECT * FROM assets ORDER BY id').all(),
      events: lib.db.prepare('SELECT count(*) AS n FROM events').get().n,
    });
    const thumbs = () => snapshot(lib.thumbsDir);
    const dbBefore = dump();
    const thumbsBefore = thumbs();
    const r = await scan(lib, rootDir, root.id, { dryRun: true });
    assert.equal(r.dry_run, true);
    assert.equal(r.added, 2);
    assert.equal(r.relinked, 1);
    assert.equal(r.missing, 1);
    assert.equal(dump(), dbBefore);
    assert.deepEqual(thumbs(), thumbsBefore);
    // The real scan then applies exactly that plan.
    const real = await scan(lib, rootDir, root.id);
    assert.deepEqual({ ...real, dry_run: true }, r);
  });

  test('scan writes a root_scan event', () => {
    const ev = lib.db.prepare("SELECT payload_json FROM events WHERE action = 'root_scan' ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(ev.payload_json).root_id, root.id);
  });
});

describe('referenced roots: validation and cross-root dedup', () => {
  let base, libDir, lib;

  before(() => {
    base = tempDir('rootval');
    libDir = path.join(base, 'library');
    lib = openLibrary(libDir);
    fs.mkdirSync(path.join(base, 'photos', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(base, 'other'), { recursive: true });
  });

  after(() => { lib.db.close(); cleanup(base); });

  const status400 = (fn) => assert.throws(fn, (e) => e.statusCode === 400);

  test('rejects relative, missing, inside-library, containing-library and overlapping roots', () => {
    status400(() => addRoot(lib, 'relative/dir'));
    status400(() => addRoot(lib, path.join(base, 'nope')));
    status400(() => addRoot(lib, undefined));
    status400(() => addRoot(lib, path.join(libDir, 'originals')));
    status400(() => addRoot(lib, path.join(libDir, 'exports'))); // inside library, not under any root
    status400(() => addRoot(lib, libDir));
    status400(() => addRoot(lib, base)); // contains the library
    addRoot(lib, path.join(base, 'photos'));
    status400(() => addRoot(lib, path.join(base, 'photos'))); // same root twice
    status400(() => addRoot(lib, path.join(base, 'photos', 'nested'))); // inside existing root
    assert.equal(addRoot(lib, path.join(base, 'other')).mode, 'referenced');
  });

  test('content already in the managed library is a duplicate, not a relink', async () => {
    const src = tempDir('rootsrc');
    try {
      const [file] = await makeImages(src, 1, { offset: 300 });
      await importFolder(lib, src);
      const managed = assetBy(lib, 'sha256 = ?', sha(file));
      fs.copyFileSync(file, path.join(base, 'other', 'same.png'));
      const other = listRoots(lib).find((r) => r.path.endsWith('other'));
      const r = await scan(lib, path.join(base, 'other'), other.id);
      assert.deepEqual([r.duplicates, r.added, r.relinked], [1, 0, 0]);
      assert.equal(assetBy(lib, 'id = ?', managed.id).root_id, lib.managedRootId);
    } finally { cleanup(src); }
  });

  test('managed root cannot be scanned; unknown root is 404', async () => {
    await assert.rejects(scanRoot(lib, lib.managedRootId), (e) => e.statusCode === 400);
    await assert.rejects(scanRoot(lib, 9999), (e) => e.statusCode === 404);
  });
});

describe('referenced roots over real HTTP', () => {
  let rootDir, libDir, app, srv;
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    rootDir = tempDir('httproot');
    libDir = tempDir('httplib');
    await makeImages(path.join(rootDir, 'x'), 3, { width: 1200, height: 800 });
    ({ app, base: srv } = await startTestServer(libDir));
  });

  after(async () => { await app.close(); cleanup(rootDir, libDir); });

  async function waitScan() {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const job = await (await fetch(`${srv}/api/roots/scan`)).json();
      if (job.state !== 'running') return job;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('scan did not finish');
  }

  test('POST /api/roots validates and creates; GET lists', async () => {
    assert.equal((await post(`${srv}/api/roots`, { path: 'rel' })).status, 400);
    assert.equal((await post(`${srv}/api/roots`, { path: libDir })).status, 400);
    assert.equal((await post(`${srv}/api/roots`, {})).status, 400);
    const res = await post(`${srv}/api/roots`, { path: rootDir });
    assert.equal(res.status, 201);
    const { roots } = await (await fetch(`${srv}/api/roots`)).json();
    assert.ok(roots.some((r) => r.mode === 'referenced'));
    assert.ok(roots.some((r) => r.mode === 'managed'));
  });

  test('dry-run then real scan via job; media endpoints serve referenced originals', async () => {
    const before = snapshot(rootDir);
    const { roots } = await (await fetch(`${srv}/api/roots`)).json();
    const id = roots.find((r) => r.mode === 'referenced').id;
    assert.equal((await post(`${srv}/api/roots/${id}/scan`, { dry_run: true })).status, 202);
    let job = await waitScan();
    assert.deepEqual([job.state, job.result.dry_run, job.result.added], ['done', true, 3]);
    assert.equal((await (await fetch(`${srv}/api/assets`)).json()).total, 0);

    assert.equal((await post(`${srv}/api/roots/${id}/scan`, {})).status, 202);
    job = await waitScan();
    assert.deepEqual([job.state, job.result.added], ['done', 3]);
    assert.deepEqual(snapshot(rootDir), before);

    const { ids } = await (await fetch(`${srv}/api/assets?sort=name&order=asc`)).json();
    const orig = await fetch(`${srv}/media/original/${ids[0]}`);
    assert.equal(orig.status, 200);
    const got = crypto.createHash('sha256').update(Buffer.from(await orig.arrayBuffer())).digest('hex');
    assert.equal(got, sha(path.join(rootDir, 'x', 'img_0000.png')));
    const thumb = await fetch(`${srv}/media/thumb/${ids[0]}?size=1024`);
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
    assert.deepEqual(snapshot(rootDir), before, 'serving media must not write into the root');
  });

  test('scan endpoint: 404 unknown root, 400 managed root / bad id', async () => {
    const { roots } = await (await fetch(`${srv}/api/roots`)).json();
    const managed = roots.find((r) => r.mode === 'managed').id;
    assert.equal((await post(`${srv}/api/roots/9999/scan`, {})).status, 404);
    assert.equal((await post(`${srv}/api/roots/${managed}/scan`, {})).status, 400);
    assert.equal((await post(`${srv}/api/roots/abc/scan`, {})).status, 400);
  });
});

describe('cli/roots.mjs (subprocess)', () => {
  let rootDir, libDir;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--library', libDir], { encoding: 'utf8' });

  before(async () => {
    rootDir = tempDir('cliroot');
    libDir = tempDir('clilib');
    await makeImages(path.join(rootDir, 'p'), 3);
  });

  after(() => cleanup(rootDir, libDir));

  test('add / scan --dry-run / scan / move+rescan / list', () => {
    const before = snapshot(rootDir);
    assert.equal(run('add', 'relative/path').status, 2);
    const add = run('add', rootDir);
    assert.equal(add.status, 0, add.stderr);
    const { id } = JSON.parse(add.stdout);

    const dry = run('scan', String(id), '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).added, 3);
    const peek = openLibrary(libDir);
    try { assert.equal(peek.db.prepare('SELECT count(*) AS n FROM assets').get().n, 0); } finally { peek.db.close(); }

    const real = run('scan', String(id));
    assert.equal(real.status, 0, real.stderr);
    assert.equal(JSON.parse(real.stdout).added, 3);
    assert.deepEqual(snapshot(rootDir), before);

    fs.mkdirSync(path.join(rootDir, 'q'));
    fs.renameSync(path.join(rootDir, 'p', 'img_0001.png'), path.join(rootDir, 'q', 'img_0001.png'));
    const re = JSON.parse(run('scan', String(id)).stdout);
    assert.deepEqual([re.relinked, re.added, re.missing], [1, 0, 0]);

    const list = JSON.parse(run('list').stdout);
    assert.deepEqual(list.find((r) => r.id === id).counts, { active: 3, trashed: 0, missing: 0 });
    assert.equal(run('bogus').status, 2);
  });
});
