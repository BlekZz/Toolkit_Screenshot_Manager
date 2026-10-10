import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { tx } from '../server/db.mjs';
import { openLibrary } from '../server/library.mjs';
import { cleanup, startTestServer, tempDir } from './helpers.mjs';

const N = 50000;
let libDir, app, base;

before(async () => {
  libDir = tempDir('perf');
  // Synthetic catalogue rows only (no files) — exercises the list path at target scale.
  const lib = openLibrary(libDir);
  const ins = lib.db.prepare(`INSERT INTO assets (root_id, rel_path, sha256, filename, ext, width, height, bytes,
    file_mtime, imported_at) VALUES (?, ?, ?, ?, 'png', 1920, 1080, 1000, ?, ?)`);
  tx(lib.db, () => {
    for (let i = 0; i < N; i++) {
      const ts = new Date(1.7e12 + i * 1000).toISOString();
      ins.run(lib.managedRootId, `x/${i}.png`, i.toString(16).padStart(64, '0'), `f${i}.png`, ts, ts);
    }
  });
  lib.db.close();
  ({ app, base } = await startTestServer(libDir));
});

after(async () => { await app.close(); cleanup(libDir); });

test(`GET /api/assets with ${N} rows answers under 500ms for every sort`, async () => {
  for (const sort of ['imported', 'mtime', 'name']) {
    const t0 = performance.now();
    const body = await (await fetch(`${base}/api/assets?sort=${sort}`)).json();
    const ms = performance.now() - t0;
    assert.equal(body.total, N);
    assert.ok(ms < 500, `${sort}: ${ms.toFixed(0)}ms`);
    console.log(`  ${sort}: ${ms.toFixed(0)}ms`);
  }
});
