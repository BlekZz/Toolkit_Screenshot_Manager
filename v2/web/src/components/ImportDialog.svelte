<script>
  import { api, prefs } from '../lib/api.js';

  /** Import a local folder by absolute path (server reads it directly). */
  let { onclose, ondone } = $props();

  let path = $state(prefs.get('lastImportPath', ''));
  let recursive = $state(true);
  let job = $state(null);
  let error = $state('');
  let timer;
  let dialog;
  let closeButton;
  let composing = false;
  let pollFailures = $state(0);

  // After this many consecutive failed status requests the dialog stops holding the page: the import
  // may still be running server-side, but the user can close the dialog and reopen it later.
  const MAX_POLL_FAILURES = 4;
  const running = $derived(job?.state === 'running');
  const statusLost = $derived(running && pollFailures >= MAX_POLL_FAILURES);
  // While locked the dialog cannot be dismissed.
  const locked = $derived(running && !statusLost);

  // Re-attach to an import already in progress (e.g. after a reload).
  api.importStatus().then((j) => { if (j.state === 'running') { job = j; poll(); } }).catch(() => {});

  async function start() {
    error = '';
    try {
      prefs.set('lastImportPath', path.trim());
      job = await api.startImport(path.trim(), recursive);
      poll();
    } catch (e) {
      error = e.message;
    }
  }

  // Failed status requests are retried with backoff (and keep retrying after the dialog unlocks),
  // so a transient error resumes normal progress once the server answers again.
  function poll() {
    clearTimeout(timer);
    const delay = pollFailures ? Math.min(300 * 2 ** pollFailures, 5000) : 300;
    timer = setTimeout(async () => {
      try {
        job = await api.importStatus();
        pollFailures = 0;
        if (job.state === 'running') poll();
        else if (job.state === 'done') ondone?.(job.result);
      } catch {
        pollFailures += 1;
        poll();
      }
    }, delay);
  }

  $effect(() => () => clearTimeout(timer));

  // Native modal: the browser makes the page inert, contains focus, handles Esc
  // and returns focus to the opener when the dialog closes.
  $effect(() => {
    if (!dialog.open) dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  });

  // No close requests while an import runs: closedby="none" covers Chrome/Firefox,
  // cancel + preventDefault covers browsers without closedby (Safari).
  function oncancel(e) {
    if (locked) e.preventDefault();
  }

  // Repeated Esc without user activation may skip `cancel`; never let the dialog go away mid-import.
  function handleClose() {
    if (locked && dialog.isConnected) dialog.showModal();
    else onclose?.();
  }

  // Click-outside dismissal, done on `click` rather than closedby="any"/pointerup: closing on pointerup
  // lets a touch tap's synthesized click land on the page underneath. Backdrop clicks target the dialog
  // itself, so check the position too (the dialog is also the target for its own padding); the press
  // must have started outside as well, so a text-selection drag ending on the backdrop does not close it.
  let pressedOutside = false;
  function outside(e) {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  }
  function onpointerdown(e) {
    pressedOutside = e.target === dialog && outside(e);
  }
  function onclick(e) {
    if (pressedOutside && e.target === dialog && outside(e) && !locked) dialog.close();
    pressedOutside = false;
  }

  // Controls are disabled while locked, which drops focus to <body>: keep it on the dialog itself,
  // then hand it to the way out once the dialog can be closed again.
  let wasLocked = false;
  $effect(() => {
    if (locked && !wasLocked) dialog.focus();
    else if (!locked && wasLocked) closeButton?.focus();
    wasLocked = locked;
  });

  // Enter also confirms an IME candidate; only a plain Enter starts the import.
  // keyCode 229 catches Safari, which delivers compositionend before the confirming keydown.
  function oninputkeydown(e) {
    e.stopPropagation();
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || composing) return;
    if (path.trim() && !running) start();
  }

  const progress = $derived(job?.progress);
  const result = $derived(job?.result);
</script>

<dialog
  bind:this={dialog}
  class="dialog"
  aria-labelledby="import-title"
  aria-describedby="import-desc"
  closedby={locked ? 'none' : 'closerequest'}
  tabindex="-1"
  data-testid="import-dialog"
  {oncancel}
  onclose={handleClose}
  {onpointerdown}
  {onclick}
>
  <h2 id="import-title">匯入照片</h2>
  <p id="import-desc" class="muted">輸入本機資料夾的完整路徑。照片會<strong>複製</strong>進照片庫（依內容 hash 去重），來源檔案不會被移動或刪除。</p>
  <label class="field">
    <span>資料夾路徑</span>
    <input type="text" bind:value={path} placeholder="D:\Screenshots" disabled={running}
      oncompositionstart={() => (composing = true)} oncompositionend={() => (composing = false)} onblur={() => (composing = false)}
      onkeydown={oninputkeydown} />
  </label>
  <label class="check"><input type="checkbox" bind:checked={recursive} disabled={running} /> 包含子資料夾</label>

  {#if progress}
    <div class="progress">
      <div class="track" role="progressbar" aria-label="匯入進度" aria-valuemin="0" aria-valuemax={progress.total}
        aria-valuenow={progress.done} aria-valuetext="{progress.done} / {progress.total}" data-testid="import-progress">
        <div class="fill" style:width="{progress.total ? (progress.done / progress.total) * 100 : 100}%"></div>
      </div>
      <span aria-hidden="true">{progress.done} / {progress.total}</span>
    </div>
  {/if}

  <!-- Stays mounted; announces only the start and the result, not every progress tick. -->
  <div role="status" data-testid="import-status">
    {#if running}<span class="sr-only">匯入中</span>{/if}
    {#if job?.state === 'done' && result}
      <ul class="summary" data-testid="import-summary">
        <li>掃描 <b>{result.scanned}</b> 個檔案</li>
        <li>新匯入 <b>{result.imported}</b> 張</li>
        <li>重複略過 <b>{result.duplicates}</b> 張</li>
        {#if result.unsupported.length}<li>不支援格式 <b>{result.unsupported.length}</b> 個（BMP／GIF／HEIC 等）</li>{/if}
        {#if result.errors.length}
          <li class="err">失敗 <b>{result.errors.length}</b> 個
            <ul>{#each result.errors.slice(0, 5) as e}<li>{e.file}：{e.error}</li>{/each}</ul>
          </li>
        {/if}
      </ul>
    {/if}
  </div>
  {#if job?.state === 'failed'}<p class="err" role="alert">匯入失敗：{job.error}</p>{/if}
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  {#if statusLost}
    <p class="err" role="alert" data-testid="import-status-lost">無法取得匯入進度，匯入可能仍在背景進行。可以先關閉此視窗，稍後再開啟「匯入」查看；仍會持續重試。</p>
  {/if}

  <div class="actions">
    <button type="button" bind:this={closeButton} onclick={() => dialog.close()} disabled={locked}>{job?.state === 'done' ? '完成' : statusLost ? '關閉' : '取消'}</button>
    <button type="button" class="primary" onclick={start} disabled={running || !path.trim()}>
      {running ? '匯入中…' : '開始匯入'}
    </button>
  </div>
</dialog>

<style>
  .dialog {
    width: min(520px, calc(100% - 32px));
    max-width: none;
    color: inherit;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 22px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  }
  /* Keep scroll gestures in the modal from reaching the page behind it. */
  .dialog:modal { overscroll-behavior: contain; }
  .dialog:focus { outline: none; }
  .dialog::backdrop { background: rgba(0, 0, 0, 0.45); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  h2 { margin: 0 0 8px; font-size: 18px; }
  .muted { color: var(--muted); margin: 0 0 16px; font-size: 13px; }
  .field { display: grid; gap: 6px; margin-bottom: 10px; }
  .field span { font-size: 13px; color: var(--muted); }
  .check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .progress { display: flex; align-items: center; gap: 10px; margin-top: 16px; font-size: 13px; }
  .track { flex: 1; height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }
  .fill { height: 100%; background: var(--accent); transition: width 0.2s; }
  .summary { margin: 16px 0 0; padding-left: 18px; font-size: 13px; }
  .err { color: var(--danger); overflow-wrap: anywhere; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
</style>
