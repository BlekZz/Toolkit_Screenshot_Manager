<script>
  import { untrack } from 'svelte';
  import { originalUrl, thumbUrl } from '../lib/api.js';
  import { CURSORS, dragNew, fitRect, hitTest, move, normalize, ratioValue, rescale, resize, toRelative } from '../lib/crop.js';

  /**
   * Triage image stage — port of the legacy viewer (repo-root public/app.js):
   *   browse: wheel over the image zooms (1–5×, ×1.12 per notch), wheel beside
   *           the image changes image, drag pans while zoomed
   *   crop:   zoom resets to fit; drag a new box, drag inside to move, drag
   *           edges / corners to resize; optional ratio lock
   * Geometry lives in lib/crop.js; this component only wires pointer events.
   * width / height = the asset's display (EXIF-oriented) size.
   */
  let { assetId, width, height, mode = 'browse', ratio = 'free', onnav } = $props();

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 5;
  const STEP = 1.12;

  let stageW = $state(0);
  let stageH = $state(0);
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let box = $state(null);
  let cursor = $state('crosshair');
  let pan = null;
  let drag = null;
  let overlay = $state();

  const fit = $derived(fitRect(width, height, stageW, stageH, 2));

  // New image or leaving / entering crop mode → back to fit, no box.
  $effect(() => {
    assetId; mode;
    zoom = 1; panX = 0; panY = 0; box = null; drag = null; pan = null;
  });

  // Keep the box glued to the image when the stage resizes.
  let lastFit = { width: 0, height: 0 };
  $effect(() => {
    const f = fit;
    untrack(() => {
      if (box && lastFit.width && (f.width !== lastFit.width || f.height !== lastFit.height)) {
        box = rescale(box, lastFit.width, lastFit.height, f.width, f.height);
      }
    });
    lastFit = { width: f.width, height: f.height };
  });

  // Re-lock an existing box when the ratio changes (legacy setRatio).
  $effect(() => {
    const r = ratioValue(ratio);
    untrack(() => {
      if (box && r && !drag) box = resize(normalize(box, fit.width, fit.height), 'se', 0, 0, r, fit.width, fit.height);
    });
  });

  function clampPan() {
    if (zoom <= 1) { panX = 0; panY = 0; return; }
    const maxX = (fit.width * (zoom - 1)) / 2;
    const maxY = (fit.height * (zoom - 1)) / 2;
    panX = Math.max(-maxX, Math.min(maxX, panX));
    panY = Math.max(-maxY, Math.min(maxY, panY));
  }

  export function zoomBy(dir) {
    if (mode !== 'browse') return;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * (dir > 0 ? STEP : 1 / STEP)));
    clampPan();
  }
  export function resetZoom() { zoom = 1; panX = 0; panY = 0; }
  /** Relative 0..1 crop of the drawn box, or null when no box (< 4 px) is drawn. */
  export function getRelative() { return toRelative(box, fit.width, fit.height); }
  export function hasBox() { return getRelative() != null; }

  function onImage(e, rect) {
    const cx = rect.left + fit.left + fit.width / 2 + panX;
    const cy = rect.top + fit.top + fit.height / 2 + panY;
    return Math.abs(e.clientX - cx) <= (fit.width * zoom) / 2 && Math.abs(e.clientY - cy) <= (fit.height * zoom) / 2;
  }

  function onwheel(e) {
    if (mode !== 'browse') return;
    e.preventDefault();
    if (onImage(e, e.currentTarget.getBoundingClientRect())) zoomBy(e.deltaY < 0 ? 1 : -1);
    else onnav?.(e.deltaY > 0 ? 1 : -1);
  }

  function stagedown(e) {
    if (mode !== 'browse' || zoom <= 1 || e.button !== 0) return;
    pan = { x: e.clientX, y: e.clientY, panX, panY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function stagemove(e) {
    if (!pan) return;
    panX = pan.panX + e.clientX - pan.x;
    panY = pan.panY + e.clientY - pan.y;
    clampPan();
  }
  function stageup() { pan = null; }

  function point(e) {
    const r = overlay.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * fit.width) / r.width, y: ((e.clientY - r.top) * fit.height) / r.height };
  }

  function cropdown(e) {
    if (e.button !== 0) return;
    const p = point(e);
    const hit = hitTest(box, p);
    drag = { start: p, hit, original: box ? normalize(box, fit.width, fit.height) : null };
    if (hit === 'new') box = { x: p.x, y: p.y, width: 0, height: 0 };
    cursor = CURSORS[hit];
    overlay.setPointerCapture(e.pointerId);
  }
  function cropmove(e) {
    const p = point(e);
    if (!drag) { cursor = CURSORS[hitTest(box, p)]; return; }
    const r = ratioValue(ratio);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (drag.hit === 'move' && drag.original) box = move(drag.original, dx, dy, fit.width, fit.height);
    else if (drag.hit !== 'new' && drag.original) box = resize(drag.original, drag.hit, dx, dy, r, fit.width, fit.height);
    else box = dragNew(drag.start, p, r, fit.width, fit.height);
  }
  function cropup(e) {
    drag = null;
    if (box) box = normalize(box, fit.width, fit.height);
    cursor = CURSORS[hitTest(box, point(e))];
  }

  const shown = $derived(box ? normalize(box, fit.width, fit.height) : null);
</script>

<div
  class="stage"
  class:zoomed={zoom > 1}
  bind:clientWidth={stageW}
  bind:clientHeight={stageH}
  {onwheel}
  onpointerdown={stagedown}
  onpointermove={stagemove}
  onpointerup={stageup}
  onpointercancel={stageup}
  role="presentation"
  data-testid="crop-stage"
>
  {#if assetId != null && fit.width}
    <img
      src={originalUrl(assetId)}
      alt=""
      draggable="false"
      style:left="{fit.left}px"
      style:top="{fit.top}px"
      style:width="{fit.width}px"
      style:height="{fit.height}px"
      style:transform="translate({panX}px, {panY}px) scale({zoom})"
      style:background-image="url({thumbUrl(assetId, 1024)})"
    />
    {#if mode === 'crop'}
      <div
        class="overlay"
        bind:this={overlay}
        style:left="{fit.left}px"
        style:top="{fit.top}px"
        style:width="{fit.width}px"
        style:height="{fit.height}px"
        style:cursor={cursor}
        onpointerdown={cropdown}
        onpointermove={cropmove}
        onpointerup={cropup}
        onpointercancel={cropup}
        role="presentation"
        data-testid="crop-overlay"
      >
        {#if shown && shown.width > 0 && shown.height > 0}
          <div class="box" style:left="{shown.x}px" style:top="{shown.y}px" style:width="{shown.width}px" style:height="{shown.height}px" data-testid="crop-box">
            <i class="h nw"></i><i class="h ne"></i><i class="h sw"></i><i class="h se"></i>
          </div>
        {:else}
          <div class="tip">拖曳框選範圍（不框選＝整張）</div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .stage { position: absolute; inset: 0; overflow: hidden; touch-action: none; user-select: none; }
  .stage.zoomed { cursor: grab; }
  .stage.zoomed:active { cursor: grabbing; }
  img {
    position: absolute;
    transform-origin: center center;
    background-size: 100% 100%;
    user-select: none;
  }
  .overlay { position: absolute; outline: 1px dashed rgba(95, 208, 181, 0.6); }
  .box {
    position: absolute;
    border: 2px dashed #5fd0b5;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.45);
    pointer-events: none;
  }
  .h { position: absolute; width: 10px; height: 10px; background: #5fd0b5; }
  .nw { left: -6px; top: -6px; }
  .ne { right: -6px; top: -6px; }
  .sw { left: -6px; bottom: -6px; }
  .se { right: -6px; bottom: -6px; }
  .tip {
    position: absolute;
    left: 50%;
    top: 12px;
    transform: translateX(-50%);
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.6);
    color: #ecece8;
    font-size: 12px;
    pointer-events: none;
    white-space: nowrap;
  }
</style>
