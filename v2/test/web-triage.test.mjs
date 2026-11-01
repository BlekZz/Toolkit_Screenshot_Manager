import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isEditableTarget, nextIndex, planUndo, triageAction } from '../web/src/lib/triageKeys.js';
import { buildGroups, chunks, firstRowAt, layoutGroups } from '../web/src/lib/groups.js';

// P2c 前端：Triage 鍵位分派（§7）、游標重定位、Z 合併撤銷計畫、依相簿分組版面。

const key = (k, extra = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...extra });
const act = (k, extra, ctx) => triageAction(key(k, extra), ctx);

describe('triageAction — browse mode', () => {
  test('Q W E R Z S map per §7 (case-insensitive)', () => {
    assert.deepEqual(act('q'), { type: 'crop-start', purpose: 'bundle' });
    assert.deepEqual(act('Q', { shiftKey: true }), { type: 'crop-start', purpose: 'bundle' });
    assert.deepEqual(act('w'), { type: 'crop-start', purpose: 'keep' });
    assert.deepEqual(act('e'), { type: 'later' });
    assert.deepEqual(act('r'), { type: 'trash' });
    assert.deepEqual(act('z'), { type: 'undo' });
    assert.deepEqual(act('s'), { type: 'stats' });
  });

  test('G and Shift+G are distinct', () => {
    assert.deepEqual(act('g'), { type: 'bundle-toggle' });
    assert.deepEqual(act('G', { shiftKey: true }), { type: 'bundle-cancel' });
    // Caps-lock "G" without Shift is still plain G.
    assert.deepEqual(act('G'), { type: 'bundle-toggle' });
  });

  test('1–9 select slots 0–8; 0 and Shift+digit are not slots', () => {
    for (let n = 1; n <= 9; n++) assert.deepEqual(act(String(n)), { type: 'slot', slot: n - 1 });
    assert.deepEqual(act('0'), { type: 'zoom-reset' });
    assert.equal(act('1', { shiftKey: true }), null);
    assert.equal(act('!', { shiftKey: true }), null);
  });

  test('navigation and zoom', () => {
    assert.deepEqual(act('ArrowLeft'), { type: 'nav', delta: -1 });
    assert.deepEqual(act('a'), { type: 'nav', delta: -1 });
    assert.deepEqual(act('ArrowRight'), { type: 'nav', delta: 1 });
    assert.deepEqual(act('d'), { type: 'nav', delta: 1 });
    assert.deepEqual(act('ArrowUp'), { type: 'zoom', dir: 1 });
    assert.deepEqual(act('ArrowDown'), { type: 'zoom', dir: -1 });
    assert.deepEqual(act('Escape'), { type: 'exit' });
    assert.deepEqual(act('End'), { type: 'nav-to', where: 'last' });
  });

  test('modifier chords (Ctrl/Meta/Alt) never trigger triage actions', () => {
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
      for (const k of ['q', 'r', 'z', '1', 'g']) assert.equal(act(k, { [mod]: true }), null, `${mod}+${k}`);
    }
  });

  test('auto-repeat only repeats navigation, never a destructive key', () => {
    for (const k of ['r', 'e', 'q', 'w', 'z', '3', 'g']) assert.equal(act(k, { repeat: true }), null, k);
    assert.deepEqual(act('ArrowRight', { repeat: true }), { type: 'nav', delta: 1 });
  });

  test('unknown keys → null', () => {
    assert.equal(act('x'), null);
    assert.equal(act('F5'), null);
    assert.equal(triageAction(null), null);
  });
});

describe('triageAction — focus and overlays', () => {
  test('typing in an input / textarea / select / contenteditable never fires a shortcut', () => {
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'input' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' },
      { tagName: 'DIV', isContentEditable: true }]) {
      for (const k of ['q', 'w', 'e', 'r', 'z', 's', 'g', '1', '9', 'Escape']) {
        assert.equal(act(k, { target }), null, `${JSON.stringify(target)} ${k}`);
      }
    }
    assert.deepEqual(act('r', { target: { tagName: 'BUTTON' } }), { type: 'trash' });
  });

  test('isEditableTarget', () => {
    assert.equal(isEditableTarget(null), false);
    assert.equal(isEditableTarget({ tagName: 'BODY' }), false);
    assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  });

  test('a blocking dialog swallows everything', () => {
    assert.equal(act('r', {}, { blocked: true }), null);
    assert.equal(act('Escape', {}, { blocked: true, mode: 'crop' }), null);
  });
});

describe('triageAction — crop and stats modes', () => {
  test('crop: Enter/Space confirm, Esc cancel, 1–4 ratios; everything else (R, Z, slots 5–9) ignored', () => {
    const crop = { mode: 'crop' };
    assert.deepEqual(act('Enter', {}, crop), { type: 'crop-confirm' });
    assert.deepEqual(act(' ', {}, crop), { type: 'crop-confirm' });
    assert.deepEqual(act('Escape', {}, crop), { type: 'crop-cancel' });
    assert.deepEqual(act('1', {}, crop), { type: 'ratio', ratio: 'free' });
    assert.deepEqual(act('2', {}, crop), { type: 'ratio', ratio: '1:1' });
    assert.deepEqual(act('3', {}, crop), { type: 'ratio', ratio: '3:4' });
    assert.deepEqual(act('4', {}, crop), { type: 'ratio', ratio: '16:9' });
    for (const k of ['5', '9', 'r', 'z', 'e', 'q', 'g']) assert.equal(act(k, {}, crop), null, k);
    assert.equal(act('Enter', { repeat: true }, crop), null);
  });

  test('stats: S or Esc closes, other keys ignored', () => {
    const stats = { mode: 'stats' };
    assert.deepEqual(act('s', {}, stats), { type: 'stats' });
    assert.deepEqual(act('Escape', {}, stats), { type: 'stats' });
    assert.equal(act('r', {}, stats), null);
  });
});

describe('nextIndex — cursor after re-query', () => {
  test('still present: stay, or advance one', () => {
    assert.equal(nextIndex([1, 2, 3], [1, 2, 3], 1), 1);
    assert.equal(nextIndex([1, 2, 3], [1, 2, 3], 1, true), 2);
    assert.equal(nextIndex([1, 2, 3], [1, 2, 3], 2, true), 2); // last stays last
  });
  test('left the source: lands on the next survivor (no double skip on advance)', () => {
    assert.equal(nextIndex([1, 2, 3, 4], [1, 3, 4], 1, true), 1); // id 3
    assert.equal(nextIndex([1, 2, 3, 4], [1, 4], 1), 1); // 2 and 3 gone → 4
    assert.equal(nextIndex([1, 2, 3], [1, 2], 2), 1); // last removed → previous
    assert.equal(nextIndex([1, 2], [], 0), -1);
    assert.equal(nextIndex([1, 2], [7, 8, 9], 1), 1); // nothing in common
  });
});

describe('planUndo — one keystroke = one undo', () => {
  test('compound Q (3 events) undone together, newest first', () => {
    const history = [{ label: 'E', eventIds: [] }, { label: 'Q', eventIds: [10, 11, 12] }];
    const p = planUndo(history, [{ id: 12 }, { id: 11 }, { id: 10 }, { id: 9 }]);
    assert.deepEqual(p.eventIds, [12, 11, 10]);
    assert.equal(p.label, 'Q');
    assert.deepEqual(p.rest, [{ label: 'E', eventIds: [] }]);
  });
  test('newest global event is not ours → plain undo; entries holding that event are dropped', () => {
    const history = [{ label: 'R', eventIds: [5] }, { label: 'Q', eventIds: [10, 11] }];
    const p = planUndo(history, [{ id: 20 }, { id: 11 }]);
    assert.equal(p.eventIds, null);
    assert.deepEqual(p.rest, history);
    const q = planUndo([{ label: 'R', eventIds: [5] }, { label: 'Q', eventIds: [10, 11] }], [{ id: 11 }]); // 10 already undone
    assert.equal(q.eventIds, null);
    assert.deepEqual(q.rest, [{ label: 'R', eventIds: [5] }]);
  });
  test('Q, then E (no event id): Z, Z undoes E then the whole Q (browser regression)', () => {
    let history = [{ label: 'Q', eventIds: [10, 11, 12] }, { label: 'E', eventIds: [] }];
    const first = planUndo(history, [{ id: 13 }, { id: 12 }, { id: 11 }, { id: 10 }]);
    assert.equal(first.eventIds, null); // plain undo of #13 (the E)
    history = first.rest;
    const second = planUndo(history, [{ id: 12 }, { id: 11 }, { id: 10 }]);
    assert.deepEqual(second.eventIds, [12, 11, 10]);
  });

  test('catalog ops without event ids → plain undo; empty stack → nothing', () => {
    const p = planUndo([{ label: 'E', eventIds: [] }], [{ id: 3 }]);
    assert.equal(p.eventIds, null);
    assert.deepEqual(p.rest, []);
    assert.deepEqual(planUndo([], []).eventIds, null);
  });
});

describe('album grouping layout', () => {
  const albums = { 1: [{ id: 7, name: 'B' }], 2: [{ id: 6, name: 'A' }, { id: 7, name: 'B' }], 3: [], 4: [{ id: 6, name: 'A' }] };

  test('one section per album (name order), multi-album assets repeat, unfiled last; view order kept', () => {
    const g = buildGroups([4, 3, 2, 1], albums);
    assert.deepEqual(g.map((x) => [x.title, x.ids]), [['A', [4, 2]], ['B', [2, 1]], ['未在任何相簿', [3]]]);
    assert.deepEqual(buildGroups([3], albums).map((x) => x.key), ['none']);
    assert.deepEqual(buildGroups([], albums), []);
  });

  test('layout rows and visible-row search', () => {
    const g = buildGroups([4, 3, 2, 1], albums);
    const l = layoutGroups(g, 1, 100, 30);
    assert.deepEqual(l.rows.map((r) => r.type), ['header', 'cells', 'cells', 'header', 'cells', 'cells', 'header', 'cells']);
    assert.equal(l.height, 3 * 30 + 5 * 100);
    assert.deepEqual(l.entries.map((e) => e.id), [4, 2, 2, 1, 3]);
    assert.equal(l.rows[4].start, 2);
    assert.deepEqual(l.rows.filter((r) => r.type === 'cells').map((r) => r.count), [1, 1, 1, 1, 1]);
    assert.equal(firstRowAt(l.rows, 0), 0);
    assert.equal(firstRowAt(l.rows, 30), 1);
    assert.equal(firstRowAt(l.rows, 229), 2);
    assert.equal(firstRowAt(l.rows, 230), 3);
    assert.equal(firstRowAt(l.rows, 1e9), l.rows.length);
    const wide = layoutGroups(g, 5, 100, 30);
    assert.deepEqual(wide.rows.filter((r) => r.type === 'cells').map((r) => [r.start, r.count]), [[0, 2], [2, 2], [4, 1]]);
  });

  test('chunks respect the 5000-id API limit', () => {
    const ids = Array.from({ length: 12001 }, (_, i) => i + 1);
    assert.deepEqual(chunks(ids).map((c) => c.length), [5000, 5000, 2001]);
  });
});
