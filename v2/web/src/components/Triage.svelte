<script>
  import { untrack } from 'svelte';
  import CropStage from './CropStage.svelte';
  import Picker from './Picker.svelte';
  import { api, formatBytes } from '../lib/api.js';
  import { RATIOS, outputSize } from '../lib/crop.js';
  import { nextIndex, triageAction } from '../lib/triageKeys.js';

  /**
   * Triage mode (Sprint §7): walk the current filter result one image at a
   * time with the keyboard. After every action the source query is re-run by
   * the parent (onrefresh); images that no longer match (tagged out of
   * 未歸類, trashed) drop out on their own and the cursor lands on the next
   * survivor (lib/triageKeys.js nextIndex).
   */
  let {
    ids,
    startIndex = 0,
    catalog,
    catalogIndex,
    sourceLabel = '',
    refreshKey = 0,
    onrefresh,
    onundo,
    onclose,
    notify,
    pushHistory,
  } = $props();

  const LATER_PATH = 'triage/later';

  let index = $state(untrack(() => Math.max(0, Math.min(startIndex, ids.length - 1))));
  let mode = $state('browse'); // browse | crop
  let purpose = $state('bundle'); // crop purpose: bundle (Q) | keep (W)
  let ratio = $state('free');
  let showStats = $state(false);
  let busy = $state(false);
  let detail = $state(null);
  let bundle = $state(null);
  let openBundles = $state(0);
  let slots = $state(Array(9).fill(null));
  let picker = $state(null);
  let stage = $state();
  let stats = $state({ q: 0, w: 0, e: 0, r: 0, slot: 0, g: 0, cancel: 0, undo: 0 });
  let processed = $state(new Set());

  const at = $derived(ids.length ? Math.min(index, ids.length - 1) : -1);
  const id = $derived(at >= 0 ? ids[at] : null);
  const laterTag = $derived(catalog.tags.find((t) => catalogIndex.tagPath(t.id) === LATER_PATH) ?? null);

  // ---- data ------------------------------------------------------------------

  let shown = null;
  $effect(() => {
    const current = id;
    refreshKey;
    if (current == null) { detail = null; return; }
    if (current !== shown) { detail = null; shown = current; }
    api.asset(current).then((d) => { if (current === id) detail = d; }).catch((e) => notify(e.message, true));
  });

  async function loadBundle() {
    try {
      const open = await api.bundles('open');
      bundle = open[0] ?? null;
      openBundles = open.length;
    } catch (e) { notify(e.message, true); }
  }
  async function loadSlots() {
    try { slots = await api.slots(); } catch (e) { notify(e.message, true); }
  }
  loadBundle();
  loadSlots();

  // ---- action runner -----------------------------------------------------------

  /**
   * Runs one mutation on the current image, then re-queries the source and
   * repositions the cursor. `advance` = move to the next image when the
   * current one still matches the source.
   */
  async function run(fn, { advance = false } = {}) {
    if (busy || id == null) return;
    busy = true;
    const before = ids;
    const from = at;
    const target = id;
    let ok = false;
    try {
      const msg = await fn(target);
      ok = true;
      processed = new Set(processed).add(target);
      if (msg) notify(msg);
    } catch (e) {
      notify(e.message, true);
    }
    try {
      await onrefresh?.();
      index = Math.max(0, nextIndex(before, ids, from, ok && advance));
    } finally {
      busy = false;
    }
  }

  const bump = (k) => { stats = { ...stats, [k]: stats[k] + 1 }; };

  // ---- Q / W: crop ------------------------------------------------------------

  function startCrop(p) {
    if (id == null || !detail) return;
    purpose = p;
    ratio = 'free';
    mode = 'crop';
  }

  async function confirmCrop() {
    const rel = stage?.getRelative() ?? null;
    if (purpose === 'keep' && !rel) {
      notify('W 需要先框選範圍（Esc 取消）', true);
      return;
    }
    const ratioLabel = ratio === 'free' ? null : ratio;
    const kind = purpose;
    await run(async (assetId) => {
      const events = [];
      try {
        if (kind === 'keep') {
          const crop = await api.createCrop(assetId, { ...rel, ratio_label: ratioLabel });
          events.push(crop.event_id);
          bump('w');
          const px = outputSize(rel, detail.width, detail.height);
          return `已存裁剪 ${px.width}×${px.height}（Z 撤銷）`;
        }
        let b = bundle;
        if (!b) {
          b = await api.createBundle({});
          events.push(b.event_id);
        }
        let item;
        if (rel) {
          const crop = await api.createCrop(assetId, { ...rel, ratio_label: ratioLabel });
          events.push(crop.event_id);
          item = await api.addBundleItem(b.id, { crop_id: crop.id });
        } else {
          item = await api.addBundleItem(b.id, { asset_id: assetId });
        }
        events.push(item.event_id);
        bump('q');
        return `已加入 bundle「${b.name}」${rel ? '（裁剪）' : '（整張）'}${b === bundle ? '' : '・新 bundle'}（Z 撤銷）`;
      } finally {
        if (events.length) pushHistory?.({ label: kind === 'keep' ? 'W 存裁剪' : 'Q 加入 bundle', eventIds: events });
      }
    }, { advance: true });
    mode = 'browse';
    await loadBundle();
  }

  // ---- E / R / slots ------------------------------------------------------------

  const later = () => run(async (assetId) => {
    if (!laterTag) throw new Error(`找不到系統 tag「${LATER_PATH}」`);
    const r = await api.applyTags({ asset_ids: [assetId], add: [laterTag.id] });
    if (r.event_id) pushHistory?.({ label: 'E 稍後處理', eventIds: [r.event_id] });
    bump('e');
    return `已標記「${LATER_PATH}」（Z 撤銷）`;
  }, { advance: true });

  const trash = () => run(async (assetId) => {
    const r = await api.trash([assetId]);
    pushHistory?.({ label: 'R 移入垃圾桶', eventIds: [r.event_id] });
    bump('r');
    return r.trashed ? '已移入垃圾桶（Z 撤銷）' : '這張不在可移入垃圾桶的狀態';
  }, { advance: true });

  function slotActive(slot, d) {
    if (!slot || !d) return false;
    return slot.kind === 'tag' ? d.tags.some((t) => t.id === slot.id) : d.albums.includes(slot.id);
  }

  function toggleSlot(n) {
    const slot = slots[n];
    if (!slot) { notify(`快捷槽 ${n + 1} 尚未設定（點右側清單設定）`, true); return; }
    if (slot.name == null) { notify(`快捷槽 ${n + 1} 的目標已被刪除，請重新設定`, true); return; }
    if (!detail || detail.id !== id) return;
    const on = slotActive(slot, detail);
    return run(async (assetId) => {
      let r;
      if (slot.kind === 'tag') r = await api.applyTags({ asset_ids: [assetId], [on ? 'remove' : 'add']: [slot.id] });
      else if (on) r = await api.removeFromAlbum(slot.id, [assetId]);
      else r = await api.addToAlbum(slot.id, [assetId]);
      if (r?.event_id) pushHistory?.({ label: `${n + 1} ${slot.name}`, eventIds: [r.event_id] });
      bump('slot');
      const what = slot.kind === 'tag' ? `tag「${catalogIndex.tagPath(slot.id) || slot.name}」` : `相簿「${slot.name}」`;
      return `${on ? '已移除' : '已套用'} ${what}（Z 撤銷）`;
    });
  }

  // ---- G / Shift+G: bundle --------------------------------------------------------

  async function bundleOp(cancel) {
    if (busy) return;
    if (cancel && !bundle) { notify('沒有進行中的 bundle'); return; }
    busy = true;
    try {
      if (bundle) {
        const r = await api.updateBundle(bundle.id, { status: cancel ? 'cancelled' : 'closed' });
        pushHistory?.({ label: cancel ? 'Shift+G 取消 bundle' : 'G 結束 bundle', eventIds: [r.event_id] });
        bump(cancel ? 'cancel' : 'g');
        notify(`${cancel ? '已取消' : '已結束'} bundle「${r.name}」（${r.items.length} 項，Z 撤銷）`);
      } else {
        const r = await api.createBundle({});
        pushHistory?.({ label: 'G 開始 bundle', eventIds: [r.event_id] });
        notify(`已開始 bundle「${r.name}」（Z 撤銷）`);
      }
    } catch (e) {
      notify(e.message, true);
    } finally {
      busy = false;
    }
    await loadBundle();
  }

  // ---- Z ------------------------------------------------------------------------

  async function undo() {
    if (busy) return;
    busy = true;
    const before = ids;
    const from = at;
    try {
      if (await onundo?.()) bump('undo');
      index = Math.max(0, nextIndex(before, ids, from, false));
    } finally {
      busy = false;
    }
    await loadBundle();
    await loadSlots();
  }

  // ---- slot setup -----------------------------------------------------------------

  function editSlot(n) {
    const items = [
      { id: 'clear', label: '（清除此槽）' },
      ...catalog.tags.map((t) => ({ id: `tag:${t.id}`, label: catalogIndex.tagPath(t.id), color: t.color, hint: t.is_system ? 'tag・系統' : 'tag' })),
      ...catalog.albums.map((a) => ({ id: `album:${a.id}`, label: a.name, hint: '相簿' })),
    ];
    picker = {
      title: `設定快捷槽 ${n + 1}`,
      subtitle: '選 tag 或相簿；按該數字鍵即可切換套用',
      items,
      allowCreate: false,
      onpick: async (key) => {
        picker = null;
        const next = slots.map((s) => (s ? { kind: s.kind, id: s.id } : null));
        if (key === 'clear') next[n] = null;
        else {
          const [kind, raw] = key.split(':');
          next[n] = { kind, id: Number(raw) };
        }
        try {
          slots = await api.putSlots(next);
          notify(`快捷槽 ${n + 1} 已${next[n] ? `設為「${slots[n]?.name ?? ''}」` : '清除'}`);
        } catch (e) { notify(e.message, true); }
      },
    };
  }

  // ---- keyboard ---------------------------------------------------------------------

  function go(delta) {
    if (!ids.length) return;
    index = Math.max(0, Math.min(ids.length - 1, at + delta));
  }

  /** Called by App while Triage is open. Returns true if the key was consumed. */
  export function handleKey(e) {
    if (picker) return false; // Picker handles (and stops) its own keys
    const a = triageAction(e, { mode: showStats ? 'stats' : mode });
    if (!a) return false;
    switch (a.type) {
      case 'stats': showStats = !showStats; break;
      case 'crop-start': startCrop(a.purpose); break;
      case 'crop-confirm': confirmCrop(); break;
      case 'crop-cancel': mode = 'browse'; break;
      case 'ratio': ratio = a.ratio; break;
      case 'later': later(); break;
      case 'trash': trash(); break;
      case 'slot': toggleSlot(a.slot); break;
      case 'bundle-toggle': bundleOp(false); break;
      case 'bundle-cancel': bundleOp(true); break;
      case 'undo': undo(); break;
      case 'nav': go(a.delta); break;
      case 'nav-to': index = a.where === 'first' ? 0 : Math.max(0, ids.length - 1); break;
      case 'zoom': stage?.zoomBy(a.dir); break;
      case 'zoom-reset': stage?.resetZoom(); break;
      case 'exit': onclose?.(id); break;
      default: return false;
    }
    return true;
  }

  const modeLabel = $derived(mode === 'crop' ? (purpose === 'bundle' ? '裁剪 Q → 加入 bundle' : '裁剪 W → 存 crop') : '分流');
</script>

<div class="triage" data-testid="triage">
  <header class="bar">
    <button type="button" onclick={() => onclose?.(id)} title="離開 Triage（Esc）">← 離開</button>
    <span class="mode" class:crop={mode === 'crop'} data-testid="triage-mode">{modeLabel}</span>
    <span class="name">{detail?.filename ?? ''}</span>
    {#if detail}<span class="muted">{detail.width}×{detail.height} · {formatBytes(detail.bytes)}</span>{/if}
    <span class="muted" data-testid="triage-pos">{ids.length ? `${at + 1} / ${ids.length}` : '0 / 0'}</span>
    <span class="muted src" title="來源查詢">來源：{sourceLabel}</span>
    {#if busy}<span class="muted">處理中…</span>{/if}
  </header>

  <div class="body">
    <section class="view">
      {#if id != null && detail && detail.id === id}
        <CropStage bind:this={stage} assetId={id} width={detail.width} height={detail.height} {mode} {ratio} wholeAllowed={purpose === 'bundle'} onnav={go} />
      {:else if !ids.length}
        <div class="empty" data-testid="triage-empty">
          <p>這個來源已經沒有照片了。</p>
          <button type="button" onclick={() => onclose?.(null)}>回到 grid</button>
        </div>
      {/if}
      {#if mode === 'crop'}
        <div class="ratios" role="group" aria-label="裁剪比例">
          {#each RATIOS as r, i (r.key)}
            <button type="button" class:on={ratio === r.key} onclick={() => (ratio = r.key)} title={`${i + 1}`}>{r.label}</button>
          {/each}
          <span class="muted">Enter 確認 · Esc 取消</span>
        </div>
      {/if}
    </section>

    <aside class="panel">
      <section data-testid="triage-bundle">
        <h4>目前 bundle</h4>
        {#if bundle}
          <p class="strong">{bundle.name}</p>
          <p class="muted">{bundle.item_count ?? 0} 項 · <kbd>G</kbd> 結束 · <kbd>Shift+G</kbd> 取消</p>
          {#if openBundles > 1}<p class="muted">另有 {openBundles - 1} 個未結束（用最近更新的）</p>{/if}
        {:else}
          <p class="muted">無（<kbd>Q</kbd> 會自動建立；<kbd>G</kbd> 開始新的）</p>
        {/if}
      </section>

      <section data-testid="triage-slots">
        <h4>快捷槽 <span class="muted">點一下設定</span></h4>
        <ol class="slots">
          {#each slots as s, i}
            <li>
              <button type="button" class="slot" class:on={slotActive(s, detail)} class:stale={s && s.name == null} onclick={() => editSlot(i)} data-slot={i + 1}>
                <kbd>{i + 1}</kbd>
                {#if s}
                  <span class="label">{s.kind === 'tag' ? (catalogIndex.tagPath(s.id) || s.name || `#${s.id}（已刪除）`) : (s.name ?? `#${s.id}（已刪除）`)}</span>
                  <span class="kind">{s.kind === 'tag' ? 'tag' : '相簿'}</span>
                {:else}
                  <span class="label muted">（未設定）</span>
                {/if}
              </button>
            </li>
          {/each}
        </ol>
      </section>

      {#if detail}
        <section>
          <h4>目前照片</h4>
          <p class="pills">
            {#each detail.tags as t (t.id)}<span class="pill">{catalogIndex.tagPath(t.id)}</span>{/each}
            {#each detail.albums as a (a)}<span class="pill">▣ {catalogIndex.albumById.get(a)?.name ?? `#${a}`}</span>{/each}
            {#if !detail.tags.length && !detail.albums.length}<span class="muted">未歸類</span>{/if}
          </p>
        </section>
      {/if}

      <section class="keys">
        <h4>按鍵</h4>
        <ul>
          <li><kbd>Q</kbd> 裁剪 → 加入 bundle</li>
          <li><kbd>W</kbd> 裁剪 → 存 crop</li>
          <li><kbd>E</kbd> 稍後處理（triage/later）</li>
          <li><kbd>R</kbd> 移入垃圾桶</li>
          <li><kbd>1</kbd>–<kbd>9</kbd> 快捷槽切換</li>
          <li><kbd>Z</kbd> 撤銷 · <kbd>S</kbd> 統計</li>
          <li><kbd>←</kbd><kbd>→</kbd>/<kbd>A</kbd><kbd>D</kbd> 換圖 · 圖外滾輪換圖</li>
          <li>圖上滾輪／<kbd>↑</kbd><kbd>↓</kbd> 縮放 · <kbd>0</kbd> 符合</li>
        </ul>
      </section>
    </aside>
  </div>

  {#if showStats}
    <div class="stats" role="dialog" aria-label="本次統計" data-testid="triage-stats">
      <h3>本次 Triage 統計</h3>
      <dl>
        <dt>處理張數</dt><dd>{processed.size}</dd>
        <dt>Q 加入 bundle</dt><dd>{stats.q}</dd>
        <dt>W 存裁剪</dt><dd>{stats.w}</dd>
        <dt>E 稍後處理</dt><dd>{stats.e}</dd>
        <dt>R 垃圾桶</dt><dd>{stats.r}</dd>
        <dt>快捷槽切換</dt><dd>{stats.slot}</dd>
        <dt>G 結束 / Shift+G 取消</dt><dd>{stats.g} / {stats.cancel}</dd>
        <dt>Z 撤銷</dt><dd>{stats.undo}</dd>
        <dt>來源剩餘</dt><dd>{ids.length}</dd>
      </dl>
      <p class="muted">S 或 Esc 關閉</p>
    </div>
  {/if}
</div>

{#if picker}
  <Picker {...picker} onclose={() => (picker = null)} />
{/if}

<style>
  .triage { position: fixed; inset: 0; z-index: 12; background: var(--loupe-bg); color: #ecece8; display: flex; flex-direction: column; }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 48px;
    padding: 0 12px;
    background: rgba(20, 20, 19, 0.95);
    border-bottom: 1px solid #2c2c2a;
    flex: none;
    min-width: 0;
  }
  .bar button, .panel button, .ratios button, .empty button { background: #2a2a28; border-color: #3a3a37; color: #ecece8; }
  .mode { padding: 2px 10px; border-radius: 999px; background: #2a2a28; font-size: 12px; white-space: nowrap; }
  .mode.crop { background: #1f5f50; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .muted { color: #9a9a94; white-space: nowrap; font-size: 12px; }
  .src { overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
  .body { flex: 1; min-height: 0; display: flex; }
  .view { flex: 1; position: relative; min-width: 0; }
  .panel {
    width: 280px;
    flex: none;
    overflow: auto;
    padding: 12px 14px;
    background: #1b1b1a;
    border-left: 1px solid #2c2c2a;
    font-size: 13px;
  }
  .panel section { margin-bottom: 16px; }
  h4 { margin: 0 0 6px; font-size: 12px; color: #9a9a94; font-weight: 600; display: flex; justify-content: space-between; }
  p { margin: 2px 0; }
  .strong { font-weight: 600; overflow-wrap: anywhere; }
  .slots { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
  .slot { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 3px 8px; }
  .slot.on { background: #1f5f50; border-color: #5fd0b5; }
  .slot.stale .label { color: #ff7a66; }
  .slot .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .slot .kind { color: #9a9a94; font-size: 11px; }
  .pills { display: flex; flex-wrap: wrap; gap: 4px; }
  .pill { padding: 1px 8px; border-radius: 999px; background: #2a2a28; font-size: 12px; }
  .keys ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; color: #c8c8c2; font-size: 12px; }
  kbd {
    display: inline-block;
    min-width: 18px;
    padding: 0 4px;
    border: 1px solid #4a4a46;
    border-bottom-width: 2px;
    border-radius: 4px;
    font: 11px/16px ui-monospace, monospace;
    text-align: center;
    color: #ecece8;
    background: #2a2a28;
  }
  .ratios {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 8px;
    background: rgba(20, 20, 19, 0.9);
  }
  .ratios button.on { background: #1f5f50; border-color: #5fd0b5; }
  .empty { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; gap: 10px; color: #9a9a94; }
  .stats {
    position: absolute;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    width: min(340px, calc(100% - 32px));
    padding: 14px 18px;
    border-radius: 10px;
    background: rgba(31, 31, 30, 0.97);
    border: 1px solid #3a3a37;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  }
  .stats h3 { margin: 0 0 10px; font-size: 15px; }
  .stats dl { margin: 0 0 8px; display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; }
  .stats dt { color: #9a9a94; }
  .stats dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
  @media (max-width: 760px) {
    .panel { display: none; }
    .src { display: none; }
  }
</style>
