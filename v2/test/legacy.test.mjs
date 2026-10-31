import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { migrateLegacy } from '../server/legacy.mjs';
import { openLibrary } from '../server/library.mjs';
import { tagIdByPath } from '../server/suggestions.mjs';
import { cleanup, makeImages, tempDir } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'migrate-legacy.mjs');

async function legacyFixture(root) {
  const keep = await makeImages(path.join(root, 'staging/keep/2026-06-21'), 2, { offset: 0 });
  await makeImages(path.join(root, 'staging/trash-candidate/2026-06-21'), 3, { offset: 10 });
  await makeImages(path.join(root, 'staging/review-later/2026-06-21'), 1, { offset: 20 });
  await makeImages(path.join(root, 'output/pending-delete/2026-06-21/group-001'), 2, { offset: 30 });
  // Same bytes as a keep image, also archived as an original ⇒ one asset, two tags.
  fs.mkdirSync(path.join(root, 'archive/originals/2026-06-21'), { recursive: true });
  fs.copyFileSync(keep[0], path.join(root, 'archive/originals/2026-06-21/orig.png'));
}

const tagged = (db, p) => db.prepare('SELECT COUNT(*) AS n FROM asset_tags WHERE tag_id = ?').get(tagIdByPath(db, p)).n;

test('migrates decided folders with decision tags; idempotent; sources untouched; shared image gets both tags', async () => {
  const root = tempDir('legacy-src');
  const libDir = tempDir('legacy-lib');
  try {
    await legacyFixture(root);
    const before = fs.readdirSync(path.join(root, 'staging/keep/2026-06-21'));
    const lib = openLibrary(libDir);

    const dry = await migrateLegacy(lib, root, { dryRun: true });
    assert.equal(lib.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0, 'dry run imports nothing');
    assert.deepEqual(dry.folders.filter((f) => f.files).map((f) => [f.dir, f.files]),
      [['staging/keep', 2], ['staging/review-later', 1], ['staging/trash-candidate', 3], ['output/pending-delete', 2], ['archive/originals', 1]]);

    await migrateLegacy(lib, root);
    assert.equal(lib.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 8, '9 files, one duplicate');
    assert.equal(tagged(lib.db, 'migration/keep'), 2);
    assert.equal(tagged(lib.db, 'migration/trash-candidate'), 3);
    assert.equal(tagged(lib.db, 'migration/review-later'), 1);
    assert.equal(tagged(lib.db, 'triage/later'), 1);
    assert.equal(tagged(lib.db, 'migration/text-extracted'), 2);
    assert.equal(tagged(lib.db, 'migration/original'), 1);
    const both = lib.db.prepare(`SELECT COUNT(*) AS n FROM asset_tags WHERE asset_id =
      (SELECT asset_id FROM asset_tags WHERE tag_id = ?) AND tag_id IN (?, ?)`)
      .get(tagIdByPath(lib.db, 'migration/original'), tagIdByPath(lib.db, 'migration/original'), tagIdByPath(lib.db, 'migration/keep')).n;
    assert.equal(both, 2, 'archived original that equals a keep crop carries both tags');
    assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM asset_tags WHERE source != 'migration'").get().n, 0);

    const again = await migrateLegacy(lib, root);
    assert.equal(again.folders.reduce((s, f) => s + f.imported + f.tagged, 0), 0, 're-run adds nothing');
    assert.deepEqual(fs.readdirSync(path.join(root, 'staging/keep/2026-06-21')), before, 'sources untouched');
    lib.db.close();

    const r = spawnSync(process.execPath, [CLI, root, '--library', libDir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /staging\/trash-candidate\s+3\s+0\s+3\s+0\s+0/);
  } finally {
    cleanup(root, libDir);
  }
});
