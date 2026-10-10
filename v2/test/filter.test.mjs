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
