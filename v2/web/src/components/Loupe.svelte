<script>
  import { api, formatBytes, originalUrl, thumbUrl } from '../lib/api.js';

  /** Single-image viewer: fit / zoom around cursor / drag pan / prev-next. */
  let { ids, index = $bindable(0), onclose } = $props();

  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 16;

  let stage;
  let stageW = $state(0);
  let stageH = $state(0);
  let detail = $state(null);
  let error = $state('');
  let showInfo = $state(true);
  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let fitted = $state(true);
  let drag = null;

  const id = $derived(ids[index]);

  $effect(() => {
    const current = id;
    detail = null;
    error = '';
    api.asset(current).then((d) => { if (current === id) detail = d; }).catch((e) => { error = e.message; });
    // Warm neighbours so arrow-key browsing feels instant.
    for (const k of [index - 1, index + 1]) if (ids[k] != null) new Image().src = originalUrl(ids[k]);
  });

  function fit() {
    if (!detail || !stageW || !stageH) return;
    const s = Math.min(stageW / detail.width, stageH / detail.height, 1);
    scale = s;
    tx = (stageW - detail.width * s) / 2;
    ty = (stageH - detail.height * s) / 2;
    fitted = true;
  }

  // Refit when the image changes or the stage resizes, unless the user has zoomed.
  $effect(() => {
    detail; stageW; stageH;
    if (fitted) fit();
  });

  function zoomAt(cx, cy, next) {
    next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    tx = cx - (cx - tx) * (next / scale);
    ty = cy - (cy - ty) * (next / scale);
    scale = next;
    fitted = false;
  }

  function onwheel(e) {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, scale * Math.exp(-e.deltaY * 0.0015));
  }

  function ondblclick(e) {
    if (!fitted) { fit(); return; }
    const r = stage.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, 1);
  }

  function onpointerdown(e) {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, tx, ty };
    stage.setPointerCapture(e.pointerId);
  }
  function onpointermove(e) {
    if (!drag) return;
    tx = drag.tx + e.clientX - drag.x;
    ty = drag.ty + e.clientY - drag.y;
    fitted = false;
  }
  function onpointerup() { drag = null; }

  function go(delta) {
    const next = index + delta;
    if (next < 0 || next >= ids.length) return;
    index = next;
    fitted = true;
  }

  /** Called by App while the loupe is open. Returns true if handled. */
  export function handleKey(e) {
    switch (e.key) {
      case 'ArrowLeft': case 'a': go(-1); return true;
      case 'ArrowRight': case 'd': go(1); return true;
      case 'Home': index = 0; fitted = true; return true;
      case 'End': index = ids.length - 1; fitted = true; return true;
      case 'Escape': case 'Enter': onclose?.(); return true;
      case 'i': showInfo = !showInfo; return true;
      case '0': fit(); return true;
      case '1': zoomAt(stageW / 2, stageH / 2, 1); return true;
      case '+': case '=': case 'ArrowUp': zoomAt(stageW / 2, stageH / 2, scale * 1.25); return true;
      case '-': case 'ArrowDown': zoomAt(stageW / 2, stageH / 2, scale / 1.25); return true;
      default: return false;
    }
  }
</script>

<div class="loupe" data-testid="loupe">
  <div
    class="stage"
    bind:this={stage}
    bind:clientWidth={stageW}
    bind:clientHeight={stageH}
    {onwheel}
    {ondblclick}
    {onpointerdown}
    {onpointermove}
    {onpointerup}
    role="presentation"
  >
    {#if detail}
      <img
        src={originalUrl(id)}
        alt={detail.filename}
        draggable="false"
        style:width="{detail.width}px"
        style:height="{detail.height}px"
        style:transform="translate({tx}px, {ty}px) scale({scale})"
        style:background-image="url({thumbUrl(id, 1024)})"
      />
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
  </div>

  <header class="bar">
    <button type="button" onclick={() => onclose?.()} title="返回 grid（Esc）">← 返回</button>
    <span class="name">{detail?.filename ?? ''}</span>
    <span class="muted">{index + 1} / {ids.length}</span>
    <span class="muted zoom">{Math.round(scale * 100)}%</span>
    <button type="button" onclick={fit} title="符合視窗（0）">符合</button>
    <button type="button" onclick={() => zoomAt(stageW / 2, stageH / 2, 1)} title="原尺寸（1）">100%</button>
    <button type="button" onclick={() => (showInfo = !showInfo)} title="資訊面板（I）">資訊</button>
  </header>

  {#if showInfo && detail}
    <aside class="info" data-testid="info">
      <dl>
        <dt>檔名</dt><dd>{detail.filename}</dd>
        <dt>尺寸</dt><dd>{detail.width} × {detail.height}</dd>
        <dt>大小</dt><dd>{formatBytes(detail.bytes)}</dd>
        <dt>格式</dt><dd>{detail.ext.toUpperCase()}</dd>
        <dt>檔案時間</dt><dd>{new Date(detail.file_mtime).toLocaleString()}</dd>
        <dt>匯入時間</dt><dd>{new Date(detail.imported_at).toLocaleString()}</dd>
        <dt>來源</dt><dd class="path">{detail.source_path ?? '—'}</dd>
        <dt>SHA-256</dt><dd class="path">{detail.sha256.slice(0, 16)}…</dd>
      </dl>
      <p class="hint">Tag／Album 於 P1 加入</p>
    </aside>
  {/if}
</div>

<style>
  .loupe { position: fixed; inset: 0; background: var(--loupe-bg); color: #ecece8; z-index: 10; }
  .stage { position: absolute; inset: 48px 0 0 0; overflow: hidden; cursor: grab; touch-action: none; }
  .stage:active { cursor: grabbing; }
  .stage img {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    background-size: 100% 100%;
    user-select: none;
    image-rendering: auto;
  }
  .bar {
    position: absolute;
    inset: 0 0 auto 0;
    height: 48px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px;
    background: rgba(20, 20, 19, 0.92);
    border-bottom: 1px solid #2c2c2a;
  }
  .bar button { background: #2a2a28; border-color: #3a3a37; color: #ecece8; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .muted { color: #9a9a94; white-space: nowrap; }
  .zoom { min-width: 48px; text-align: right; }
  .info {
    position: absolute;
    top: 60px;
    right: 12px;
    width: 280px;
    max-height: calc(100% - 72px);
    overflow: auto;
    background: rgba(31, 31, 30, 0.94);
    border: 1px solid #3a3a37;
    border-radius: 8px;
    padding: 12px 14px;
    font-size: 13px;
  }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; }
  dt { color: #9a9a94; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .path { font: 12px ui-monospace, monospace; }
  .hint { margin: 12px 0 0; color: #9a9a94; font-size: 12px; }
  .error { position: absolute; inset: 0; display: grid; place-content: center; color: #ff7a66; }
  @media (max-width: 640px) {
    .info { left: 12px; right: 12px; width: auto; top: auto; bottom: 12px; max-height: 40%; }
    .zoom, .bar button:nth-of-type(n + 2) { display: none; }
  }
</style>
