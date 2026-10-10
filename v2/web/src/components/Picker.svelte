<script>
  /**
   * Searchable picker for applying a tag / album to the selection.
   * items: [{id, label, color?, hint?}]. Enter picks the highlighted item, or
   * creates a new one when the text matches nothing exactly (if allowCreate).
   */
  let { title, items, allowCreate = true, createLabel = '建立', subtitle = '', onpick, oncreate, onclose } = $props();

  let text = $state('');
  let active = $state(0);
  let input = $state();
  let list = $state();

  $effect(() => { input?.focus(); });

  const needle = $derived(text.trim().toLowerCase());
  const matches = $derived(needle ? items.filter((it) => it.label.toLowerCase().includes(needle)) : items);
  const exact = $derived(items.some((it) => it.label.toLowerCase() === needle));
  const canCreate = $derived(allowCreate && needle && !exact);
  const total = $derived(matches.length + (canCreate ? 1 : 0));

  $effect(() => { needle; active = 0; });
  $effect(() => { list?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); });

  function choose(i) {
    if (i < matches.length) onpick?.(matches[i].id);
    else if (canCreate) oncreate?.(text.trim());
  }

  function onkeydown(e) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onclose?.(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = total ? (active + 1) % total : 0; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = total ? (active - 1 + total) % total : 0; }
    else if (e.key === 'Enter') { e.preventDefault(); if (total) choose(active); }
  }
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose?.()}>
  <div class="picker" role="dialog" aria-label={title} tabindex="-1" {onkeydown} data-testid="picker">
    <header>
      <h2>{title}</h2>
      {#if subtitle}<span>{subtitle}</span>{/if}
    </header>
    <input type="text" bind:this={input} bind:value={text} placeholder={allowCreate ? '搜尋或輸入新名稱…' : '搜尋…'} />
    <ul bind:this={list}>
      {#each matches as it, i (it.id)}
        <li>
          <button type="button" data-index={i} class:active={i === active} onclick={() => choose(i)} onpointermove={() => (active = i)}>
            {#if it.color}<i class="dot" style:background={it.color}></i>{/if}
            <span class="label">{it.label}</span>
            {#if it.hint}<span class="hint">{it.hint}</span>{/if}
          </button>
        </li>
      {/each}
      {#if canCreate}
        <li>
          <button type="button" data-index={matches.length} class:active={active === matches.length} class="create"
            onclick={() => choose(matches.length)} onpointermove={() => (active = matches.length)}>
            ＋ {createLabel}「{text.trim()}」
          </button>
        </li>
      {/if}
      {#if !total}<li class="none">沒有符合的項目</li>{/if}
    </ul>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: grid; place-items: start center; padding: 12vh 16px 16px; z-index: 35; }
  .picker {
    width: min(420px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    outline: none;
  }
  header { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px 8px; }
  h2 { margin: 0; font-size: 15px; }
  header span { color: var(--muted); font-size: 12px; }
  input { width: calc(100% - 32px); margin: 0 16px 8px; }
  ul { list-style: none; margin: 0; padding: 0 6px 6px; max-height: 50vh; overflow: auto; }
  li button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    border-radius: 6px;
    padding: 7px 10px;
  }
  li button.active { background: var(--accent-soft); }
  .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint { color: var(--muted); font-size: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .create { color: var(--accent); }
  .none { padding: 8px 10px; color: var(--muted); font-size: 13px; }
</style>
