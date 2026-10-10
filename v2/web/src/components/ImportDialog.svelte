<script>
  import { api, prefs } from '../lib/api.js';

  /** Import a local folder by absolute path (server reads it directly). */
  let { onclose, ondone } = $props();

  let path = $state(prefs.get('lastImportPath', ''));
  let recursive = $state(true);
  let job = $state(null);
  let error = $state('');
  let timer;

  const running = $derived(job?.state === 'running');

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

  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        job = await api.importStatus();
        if (job.state === 'running') poll();
        else if (job.state === 'done') ondone?.(job.result);
      } catch (e) {
        error = e.message;
      }
    }, 300);
  }

  $effect(() => () => clearTimeout(timer));

  const progress = $derived(job?.progress);
  const result = $derived(job?.result);
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && !running && onclose?.()}>
  <div class="dialog" role="dialog" aria-label="匯入照片" data-testid="import-dialog">
    <h2>匯入照片</h2>
    <p class="muted">輸入本機資料夾的完整路徑。照片會<strong>複製</strong>進照片庫（依內容 hash 去重），來源檔案不會被移動或刪除。</p>
    <label class="field">
      <span>資料夾路徑</span>
      <input type="text" bind:value={path} placeholder="D:\Screenshots" disabled={running}
        onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && path.trim() && !running) start(); }} />
    </label>
    <label class="check"><input type="checkbox" bind:checked={recursive} disabled={running} /> 包含子資料夾</label>

    {#if progress}
      <div class="progress">
        <div class="track"><div class="fill" style:width="{progress.total ? (progress.done / progress.total) * 100 : 100}%"></div></div>
        <span>{progress.done} / {progress.total}</span>
      </div>
    {/if}

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
    {#if job?.state === 'failed'}<p class="err">匯入失敗：{job.error}</p>{/if}
    {#if error}<p class="err">{error}</p>{/if}

    <div class="actions">
      <button type="button" onclick={() => onclose?.()} disabled={running}>{job?.state === 'done' ? '完成' : '取消'}</button>
      <button type="button" class="primary" onclick={start} disabled={running || !path.trim()}>
        {running ? '匯入中…' : '開始匯入'}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: grid; place-items: center; z-index: 20; padding: 16px; }
  .dialog {
    width: min(520px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 22px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  }
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
