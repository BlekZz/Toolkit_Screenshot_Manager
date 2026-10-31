import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { importFolder } from '../server/importer.mjs';
import { assetFilePath, openLibrary } from '../server/library.mjs';
import { charCount, cleanText, LOW_YIELD_CHARS, powershellOcr, runOcr } from '../server/ocr.mjs';
import { tagIdByPath } from '../server/suggestions.mjs';
import { cleanup, makeImages, tempDir } from './helpers.mjs';

let dir, lib;
beforeEach(() => {
  dir = tempDir('ocr');
  lib = openLibrary(path.join(dir, 'lib'));
});
afterEach(() => {
  try { lib.db.close(); } catch { /* closed */ }
  cleanup(dir);
});

/** Imports n images; returns assets ordered by id with their absolute file paths. */
async function seed(n) {
  await makeImages(path.join(dir, 'src'), n);
  await importFolder(lib, path.join(dir, 'src'));
  return lib.db.prepare('SELECT * FROM assets ORDER BY id').all().map((a) => ({ ...a, file: assetFilePath(lib, a) }));
}

/** Fake runner: text per file from `texts` (by asset index); records each call's file list. */
function fakeRunner(assets, texts) {
  const calls = [];
  const runner = async (files) => {
    calls.push(files);
    return files.map((f) => {
      const i = assets.findIndex((a) => a.file === f);
      const t = texts[i];
      return t instanceof Error ? { path: f, error: t.message } : { path: f, text: t };
    });
  };
  return { runner, calls };
}
const lowYield = () => lib.db.prepare(`SELECT asset_id FROM asset_tags WHERE tag_id = ? AND source = 'ocr' ORDER BY asset_id`)
  .all(tagIdByPath(lib.db, 'ocr/low-yield')).map((r) => r.asset_id);
const runStatus = (id) => lib.db.prepare("SELECT status FROM suggestion_runs WHERE asset_id = ? AND stage = 'ocr'").get(id)?.status;

describe('runOcr', () => {
  test('stores ocr_results (windows-ocr) + text_fts; cleanText applied; < 5 chars ⇒ ocr/low-yield, exactly 5 is not', async () => {
    const assets = await seed(3);
    const { runner } = fakeRunner(assets, ['付款 成功 金額 120 元', '12345', 'abcd']);
    const r = await runOcr(lib, { runner });
    assert.equal(r.ok, 3);
    assert.equal(r.lowYield, 1);
    const rows = lib.db.prepare('SELECT * FROM ocr_results ORDER BY asset_id').all();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].engine, 'windows-ocr');
    assert.equal(rows[0].raw_text, '付款 成功 金額 120 元');
    assert.equal(rows[0].cleaned_text, '付款成功金額 120 元');
    assert.deepEqual(rows.map((x) => x.char_count), [charCount('付款成功金額 120 元'), 5, 4]);
    assert.equal(LOW_YIELD_CHARS, 5);
    assert.deepEqual(lowYield(), [assets[2].id]);
    const fts = lib.db.prepare("SELECT ref_id FROM text_fts WHERE kind = 'ocr' AND text_fts MATCH ?").all('付款成功');
    assert.deepEqual(fts.map((x) => x.ref_id), [rows[0].id]);
  });

  test('resumes: completed assets are skipped; errored ones are retried; re-OCR replaces old text and low-yield', async () => {
    const assets = await seed(3);
    const first = fakeRunner(assets, ['hello world', new Error('decode failed'), 'ab']);
    const r1 = await runOcr(lib, { runner: first.runner });
    assert.equal(r1.ok, 2);
    assert.deepEqual(r1.errors.map((e) => e.asset_id), [assets[1].id]);
    assert.equal(runStatus(assets[1].id), 'error');

    const second = fakeRunner(assets, ['x', 'now readable text', 'y']);
    const r2 = await runOcr(lib, { runner: second.runner });
    assert.deepEqual(second.calls, [[assets[1].file]], 'only the errored asset is sent again');
    assert.equal(r2.ok, 1);
    assert.equal(runStatus(assets[1].id), 'ok');

    const third = fakeRunner(assets, []);
    const r3 = await runOcr(lib, { runner: third.runner });
    assert.equal(third.calls.length, 0);
    assert.equal(r3.pending, 0);
    assert.equal(lib.db.prepare('SELECT COUNT(*) AS n FROM ocr_results').get().n, 3);

    // Forced re-OCR (run record removed) replaces the old row + FTS entry and drops a stale low-yield tag.
    assert.deepEqual(lowYield(), [assets[2].id]);
    lib.db.prepare("DELETE FROM suggestion_runs WHERE asset_id = ? AND stage = 'ocr'").run(assets[2].id);
    await runOcr(lib, { runner: fakeRunner(assets, [null, null, 'much longer text now']).runner });
    const rows = lib.db.prepare('SELECT id, cleaned_text FROM ocr_results WHERE asset_id = ?').all(assets[2].id);
    assert.deepEqual(rows.map((x) => x.cleaned_text), ['much longer text now']);
    assert.deepEqual(lowYield(), []);
    assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM text_fts WHERE kind = 'ocr'").get().n, 3);
  });

  test('a failing batch records errors for that batch only and the run continues', async () => {
    const assets = await seed(5);
    let call = 0;
    const runner = async (files) => {
      call++;
      if (call === 2) throw new Error('powershell crashed');
      return files.map((f) => ({ path: f, text: 'plenty of text' }));
    };
    const r = await runOcr(lib, { runner, batchSize: 2 });
    assert.equal(r.batches, 3);
    assert.equal(r.failedBatches, 1);
    assert.equal(r.ok, 3);
    assert.deepEqual(r.errors.map((e) => e.asset_id), [assets[2].id, assets[3].id]);
    assert.match(r.errors[0].error, /batch failed: powershell crashed/);
    assert.equal(runStatus(assets[2].id), 'error');
    assert.equal(runStatus(assets[4].id), 'ok');
  });

  test('limit and dry run', async () => {
    const assets = await seed(3);
    const dry = fakeRunner(assets, ['a', 'b', 'c']);
    const d = await runOcr(lib, { runner: dry.runner, dryRun: true });
    assert.equal(d.pending, 3);
    assert.equal(dry.calls.length, 0);
    assert.equal(lib.db.prepare('SELECT COUNT(*) AS n FROM ocr_results').get().n, 0);
    const lim = fakeRunner(assets, ['long enough', 'long enough', 'long enough']);
    const r = await runOcr(lib, { runner: lim.runner, limit: 2 });
    assert.equal(r.ok, 2);
  });

  test('cleanText matches the legacy extract.mjs fixes', () => {
    assert.equal(cleanText('SSlS 與 T0kyo'), 'SSIS 與 Tokyo');
    assert.equal(cleanText('1 · 5 萬'), '1.5 萬');
    assert.equal(cleanText('甲 , 乙'), '甲，乙');
    assert.equal(cleanText('  資 料 分 析  '), '資料分析');
  });
});

describe('real Windows OCR (powershell.exe + extract-ocr.ps1)', () => {
  const reason = process.platform !== 'win32' ? 'not Windows' : null;
  test('recognises text in a synthetic image', { skip: reason ?? false }, async (t) => {
    const file = path.join(dir, 'text.png');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200">
      <rect width="100%" height="100%" fill="white"/>
      <text x="40" y="120" font-family="Arial, sans-serif" font-size="72" fill="black">HELLO OCR 2026</text></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(file);
    let res;
    try {
      res = await powershellOcr([file]);
    } catch (err) {
      // Only an environment problem (no OCR language pack / no WinRT) may skip; anything else fails.
      if (/No supported OCR language|TryCreateFromLanguage|ENOENT/.test(err.message)) { t.skip(`Windows OCR unavailable: ${err.message}`); return; }
      throw err;
    }
    assert.equal(res.length, 1);
    assert.equal(res[0].path, file);
    assert.equal(res[0].error, undefined, res[0].error);
    assert.match(res[0].text.replace(/\s+/g, ' '), /HELLO\s*OCR/i);
  });
});
