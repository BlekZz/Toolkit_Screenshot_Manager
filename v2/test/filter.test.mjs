import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeHash, emptyFilter, encodeHash, pruneFilter, soleAlbum, toPayload, UNFILED_AST } from '../web/src/lib/filter.js';

const f = (over) => ({ ...emptyFilter(), ...over });

test('empty filter → {op:all}', () => {
  assert.deepEqual(toPayload(emptyFilter()), { ast: { op: 'all' }, q: '' });
});

test('excluded album / tag become NOT nodes; included stay positive', () => {
  assert.deepEqual(toPayload(f({ albums: { 3: 'out' } })).ast, { op: 'not', arg: { op: 'album', id: 3 } });
  assert.deepEqual(toPayload(f({ tags: { 7: 'in' } })).ast, { op: 'tag', id: 7 });
  assert.deepEqual(toPayload(f({ albums: { 1: 'in' }, tags: { 7: 'out' } })).ast, {
    op: 'and', args: [{ op: 'album', id: 1 }, { op: 'not', arg: { op: 'tag', id: 7 } }],
  });
});

test('tagMode / albumMode decide AND vs OR among included items', () => {
  const two = { 1: 'in', 2: 'in' };
  assert.equal(toPayload(f({ tags: two, tagMode: 'all' })).ast.op, 'and');
  assert.equal(toPayload(f({ tags: two, tagMode: 'any' })).ast.op, 'or');
  assert.equal(toPayload(f({ albums: two, albumMode: 'any' })).ast.op, 'or');
  assert.equal(toPayload(f({ albums: two, albumMode: 'all' })).ast.op, 'and');
});

test('unfiled = neither album nor tag', () => {
  assert.deepEqual(toPayload(f({ smart: 'unfiled' })).ast, UNFILED_AST);
  assert.deepEqual(UNFILED_AST.args.map((n) => n.arg.what).sort(), ['album', 'tag']);
  assert.ok(UNFILED_AST.args.every((n) => n.op === 'not'));
});

test('smart album id and query text pass through', () => {
  assert.deepEqual(toPayload(f({ smart: 4, q: '  tag:x ' })), { ast: { op: 'smart', id: 4 }, q: 'tag:x' });
});

test('soleAlbum only when exactly one included album and nothing else', () => {
  assert.equal(soleAlbum(f({ albums: { 5: 'in' } })), 5);
  assert.equal(soleAlbum(f({ albums: { 5: 'in', 6: 'in' } })), null);
  assert.equal(soleAlbum(f({ albums: { 5: 'in' }, tags: { 1: 'in' } })), null);
  assert.equal(soleAlbum(f({ albums: { 5: 'in' }, q: 'x' })), null);
});

test('hash round-trip; garbage decodes to empty', () => {
  const v = f({ tags: { 7: 'out' }, albums: { 1: 'in' }, tagMode: 'any', smart: 'unfiled', q: '收據' });
  assert.deepEqual(decodeHash(encodeHash(v)), v);
  assert.deepEqual(decodeHash('#f=%7Bnot json'), emptyFilter());
  assert.deepEqual(decodeHash('#f=' + encodeURIComponent(JSON.stringify({ tags: { x: 'in', 3: 'maybe', 4: 'in' }, smart: 'evil' }))),
    f({ tags: { 4: 'in' } }));
});

test('pruneFilter drops references to deleted items, keeps identity when unchanged', () => {
  const cat = { tags: [{ id: 1 }], albums: [{ id: 2 }], smart: [{ id: 3 }] };
  const ok = f({ tags: { 1: 'in' }, albums: { 2: 'out' }, smart: 3 });
  assert.equal(pruneFilter(ok, cat), ok);
  assert.deepEqual(pruneFilter(f({ tags: { 1: 'in', 9: 'out' }, albums: { 8: 'in' }, smart: 99 }), cat), f({ tags: { 1: 'in' } }));
  assert.equal(pruneFilter(f({ smart: 'unfiled' }), cat).smart, 'unfiled');
});

// ---- A1 query syntax: suggest: / confidence: / age: (server compiler, real SQLite) ----
import { openLibrary } from '../server/library.mjs';
import { createCatalog } from '../server/catalog.mjs';
import { tagIdByPath } from '../server/suggestions.mjs';
import { cleanup, tempDir } from './helpers.mjs';

function suggestFixture() {
  const dir = tempDir('filter-suggest');
  const lib = openLibrary(dir);
  const day = 86400000;
  const ins = lib.db.prepare(`INSERT INTO assets (id, root_id, rel_path, sha256, filename, ext, width, height, bytes,
    file_mtime, imported_at) VALUES (?, ?, ?, ?, ?, 'png', 1, 1, 1, ?, ?)`);
  // 1: 60 days old, 2: 20 days old, 3: 3 days old, 4: 1 hour old
  [60, 20, 3, 1 / 24].forEach((age, i) => {
    const t = new Date(Date.now() - age * day).toISOString();
    ins.run(i + 1, lib.managedRootId, `x/${i}`, String(i).padStart(64, '0'), `f${i}.png`, t, t);
  });
  const sens = tagIdByPath(lib.db, 'sensitive');
  const adult = Number(lib.db.prepare("INSERT INTO tags (parent_id, name) VALUES (?, 'Adult')").run(sens).lastInsertRowid);
  const receipt = tagIdByPath(lib.db, 'purpose/receipt');
  const s = lib.db.prepare(`INSERT INTO asset_suggestions (asset_id, tag_id, stage, confidence, status, created_at)
    VALUES (?, ?, 'rule', ?, ?, 'x')`);
  s.run(1, sens, 0.5, 'pending');     // pending, low confidence
  s.run(1, receipt, 0.9, 'pending');  // high confidence but another tag
  s.run(2, sens, 0.95, 'rejected');   // decided ⇒ not a suggestion any more
  s.run(3, adult, 0.85, 'pending');   // child tag counts for suggest:sensitive
  s.run(4, sens, 0.9, 'accepted');
  const cat = createCatalog(lib.db);
  const ids = (q) => [...cat.query({ q }).ids].sort((a, b) => a - b);
  return { ids, done: () => { lib.db.close(); cleanup(dir); } };
}

test('suggest: matches pending suggestions only, including child tags', () => {
  const { ids, done } = suggestFixture();
  try {
    assert.deepEqual(ids('suggest:sensitive'), [1, 3]);
    assert.deepEqual(ids('suggest:sensitive/Adult'), [3]);
    assert.deepEqual(ids('suggest:purpose'), [1]);
    assert.deepEqual(ids('-suggest:sensitive'), [2, 4]);
  } finally { done(); }
});

test('confidence: folds into suggest: siblings (same row); standalone = any pending suggestion', () => {
  const { ids, done } = suggestFixture();
  try {
    assert.deepEqual(ids('suggest:sensitive confidence:>=0.8'), [3], 'asset 1 has sensitive@0.5 and receipt@0.9 — not the same row');
    assert.deepEqual(ids('confidence:>=0.8 AND suggest:sensitive'), [3]);
    assert.deepEqual(ids('suggest:sensitive confidence:<0.8'), [1]);
    assert.deepEqual(ids('confidence:>=0.8'), [1, 3]);
    assert.deepEqual(ids('confidence:0.9'), [1], 'bare number means >=');
    assert.throws(() => ids('confidence:>=2'), /between 0 and 1/);
  } finally { done(); }
});

test('age: compares file_mtime against now; > means older', () => {
  const { ids, done } = suggestFixture();
  try {
    assert.deepEqual(ids('age:>30d'), [1]);
    assert.deepEqual(ids('age:<7d'), [3, 4]);
    assert.deepEqual(ids('age:>=2w'), [1, 2]);
    assert.deepEqual(ids('age:<2h'), [4]);
    assert.deepEqual(ids('age:>7d suggest:sensitive'), [1]);
    assert.throws(() => ids('age:30d'), /age: expects/);
    assert.throws(() => ids('age:=30d'), /age: expects/);
  } finally { done(); }
});
