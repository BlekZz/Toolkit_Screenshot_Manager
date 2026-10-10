<script>
  import { untrack } from 'svelte';
  /**
   * Modal text prompt / confirm (replaces window.prompt/confirm, which block
   * the page). Enter submits, Esc cancels.
   */
  const COLORS = ['#2f6fde', '#2f9e44', '#c2412d', '#b7791f', '#8b5cf6', '#d6336c', '#0c8599', '#6b6b66'];

  let {
    title,
    message = '',
    label = '',
    value = '',
    withColor = false,
    color = null,
    confirmOnly = false,
    danger = false,
    submitLabel = '確定',
    onsubmit,
    oncancel,
  } = $props();

  let text = $state(untrack(() => value)); // initial value only; the prompt owns it afterwards
  let chosen = $state(untrack(() => color));
  let input = $state();
  let submitBtn = $state();

  $effect(() => {
    if (confirmOnly) submitBtn?.focus();
    else { input?.focus(); input?.select(); }
  });

  function submit() {
    if (!confirmOnly && !text.trim()) return;
    onsubmit?.(confirmOnly ? true : text.trim(), chosen);
  }

  function onkeydown(e) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); oncancel?.(); }
  }
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && oncancel?.()}>
  <div class="dialog" role="dialog" aria-label={title} tabindex="-1" {onkeydown} data-testid="prompt">
    <h2>{title}</h2>
    {#if message}<p class="msg">{message}</p>{/if}
    {#if !confirmOnly}
      <label class="field">
        {#if label}<span>{label}</span>{/if}
        <input type="text" bind:this={input} bind:value={text} />
      </label>
    {/if}
    {#if withColor}
      <div class="colors" role="radiogroup" aria-label="顏色">
        <button type="button" class="swatch none" class:on={!chosen} onclick={() => (chosen = null)} aria-label="無顏色"></button>
        {#each COLORS as c}
          <button type="button" class="swatch" class:on={chosen === c} style:background={c} onclick={() => (chosen = c)} aria-label={c}></button>
        {/each}
      </div>
    {/if}
    <div class="actions">
      <button type="button" onclick={() => oncancel?.()}>取消</button>
      <button type="button" class={danger ? 'danger' : 'primary'} onclick={submit} bind:this={submitBtn}>
        {submitLabel}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: grid; place-items: center; z-index: 40; padding: 16px; }
  .dialog {
    width: min(400px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    outline: none;
  }
  h2 { margin: 0 0 10px; font-size: 16px; }
  .msg { margin: 0 0 12px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .field { display: grid; gap: 6px; }
  .field span { font-size: 13px; color: var(--muted); }
  .colors { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
  .swatch { width: 22px; height: 22px; padding: 0; border-radius: 50%; border: 2px solid transparent; }
  .swatch.on { border-color: var(--text); }
  .swatch.none { background: linear-gradient(135deg, transparent 45%, var(--danger) 45% 55%, transparent 55%), var(--surface-2); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .danger { background: var(--danger); border-color: var(--danger); color: #fff; }
</style>
