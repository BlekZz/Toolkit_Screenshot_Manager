import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ensureThumb } from '../server/thumbs.mjs';
import { cleanup, makeImages, tempDir } from './helpers.mjs';

let dir, files;
before(async () => { dir = tempDir('thumbs'); files = await makeImages(path.join(dir, 'src'), 12, { width: 2400, height: 1600 }); });
after(() => cleanup(dir));

const sha = (i) => String(i).padStart(64, 'a');

test('abandoned queued requests are skipped (null) and leave no file; live ones render', async () => {
  const out = path.join(dir, 'out');
  // 4 slots busy, then 8 queued: even-indexed queued ones are abandoned.
  const jobs = files.map((f, i) => ensureThumb(out, f, sha(i), 256, () => i < 4 || i % 2 === 1));
  const results = await Promise.all(jobs);
  for (let i = 0; i < files.length; i++) {
    const abandoned = i >= 4 && i % 2 === 0;
    if (abandoned) {
      assert.equal(results[i], null, `#${i} should be skipped`);
      assert.ok(!fs.existsSync(path.join(out, sha(i).slice(0, 2), `${sha(i)}_256.webp`)));
    } else {
      assert.ok(results[i] && fs.existsSync(results[i]), `#${i} should render`);
    }
  }
});

test('queued renders run newest-first (LIFO)', async () => {
  const out = path.join(dir, 'lifo');
  const order = [];
  const jobs = files.slice(0, 8).map((f, i) => ensureThumb(out, f, sha(100 + i), 256).then(() => order.push(i)));
  await Promise.all(jobs);
  // First 4 start immediately; of the queued 4..7, #7 must finish before #4.
  assert.ok(order.indexOf(7) < order.indexOf(4), `order: ${order}`);
});
