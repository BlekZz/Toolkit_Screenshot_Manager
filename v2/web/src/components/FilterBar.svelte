<script>
  import { untrack } from 'svelte';
  import { includedCount, isEmpty } from '../lib/filter.js';

  /**
   * Active-filter chips + combine-mode toggles + advanced query input.
   * Chips: click flips include⇄exclude, × removes.
   */
  let { filter = $bindable(), index, total, error = '', onsave } = $props();

  let draft = $state(filter.q);
  let timer;

  // Keep the input in sync when the filter changes elsewhere (sidebar "全部照片", hash nav);
  // only filter.q is tracked so typing is never overwritten mid-debounce.
  $effect(() => {
    const q = filter.q;
    untrack(() => { if (q !== draft.trim()) draft = q; });
  });

  function oninput() {
    clearTimeout(timer);
    timer = setTimeout(() => { filter = { ...filter, q: draft }; }, 250);
  }

  function flip(kind, id) {
    filter = { ...filter, [kind]: { ...filter[kind], [id]: filter[kind][id] === 'in' ? 'out' : 'in' } };
  }
  function remove(kind, id) {
    const map = { ...filter[kind] };
    delete map[id];
    filter = { ...filter, [kind]: map };
  }

  const chips = $derived([
    ...Object.entries(filter.albums).map(([id, s]) => ({ kind: 'albums', id: Number(id), s, label: index.albumById.get(Number(id))?.name ?? `#${id}` })),
    ...Object.entries(filter.tags).map(([id, s]) => ({ kind: 'tags', id: Number(id), s, label: index.tagPath(Number(id)) || `#${id}`, color: index.tagById.get(Number(id))?.color })),
  ]);
  const smartLabel = $derived(filter.smart === 'unfiled' ? '未歸類' : filter.smart != null ? index.smartById.get(filter.smart)?.name ?? `#${filter.smart}` : null);
</script>

<div class="bar" data-testid="filter-bar">
  <div class="chips">
    {#if smartLabel}
      <span class="chip smart">◆ {smartLabel}<button type="button" onclick={() => (filter = { ...filter, smart: null })} aria-label="移除">×</button></span>
    {/if}
    {#each chips as c (`${c.kind}:${c.id}`)}
      <span class="chip" class:out={c.s === 'out'} data-chip="{c.kind}:{c.id}">
        <button type="button" class="flip" onclick={() => flip(c.kind, c.id)} title="切換包含／排除">
          {c.s === 'out' ? '−' : '+'}
          {#if c.kind === 'albums'}▣{:else}<i class="dot" style:background={c.color ?? 'currentColor'}></i>{/if}
          {c.label}
        </button>
        <button type="button" onclick={() => remove(c.kind, c.id)} aria-label="移除">×</button>
      </span>
    {/each}
    {#if includedCount(filter.albums) > 1}
      <button type="button" class="mode" onclick={() => (filter = { ...filter, albumMode: filter.albumMode === 'any' ? 'all' : 'any' })} data-testid="album-mode">
        相簿：{filter.albumMode === 'any' ? '任一' : '全部'}
      </button>
    {/if}
    {#if includedCount(filter.tags) > 1}
      <button type="button" class="mode" onclick={() => (filter = { ...filter, tagMode: filter.tagMode === 'all' ? 'any' : 'all' })} data-testid="tag-mode">
        Tag：{filter.tagMode === 'all' ? '全部符合' : '任一符合'}
      </button>
    {/if}
    <input
      type="text"
      class="q"
      class:invalid={!!error}
      bind:value={draft}
      {oninput}
      onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { clearTimeout(timer); filter = { ...filter, q: draft }; } if (e.key === 'Escape') e.currentTarget.blur(); }}
      placeholder={'搜尋檔名，或 tag:類型/收據 AND NOT album:"已報帳"'}
      aria-label="進階查詢"
      data-testid="query"
    />
  </div>
  <div class="right">
    <span class="total" data-testid="result-count">{total.toLocaleString()} 張</span>
    {#if !isEmpty(filter)}
      <button type="button" onclick={() => onsave?.()} data-testid="save-smart">存為智慧相簿</button>
      <button type="button" onclick={() => (filter = { ...filter, tags: {}, albums: {}, smart: null, q: '' })}>清除</button>
    {/if}
  </div>
  {#if error}<p class="error" data-testid="query-error">{error}</p>{/if}
</div>

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    padding: 8px 12px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; flex: 1; min-width: 0; }
  .chip {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    background: color-mix(in srgb, #2f9e44 16%, transparent);
    border: 1px solid color-mix(in srgb, #2f9e44 40%, transparent);
    font-size: 12px;
    max-width: 260px;
  }
  .chip.out { background: color-mix(in srgb, var(--danger) 14%, transparent); border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
  .chip.out .flip { text-decoration: line-through; }
  .chip.smart { background: var(--accent-soft); border-color: var(--accent); padding-left: 10px; }
  .chip button { background: none; border: 0; padding: 2px 8px; border-radius: 999px; }
  .chip .flip { display: inline-flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .mode { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
  .q { flex: 1; min-width: 200px; }
  .q.invalid { border-color: var(--danger); }
  .right { display: flex; align-items: center; gap: 8px; }
  .total { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .error { flex-basis: 100%; margin: 0; color: var(--danger); font-size: 12px; }
</style>
