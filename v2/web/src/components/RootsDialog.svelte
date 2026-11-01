<script>
  import { onDestroy } from 'svelte';
  import { api } from '../lib/api.js';

  /**
   * Settings → 原地引用 roots (P2, simple version): list roots, add a
   * referenced folder, scan it (background job, polled). Scanning only reads
   * the folder: new files are added, moved files relinked by hash, vanished
   * ones marked missing — nothing is moved or deleted.
   */
  let { onclose, ondone } = $props();

  let roots = $state([]);
  let path = $state('');
  let job = $state(null);
  let error = $state('');
  let timer;

  async function load() {
    try {
      roots = (await api.roots()).roots;
      job = await api.scanStatus();
      if (job?.state === 'running') poll();
    } catch (e) { error = e.message; }
  }
  load();

  async function add() {
    error = '';
    if (!path.trim()) return;
    try {
      await api.addRoot(path.trim());
      path = '';
      await load();
    } catch (e) { error = e.message; }
  }

  async function scan(id, dryRun) {
    error = '';
    try {
      job = await api.scanRoot(id, dryRun);
      poll();
    } catch (e) { error = e.message; }
  }

  function poll() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        job = await api.scanStatus();
        if (job.state === 'running') poll();
        else { await load(); if (job.state === 'done' && !job.dry_run) ondone?.(); }
      } catch (e) { error = e.message; }
    }, 500);
  }
  onDestroy(() => clearTimeout(timer));

  function onkeydown(e) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onclose?.(); }
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) { e.preventDefault(); add(); }
  }

  const summary = (r) => r ? Object.entries(r).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}: ${v}`).join(' · ') : '';
</script>

<div class="backdrop" role="presentation" onclick={(e) => e.target === e.currentTarget && onclose?.()}>
  <div class="dialog" role="dialog" aria-label="照片來源" tabindex="-1" {onkeydown} data-testid="roots">
    <h2>照片來源（原地引用）</h2>
    <p class="muted">原地引用的資料夾不會被複製；掃描時新增新檔、依 hash 重新連結搬動過的檔、找不到的標記為遺失。不會移動或刪除任何檔案。</p>
    <ul>
      {#each roots as r (r.id)}
        <li>
          <span class="path" title={r.abs_path ?? r.path}>{r.abs_path ?? r.path}</span>
          <span class="muted">{r.mode === 'referenced' ? '原地引用' : '受管理'} · {r.counts?.active ?? 0} 張{r.counts?.missing ? ` · 遺失 ${r.counts.missing}` : ''}</span>
          {#if r.mode === 'referenced'}
            <button type="button" disabled={job?.state === 'running'} onclick={() => scan(r.id, true)}>試掃</button>
            <button type="button" class="primary" disabled={job?.state === 'running'} onclick={() => scan(r.id, false)}>掃描</button>
          {/if}
        </li>
      {:else}<li class="muted">尚無來源</li>{/each}
    </ul>
    <label class="field">
      <span>新增原地引用資料夾（完整路徑）</span>
      <input type="text" bind:value={path} placeholder="D:\Screenshots" />
    </label>
    {#if job && job.state !== 'idle'}
      <p class="job" data-testid="scan-job">
        掃描 #{job.root_id}{job.dry_run ? '（試掃）' : ''}：{job.state === 'running' ? '進行中…' : job.state === 'done' ? '完成' : `失敗：${job.error}`}
        {#if job.progress}<br /><span class="muted">{summary(job.progress)}</span>{/if}
        {#if job.result}<br /><span class="muted">{summary(job.result)}</span>{/if}
      </p>
    {/if}
    {#if error}<p class="err">{error}</p>{/if}
    <div class="actions">
      <button type="button" onclick={() => onclose?.()}>關閉</button>
      <button type="button" class="primary" onclick={add} disabled={!path.trim()}>新增來源</button>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: grid; place-items: center; z-index: 40; padding: 16px; }
  .dialog {
    width: min(620px, 100%);
    max-height: 90vh;
    overflow: auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    outline: none;
  }
  h2 { margin: 0 0 6px; font-size: 16px; }
  .muted { color: var(--muted); font-size: 12px; }
  ul { list-style: none; margin: 12px 0; padding: 0; display: grid; gap: 6px; }
  li { display: flex; align-items: center; gap: 8px; }
  .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px ui-monospace, monospace; }
  .field { display: grid; gap: 6px; }
  .field span { font-size: 13px; color: var(--muted); }
  .job { font-size: 13px; overflow-wrap: anywhere; }
  .err { color: var(--danger); font-size: 13px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
</style>
