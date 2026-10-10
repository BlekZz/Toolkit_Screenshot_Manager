<script>
  /** Right-click menu. items: [{label, action, danger?, disabled?} | 'sep'] */
  let { x, y, items, onclose } = $props();

  let menu = $state();
  let pos = $state({ left: -9999, top: -9999 }); // placed by the effect below once measured

  // Keep the menu inside the viewport.
  $effect(() => {
    if (!menu) return;
    const r = menu.getBoundingClientRect();
    pos = {
      left: Math.max(4, Math.min(x, innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, innerHeight - r.height - 4)),
    };
    menu.querySelector('button:not(:disabled)')?.focus();
  });

  function run(item) {
    onclose?.();
    item.action?.();
  }

  function onkeydown(e) {
    e.stopPropagation();
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); onclose?.(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
  }
</script>

<div class="catcher" role="presentation" onpointerdown={() => onclose?.()} oncontextmenu={(e) => { e.preventDefault(); onclose?.(); }}></div>
<div class="menu" role="menu" tabindex="-1" bind:this={menu} style:left="{pos.left}px" style:top="{pos.top}px" {onkeydown} data-testid="context-menu">
  {#each items as item}
    {#if item === 'sep'}
      <hr />
    {:else}
      <button type="button" role="menuitem" class:danger={item.danger} disabled={item.disabled} onclick={() => run(item)}>{item.label}</button>
    {/if}
  {/each}
</div>

<style>
  .catcher { position: fixed; inset: 0; z-index: 30; }
  .menu {
    position: fixed;
    z-index: 31;
    min-width: 170px;
    padding: 4px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
    outline: none;
  }
  button {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    border-radius: 5px;
    padding: 6px 10px;
  }
  button:hover:not(:disabled), button:focus-visible { background: var(--accent-soft); outline: none; }
  .danger { color: var(--danger); }
  hr { border: 0; border-top: 1px solid var(--border); margin: 4px 2px; }
</style>
