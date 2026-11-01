/**
 * Crop-box geometry for the Triage crop stage (ported from the legacy viewer in
 * repo-root public/app.js: drag a new box, move it, resize by edge / corner
 * handles, optional aspect-ratio lock).
 *
 * All boxes are in "stage pixels" of the displayed image rect (W×H), i.e. the
 * EXIF-oriented image as the browser shows it. Boxes may carry negative
 * width / height while being dragged ("signed" boxes); `normalize` turns them
 * into positive, in-bounds boxes. Output to the server is relative 0..1.
 * Pure functions only — unit-tested under node (v2/test/web-crop.test.mjs).
 */

/** Ratio presets, in legacy key order (crop mode keys 1–4). null = free. */
export const RATIOS = [
  { key: 'free', label: '自由', value: null },
  { key: '1:1', label: '1:1', value: 1 },
  { key: '3:4', label: '3:4', value: 3 / 4 },
  { key: '16:9', label: '16:9', value: 16 / 9 },
];
export const ratioValue = (key) => RATIOS.find((r) => r.key === key)?.value ?? null;

/** Boxes smaller than this (stage px) count as "no box drawn". */
export const MIN_BOX_PX = 4;

/**
 * Display size of an image whose stored pixels carry an EXIF orientation:
 * orientations 5–8 rotate by 90°, swapping the axes.
 *
 * @param {number} width Stored pixel width.
 * @param {number} height Stored pixel height.
 * @param {number} [orientation] EXIF orientation 1–8.
 */
export function orientedSize(width, height, orientation = 1) {
  return orientation >= 5 ? { width: height, height: width } : { width, height };
}

/**
 * Where an image of display size imgW×imgH sits when fitted (contain) into a
 * stage, never upscaled beyond maxScale.
 *
 * @returns {{left: number, top: number, width: number, height: number, scale: number}}
 */
export function fitRect(imgW, imgH, stageW, stageH, maxScale = 1) {
  if (!imgW || !imgH || !stageW || !stageH) return { left: 0, top: 0, width: 0, height: 0, scale: 0 };
  const scale = Math.min(stageW / imgW, stageH / imgH, maxScale);
  const width = imgW * scale;
  const height = imgH * scale;
  return { left: (stageW - width) / 2, top: (stageH - height) / 2, width, height, scale };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Positive-size box clipped to [0,W]×[0,H] (legacy normalizeCrop). */
export function normalize(box, W, H) {
  const x1 = clamp(Math.min(box.x, box.x + box.width), 0, W);
  const y1 = clamp(Math.min(box.y, box.y + box.height), 0, H);
  const x2 = clamp(Math.max(box.x, box.x + box.width), 0, W);
  const y2 = clamp(Math.max(box.y, box.y + box.height), 0, H);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Translates a box so it lies fully inside the bounds, keeping its size (legacy clampCrop). */
export function clampMove(box, W, H) {
  const width = Math.min(Math.abs(box.width), W);
  const height = Math.min(Math.abs(box.height), H);
  return {
    x: clamp(Math.min(box.x, box.x + box.width), 0, W - width),
    y: clamp(Math.min(box.y, box.y + box.height), 0, H - height),
    width,
    height,
  };
}

/**
 * Locks a signed box anchored at (box.x, box.y) to `ratio` (w/h). Like the
 * legacy tool the larger relative dimension wins; unlike it, the result is
 * shrunk (ratio preserved) so it never runs past the bounds from the anchor.
 *
 * @param {{x: number, y: number, width: number, height: number}} box Signed.
 * @param {number|null} ratio
 * @returns {{x: number, y: number, width: number, height: number}} Signed.
 */
export function applyRatio(box, ratio, W, H) {
  if (!ratio || box.width === 0 || box.height === 0) return box;
  const sx = box.width < 0 ? -1 : 1;
  const sy = box.height < 0 ? -1 : 1;
  let w = Math.abs(box.width);
  let h = Math.abs(box.height);
  if (w / h > ratio) h = w / ratio;
  else w = h * ratio;
  const availX = sx > 0 ? W - box.x : box.x;
  const availY = sy > 0 ? H - box.y : box.y;
  const k = Math.min(1, Math.max(0, availX) / w, Math.max(0, availY) / h);
  return { x: box.x, y: box.y, width: w * k * sx, height: h * k * sy };
}

/** New box being dragged from (startX, startY) to the pointer. */
export function dragNew(start, point, ratio, W, H) {
  const sx = clamp(start.x, 0, W);
  const sy = clamp(start.y, 0, H);
  const raw = { x: sx, y: sy, width: clamp(point.x, 0, W) - sx, height: clamp(point.y, 0, H) - sy };
  return normalize(applyRatio(raw, ratio, W, H), W, H);
}

/**
 * Resizes `original` by dragging handle `dir` (n, s, e, w, ne, nw, se, sw)
 * by (dx, dy). The opposite edge / corner stays fixed; the box may flip.
 */
export function resize(original, dir, dx, dy, ratio, W, H) {
  let left = original.x;
  let top = original.y;
  let right = original.x + original.width;
  let bottom = original.y + original.height;
  if (dir.includes('w')) left = clamp(left + dx, 0, W);
  if (dir.includes('e')) right = clamp(right + dx, 0, W);
  if (dir.includes('n')) top = clamp(top + dy, 0, H);
  if (dir.includes('s')) bottom = clamp(bottom + dy, 0, H);
  const ax = dir.includes('w') ? right : left;
  const ay = dir.includes('n') ? bottom : top;
  const mx = dir.includes('w') ? left : right;
  const my = dir.includes('n') ? top : bottom;
  return normalize(applyRatio({ x: ax, y: ay, width: mx - ax, height: my - ay }, ratio, W, H), W, H);
}

/** Moves `original` by (dx, dy), kept inside the bounds. */
export function move(original, dx, dy, W, H) {
  return clampMove({ ...original, x: original.x + dx, y: original.y + dy }, W, H);
}

/**
 * What a pointer at `point` grabs (legacy cropHit): a resize handle, the box
 * body ("move") or empty space ("new").
 */
export function hitTest(box, point, handle = 12) {
  if (!box || box.width < 1 || box.height < 1) return 'new';
  const nearL = Math.abs(point.x - box.x) <= handle;
  const nearR = Math.abs(point.x - (box.x + box.width)) <= handle;
  const nearT = Math.abs(point.y - box.y) <= handle;
  const nearB = Math.abs(point.y - (box.y + box.height)) <= handle;
  const inX = point.x >= box.x && point.x <= box.x + box.width;
  const inY = point.y >= box.y && point.y <= box.y + box.height;
  if (nearL && nearT) return 'nw';
  if (nearR && nearT) return 'ne';
  if (nearL && nearB) return 'sw';
  if (nearR && nearB) return 'se';
  if (nearL && inY) return 'w';
  if (nearR && inY) return 'e';
  if (nearT && inX) return 'n';
  if (nearB && inX) return 's';
  if (inX && inY) return 'move';
  return 'new';
}

export const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize', move: 'move', new: 'crosshair' };

/** Rescales a box when the displayed image rect changes size (window resize). */
export function rescale(box, fromW, fromH, toW, toH) {
  if (!box || !fromW || !fromH) return box;
  const kx = toW / fromW;
  const ky = toH / fromH;
  return { x: box.x * kx, y: box.y * ky, width: box.width * kx, height: box.height * ky };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * Stage-pixel box → relative 0..1 crop for POST /api/assets/:id/crops.
 * Returns null when no usable box is drawn (smaller than MIN_BOX_PX).
 * Guarantees 0 ≤ x, y and x + w ≤ 1, y + h ≤ 1 after rounding.
 */
export function toRelative(box, W, H) {
  if (!box || !W || !H) return null;
  const b = normalize(box, W, H);
  if (b.width < MIN_BOX_PX || b.height < MIN_BOX_PX) return null;
  const x = clamp(round6(b.x / W), 0, 1);
  const y = clamp(round6(b.y / H), 0, 1);
  const w = Math.min(round6(b.width / W), round6(1 - x));
  const h = Math.min(round6(b.height / H), round6(1 - y));
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/**
 * Output pixel size of a relative crop on an image of display size W×H —
 * the same rounding as the server's pixelRegion (server/triage.mjs).
 */
export function outputSize(rel, W, H) {
  return {
    width: Math.min(W, Math.max(1, Math.round(rel.w * W))),
    height: Math.min(H, Math.max(1, Math.round(rel.h * H))),
  };
}
