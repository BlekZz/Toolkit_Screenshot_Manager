import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { importFolder } from '../server/importer.mjs';
import { openLibrary } from '../server/library.mjs';
import { evaluate, importLabels, sampleForReview, tagIdByPath } from '../server/suggestions.mjs';
import { buildPrompt, buildTaxonomy, runVlm, toSuggestionItems } from '../server/vlm.mjs';
import { compareSources } from '../server/vlm-compare.mjs';
import { cleanup, makeImages, tempDir } from './helpers.mjs';

let src, dir, lib;
beforeEach(async () => {
  src = tempDir('vlm-src');
  dir = tempDir('vlm-lib');
  await makeImages(path.join(src, 'Input'), 4);
  lib = openLibrary(dir);
  await importFolder(lib, src);
});
afterEach(() => {
  try { lib.db.close(); } catch { /* closed */ }
  cleanup(src, dir);
});

const ids = () => lib.db.prepare('SELECT id FROM assets ORDER BY id').all().map((r) => r.id);
const answer = (over = {}) => ({ purpose: 'chat', context: 'work', sensitive: false, confidence: 0.8, reason: '對話', ...over });
const fake = (fn) => async (args) => ({ answer: await fn(args), ms: 5 });
const adultTag = () => Number(lib.db.prepare("INSERT INTO tags (parent_id, name, is_system, description) VALUES (?, 'Adult', 0, '成人內容')")
  .run(tagIdByPath(lib.db, 'sensitive')).lastInsertRowid);

describe('taxonomy and prompt', () => {
  test('includes purposes, contexts (incl. user-made), only described customs and sensitive subtypes', () => {
    lib.db.prepare("INSERT INTO tags (parent_id, name, is_system) VALUES (?, 'Gaming', 0)").run(tagIdByPath(lib.db, 'context'));
    lib.db.prepare("INSERT INTO tags (parent_id, name, is_system) VALUES (?, '沒描述', 0)").run(tagIdByPath(lib.db, 'custom'));
    adultTag();
    const tax = buildTaxonomy(lib.db);
    assert.deepEqual(tax.purposes.map((t) => t.name).sort(), ['chat', 'ephemeral', 'receipt', 'text-note', 'translate', 'visual-ref']);
    assert.ok(tax.contexts.some((t) => t.name === 'Gaming'));
    assert.ok(!tax.customs.some((t) => t.name === '沒描述'));
    assert.equal(tax.customs.length, 7);
    assert.deepEqual(tax.sensitiveSubs.map((t) => t.name), ['Adult']);
    const { schema, prompt } = buildPrompt(tax);
    assert.deepEqual(schema.properties.sensitive_kind.items.enum, ['Adult']);
    assert.match(prompt, /旅遊: 景點/);
  });

  test('prompt hash changes when a tag description changes', () => {
    const h1 = buildPrompt(buildTaxonomy(lib.db)).promptHash;
    lib.db.prepare('UPDATE tags SET description = ? WHERE id = ?').run('換個說法', tagIdByPath(lib.db, 'custom/旅遊'));
    assert.notEqual(buildPrompt(buildTaxonomy(lib.db)).promptHash, h1);
  });
});

describe('toSuggestionItems', () => {
  test('rejects out-of-taxonomy and malformed answers', () => {
    const tax = buildTaxonomy(lib.db);
    assert.equal(toSuggestionItems(tax, answer({ purpose: 'meme' })).ok, false);
    assert.equal(toSuggestionItems(tax, answer({ context: 'school' })).ok, false);
    assert.equal(toSuggestionItems(tax, answer({ confidence: 1.5 })).ok, false);
    assert.equal(toSuggestionItems(tax, answer({ sensitive: 'yes' })).ok, false);
    assert.equal(toSuggestionItems(tax, null).ok, false);
  });

  test('unsure/unknown give no tag; sensitive_kind and topics map to tags', () => {
    const adult = adultTag();
    const tax = buildTaxonomy(lib.db);
    const r = toSuggestionItems(tax, answer({ purpose: 'unsure', context: 'unknown', sensitive: true, sensitive_kind: ['Adult'], topics: ['旅遊', 'nope'] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.items.map((i) => i.tagId).sort(), [tagIdByPath(lib.db, 'sensitive'), adult, tagIdByPath(lib.db, 'custom/旅遊')].sort());
  });
});

describe('runVlm', () => {
  test('writes vlm suggestions with model+prompt hash and is resumable', async () => {
    let calls = 0;
    const r1 = await runVlm(lib, { model: 'm', classify: fake(() => { calls++; return answer(); }) });
    assert.equal(r1.ok, 4);
    assert.equal(r1.inserted, 8);
    const row = lib.db.prepare("SELECT DISTINCT stage, model, prompt_hash FROM asset_suggestions").all();
    assert.deepEqual(row.map((x) => [x.stage, x.model, x.prompt_hash]), [['vlm', 'm', r1.promptHash]]);
    const r2 = await runVlm(lib, { model: 'm', classify: fake(() => { calls++; return answer(); }) });
    assert.equal(r2.total, 0);
    assert.equal(calls, 4);
  });

  test('assets whose answer had no tag are still marked done (no endless retries)', async () => {
    await runVlm(lib, { model: 'm', classify: fake(() => answer({ purpose: 'unsure', context: 'unknown' })) });
    const r2 = await runVlm(lib, { model: 'm', classify: fake(() => answer()) });
    assert.equal(r2.total, 0);
  });

  test('pauses after consecutive transport errors and retries those assets next run', async () => {
    const r1 = await runVlm(lib, { model: 'm', maxConsecutiveErrors: 2, classify: async () => { throw new Error('timeout after 1ms'); } });
    assert.equal(r1.errors, 2);
    assert.match(r1.paused, /2 consecutive errors/);
    const r2 = await runVlm(lib, { model: 'm', classify: fake(() => answer()) });
    assert.equal(r2.total, 4, 'errored and untouched assets are retried');
    assert.equal(r2.ok, 4);
  });

  test('schema errors are recorded but do not pause the run', async () => {
    const r = await runVlm(lib, { model: 'm', maxConsecutiveErrors: 2, classify: fake(() => answer({ purpose: 'meme' })) });
    assert.equal(r.paused, null);
    assert.equal(r.errors, 4);
    assert.equal(lib.db.prepare("SELECT COUNT(*) AS n FROM suggestion_runs WHERE status = 'error' AND detail LIKE 'schema:%'").get().n, 4);
  });

  test('assetIds restricts the run; reason is sanitized', async () => {
    const [first] = ids();
    const r = await runVlm(lib, { model: 'm', assetIds: [first], classify: fake(() => answer({ reason: '卡號 5024 末四碼' })) });
    assert.equal(r.total, 1);
    assert.ok(!/5024/.test(lib.db.prepare('SELECT reason FROM asset_suggestions LIMIT 1').get().reason));
  });
});

describe('evaluate by source and compareSources', () => {
  test('stage/model filter scores only that source; compare counts agreement', async () => {
    const names = lib.db.prepare('SELECT filename FROM assets ORDER BY id').all().map((r) => r.filename);
    importLabels(lib.db, names.map((file) => ({ file, purpose: 'chat', context: 'work', sensitive: false, confidence: 0.9, reason: 'c' })), { model: 'claude' });
    sampleForReview(lib.db, { n: 4 }); // applies claude's chat+work tags as the "truth"
    let k = 0;
    await runVlm(lib, { model: 'm', classify: fake(() => answer({ purpose: k++ % 2 ? 'chat' : 'receipt' })) });

    const v = evaluate(lib.db, { stage: 'vlm', model: 'm' });
    assert.deepEqual([v.perTag['purpose/chat'].tp, v.perTag['purpose/chat'].fn, v.perTag['purpose/receipt'].fp], [2, 2, 2]);
    assert.throws(() => evaluate(lib.db, { stage: 'vlm', finalize: true }), /finalize/);

    const c = compareSources(lib.db, { a: { stage: 'vlm', model: 'm' }, b: { model: 'claude' } });
    assert.equal(c.assets, 4);
    assert.equal(c.purposeAgree, 2);
    assert.equal(c.contextAgree, 4);
    assert.deepEqual(c.purposePairs, { 'chat→receipt': 2 });
  });
});
