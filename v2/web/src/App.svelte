<script>
  import ContextMenu from './components/ContextMenu.svelte';
  import FilterBar from './components/FilterBar.svelte';
  import Grid from './components/Grid.svelte';
  import ImportDialog from './components/ImportDialog.svelte';
  import Loupe from './components/Loupe.svelte';
  import Picker from './components/Picker.svelte';
  import Prompt from './components/Prompt.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import { api, formatBytes, prefs } from './lib/api.js';
  import { decodeHash, encodeHash, indexCatalog, isEmpty, soleAlbum, toPayload } from './lib/filter.js';

  const BASE_SORTS = [
    { key: 'imported:desc', label: '匯入時間（新→舊）' },
    { key: 'imported:asc', label: '匯入時間（舊→新）' },
    { key: 'mtime:desc', label: '檔案時間（新→舊）' },
    { key: 'mtime:asc', label: '檔案時間（舊→新）' },
    { key: 'name:asc', label: '檔名（A→Z）' },
  ];

  let catalog = $state({ tags: [], folders: [], albums: [], smart: [] });
  let filter = $state(decodeHash(location.hash));
  let ids = $state([]);
  let facets = $state(null);
  let queryError = $state('');
  let sort = $state(prefs.get('sort', 'imported:desc'));
  let cellSize = $state(prefs.get('cellSize', 180));
  let selected = $state(new Set());
  let focus = $state(0);
  let loupeIndex = $state(-1);
  let importing = $state(false);
  let stats = $state(null);
  let loadError = $state('');
  // On narrow screens the sidebar overlays the grid, so it starts closed there.
  let showSidebar = $state(innerWidth > 760 && prefs.get('sidebar', true));
  let picker = $state(null);
  let menu = $state(null);
  let prompt = $state(null);
  let toast = $state(null);
  let refreshKey = $state(0);
  let grid = $state();
  let loupe = $state();

  const index = $derived(indexCatalog(catalog));
  const albumView = $derived(soleAlbum(filter));
  const sorts = $derived(albumView != null ? [{ key: 'album:asc', label: '相簿順序' }, ...BASE_SORTS] : BASE_SORTS);
  const effectiveSort = $derived(sort === 'album:asc' && albumView == null ? 'imported:desc' : sort);

  // ---- data loading ----------------------------------------------------------

  let seq = 0;
  async function runQuery() {
    const mine = ++seq;
    const [s, o] = effectiveSort.split(':');
    const payload = { ...toPayload(filter), sort: s, order: o, ...(s === 'album' ? { album_id: albumView } : {}) };
    try {
      const [res, f] = await Promise.all([api.query(payload), api.facets(payload)]);
      if (mine !== seq) return;
      ids = res.ids;
      facets = f;
      queryError = '';
      loadError = '';
      const present = new Set(ids);
      if ([...selected].some((id) => !present.has(id))) selected = new Set([...selected].filter((id) => present.has(id)));
      if (focus >= ids.length) focus = Math.max(0, ids.length - 1);
      if (loupeIndex >= ids.length) loupeIndex = ids.length ? ids.length - 1 : -1;
    } catch (e) {
      if (mine !== seq) return;
      if (/fetch|network/i.test(e.message)) loadError = e.message;
      else queryError = e.message;
    }
  }

  async function loadCatalog() {
    try {
      catalog = await api.catalog();
      stats = await api.stats();
    } catch (e) {
      loadError = e.message;
    }
  }

  async function refresh() {
    await loadCatalog();
    await runQuery();
    refreshKey++;
  }

  loadCatalog();

  $effect(() => { filter; effectiveSort; runQuery(); });
  $effect(() => { prefs.set('sort', sort); });
  $effect(() => { prefs.set('cellSize', cellSize); });
  /** Persist only explicit toggles, so a narrow-screen visit doesn't hide it on desktop. */
  function toggleSidebar() {
    showSidebar = !showSidebar;
    prefs.set('sidebar', showSidebar);
  }
  $effect(() => {
    const hash = encodeHash(filter);
    if (hash !== location.hash) history.replaceState(null, '', hash || location.pathname + location.search);
  });

  function onhashchange() { filter = decodeHash(location.hash); }

  // ---- feedback ---------------------------------------------------------------

  let toastTimer;
  function notify(text, isError = false) {
    clearTimeout(toastTimer);
    toast = { text, isError };
    toastTimer = setTimeout(() => (toast = null), isError ? 6000 : 2500);
  }

  async function attempt(fn, success) {
    try {
      const r = await fn();
      await refresh(); // message may name a just-created tag/album, so index must be fresh
      if (success) notify(typeof success === 'function' ? success(r) : success);
      return r;
    } catch (e) {
      notify(e.message, true);
      return null;
    }
  }

  /** Promise-based replacement for window.prompt / confirm. */
  function ask(opts) {
    return new Promise((resolve) => {
      prompt = {
        ...opts,
        onsubmit: (value, color) => { prompt = null; resolve({ value, color }); },
        oncancel: () => { prompt = null; resolve(null); },
      };
    });
  }

  // ---- assignment -------------------------------------------------------------

  /** Selected ids, or the focused one when nothing is selected. */
  function targetIds() {
    if (loupeIndex >= 0) return [ids[loupeIndex]];
    if (selected.size) return [...selected];
    return ids.length ? [ids[focus]] : [];
  }

  const tagItems = () => catalog.tags
    .map((t) => ({ id: t.id, label: index.tagPath(t.id), color: t.color, hint: t.is_system ? '系統' : '' }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const albumItems = () => catalog.albums
    .map((a) => ({ id: a.id, label: a.name, hint: a.folder_id ? index.folderById.get(a.folder_id)?.name : '' }))
    .sort((a, b) => a.label.localeCompare(b.label));

  function openPicker(kind, assetIds, mode = 'add') {
    if (!assetIds.length) return;
    const n = assetIds.length;
    if (kind === 'tags') {
      picker = {
        title: mode === 'add' ? '加 Tag' : '移除 Tag',
        subtitle: `${n} 張照片`,
        items: tagItems(),
        allowCreate: mode === 'add',
        createLabel: '建立 tag',
        onpick: (id) => { picker = null; applyTag(id, assetIds, mode === 'remove'); },
        oncreate: async (name) => {
          picker = null;
          try {
            const tag = await api.createTag({ name });
            await applyTag(tag.id, assetIds, false);
          } catch (e) { notify(e.message, true); }
        },
      };
    } else {
      picker = {
        title: mode === 'add' ? '加入相簿' : '移出相簿',
        subtitle: `${n} 張照片`,
        items: albumItems(),
        allowCreate: mode === 'add',
        createLabel: '建立相簿',
        onpick: (id) => { picker = null; mode === 'add' ? addToAlbum(id, assetIds) : removeFromAlbum(id, assetIds); },
        oncreate: async (name) => {
          picker = null;
          try {
            const album = await api.createAlbum({ name });
            await addToAlbum(album.id, assetIds);
          } catch (e) { notify(e.message, true); }
        },
      };
    }
  }

  const applyTag = (tagId, assetIds, remove) => attempt(
    () => api.applyTags({ asset_ids: assetIds, [remove ? 'remove' : 'add']: [tagId] }),
    (r) => remove ? `已從 ${r.removed} 張移除「${index.tagPath(tagId)}」` : `已為 ${r.added} 張加上「${index.tagPath(tagId)}」`,
  );
  const addToAlbum = (albumId, assetIds) => attempt(
    () => api.addToAlbum(albumId, assetIds),
    (r) => `已加入 ${r.added} 張到「${index.albumById.get(albumId)?.name ?? ''}」${r.added < assetIds.length ? `（${assetIds.length - r.added} 張原本就在）` : ''}`,
  );
  const removeFromAlbum = (albumId, assetIds) => attempt(
    () => api.removeFromAlbum(albumId, assetIds),
    (r) => `已從「${index.albumById.get(albumId)?.name ?? ''}」移出 ${r.removed} 張`,
  );

  function ondropassets(kind, id, assetIds) {
    if (kind === 'tags') applyTag(id, assetIds, false);
    else addToAlbum(id, assetIds);
  }

  // ---- catalogue management (sidebar "+" and context menus) ----------------

  async function create(kind, parentId) {
    if (kind === 'tags') {
      const parent = parentId ? `「${index.tagPath(parentId)}」底下` : '';
      const r = await ask({ title: `新增 tag${parent ? `（${parent}）` : ''}`, label: '名稱（可用 / 建立階層，如 類型/收據）', withColor: true });
      if (r) attempt(() => api.createTag({ name: r.value, parent_id: parentId, color: r.color }), (t) => (t.created ? `已建立「${index.tagPath(t.id) || r.value}」` : '已存在'));
    } else if (kind === 'albums') {
      const r = await ask({ title: '新增相簿', label: '相簿名稱' });
      if (r) {
        const assetIds = selected.size ? [...selected] : [];
        const album = await attempt(() => api.createAlbum({ name: r.value, folder_id: parentId }), `已建立相簿「${r.value}」`);
        if (album && assetIds.length) {
          const ok = await ask({ title: '加入選取的照片？', message: `要把目前選取的 ${assetIds.length} 張加入「${r.value}」嗎？`, confirmOnly: true, submitLabel: '加入' });
          if (ok) addToAlbum(album.id, assetIds);
        }
      }
    } else if (kind === 'folders') {
      const r = await ask({ title: '新增資料夾', label: '資料夾名稱' });
      if (r) attempt(() => api.createFolder({ name: r.value, parent_id: parentId }), `已建立資料夾「${r.value}」`);
    }
  }

  function setFilterState(kind, id, state) {
    const map = { ...filter[kind] };
    if (state) map[id] = state; else delete map[id];
    filter = { ...filter, [kind]: map };
  }

  function oncontext(kind, item, e) {
    const at = { x: e.clientX, y: e.clientY };
    if (kind === 'tags') {
      const sys = item.is_system;
      menu = { ...at, items: [
        { label: '只看此 tag', action: () => (filter = { ...filter, tags: { [item.id]: 'in' }, albums: {}, smart: null, q: '' }) },
        { label: '排除此 tag', action: () => setFilterState('tags', item.id, 'out') },
        'sep',
        { label: '新增子 tag…', action: () => create('tags', item.id) },
        { label: '重新命名…', disabled: sys, action: async () => {
          const r = await ask({ title: '重新命名 tag', label: '名稱', value: item.name });
          if (r) attempt(() => api.updateTag(item.id, { name: r.value }), '已重新命名');
        } },
        { label: '顏色…', disabled: sys, action: async () => {
          const r = await ask({ title: `「${item.name}」的顏色`, confirmOnly: true, withColor: true, color: item.color, submitLabel: '套用' });
          if (r) attempt(() => api.updateTag(item.id, { color: r.color }), '已更新顏色');
        } },
        { label: '移到頂層', disabled: sys || item.parent_id == null, action: () => attempt(() => api.updateTag(item.id, { parent_id: null }), '已移到頂層') },
        'sep',
        { label: '刪除 tag…', danger: true, disabled: sys, action: async () => {
          const r = await ask({ title: '刪除 tag', message: `刪除「${index.tagPath(item.id)}」及其所有子 tag？照片本身不會被刪除，只會失去這些 tag。`, confirmOnly: true, danger: true, submitLabel: '刪除' });
          if (r) {
            setFilterState('tags', item.id, undefined);
            attempt(() => api.deleteTag(item.id), (x) => `已刪除 ${x.deleted_tags} 個 tag（${x.removed_links} 個標記）`);
          }
        } },
      ] };
    } else if (kind === 'albums') {
      menu = { ...at, items: [
        { label: '只看此相簿', action: () => (filter = { ...filter, albums: { [item.id]: 'in' }, tags: {}, smart: null, q: '' }) },
        { label: '排除此相簿', action: () => setFilterState('albums', item.id, 'out') },
        'sep',
        { label: '重新命名…', action: async () => {
          const r = await ask({ title: '重新命名相簿', label: '名稱', value: item.name });
          if (r) attempt(() => api.updateAlbum(item.id, { name: r.value }), '已重新命名');
        } },
        { label: '移到資料夾…', action: () => {
          picker = {
            title: `移動「${item.name}」`, subtitle: '選擇資料夾', allowCreate: false,
            items: [{ id: 0, label: '（頂層）' }, ...catalog.folders.map((f) => ({ id: f.id, label: f.name }))],
            onpick: (fid) => { picker = null; attempt(() => api.updateAlbum(item.id, { folder_id: fid || null }), '已移動'); },
          };
        } },
        'sep',
        { label: '刪除相簿…', danger: true, action: async () => {
          const r = await ask({ title: '刪除相簿', message: `刪除相簿「${item.name}」？裡面的 ${item.count} 張照片會留在照片庫，只是不再屬於這本相簿。`, confirmOnly: true, danger: true, submitLabel: '刪除' });
          if (r) {
            setFilterState('albums', item.id, undefined);
            attempt(() => api.deleteAlbum(item.id), '已刪除相簿');
          }
        } },
      ] };
    } else if (kind === 'folders') {
      menu = { ...at, items: [
        { label: '在此新增相簿…', action: () => create('albums', item.id) },
        { label: '新增子資料夾…', action: () => create('folders', item.id) },
        { label: '重新命名…', action: async () => {
          const r = await ask({ title: '重新命名資料夾', label: '名稱', value: item.name });
          if (r) attempt(() => api.updateFolder(item.id, { name: r.value }), '已重新命名');
        } },
        'sep',
        { label: '刪除資料夾…', danger: true, action: async () => {
          const r = await ask({ title: '刪除資料夾', message: `刪除「${item.name}」？裡面的相簿會移到頂層，不會被刪除。`, confirmOnly: true, danger: true, submitLabel: '刪除' });
          if (r) attempt(() => api.deleteFolder(item.id), '已刪除資料夾');
        } },
      ] };
    } else if (kind === 'smart') {
      menu = { ...at, items: [
        { label: '重新命名…', action: async () => {
          const r = await ask({ title: '重新命名智慧相簿', label: '名稱', value: item.name });
          if (r) attempt(() => api.updateSmart(item.id, { name: r.value }), '已重新命名');
        } },
        { label: '以目前篩選取代條件', disabled: isEmpty(filter) || filter.smart === item.id, action: () =>
          attempt(() => api.updateSmart(item.id, toPayload(filter)), '已更新條件') },
        'sep',
        { label: '刪除智慧相簿…', danger: true, action: async () => {
          const r = await ask({ title: '刪除智慧相簿', message: `刪除「${item.name}」？只刪除這個篩選條件，照片不受影響。`, confirmOnly: true, danger: true, submitLabel: '刪除' });
          if (r) {
            if (filter.smart === item.id) filter = { ...filter, smart: null };
            attempt(() => api.deleteSmart(item.id), '已刪除');
          }
        } },
      ] };
    }
  }

  function oncellcontext(e) {
    const assetIds = [...selected];
    const n = assetIds.length;
    menu = { x: e.clientX, y: e.clientY, items: [
      { label: n === 1 ? '開啟' : `開啟第一張`, action: () => { loupeIndex = ids.indexOf(assetIds[0]); } },
      'sep',
      { label: `加 Tag…（${n} 張）`, action: () => openPicker('tags', assetIds) },
      { label: `加入相簿…（${n} 張）`, action: () => openPicker('albums', assetIds) },
      'sep',
      { label: '移除 Tag…', action: () => openPicker('tags', assetIds, 'remove') },
      ...(albumView != null
        ? [{ label: `從「${index.albumById.get(albumView)?.name}」移出`, action: () => removeFromAlbum(albumView, assetIds) }]
        : [{ label: '移出相簿…', action: () => openPicker('albums', assetIds, 'remove') }]),
    ] };
  }

  async function saveSmart() {
    const r = await ask({ title: '存為智慧相簿', label: '名稱', message: '儲存目前的篩選條件；之後符合條件的新照片會自動出現。' });
    if (!r) return;
    const s = await attempt(() => api.createSmart({ name: r.value, ...toPayload(filter) }), `已建立智慧相簿「${r.value}」`);
    if (s) filter = { tags: {}, albums: {}, tagMode: 'all', albumMode: 'any', smart: s.id, q: '' };
  }

  // ---- loupe + keyboard -------------------------------------------------------

  function openLoupe(i) { loupeIndex = i; }
  function closeLoupe() {
    const i = loupeIndex;
    loupeIndex = -1;
    queueMicrotask(() => grid?.reveal(i));
  }

  function onremove(kind, memberId, assetId) {
    if (kind === 'tags') applyTag(memberId, [assetId], true);
    else removeFromAlbum(memberId, [assetId]);
  }

  function onkeydown(e) {
    if (importing || picker || prompt || menu) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (loupeIndex >= 0) {
      if (loupe?.handleKey(e)) e.preventDefault();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 't') { e.preventDefault(); openPicker('tags', targetIds(), e.shiftKey ? 'remove' : 'add'); return; }
      if (key === 'b') { e.preventDefault(); openPicker('albums', targetIds(), e.shiftKey ? 'remove' : 'add'); return; }
      if (key === '/') { e.preventDefault(); document.querySelector('[data-testid=query]')?.focus(); return; }
      if (key === '\\') { e.preventDefault(); toggleSidebar(); return; }
    }
    if (grid?.handleKey(e)) e.preventDefault();
  }

  const active = $derived(stats?.active);
</script>

<svelte:window {onkeydown} {onhashchange} />

<div class="shell" class:nosidebar={!showSidebar}>
  <header class="top">
    <button type="button" class="icon" onclick={toggleSidebar} title="側欄（\）" aria-label="切換側欄">☰</button>
    <h1>Photo Library</h1>
    <span class="count" data-testid="count">
      {`${(active?.count ?? 0).toLocaleString()} 張${active?.bytes ? ` · ${formatBytes(active.bytes)}` : ''}`}
      {#if selected.size}<b>{` · 已選 ${selected.size.toLocaleString()}`}</b>{/if}
    </span>
    <div class="spacer"></div>
    {#if selected.size}
      <div class="selbar" data-testid="selection-bar">
        <button type="button" onclick={() => openPicker('tags', [...selected])} title="T">加 Tag</button>
        <button type="button" onclick={() => openPicker('albums', [...selected])} title="B">加入相簿</button>
        {#if albumView != null}
          <button type="button" onclick={() => removeFromAlbum(albumView, [...selected])}>移出此相簿</button>
        {/if}
        <button type="button" onclick={() => (selected = new Set())} title="Esc">取消選取</button>
      </div>
    {/if}
    <select bind:value={sort} aria-label="排序">
      {#each sorts as s}<option value={s.key}>{s.label}</option>{/each}
    </select>
    <label class="size">
      <span aria-hidden="true">▦</span>
      <input type="range" min="96" max="360" step="12" bind:value={cellSize} aria-label="縮圖大小" />
    </label>
    <button type="button" class="primary" onclick={() => (importing = true)}>匯入</button>
  </header>

  {#if showSidebar}
    <aside class="side">
      <Sidebar {catalog} {facets} bind:filter {oncontext} oncreate={create} {ondropassets} />
    </aside>
  {/if}

  <main class="main">
    {#if loadError}<p class="error">無法連線到 server：{loadError}</p>{/if}
    <FilterBar bind:filter {index} total={ids.length} error={queryError} onsave={saveSmart} />
    <div class="gridwrap">
      <Grid bind:this={grid} {ids} {cellSize} bind:selected bind:focus filtered={!isEmpty(filter)} onopen={openLoupe} {oncellcontext} />
    </div>
    <footer class="hints">
      <span><kbd>Enter</kbd> 開啟</span>
      <span><kbd>Space</kbd>／<kbd>Shift</kbd>/<kbd>Ctrl</kbd>+點擊 選取</span>
      <span><kbd>T</kbd> 加 Tag</span>
      <span><kbd>B</kbd> 加入相簿</span>
      <span><kbd>Shift+T</kbd>/<kbd>Shift+B</kbd> 移除</span>
      <span><kbd>/</kbd> 查詢</span>
      <span>拖曳到側欄＝加入</span>
    </footer>
  </main>
</div>

{#if loupeIndex >= 0}
  <Loupe bind:this={loupe} {ids} bind:index={loupeIndex} catalogIndex={index} {refreshKey} onclose={closeLoupe}
    onpick={(kind, id) => openPicker(kind, [id])} {onremove} />
{/if}

{#if importing}
  <ImportDialog onclose={() => (importing = false)} ondone={refresh} />
{/if}

{#if picker}
  <Picker {...picker} onclose={() => (picker = null)} />
{/if}

{#if menu}
  <ContextMenu {...menu} onclose={() => (menu = null)} />
{/if}

{#if prompt}
  <Prompt {...prompt} />
{/if}

{#if toast}
  <div class="toast" class:err={toast.isError} role="status" data-testid="toast">{toast.text}</div>
{/if}

<style>
  .shell {
    display: grid;
    grid-template-columns: 260px 1fr;
    grid-template-rows: auto 1fr;
    grid-template-areas: 'top top' 'side main';
    height: 100%;
  }
  .shell.nosidebar { grid-template-columns: 1fr; grid-template-areas: 'top' 'main'; }
  .top {
    grid-area: top;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    min-width: 0;
  }
  .icon { padding: 4px 9px; }
  h1 { font-size: 16px; margin: 0; white-space: nowrap; }
  .count { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .count b { color: var(--accent); font-weight: 600; }
  .spacer { flex: 1; }
  .selbar { display: flex; gap: 6px; }
  .size { display: flex; align-items: center; gap: 6px; color: var(--muted); }
  .size input { width: 100px; accent-color: var(--accent); }
  .side { grid-area: side; min-height: 0; }
  .main { grid-area: main; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .gridwrap { flex: 1; min-height: 0; }
  .error { margin: 0; padding: 8px 16px; color: var(--danger); background: var(--surface); }
  .hints {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    padding: 5px 14px;
    font-size: 12px;
    color: var(--muted);
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 40px;
    transform: translateX(-50%);
    max-width: min(560px, calc(100% - 32px));
    padding: 8px 16px;
    border-radius: 8px;
    background: var(--text);
    color: var(--bg);
    font-size: 13px;
    z-index: 50;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  }
  .toast.err { background: var(--danger); color: #fff; }
  @media (max-width: 760px) {
    .shell, .shell.nosidebar { grid-template-columns: 1fr; grid-template-areas: 'top' 'main'; }
    .side { position: fixed; top: 49px; bottom: 0; left: 0; width: min(280px, 85vw); z-index: 15; box-shadow: 8px 0 24px rgba(0, 0, 0, 0.3); }
    .top { flex-wrap: wrap; }
    .size, .hints, h1 { display: none; }
    .selbar { order: 10; flex-basis: 100%; overflow-x: auto; }
  }
</style>
