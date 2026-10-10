import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { importFolder, sha256File } from '../server/importer.mjs';
import { assetFilePath, openLibrary } from '../server/library.mjs';
import { cleanup, makeImages, tempDir } from './helpers.mjs';

let src, libDir, lib, sources;

before(async () => {
  src = tempDir('src');
  libDir = tempDir('lib');
  sources = [
    ...await makeImages(src, 6, { ext: 'png' }),
    ...await makeImages(path.join(src, 'nested'), 4, { ext: 'jpg', offset: 100 }),
  ];
  // Two byte-identical copies under different names → must be deduplicated.
  fs.copyFileSync(sources[0], path.join(src, 'copy_a.png'));
  fs.copyFileSync(sources[7], path.join(src, 'nested', 'copy_b.jpg'));
  fs.writeFileSync(path.join(src, 'legacy.bmp'), 'BM fake');
  fs.writeFileSync(path.join(src, 'notes.txt'), 'not an image');
  lib = openLibrary(libDir);
});

after(() => { lib.db.close(); cleanup(src, libDir); });

test('first import: 10 unique imported, 2 duplicates, 1 unsupported, txt ignored', async () => {
  const r = await importFolder(lib, src);
  assert.equal(r.scanned, 14);
  assert.equal(r.imported, 10);
  assert.equal(r.duplicates, 2);
  assert.deepEqual(r.unsupported.map((f) => path.basename(f)), ['legacy.bmp']);
  assert.deepEqual(r.errors, []);
  assert.equal(lib.db.prepare('SELECT count(*) AS n FROM assets').get().n, 10);
});

test('every managed original is byte-identical (sha256) to its source', async () => {
  const rows = lib.db.prepare('SELECT * FROM assets').all();
  const bySha = new Map(await Promise.all(sources.map(async (f) => [await sha256File(f), f])));
  for (const row of rows) {
    const file = assetFilePath(lib, row);
    assert.ok(fs.existsSync(file), `missing ${file}`);
    assert.equal(await sha256File(file), row.sha256);
    assert.ok(bySha.has(row.sha256), `row ${row.id} sha not among sources`);
    assert.ok(file.startsWith(lib.originalsDir));
  }
});

test('dimensions recorded from image metadata', () => {
  const row = lib.db.prepare("SELECT width, height FROM assets WHERE ext = 'png' LIMIT 1").get();
  assert.deepEqual({ ...row }, { width: 640, height: 400 });
});

test('re-import is idempotent: 0 imported, 12 duplicates, no new files', async () => {
  const countFiles = (d) => fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
  const before = countFiles(lib.originalsDir);
  const r = await importFolder(lib, src);
  assert.equal(r.imported, 0);
  assert.equal(r.duplicates, 12);
  assert.equal(countFiles(lib.originalsDir), before);
  assert.equal(lib.db.prepare('SELECT count(*) AS n FROM assets').get().n, 10);
});

test('sources are untouched', () => {
  for (const f of sources) assert.ok(fs.existsSync(f));
});

test('non-recursive import skips nested dir', async () => {
  const lib2Dir = tempDir('lib2');
  const lib2 = openLibrary(lib2Dir);
  try {
    const r = await importFolder(lib2, src, { recursive: false });
    assert.equal(r.imported, 6);
    assert.equal(r.duplicates, 1);
  } finally { lib2.db.close(); cleanup(lib2Dir); }
});

test('rejects relative path, missing dir, and the library itself', async () => {
  await assert.rejects(importFolder(lib, 'relative/dir'), /absolute/);
  await assert.rejects(importFolder(lib, path.join(src, 'nope')), /not a directory/);
  await assert.rejects(importFolder(lib, lib.originalsDir), /inside the library/);
  await assert.rejects(importFolder(lib, libDir), /inside the library/);
});

test('corrupted copy is rejected: error reported, no row, no orphan file', async () => {
  const lib3Dir = tempDir('lib3');
  const lib3 = openLibrary(lib3Dir);
  try {
    const corrupt = (from, to) => { fs.copyFileSync(from, to); fs.appendFileSync(to, 'X'); };
    const r = await importFolder(lib3, src, { recursive: false, copyFile: corrupt });
    assert.equal(r.imported, 0);
    assert.ok(r.errors.length > 0 && r.errors.every((e) => /hash mismatch/.test(e.error)), JSON.stringify(r.errors[0]));
    assert.equal(lib3.db.prepare('SELECT count(*) AS n FROM assets').get().n, 0);
    const leftovers = fs.readdirSync(lib3.originalsDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    assert.deepEqual(leftovers.map((e) => e.name), []);
  } finally { lib3.db.close(); cleanup(lib3Dir); }
});

test('importing a parent folder never ingests the library itself', async () => {
  const parent = tempDir('parent');
  try {
    await makeImages(path.join(parent, 'pics'), 3, { offset: 300 });
    const lib4 = openLibrary(path.join(parent, 'lib'));
    try {
      // Plant files that look importable inside the library (originals + thumbnail cache).
      await makeImages(path.join(lib4.thumbsDir, 'ab'), 2, { offset: 400 });
      const r = await importFolder(lib4, parent);
      assert.equal(r.imported, 3);
      assert.equal(r.scanned, 3);
      const again = await importFolder(lib4, parent);
      assert.equal(again.scanned, 3); // its own originals are not re-scanned
    } finally { lib4.db.close(); }
  } finally { cleanup(parent); }
});
