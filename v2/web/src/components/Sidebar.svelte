<script>
  import { prefs } from '../lib/api.js';
  import { childrenOf, cycle, DRAG_TYPE, isEmpty } from '../lib/filter.js';

  /**
   * Library navigation: built-in views, smart albums, album folders/albums,
   * tags. Albums and tags are three-state filters (click = include,
   * Alt+click = exclude, click again = off) and drop targets for photos.
   */
  let { catalog, facets, filter = $bindable(), oncontext, oncreate, ondropassets } = $props();


  let collapsed = $state(new Set(prefs.get('collapsed', [])));
  let dropTarget = $state(null);

  const folderKids = $derived(childrenOf(catalog.folders, 'parent_id'));
  const albumKids = $derived(childrenOf(catalog.albums, 'folder_id'));
  const userTags = $derived(catalog.tags.filter((t) => !t.is_system));
  const systemTags = $derived(catalog.tags.filter((t) => t.is_system));
  const userTagKids = $derived(childrenOf(userTags, 'parent_id'));
  const systemTagKids = $derived(childrenOf(systemTags, 'parent_id'));

  function toggleCollapse(key) {
    const next = new Set(collapsed);
    next.has(key) ? next.delete(key) : next.add(key);
    collapsed = next;
    prefs.set('collapsed', [...next]);
  }

  function setState(kind, id, e) {
    const next = cycle(filter[kind][id], e.altKey);
    const map = { ...filter[kind] };
    if (next) map[id] = next; else delete map[id];
    filter = { ...filter, [kind]: map };
  }

  function setSmart(value) {
    filter = { ...filter, smart: filter.smart === value ? null : value };
  }

  function showAll() {
    filter = { ...filter, tags: {}, albums: {}, smart: null, q: '' };
  }

  // ---- drag & drop of photos onto albums / tags ----------------------------

  function dragover(e, key) {
    if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dropTarget = key;
  }
  function drop(e, kind, id) {
    dropTarget = null;
    const raw = e.dataTransfer?.getData(DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    ondropassets?.(kind, id, JSON.parse(raw));
  }

  const count = (kind, id) => facets?.[kind]?.[id] ?? 0;
</script>

{#snippet row(kind, item, depth, hasKids, collapseKey)}
  {@const state = filter[kind][item.id]}
  {@const n = count(kind, item.id)}
  <div
    class="row"
    class:in={state === 'in'}
    class:out={state === 'out'}
    class:drop={dropTarget === `${kind}:${item.id}`}
    style:padding-left="{8 + depth * 14}px"
    role="treeitem"
    aria-selected={!!state}
    tabindex="-1"
    data-kind={kind}
    data-id={item.id}
    onclick={(e) => setState(kind, item.id, e)}
    oncontextmenu={(e) => { e.preventDefault(); oncontext?.(kind, item, e); }}
    ondragover={(e) => dragover(e, `${kind}:${item.id}`)}
    ondragleave={() => (dropTarget = null)}
    ondrop={(e) => drop(e, kind, item.id)}
    title={state === 'in' ? '包含（點擊取消；Alt+點擊改為排除）' : state === 'out' ? '排除（點擊取消）' : '點擊包含；Alt+點擊排除'}
    onkeydown={() => {}}
  >
    {#if hasKids}
      <button type="button" class="twisty" onclick={(e) => { e.stopPropagation(); toggleCollapse(collapseKey); }}
        aria-label={collapsed.has(collapseKey) ? '展開' : '收合'}>{collapsed.has(collapseKey) ? '▸' : '▾'}</button>
    {:else}
      <span class="twisty"></span>
    {/if}
    {#if kind === 'tags'}
      <i class="dot" style:background={item.color ?? 'transparent'} class:hollow={!item.color}></i>
    {:else}
      <span class="glyph">▣</span>
    {/if}
    <span class="name">{item.name}</span>
    <span class="mark">{state === 'in' ? '✓' : state === 'out' ? '⊘' : ''}</span>
    <span class="n" class:zero={!n}>{n}</span>
  </div>
{/snippet}

{#snippet tagTree(kids, parent, depth)}
  {#each kids.get(parent) ?? [] as tag (tag.id)}
    {@const key = `t${tag.id}`}
    {@const hasKids = kids.has(tag.id)}
    {@render row('tags', tag, depth, hasKids, key)}
    {#if hasKids && !collapsed.has(key)}{@render tagTree(kids, tag.id, depth + 1)}{/if}
  {/each}
{/snippet}

{#snippet folderTree(parent, depth)}
  {#each folderKids.get(parent) ?? [] as folder (folder.id)}
    {@const key = `f${folder.id}`}
    <div
      class="row folder"
      style:padding-left="{8 + depth * 14}px"
      role="treeitem"
      aria-selected="false"
      tabindex="-1"
      onclick={() => toggleCollapse(key)}
      oncontextmenu={(e) => { e.preventDefault(); oncontext?.('folders', folder, e); }}
      onkeydown={() => {}}
    >
      <span class="twisty">{collapsed.has(key) ? '▸' : '▾'}</span>
      <span class="glyph">📁</span>
      <span class="name">{folder.name}</span>
    </div>
    {#if !collapsed.has(key)}
      {@render folderTree(folder.id, depth + 1)}
      {#each albumKids.get(folder.id) ?? [] as album (album.id)}{@render row('albums', album, depth + 1, false, '')}{/each}
    {/if}
  {/each}
{/snippet}

<nav class="sidebar" aria-label="照片庫導覽" data-testid="sidebar">
  <section>
    <button type="button" class="nav" class:on={isEmpty(filter)} onclick={showAll}>
      <span class="glyph">▦</span><span class="name">全部照片</span>
    </button>
    <button type="button" class="nav" class:on={filter.smart === 'unfiled'} onclick={() => setSmart('unfiled')} data-testid="unfiled">
      <span class="glyph">◌</span><span class="name">未歸類</span>
    </button>
  </section>

  <section>
    <h3>智慧相簿</h3>
    {#each catalog.smart as s (s.id)}
      <button type="button" class="nav" class:on={filter.smart === s.id} onclick={() => setSmart(s.id)}
        oncontextmenu={(e) => { e.preventDefault(); oncontext?.('smart', s, e); }} data-smart={s.id}>
        <span class="glyph">◆</span><span class="name">{s.name}</span>
      </button>
    {:else}
      <p class="empty">在篩選列按「存為智慧相簿」</p>
    {/each}
  </section>

  <section>
    <h3>
      相簿
      <span class="actions">
        <button type="button" onclick={() => oncreate?.('folders', null)} title="新增資料夾">📁+</button>
        <button type="button" onclick={() => oncreate?.('albums', null)} title="新增相簿" data-testid="new-album">＋</button>
      </span>
    </h3>
    <div role="tree">
      {@render folderTree(0, 0)}
      {#each albumKids.get(0) ?? [] as album (album.id)}{@render row('albums', album, 0, false, '')}{/each}
    </div>
    {#if !catalog.albums.length && !catalog.folders.length}<p class="empty">尚無相簿</p>{/if}
  </section>

  <section>
    <h3>
      Tags
      <span class="actions">
        <button type="button" onclick={() => oncreate?.('tags', null)} title="新增 tag" data-testid="new-tag">＋</button>
      </span>
    </h3>
    <div role="tree">{@render tagTree(userTagKids, 0, 0)}</div>
    {#if !userTags.length}<p class="empty">尚無 tag</p>{/if}
    <h4>系統</h4>
    <div role="tree">{@render tagTree(systemTagKids, 0, 0)}</div>
  </section>

  <p class="legend">點擊＝包含 · <kbd>Alt</kbd>+點擊＝排除 · 右鍵＝管理 · 拖曳照片到相簿／tag 即可加入</p>
</nav>

<style>
  .sidebar {
    height: 100%;
    overflow: auto;
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: 8px 6px 16px;
    font-size: 13px;
    user-select: none;
  }
  section { margin-bottom: 14px; }
  h3, h4 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 6px 8px 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  h4 { margin-top: 10px; }
  .actions { display: flex; gap: 2px; }
  .actions button { padding: 0 6px; font-size: 12px; background: none; border-color: transparent; color: var(--muted); }
  .actions button:hover { color: var(--accent); }
  .nav, .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 28px;
    padding: 3px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    text-align: left;
    cursor: pointer;
    position: relative;
  }
  .nav:hover, .row:hover { background: var(--surface-2); }
  .nav.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .row.in { background: color-mix(in srgb, #2f9e44 16%, transparent); }
  .row.in .name { font-weight: 600; }
  .row.out { background: color-mix(in srgb, var(--danger) 14%, transparent); }
  .row.out .name { text-decoration: line-through; color: var(--muted); }
  .row.drop { outline: 2px solid var(--accent); outline-offset: -2px; }
  .row.folder { color: var(--muted); }
  .twisty { width: 14px; flex: none; padding: 0; border: 0; background: none; color: var(--muted); font-size: 10px; text-align: center; }
  .glyph { width: 16px; flex: none; text-align: center; color: var(--muted); font-size: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; margin: 0 3px; }
  .dot.hollow { border: 1px solid var(--muted); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mark { width: 14px; text-align: center; font-size: 12px; }
  .row.in .mark { color: #2f9e44; }
  .row.out .mark { color: var(--danger); }
  .n { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .n.zero { opacity: 0.45; }
  .empty { margin: 2px 10px; color: var(--muted); font-size: 12px; }
  .legend { margin: 12px 8px 0; color: var(--muted); font-size: 11px; line-height: 1.6; }
</style>
