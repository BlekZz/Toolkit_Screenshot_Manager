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

  // The element that had focus when the menu opened (the right-clicked item); focus goes back there on close.
  const opener = document.activeElement;

  function close(fromPointer = false) {
    if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
      opener.focus({ preventScroll: true, focusVisible: !fromPointer });
    }
    onclose?.();
  }

  function run(item, e) {
    close(e.detail !== 0); // detail 0 = activated from the keyboard
    item.action?.();
  }

  function onkeydown(e) {
    e.stopPropagation();
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    // Tab leaves the menu: close it and return focus to the opener (grid cells are tabindex=-1,
    // so letting the default Tab continue from there can drop focus to the end of the document).
    if (e.key === 'Tab') { e.preventDefault(); close(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    if (e.key === 'Home') { e.preventDefault(); buttons[0]?.focus(); }
    if (e.key === 'End') { e.preventDefault(); buttons.at(-1)?.focus(); }
  }
</script>

<div class="catcher" role="presentation" onpointerdown={(e) => { e.preventDefault(); close(true); }} oncontextmenu={(e) => { e.preventDefault(); close(true); }}></div>
<div class="menu" role="menu" tabindex="-1" bind:this={menu} style:left="{pos.left}px" style:top="{pos.top}px" {onkeydown} data-testid="context-menu">
  {#each items as item}
    {#if item === 'sep'}
      <hr />
    {:else}
      <button type="button" role="menuitem" class:danger={item.danger} disabled={item.disabled} onclick={(e) => run(item, e)}>{item.label}</button>
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
