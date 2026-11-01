import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  applyRatio, clampMove, dragNew, fitRect, hitTest, move, normalize, orientedSize, outputSize, ratioValue,
  rescale, resize, toRelative,
} from '../web/src/lib/crop.js';
import { cleanRect, pixelRegion } from '../server/triage.mjs';

// P2c 前端裁剪座標換算（web/src/lib/crop.js）：EXIF 轉正尺寸、邊界夾限、比例鎖定、0..1 輸出。

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const ratioOf = (b) => Math.abs(b.width / b.height);

describe('EXIF orientation and fitting', () => {
  test('orientations 5–8 swap axes; 1–4 keep them', () => {
    for (const o of [1, 2, 3, 4]) assert.deepEqual(orientedSize(300, 200, o), { width: 300, height: 200 });
    for (const o of [5, 6, 7, 8]) assert.deepEqual(orientedSize(300, 200, o), { width: 200, height: 300 });
    assert.deepEqual(orientedSize(300, 200), { width: 300, height: 200 });
  });

  test('fitRect contains and centres, never upscales past maxScale', () => {
    const r = fitRect(2000, 1000, 1000, 1000);
    assert.deepEqual([r.width, r.height, r.left, r.top, r.scale], [1000, 500, 0, 250, 0.5]);
    const small = fitRect(100, 50, 1000, 1000, 1);
    assert.deepEqual([small.width, small.height], [100, 50]);
    const up = fitRect(100, 50, 1000, 1000, 2);
    assert.deepEqual([up.width, up.height], [200, 100]);
    assert.equal(fitRect(0, 0, 10, 10).width, 0);
  });

  test('relative crop on a rotated asset maps to the server pixel region of the oriented image', () => {
    // Stored 300×200 with orientation 6 → displayed 200×300; asset row stores display dims.
    const disp = orientedSize(300, 200, 6);
    const stage = fitRect(disp.width, disp.height, 400, 450, 2); // 300×450 on screen (scale 1.5)
    assert.deepEqual([stage.width, stage.height], [300, 450]);
    // Box covering display pixels x 20..120, y 30..180 → stage px ×1.5.
    const rel = toRelative({ x: 30, y: 45, width: 150, height: 225 }, stage.width, stage.height);
    close(rel.x, 0.1); close(rel.y, 0.1); close(rel.w, 0.5); close(rel.h, 0.5);
    assert.deepEqual(pixelRegion(rel, disp.width, disp.height), { left: 20, top: 30, width: 100, height: 150 });
    assert.deepEqual(outputSize(rel, disp.width, disp.height), { width: 100, height: 150 });
    assert.doesNotThrow(() => cleanRect(rel, disp));
  });
});

describe('bounds clamping', () => {
  test('normalize flips negative sizes and clips to the image', () => {
    assert.deepEqual(normalize({ x: 50, y: 50, width: -80, height: -20 }, 100, 100), { x: 0, y: 30, width: 50, height: 20 });
    assert.deepEqual(normalize({ x: 90, y: 90, width: 50, height: 50 }, 100, 100), { x: 90, y: 90, width: 10, height: 10 });
  });

  test('move keeps size and stays inside', () => {
    const b = { x: 10, y: 10, width: 30, height: 20 };
    assert.deepEqual(move(b, 500, -500, 100, 80), { x: 70, y: 0, width: 30, height: 20 });
    assert.deepEqual(move(b, -500, 500, 100, 80), { x: 0, y: 60, width: 30, height: 20 });
    assert.deepEqual(clampMove({ x: 0, y: 0, width: 300, height: 10 }, 100, 80), { x: 0, y: 0, width: 100, height: 10 });
  });

  test('dragNew clamps the pointer to the image', () => {
    assert.deepEqual(dragNew({ x: 50, y: 50 }, { x: 999, y: -999 }, null, 100, 100), { x: 50, y: 0, width: 50, height: 50 });
  });

  test('toRelative: x + w ≤ 1 and y + h ≤ 1 even with float noise; accepted by the server validator', () => {
    const W = 333;
    const H = 777;
    for (const box of [{ x: 0, y: 0, width: W, height: H }, { x: W / 3, y: H / 7, width: (2 * W) / 3, height: (6 * H) / 7 },
      { x: 0.1, y: 0.2, width: W - 0.1, height: H - 0.2 }]) {
      const r = toRelative(box, W, H);
      assert.ok(r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0);
      assert.ok(r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, JSON.stringify(r));
      assert.doesNotThrow(() => cleanRect(r, { width: 1001, height: 667 }));
    }
  });

  test('toRelative: rounding to 6 decimals never pushes x + w past 1 (128 px: 1/128 + 127/128 → 0.007813 + 0.992188)', () => {
    const r = toRelative({ x: 1, y: 1, width: 127, height: 127 }, 128, 128);
    assert.ok(r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, JSON.stringify(r));
    assert.doesNotThrow(() => cleanRect(r, { width: 128, height: 128 }));
  });

  test('toRelative: no box / tiny box = null (legacy "< 4px means full image")', () => {
    assert.equal(toRelative(null, 100, 100), null);
    assert.equal(toRelative({ x: 10, y: 10, width: 3, height: 50 }, 100, 100), null);
    assert.equal(toRelative({ x: 10, y: 10, width: 50, height: 50 }, 0, 100), null);
    assert.notEqual(toRelative({ x: 10, y: 10, width: 4, height: 4 }, 100, 100), null);
  });

  test('rescale follows a resized stage', () => {
    assert.deepEqual(rescale({ x: 10, y: 20, width: 30, height: 40 }, 100, 200, 200, 100), { x: 20, y: 10, width: 60, height: 20 });
  });
});

describe('ratio lock', () => {
  test('ratio presets', () => {
    assert.equal(ratioValue('free'), null);
    assert.equal(ratioValue('1:1'), 1);
    close(ratioValue('3:4'), 0.75);
    close(ratioValue('16:9'), 16 / 9);
  });

  test('larger relative dimension wins, sign preserved (legacy applyRatio)', () => {
    const r = applyRatio({ x: 50, y: 50, width: 20, height: -10 }, 1, 1000, 1000);
    assert.deepEqual(r, { x: 50, y: 50, width: 20, height: -20 });
    const t = applyRatio({ x: 0, y: 0, width: 30, height: 80 }, 16 / 9, 1000, 1000);
    close(t.width / t.height, 16 / 9);
    close(t.height, 80);
  });

  test('ratio is kept when the box would run past the edge (shrinks instead of clipping)', () => {
    const b = dragNew({ x: 80, y: 10 }, { x: 100, y: 90 }, 1, 100, 100); // wants 80×80, only 20 px to the right
    assert.deepEqual(b, { x: 80, y: 10, width: 20, height: 20 });
    for (const key of ['1:1', '3:4', '16:9']) {
      const n = dragNew({ x: 5, y: 5 }, { x: 400, y: 400 }, ratioValue(key), 120, 90);
      close(ratioOf(n), ratioValue(key), 1e-9);
      assert.ok(n.x + n.width <= 120 + 1e-9 && n.y + n.height <= 90 + 1e-9);
    }
  });

  test('resize keeps the opposite corner fixed and respects the ratio', () => {
    const o = { x: 20, y: 20, width: 40, height: 40 };
    assert.deepEqual(resize(o, 'se', 10, 30, null, 100, 100), { x: 20, y: 20, width: 50, height: 70 });
    assert.deepEqual(resize(o, 'nw', -10, 5, null, 100, 100), { x: 10, y: 25, width: 50, height: 35 });
    const r = resize(o, 'nw', -10, 5, 1, 100, 100); // anchor = (60,60)
    close(ratioOf(r), 1);
    assert.equal(r.x + r.width, 60);
    assert.equal(r.y + r.height, 60);
    const e = resize(o, 'e', 100, 0, 3 / 4, 100, 100); // dragged past the right edge
    close(ratioOf(e), 0.75);
    assert.ok(e.x + e.width <= 100 && e.y + e.height <= 100);
  });

  test('resize past the opposite edge flips instead of producing a negative box', () => {
    const r = resize({ x: 20, y: 20, width: 40, height: 40 }, 'e', -60, 0, null, 100, 100);
    assert.deepEqual(r, { x: 0, y: 20, width: 20, height: 40 });
  });
});

describe('hit testing', () => {
  const box = { x: 100, y: 100, width: 200, height: 100 };
  test('corners, edges, body, outside', () => {
    assert.equal(hitTest(box, { x: 100, y: 100 }), 'nw');
    assert.equal(hitTest(box, { x: 300, y: 200 }), 'se');
    assert.equal(hitTest(box, { x: 300, y: 100 }), 'ne');
    assert.equal(hitTest(box, { x: 100, y: 200 }), 'sw');
    assert.equal(hitTest(box, { x: 200, y: 101 }), 'n');
    assert.equal(hitTest(box, { x: 299, y: 150 }), 'e');
    assert.equal(hitTest(box, { x: 200, y: 150 }), 'move');
    assert.equal(hitTest(box, { x: 10, y: 10 }), 'new');
    assert.equal(hitTest(null, { x: 10, y: 10 }), 'new');
  });
});
