<script>
  import { thumbUrl } from '../lib/api.js';
  import { DRAG_TYPE } from '../lib/filter.js';
  import { firstRowAt, layoutGroups } from '../lib/groups.js';

  /**
   * "依相簿分組" grid (Sprint §5.2): one section per album, then "未在任何相簿".
   * Virtualised by row like Grid. An asset in several albums shows in each
   * section; selection is by asset id, so it highlights everywhere.
   * `focus` (bindable) stays an index into `ids` so App logic is unchanged.
   */
  let { ids, groups, cellSize = 180, selected = $bindable(new Set()), focus = $bindable(0), onopen, oncellcontext } = $props();

  const GAP = 6;
  const HEADER = 34;
  const OVERSCAN = 600;

  let viewport;
  let width = $state(0);
  let height = $state(0);
  let scrollTop = $state(0);
  let cursor = $state(0); // index into layout.entries
  let anchor = -1;

  const cols = $derived(Math.max(1, Math.floor((width - GAP) / (cellSize + GAP))));
  const cell = $derived(Math.max(48, Math.floor((width - GAP) / cols - GAP)));
  const pitch = $derived(cell + GAP);
  const layout = $derived(layoutGroups(groups, cols, pitch, HEADER));
  const indexOf = $derived(new Map(ids.map((id, i) => [id, i])));
  const thumbSize = $derived(cell * (globalThis.devicePixelRatio || 1) > 300 ? 1024 : 256);

  const visible = $derived.by(() => {
    const out = [];
    const rows = layout.rows;
    for (let r = firstRowAt(rows, Math.max(0, scrollTop - OVERSCAN)); r < rows.length && rows[r].top < scrollTop + height + OVERSCAN; r++) {
      const row = rows[r];
      if (row.type === 'header') { out.push({ key: `h${row.group}`, header: groups[row.group], top: row.top }); continue; }
      for (let c = 0; c < row.count; c++) {
        const k = row.start + c;
        out.push({ key: `c${k}`, entry: k, id: layout.entries[k].id, top: row.top, left: GAP + c * pitch });
      }
    }
    return out;
  });

  // Keep the entry cursor in sync when App moves `focus` (e.g. after closing the loupe).
  $effect(() => {
    const want = ids[focus];
    if (layout.entries[cursor]?.id !== want) {
      const k = layout.entries.findIndex((e) => e.id === want);
      if (k >= 0) cursor = k;
    }
  });

  function setCursor(k) {
    cursor = k;
    const id = layout.entries[k]?.id;
    if (id != null && indexOf.has(id)) focus = indexOf.get(id);
  }

  function select(e, k) {
    const id = layout.entries[k].id;
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && anchor >= 0) {
      for (let j = Math.min(anchor, k); j <= Math.max(anchor, k); j++) next.add(layout.entries[j].id);
    } else if ((e.ctrlKey || e.metaKey) && next.has(id)) {
      next.delete(id);
      anchor = k;
    } else {
      next.add(id);
      anchor = k;
    }
    selected = next;
    setCursor(k);
  }

  function rowTopOf(k) {
    const r = layout.rows.find((row) => row.type === 'cells' && k >= row.start && k < row.start + row.count);
    return r ? r.top : 0;
  }

  function scrollIntoView(k) {
    if (!viewport) return;
    const top = rowTopOf(k);
    if (top < viewport.scrollTop + HEADER) viewport.scrollTop = Math.max(0, top - HEADER);
    else if (top + pitch > viewport.scrollTop + height) viewport.scrollTop = top + pitch - height;
  }

  function dragstart(e, k) {
    const id = layout.entries[k].id;
    if (!selected.has(id)) { selected = new Set([id]); setCursor(k); }
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify([...selected]));
    e.dataTransfer.effectAllowed = 'copy';
  }

  function contextmenu(e, k) {
    e.preventDefault();
    const id = layout.entries[k].id;
    if (!selected.has(id)) { selected = new Set([id]); setCursor(k); }
    oncellcontext?.(e);
  }

  /** Same contract as Grid.handleKey. */
  export function handleKey(e) {
    const n = layout.entries.length;
    if (!n) return false;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
    if (e.key in moves) {
      const next = Math.min(n - 1, Math.max(0, cursor + moves[e.key]));
      if (e.shiftKey) {
        if (anchor < 0) anchor = cursor;
        const s = new Set(e.ctrlKey ? selected : []);
        for (let j = Math.min(anchor, next); j <= Math.max(anchor, next); j++) s.add(layout.entries[j].id);
        selected = s;
      } else {
        anchor = next;
      }
      setCursor(next);
      scrollIntoView(next);
      return true;
    }
    if (e.key === 'Home' || e.key === 'End') {
      const k = e.key === 'Home' ? 0 : n - 1;
      setCursor(k);
      scrollIntoView(k);
      return true;
    }
    if (e.key === 'Enter') { onopen?.(focus); return true; }
    if (e.key === ' ') {
      const id = layout.entries[cursor].id;
      const s = new Set(selected);
      s.has(id) ? s.delete(id) : s.add(id);
      selected = s;
      anchor = cursor;
      return true;
    }
    if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { selected = new Set(ids); return true; }
    if (e.key === 'Escape' && selected.size) { selected = new Set(); return true; }
    return false;
  }

  export function reveal(i) {
    focus = i;
    const k = layout.entries.findIndex((e) => e.id === ids[i]);
    if (k >= 0) { cursor = k; scrollIntoView(k); }
  }
</script>

<div
  class="viewport"
  bind:this={viewport}
  bind:clientWidth={width}
  bind:clientHeight={height}
  onscroll={() => (scrollTop = viewport.scrollTop)}
  data-testid="grouped-grid"
>
  <div class="canvas" style:height="{layout.height + GAP}px">
    {#each visible as v (v.key)}
      {#if v.header}
        <h3 class="head" style:transform="translateY({v.top}px)" data-group={v.header.key}>
          {v.header.albumId == null ? v.header.title : `▣ ${v.header.title}`}<span>{v.header.ids.length} 張</span>
        </h3>
      {:else}
        <button
          type="button"
          class="cell"
          class:selected={selected.has(v.id)}
          class:focused={cursor === v.entry}
          style:width="{cell}px"
          style:height="{cell}px"
          style:transform="translate({v.left}px, {v.top}px)"
          onclick={(e) => select(e, v.entry)}
          ondblclick={() => onopen?.(indexOf.get(v.id))}
          oncontextmenu={(e) => contextmenu(e, v.entry)}
          draggable="true"
          ondragstart={(e) => dragstart(e, v.entry)}
          data-id={v.id}
          tabindex="-1"
        >
          <img src={thumbUrl(v.id, thumbSize)} alt="" decoding="async" draggable="false" />
        </button>
      {/if}
    {/each}
  </div>
  {#if !groups.length}
    <div class="empty"><p>沒有符合目前篩選條件的照片。</p></div>
  {/if}
</div>

<style>
  .viewport { height: 100%; overflow-y: auto; overflow-x: hidden; position: relative; outline: none; }
  .canvas { position: relative; }
  .head {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 34px;
    margin: 0;
    padding: 8px 10px 0;
    font-size: 13px;
    font-weight: 600;
    display: flex;
    gap: 8px;
    align-items: baseline;
    border-bottom: 1px solid var(--border);
  }
  .head span { color: var(--muted); font-weight: 400; font-size: 12px; }
  .cell {
    position: absolute;
    top: 6px;
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
  .empty { position: absolute; inset: 0; display: grid; place-content: center; color: var(--muted); }
</style>
