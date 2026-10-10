<script>
  import { thumbUrl } from '../lib/api.js';

  /**
   * Virtualised thumbnail grid. Only rows intersecting the viewport (plus an
   * overscan margin) are in the DOM, so 50k ids cost the same as 100.
   */
  let { ids, cellSize = 180, selected = $bindable(new Set()), focus = $bindable(0), onopen } = $props();

  const GAP = 6;
  const OVERSCAN_ROWS = 3;

  let viewport;
  let width = $state(0);
  let height = $state(0);
  let scrollTop = $state(0);
  let anchor = -1;

  // cellSize is the target; cells stretch so the columns fill the full width.
  const cols = $derived(Math.max(1, Math.floor((width - GAP) / (cellSize + GAP))));
  const cell = $derived(Math.max(48, Math.floor((width - GAP) / cols - GAP)));
  const pitch = $derived(cell + GAP);
  const rows = $derived(Math.ceil(ids.length / cols));
  const firstRow = $derived(Math.max(0, Math.floor(scrollTop / pitch) - OVERSCAN_ROWS));
  const lastRow = $derived(Math.min(rows, Math.ceil((scrollTop + height) / pitch) + OVERSCAN_ROWS));
  const thumbSize = $derived(cell * (globalThis.devicePixelRatio || 1) > 300 ? 1024 : 256);
  const visible = $derived.by(() => {
    const out = [];
    for (let r = firstRow; r < lastRow; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= ids.length) break;
        out.push(i);
      }
    }
    return out;
  });

  function select(e, i) {
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && anchor >= 0) {
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) next.add(ids[k]);
    } else if ((e.ctrlKey || e.metaKey) && next.has(ids[i])) {
      next.delete(ids[i]);
      anchor = i;
    } else {
      next.add(ids[i]);
      anchor = i;
    }
    selected = next;
    focus = i;
  }

  function scrollIntoView(i) {
    if (!viewport) return;
    const top = Math.floor(i / cols) * pitch;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + pitch > viewport.scrollTop + height) viewport.scrollTop = top + pitch - height;
  }

  /** Called by App for keys that belong to the grid. Returns true if handled. */
  export function handleKey(e) {
    if (!ids.length) return false;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols,
      PageUp: -cols * Math.max(1, Math.floor(height / pitch)), PageDown: cols * Math.max(1, Math.floor(height / pitch)) };
    if (e.key in moves) {
      const next = Math.min(ids.length - 1, Math.max(0, focus + moves[e.key]));
      if (e.shiftKey) {
        if (anchor < 0) anchor = focus;
        const s = new Set(e.ctrlKey ? selected : []);
        for (let k = Math.min(anchor, next); k <= Math.max(anchor, next); k++) s.add(ids[k]);
        selected = s;
      }
      focus = next;
      scrollIntoView(next);
      return true;
    }
    if (e.key === 'Home' || e.key === 'End') {
      focus = e.key === 'Home' ? 0 : ids.length - 1;
      scrollIntoView(focus);
      return true;
    }
    if (e.key === 'Enter') { onopen?.(focus); return true; }
    if (e.key === ' ') {
      const s = new Set(selected);
      s.has(ids[focus]) ? s.delete(ids[focus]) : s.add(ids[focus]);
      selected = s;
      anchor = focus;
      return true;
    }
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { selected = new Set(ids); return true; }
    if (e.key === 'Escape' && selected.size) { selected = new Set(); return true; }
    return false;
  }

  export function reveal(i) {
    focus = i;
    scrollIntoView(i);
  }
</script>

<div
  class="viewport"
  bind:this={viewport}
  bind:clientWidth={width}
  bind:clientHeight={height}
  onscroll={() => (scrollTop = viewport.scrollTop)}
  data-testid="grid"
>
  <div class="canvas" style:height="{rows * pitch + GAP}px">
    {#each visible as i (ids[i])}
      <button
        type="button"
        class="cell"
        class:selected={selected.has(ids[i])}
        class:focused={focus === i}
        style:width="{cell}px"
        style:height="{cell}px"
        style:transform="translate({GAP + (i % cols) * pitch}px, {GAP + Math.floor(i / cols) * pitch}px)"
        onclick={(e) => select(e, i)}
        ondblclick={() => onopen?.(i)}
        data-id={ids[i]}
        tabindex="-1"
      >
        <img src={thumbUrl(ids[i], thumbSize)} alt="" loading="lazy" decoding="async" draggable="false" />
      </button>
    {/each}
  </div>
  {#if !ids.length}
    <div class="empty">
      <p>照片庫是空的。</p>
      <p>點右上角「匯入」，或執行 <code>npm run import -- &lt;資料夾&gt;</code>。</p>
    </div>
  {/if}
</div>

<style>
  .viewport { height: 100%; overflow-y: auto; overflow-x: hidden; position: relative; outline: none; }
  .canvas { position: relative; }
  .cell {
    position: absolute;
    top: 0;
    left: 0;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: var(--cell-bg);
    overflow: hidden;
    cursor: default;
  }
  .cell img { width: 100%; height: 100%; object-fit: contain; display: block; pointer-events: none; }
  .cell.selected { box-shadow: 0 0 0 3px var(--accent); }
  .cell.selected::after { content: ''; position: absolute; inset: 0; background: var(--accent-soft); }
  .cell.focused { outline: 2px dashed var(--muted); outline-offset: 2px; }
  .empty { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; color: var(--muted); }
  .empty p { margin: 4px; }
</style>
