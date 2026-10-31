import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openLibrary } from '../server/library.mjs';
import { compileMatcher, loadMatchers, runRules } from '../server/rules.mjs';
import { tagIdByPath } from '../server/suggestions.mjs';
import { cleanup, startTestServer, tempDir } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'cheap.mjs');

let dir, lib;
beforeEach(() => {
  dir = tempDir('rules');
  lib = openLibrary(dir);
});
afterEach(() => {
  try { lib.db.close(); } catch { /* closed */ }
  cleanup(dir);
});

let seq = 0;
/** Inserts an asset (no file needed) with optional OCR text. Returns its id. */
function asset({ text = null, filename = `IMG_${++seq}.PNG`, width = 1170, height = 2532 } = {}) {
  const id = Number(lib.db.prepare(`INSERT INTO assets (root_id, rel_path, sha256, filename, ext, width, height, bytes,
    file_mtime, imported_at) VALUES (?, ?, ?, ?, 'png', ?, ?, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`)
    .run(lib.managedRootId, `x/${seq}.png`, String(seq).padStart(64, '0'), filename, width, height).lastInsertRowid);
  if (text != null) setOcr(id, text);
  return id;
}
function setOcr(id, text, ts = new Date().toISOString()) {
  lib.db.prepare(`INSERT INTO ocr_results (asset_id, engine, lang, raw_text, cleaned_text, char_count, created_at)
    VALUES (?, 'windows-ocr', 'zh-Hant-TW', ?, ?, ?, ?)`).run(id, text, text, [...text].length, ts);
}
const sugg = (id) => lib.db.prepare(`SELECT t.name, s.confidence, s.reason, s.status FROM asset_suggestions s
  JOIN tags t ON t.id = s.tag_id WHERE s.asset_id = ? AND s.stage = 'rule' ORDER BY t.name`).all(id);
const names = (id, status = 'pending') => sugg(id).filter((s) => s.status === status).map((s) => s.name);

describe('seed rules (migration 005)', () => {
  test('sensitive + receipt + weak chat seeds exist, all compile, sensitive confidences < 0.9 (recall-first)', () => {
    const { matchers, invalid } = loadMatchers(lib.db);
    assert.deepEqual(invalid, []);
    const byTag = (p) => matchers.filter((m) => m.tag_id === tagIdByPath(lib.db, p));
    assert.equal(byTag('sensitive').length, 6);
    assert.equal(byTag('purpose/receipt').length, 2);
    assert.equal(byTag('purpose/chat').length, 1);
    assert.ok(byTag('sensitive').every((m) => m.confidence < 0.9));
  });
});

describe('sensitive rules', () => {
  const cases = [
    ['keyword 密碼', '請輸入您的密碼', true],
    ['keyword 驗證碼', '您的驗證碼為 482913', true],
    ['keyword OTP (case-insensitive)', 'your otp is here', true],
    ['keyword 餘額', '帳戶餘額 NT$ 3,200', true],
    ['keyword 護照', '護照號碼', true],
    ['credit card 4-4-4-4 dashes', 'ref 4111-1111-1111-1111 end', true],
    ['credit card spaced', 'ref 4111 1111 1111 1111 end', true],
    ['TW national id', 'ID A123456789 ok', true],
    ['TW national id female', 'ID F223456789 ok', true],
    ['mobile with dashes', 'call 0912-345-678 now', true],
    ['mobile plain', 'call 0912345678 now', true],
    ['national id with bad gender digit', 'code A323456789 ok', false],
    ['order number is not a card', '訂單 12345678 已出貨', false],
    ['landline is not a mobile', 'tel 02-2345-6789', false],
    ['plain chatter', '今天天氣很好我們去吃飯', false],
  ];
  for (const [label, text, hit] of cases) {
    test(`${hit ? 'hits' : 'misses'}: ${label}`, () => {
      const id = asset({ text });
      runRules(lib.db);
      assert.equal(names(id).includes('sensitive'), hit, JSON.stringify(sugg(id)));
    });
  }

  test('reason names the rule only — never the matched OCR text', () => {
    const secret = '我的密碼是 hunter2，卡號 4111-1111-1111-1111，身分證 A123456789，手機 0912-345-678';
    const id = asset({ text: secret });
    runRules(lib.db);
    const s = sugg(id).find((x) => x.name === 'sensitive');
    assert.match(s.reason, /^命中規則「[^」]+」$/);
    for (const leak of ['密碼', 'hunter2', '4111', 'A123456789', '0912', '345-678']) assert.ok(!s.reason.includes(leak), `${leak} in ${s.reason}`);
    assert.equal(s.confidence, 0.75, 'highest-confidence hit for the tag wins (身分證字號樣式)');
  });
});

describe('receipt / chat rules and other kinds', () => {
  test('receipt keywords; confidence from the strongest rule', () => {
    const a = asset({ text: '轉帳成功 金額 500' });
    const b = asset({ text: '合計 NT$120' });
    runRules(lib.db);
    assert.deepEqual(sugg(a).find((x) => x.name === 'receipt').confidence, 0.7);
    assert.deepEqual(sugg(b).find((x) => x.name === 'receipt').confidence, 0.5);
    assert.ok(names(a).includes('sensitive'), '轉帳 is also a sensitive keyword (recall-first)');
  });

  test('all / filename / dimension kinds', () => {
    const all = compileMatcher({ kind: 'all', pattern: '訂單、出貨' });
    assert.equal(all({ text: '您的訂單已出貨' }), true);
    assert.equal(all({ text: '您的訂單' }), false);
    assert.equal(compileMatcher({ kind: 'filename', pattern: '^line_' })({ filename: 'LINE_123.jpg' }), true);
    const tall = compileMatcher({ kind: 'dimension', pattern: 'ratio>=3, w<=1200' });
    assert.equal(tall({ width: 1170, height: 4000 }), true);
    assert.equal(tall({ width: 1170, height: 2532 }), false);
    assert.throws(() => compileMatcher({ kind: 'dimension', pattern: 'depth>3' }));
  });

  test('an invalid user regex is reported, not fatal', () => {
    lib.db.prepare(`INSERT INTO tag_matchers (tag_id, name, kind, pattern, confidence, created_at)
      VALUES (?, 'broken', 'regex', '(unclosed', 0.5, 'x')`).run(tagIdByPath(lib.db, 'sensitive'));
    const id = asset({ text: '密碼' });
    const r = runRules(lib.db);
    assert.deepEqual(r.invalid.map((x) => x.name), ['broken']);
    assert.ok(names(id).includes('sensitive'));
  });
});

describe('re-runs', () => {
  test('idempotent; rule change re-evaluates and supersedes; re-enable revives; newer OCR re-evaluates', () => {
    const id = asset({ text: '請輸入密碼' });
    const r1 = runRules(lib.db);
    assert.equal(r1.evaluated, 1);
    assert.equal(r1.inserted, 1);
    const r2 = runRules(lib.db);
    assert.equal(r2.evaluated, 0, 'unchanged rules + no new OCR ⇒ skipped');
    assert.equal(sugg(id).length, 1);

    lib.db.prepare("UPDATE tag_matchers SET enabled = 0 WHERE name = '敏感關鍵字：帳密'").run();
    const r3 = runRules(lib.db);
    assert.equal(r3.evaluated, 1, 'rule-set hash changed ⇒ re-evaluated');
    assert.equal(r3.superseded, 1);
    assert.deepEqual(names(id, 'superseded'), ['sensitive']);

    lib.db.prepare("UPDATE tag_matchers SET enabled = 1 WHERE name = '敏感關鍵字：帳密'").run();
    const r4 = runRules(lib.db);
    assert.equal(r4.revived, 1);
    assert.deepEqual(names(id), ['sensitive']);
    assert.equal(sugg(id).length, 1, 'no duplicate rows');

    setOcr(id, '付款成功', new Date(Date.now() + 1000).toISOString());
    const r5 = runRules(lib.db);
    assert.equal(r5.evaluated, 1, 'newer OCR ⇒ re-evaluated');
    assert.deepEqual(names(id), ['receipt']);
    assert.deepEqual(names(id, 'superseded'), ['sensitive']);
  });

  test('dry run writes nothing', () => {
    const id = asset({ text: '密碼' });
    const r = runRules(lib.db, { dryRun: true });
    assert.equal(r.inserted, 1);
    assert.equal(sugg(id).length, 0);
    assert.equal(runRules(lib.db).evaluated, 1, 'dry run did not record runs');
  });
});

describe('tag description via the HTTP tag API', () => {
  test('create / read / update / clear description; length ≤ 200', async () => {
    lib.db.close();
    const { app, base } = await startTestServer(dir);
    try {
      const call = async (method, url, body) => {
        const res = await fetch(`${base}${url}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
      };
      const created = await call('POST', '/api/tags', { name: 'context/Gaming', description: '遊戲、實況' });
      assert.equal(created.status, 201);
      assert.equal(created.body.description, '遊戲、實況');
      const upd = await call('PATCH', `/api/tags/${created.body.id}`, { description: '  手遊、主機遊戲、遊戲攻略 ' });
      assert.equal(upd.status, 200);
      assert.equal(upd.body.description, '手遊、主機遊戲、遊戲攻略');
      const listed = (await call('GET', '/api/tags')).body.find((t) => t.id === created.body.id);
      assert.equal(listed.description, '手遊、主機遊戲、遊戲攻略');
      assert.equal((await call('PATCH', `/api/tags/${created.body.id}`, { name: 'Games' })).body.description, '手遊、主機遊戲、遊戲攻略', 'rename keeps description');
      assert.equal((await call('PATCH', `/api/tags/${created.body.id}`, { description: 'x'.repeat(201) })).status, 400);
      assert.equal((await call('PATCH', `/api/tags/${created.body.id}`, { description: '' })).body.description, null);
    } finally {
      await app.close();
    }
  });
});

describe('CLI cheap.mjs (real entry point)', () => {
  test('all: dup + ocr (injected runner) + rules on a real library; second run is a no-op; errors ⇒ exit 1', async () => {
    lib.db.close();
    const src = path.join(dir, '..', `${path.basename(dir)}-src`);
    fs.mkdirSync(src, { recursive: true });
    const raw = Buffer.from(Array.from({ length: 160 }, (_, i) => (i * 97) % 256));
    const base = sharp(raw, { raw: { width: 16, height: 10, channels: 1 } }).resize(640, 400, { kernel: 'nearest' });
    await base.clone().png().toFile(path.join(src, 'a_pay.png'));
    await base.clone().resize(320, 200).png().toFile(path.join(src, 'b_copy.png'));
    const imp = spawnSync(process.execPath, [path.join(path.dirname(CLI), 'import.mjs'), src, '--library', dir], { encoding: 'utf8' });
    assert.equal(imp.status, 0, imp.stderr + imp.stdout);

    const runnerFile = path.join(dir, 'fake-ocr.mjs');
    fs.writeFileSync(runnerFile, `export default async (files) => files.map((f) => ({ path: f,
      text: /b_copy/.test(f) ? 'ok' : '轉帳成功 卡號 4111-1111-1111-1111' }));\n`);
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--library', dir], { encoding: 'utf8' });

    const r = run('all', '--ocr-runner', runnerFile);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dup.inserted, 1);
    assert.equal(out.ocr.ok, 2);
    assert.equal(out.ocr.lowYield, 1);
    assert.equal(out.rules.hitAssets, 1);

    const again = JSON.parse(run('all', '--ocr-runner', runnerFile).stdout);
    assert.deepEqual([again.dup.hashed, again.dup.inserted, again.ocr.processed, again.rules.evaluated], [0, 0, 0, 0]);

    const check = openLibrary(dir);
    try {
      const rows = check.db.prepare(`SELECT a.filename, t.name, s.stage FROM asset_suggestions s JOIN assets a ON a.id = s.asset_id
        JOIN tags t ON t.id = s.tag_id ORDER BY a.filename, s.stage, t.name`).all().map((x) => `${x.filename}:${x.stage}:${x.name}`);
      assert.deepEqual(rows, ['a_pay.png:rule:receipt', 'a_pay.png:rule:sensitive', 'b_copy.png:dup:ephemeral']);
      check.db.prepare("DELETE FROM suggestion_runs WHERE stage = 'ocr'").run();
    } finally {
      check.db.close();
    }
    const failRunner = path.join(dir, 'fail-ocr.mjs');
    fs.writeFileSync(failRunner, 'export default async () => { throw new Error("boom"); };\n');
    const bad = run('ocr', '--ocr-runner', failRunner);
    assert.equal(bad.status, 1, 'OCR errors ⇒ non-zero exit');
    assert.equal(JSON.parse(bad.stdout).ocr.errorCount, 2);
    cleanup(src);
  });
});
