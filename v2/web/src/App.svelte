<script>
  import Grid from './components/Grid.svelte';
  import ImportDialog from './components/ImportDialog.svelte';
  import Loupe from './components/Loupe.svelte';
  import { api, formatBytes, prefs } from './lib/api.js';

  const SORTS = [
    { key: 'imported:desc', label: '匯入時間（新→舊）' },
    { key: 'imported:asc', label: '匯入時間（舊→新）' },
    { key: 'mtime:desc', label: '檔案時間（新→舊）' },
    { key: 'mtime:asc', label: '檔案時間（舊→新）' },
    { key: 'name:asc', label: '檔名（A→Z）' },
  ];

  let ids = $state([]);
  let sort = $state(prefs.get('sort', 'imported:desc'));
  let cellSize = $state(prefs.get('cellSize', 180));
  let selected = $state(new Set());
  let focus = $state(0);
  let loupeIndex = $state(-1);
  let importing = $state(false);
  let stats = $state(null);
  let loadError = $state('');
  let grid = $state();
  let loupe = $state();

  async function load() {
    const [s, o] = sort.split(':');
    try {
      const res = await api.listAssets(s, o);
      ids = res.ids;
      stats = await api.stats();
      loadError = '';
      if (focus >= ids.length) focus = Math.max(0, ids.length - 1);
    } catch (e) {
      loadError = e.message;
    }
  }

  $effect(() => { prefs.set('sort', sort); load(); });
  $effect(() => { prefs.set('cellSize', cellSize); });

  function openLoupe(i) { loupeIndex = i; }
  function closeLoupe() {
    const i = loupeIndex;
    loupeIndex = -1;
    queueMicrotask(() => grid?.reveal(i));
  }

  function onkeydown(e) {
    if (importing) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const handled = loupeIndex >= 0 ? loupe?.handleKey(e) : grid?.handleKey(e);
    if (handled) e.preventDefault();
  }

  const active = $derived(stats?.active);
</script>

<svelte:window {onkeydown} />

<div class="shell">
  <header class="top">
    <h1>Photo Library</h1>
    <span class="count" data-testid="count">
      {`${ids.length.toLocaleString()} 張${active?.bytes ? ` · ${formatBytes(active.bytes)}` : ''}`}
      {#if selected.size}<b>{` · 已選 ${selected.size.toLocaleString()}`}</b>{/if}
    </span>
    <div class="spacer"></div>
    <label class="ctl">
      <span class="sr">排序</span>
      <select bind:value={sort} aria-label="排序">
        {#each SORTS as s}<option value={s.key}>{s.label}</option>{/each}
      </select>
    </label>
    <label class="ctl size">
      <span aria-hidden="true">▦</span>
      <input type="range" min="96" max="360" step="12" bind:value={cellSize} aria-label="縮圖大小" />
    </label>
    <button type="button" class="primary" onclick={() => (importing = true)}>匯入</button>
  </header>

  {#if loadError}<p class="error">無法連線到 server：{loadError}</p>{/if}

  <main class="body">
    <Grid bind:this={grid} {ids} {cellSize} bind:selected bind:focus onopen={openLoupe} />
  </main>

  <footer class="hints">
    <span><kbd>←↑→↓</kbd> 移動</span>
    <span><kbd>Enter</kbd>／雙擊 開啟</span>
    <span><kbd>Space</kbd> 選取</span>
    <span><kbd>Shift</kbd>/<kbd>Ctrl</kbd>+點擊 多選</span>
    <span><kbd>Ctrl+A</kbd> 全選</span>
    <span><kbd>Esc</kbd> 取消選取</span>
  </footer>
</div>

{#if loupeIndex >= 0}
  <Loupe bind:this={loupe} {ids} bind:index={loupeIndex} onclose={closeLoupe} />
{/if}

{#if importing}
  <ImportDialog onclose={() => (importing = false)} ondone={load} />
{/if}

<style>
  .shell { display: grid; grid-template-rows: auto auto 1fr auto; height: 100%; }
  .top {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    min-width: 0;
  }
  h1 { font-size: 16px; margin: 0; white-space: nowrap; }
  .count { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .count b { color: var(--accent); font-weight: 600; }
  .spacer { flex: 1; }
  .ctl { display: flex; align-items: center; gap: 6px; color: var(--muted); }
  .size input { width: 110px; accent-color: var(--accent); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .body { min-height: 0; }
  .error { margin: 0; padding: 8px 16px; color: var(--danger); background: var(--surface); }
  .hints {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    padding: 6px 16px;
    font-size: 12px;
    color: var(--muted);
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  @media (max-width: 640px) {
    .top { flex-wrap: wrap; }
    .spacer { display: none; }
    .size { display: none; }
    .hints { display: none; }
  }
</style>
