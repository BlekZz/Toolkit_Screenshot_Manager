import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openLibrary } from '../server/library.mjs';
import { evaluate, importLabels, sampleForReview, sanitizeReason, tagIdByPath } from '../server/suggestions.mjs';
import { cleanup, tempDir } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'suggest.mjs');

let dir, lib;
beforeEach(() => {
  dir = tempDir('suggest');
  lib = openLibrary(dir);
});
afterEach(() => {
  try { lib.db.close(); } catch { /* already closed */ }
  cleanup(dir);
});

/** Inserts assets named IMG_<n>.PNG imported from <src>/Input/. Returns ids by name. */
function seedAssets(names, { src = 'C:/x/Input', status = 'active' } = {}) {
  const ins = lib.db.prepare(`INSERT INTO assets (root_id, rel_path, sha256, filename, ext, width, height, bytes,
    file_mtime, imported_at, source_path, status) VALUES (?, ?, ?, ?, 'png', 10, 10, 1, '2026-10-01', '2026-10-01', ?, ?)`);
  const ids = {};
  for (const name of names) {
    const sha = `${src}/${name}`.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(64, '0');
    ids[name] = Number(ins.run(lib.managedRootId, `r/${src.replace(/[:/]/g, '_')}/${name}`, sha, name, `${src}/${name}`, status).lastInsertRowid);
  }
  return ids;
}
const label = (file, purpose, extra = {}) => ({ file, purpose, context: 'unknown', sensitive: false, confidence: 0.8, reason: 'r', keywords: [], ...extra });
const suggTags = (assetId) => lib.db.prepare(`SELECT t.name FROM asset_suggestions s JOIN tags t ON t.id = s.tag_id
  WHERE s.asset_id = ? ORDER BY t.name`).all(assetId).map((r) => r.name);

describe('migration 003', () => {
  test('creates purpose/context system tags and custom tags with descriptions', () => {
    for (const p of ['purpose/text-note', 'purpose/chat', 'purpose/translate', 'purpose/visual-ref', 'purpose/receipt',
      'purpose/ephemeral', 'context/work', 'context/personal', 'custom/AI工具', 'custom/旅遊']) {
      assert.ok(tagIdByPath(lib.db, p), `missing ${p}`);
    }
    const sys = lib.db.prepare('SELECT is_system FROM tags WHERE id = ?');
    assert.equal(sys.get(tagIdByPath(lib.db, 'purpose/chat')).is_system, 1);
    assert.equal(sys.get(tagIdByPath(lib.db, 'custom/旅遊')).is_system, 0);
    const d = lib.db.prepare('SELECT description FROM tags WHERE id = ?').get(tagIdByPath(lib.db, 'custom/AI工具')).description;
    assert.match(d, /提示詞/);
  });
});

describe('importLabels', () => {
  test('maps purpose/context/sensitive/keywords to tags; junk → ephemeral; unsure and unknown give nothing', () => {
    const ids = seedAssets(['A.PNG', 'B.PNG', 'C.PNG']);
    const r = importLabels(lib.db, [
      label('A.PNG', 'junk', { context: 'work', sensitive: true, keywords: ['提示詞', '不存在'] }),
      label('B.PNG', 'unsure'),
      label('C.PNG', 'text-note', { context: 'personal', keywords: ['旅遊'] }),
    ]);
    assert.equal(r.matched, 3);
    assert.deepEqual(suggTags(ids['A.PNG']), ['AI工具', 'ephemeral', 'sensitive', 'work']);
    assert.deepEqual(suggTags(ids['B.PNG']), []);
    assert.deepEqual(suggTags(ids['C.PNG']), ['personal', 'text-note', '旅遊']);
  });

  test('is idempotent: re-import inserts nothing', () => {
    seedAssets(['A.PNG']);
    const rows = [label('A.PNG', 'chat', { context: 'work' })];
    assert.equal(importLabels(lib.db, rows).inserted, 2);
    const again = importLabels(lib.db, rows);
    assert.equal(again.inserted, 0);
    assert.equal(again.skipped, 2);
    assert.equal(lib.db.prepare('SELECT COUNT(*) AS n FROM asset_suggestions').get().n, 2);
  });

  test('dry run reports counts but writes nothing', () => {
    seedAssets(['A.PNG']);
    const r = importLabels(lib.db, [label('A.PNG', 'chat')], { dryRun: true });
    assert.equal(r.inserted, 1);
    assert.equal(lib.db.prepare('SELECT COUNT(*) AS n FROM asset_suggestions').get().n, 0);
  });

  test('unmatched, invalid, and duplicate filenames are reported; Input/ source disambiguates', () => {
    const a = seedAssets(['DUP.PNG'], { src: 'C:/x/Input' });
    seedAssets(['DUP.PNG'], { src: 'C:/y/Other' });
    seedAssets(['TWO.PNG'], { src: 'C:/p' });
    seedAssets(['TWO.PNG'], { src: 'C:/q' });
    const r = importLabels(lib.db, [
      label('DUP.PNG', 'chat'), label('TWO.PNG', 'chat'), label('NOPE.PNG', 'chat'), label('DUP.PNG', 'chat', { confidence: 2 }),
    ]);
    assert.equal(r.matched, 1);
    assert.deepEqual(suggTags(a['DUP.PNG']), ['chat']);
    assert.deepEqual(r.ambiguous, ['TWO.PNG']);
    assert.deepEqual(r.unmatched, ['NOPE.PNG']);
    assert.deepEqual(r.invalid, ['DUP.PNG']);
  });

  test('reason is sanitized before storage', () => {
    seedAssets(['A.PNG']);
    importLabels(lib.db, [label('A.PNG', 'receipt', { reason: '銀行通知含卡號5024，信箱 a.b@ex.com' })]);
    const reason = lib.db.prepare('SELECT reason FROM asset_suggestions').get().reason;
    assert.ok(!/5024/.test(reason) && !/ex\.com/.test(reason), reason);
  });
});

describe('sanitizeReason', () => {
  test('masks 4+ digit runs (incl. separated), emails, handles; keeps short numbers', () => {
    assert.equal(sanitizeReason('卡號 1234-5678 末四碼 5024'), '卡號 [數字] 末四碼 [數字]');
    assert.equal(sanitizeReason('聯絡 me@x.io 或 @blake_lee'), '聯絡 [email] 或 @[handle]');
    assert.equal(sanitizeReason('第 3 頁共 12 頁'), '第 3 頁共 12 頁');
    assert.equal(sanitizeReason(''), null);
  });
});

describe('sampleForReview + evaluate', () => {
  function seedMany() {
    const names = Array.from({ length: 40 }, (_, i) => `S${i}.PNG`);
    const ids = seedAssets(names);
    const purposes = ['text-note', 'visual-ref', 'junk', 'chat', 'receipt'];
    // Skewed: text-note 24, visual-ref 8, junk 4, chat 2, receipt 2.
    const of = (i) => (i < 24 ? purposes[0] : i < 32 ? purposes[1] : i < 36 ? purposes[2] : i < 38 ? purposes[3] : purposes[4]);
    importLabels(lib.db, names.map((n, i) => label(n, of(i), { context: i % 2 ? 'work' : 'personal' })));
    return ids;
  }

  test('stratifies so rare purposes are represented, is deterministic, and never resamples', () => {
    seedMany();
    const r = sampleForReview(lib.db, { n: 10, seed: 7 });
    assert.equal(r.picked, 10);
    assert.deepEqual(r.byPurpose, { chat: 2, ephemeral: 2, receipt: 2, 'text-note': 2, 'visual-ref': 2 });
    assert.equal(r.tagsApplied, 20); // purpose + context per asset
    const again = sampleForReview(lib.db, { n: 10, seed: 7 });
    const albumIds = lib.db.prepare('SELECT asset_id FROM album_items WHERE album_id = ?').all(r.albumId).map((x) => x.asset_id);
    assert.equal(new Set(albumIds).size, 20, 'second sample adds 10 new assets, no repeats');
    assert.equal(again.byPurpose.chat, 0, 'chat pool exhausted after first sample');
  });

  test('applied tags carry source=ai; evaluate scores TP/FP/FN from user corrections', () => {
    seedMany();
    const { albumId } = sampleForReview(lib.db, { n: 5, seed: 3 });
    const sampled = lib.db.prepare('SELECT asset_id FROM album_items WHERE album_id = ?').all(albumId).map((x) => x.asset_id);
    assert.equal(lib.db.prepare(`SELECT COUNT(*) AS n FROM asset_tags WHERE source = 'ai'`).get().n, 10);

    // User corrects one asset: removes the suggested purpose, adds a different one.
    const victim = sampled[0];
    const wrong = lib.db.prepare(`SELECT s.tag_id FROM asset_suggestions s JOIN tags t ON t.id = s.tag_id
      WHERE s.asset_id = ? AND t.parent_id = ?`).get(victim, tagIdByPath(lib.db, 'purpose')).tag_id;
    const right = wrong === tagIdByPath(lib.db, 'purpose/translate') ? tagIdByPath(lib.db, 'purpose/chat') : tagIdByPath(lib.db, 'purpose/translate');
    lib.db.prepare('DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?').run(victim, wrong);
    lib.db.prepare(`INSERT INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'manual', 'x')`).run(victim, right);

    const r = evaluate(lib.db, { finalize: true });
    assert.equal(r.assets, 5);
    const sum = (k) => Object.entries(r.perTag).filter(([t]) => t.startsWith('purpose/')).reduce((s, [, v]) => s + v[k], 0);
    assert.equal(sum('tp'), 4);
    assert.equal(sum('fp'), 1);
    assert.equal(sum('fn'), 1);
    assert.equal(r.perTag['purpose/translate'].fn + (r.perTag['purpose/chat']?.fn ?? 0), 1);
    const statuses = lib.db.prepare('SELECT status, COUNT(*) AS n FROM asset_suggestions WHERE asset_id IN (' + sampled.join(',') + ') GROUP BY status').all();
    assert.deepEqual(Object.fromEntries(statuses.map((s) => [s.status, s.n])), { accepted: 9, rejected: 1 });
  });
});

describe('evaluate with user-made child tags', () => {
  test('sensitive stays scored after a child (sensitive/Adult) is created; child confirms parent', () => {
    const ids = seedAssets(['P.PNG', 'Q.PNG', 'R.PNG']);
    importLabels(lib.db, [
      label('P.PNG', 'chat', { sensitive: true }), // user swaps sensitive → sensitive/Adult
      label('Q.PNG', 'chat', { sensitive: true }), // user removes sensitive entirely
      label('R.PNG', 'chat'), // user adds sensitive/Adult although not suggested
    ]);
    sampleForReview(lib.db, { n: 3 });
    const sens = tagIdByPath(lib.db, 'sensitive');
    const adult = Number(lib.db.prepare("INSERT INTO tags (parent_id, name, is_system) VALUES (?, 'Adult', 0)").run(sens).lastInsertRowid);
    const del = lib.db.prepare('DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ?');
    const add = lib.db.prepare("INSERT INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'manual', 'x')");
    del.run(ids['P.PNG'], sens); add.run(ids['P.PNG'], adult);
    del.run(ids['Q.PNG'], sens);
    add.run(ids['R.PNG'], adult);

    const r = evaluate(lib.db);
    assert.deepEqual(r.perTag.sensitive, { tp: 1, fp: 1, fn: 1, precision: 0.5, recall: 0.5 });
    assert.equal(r.perTag['sensitive/Adult'].fn, 2);
  });
});

describe('CLI (real entry point)', () => {
  test('import → sample → eval round trip on a library directory', () => {
    seedAssets(['A.PNG', 'B.PNG']);
    lib.db.close();
    const labels = path.join(dir, 'labels.jsonl');
    fs.writeFileSync(labels, [label('A.PNG', 'chat', { context: 'work' }), label('B.PNG', 'receipt'), label('Z.PNG', 'chat')]
      .map((x) => JSON.stringify(x)).join('\n') + '\n');
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--library', dir], { encoding: 'utf8' });

    const dry = run('import', labels, '--dry-run');
    assert.equal(dry.status, 1, 'unmatched row ⇒ exit 1');
    assert.equal(JSON.parse(dry.stdout).inserted, 3);

    const imp = run('import', labels, '--model', 'claude-sonnet');
    assert.equal(JSON.parse(imp.stdout).inserted, 3);
    assert.deepEqual(JSON.parse(imp.stdout).unmatched, ['Z.PNG']);

    const s = run('sample', '--n', '2');
    assert.equal(s.status, 0, s.stderr);
    assert.equal(JSON.parse(s.stdout).picked, 2);

    const e = run('eval', '--finalize');
    assert.equal(e.status, 0, e.stderr);
    assert.match(e.stdout, /assets=2/);
    assert.match(e.stdout, /purpose\/chat\s+1\s+0\s+0\s+100%/);
  });
});
