/**
 * S1 OCR into the photo library (Sprint_Screenshot_AI_Triage §3): batches asset
 * originals through the legacy Windows OCR script (`extract-ocr.ps1`, manifest in,
 * JSON array out, 2× upscaling inside the script), stores `ocr_results` +
 * `text_fts`, and tags low-yield images `ocr/low-yield` (source 'ocr').
 * Resumable via `suggestion_runs` (stage 'ocr'): assets with an ok run are skipped.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent, now, tx } from './db.mjs';
import { assetFilePath } from './library.mjs';
import { recordRun, tagIdByPath } from './suggestions.mjs';

export const OCR_ENGINE = 'windows-ocr';
export const OCR_LANG = 'zh-Hant-TW';
export const LOW_YIELD_CHARS = 5; // same threshold as the legacy extract.mjs
export const OCR_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extract-ocr.ps1');

/**
 * Conservative fixes for recurring Windows OCR mistakes.
 * Copied verbatim from the legacy tool `extract.mjs` cleanText() (repo root, 2026-11-01);
 * keep the two in sync if either changes.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function cleanText(raw) {
  return (
    String(raw || '')
      .replace(/(?<=[A-Z])l(?=[A-Z])/g, 'I')
      .replace(/(?<=[A-Za-z])0(?=[a-z])/g, 'o')
      .replace(/(?<=[A-Za-z0-9])[ \t]?[一—][ \t]?(?=[\d(（])/gu, '-')
      .replace(/(?<=\d)[ \t]?·[ \t]?(?=\d)/g, '.')
      .replace(/(?<=\d)[ \t]?,[ \t]?(?=\d{3}(?!\d))/g, ',')
      .replace(/丶/g, '、')
      .replace(/(?<=\p{Script=Han})[ \t]?,[ \t]?(?=\p{Script=Han})/gu, '，')
      .replace(/(?<=\p{Script=Han})[ \t]?,(?=[ \t]*(?:\n|$))/gu, '，')
      .replace(/\([ \t]?(?=\p{Script=Han})/gu, '（')
      .replace(/(?<=\p{Script=Han})[ \t]?\)/gu, '）')
      .replace(/[ \t]*([，。、；：！？「」『』（）《》…])[ \t]*/gu, '$1')
      .replace(/\([ \t]+/g, '(')
      .replace(/[ \t]+\)/g, ')')
      .replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '')
      .trim()
  );
}

/** Character count used for the low-yield threshold: code points of the cleaned text. */
export const charCount = (text) => [...text].length;

/**
 * Default runner: Windows PowerShell 5.1 (`powershell.exe`, required for WinRT) on a manifest.
 *
 * @param {string[]} files Absolute paths.
 * @returns {Promise<{path: string, text?: string, error?: string}[]>}
 */
export async function powershellOcr(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plv2-ocr-'));
  const manifest = path.join(tmp, 'manifest.txt');
  fs.writeFileSync(manifest, `${files.join('\r\n')}\r\n`, 'utf8');
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, '-ManifestPath', manifest, '-LangTag', OCR_LANG],
        { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`extract-ocr.ps1 exited ${code}: ${err.trim().slice(0, 300)}`))));
    });
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Active assets without a successful OCR run, oldest id first. */
export function pendingOcr(db) {
  return db.prepare(`SELECT a.* FROM assets a WHERE a.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM suggestion_runs r WHERE r.asset_id = a.id AND r.stage = 'ocr' AND r.model = ? AND r.prompt_hash = '' AND r.status = 'ok')
    ORDER BY a.id`).all(OCR_ENGINE);
}

/**
 * OCRs pending assets in batches. A failing batch (script crash, bad JSON) marks
 * every asset in it as error and moves on; per-file errors are recorded per asset.
 *
 * @param {ReturnType<import('./library.mjs').openLibrary>} lib
 * @param {{runner?: (files: string[]) => Promise<{path: string, text?: string, error?: string}[]>,
 *   batchSize?: number, limit?: number, dryRun?: boolean, onBatch?: (s: object) => void}} [opts]
 * @returns {Promise<{pending: number, processed: number, ok: number, lowYield: number,
 *   errors: {asset_id: number, error: string}[], batches: number, failedBatches: number}>}
 */
export async function runOcr(lib, { runner = powershellOcr, batchSize = 50, limit = Infinity, dryRun = false, onBatch } = {}) {
  const { db } = lib;
  const lowYieldTag = tagIdByPath(db, 'ocr/low-yield');
  if (!lowYieldTag) throw new Error('missing tag ocr/low-yield (migration 002 not applied?)');
  const pending = pendingOcr(db);
  const todo = pending.slice(0, limit);
  const out = { pending: pending.length, processed: 0, ok: 0, lowYield: 0, errors: [], batches: 0, failedBatches: 0 };
  if (dryRun) return { ...out, processed: todo.length };

  const oldIds = db.prepare('SELECT id FROM ocr_results WHERE asset_id = ? AND engine = ? AND crop_id IS NULL');
  const delFts = db.prepare("DELETE FROM text_fts WHERE kind = 'ocr' AND ref_id = ?");
  const delOcr = db.prepare('DELETE FROM ocr_results WHERE id = ?');
  const insOcr = db.prepare(`INSERT INTO ocr_results (asset_id, crop_id, engine, lang, raw_text, cleaned_text, char_count, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`);
  const insFts = db.prepare("INSERT INTO text_fts (body, kind, ref_id) VALUES (?, 'ocr', ?)");
  const dropLow = db.prepare("DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = ? AND source = 'ocr'");
  const addLow = db.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, source, added_at) VALUES (?, ?, 'ocr', ?)");

  const fail = (asset, error, ms = null) => {
    out.errors.push({ asset_id: asset.id, error });
    recordRun(db, { assetId: asset.id, stage: 'ocr', model: OCR_ENGINE, status: 'error', detail: error.slice(0, 300), ms });
  };

  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    out.batches++;
    const files = new Map();
    for (const a of batch) {
      const file = assetFilePath(lib, a);
      if (fs.existsSync(file)) files.set(file, a);
      else fail(a, 'original file missing');
    }
    if (!files.size) continue;
    const t0 = Date.now();
    let results;
    try {
      results = await runner([...files.keys()]);
      if (!Array.isArray(results)) throw new Error('OCR runner returned a non-array');
    } catch (err) {
      out.failedBatches++;
      tx(db, () => { for (const a of files.values()) fail(a, `batch failed: ${err.message || err}`); });
      onBatch?.({ ...out });
      continue;
    }
    const ms = Math.round((Date.now() - t0) / files.size);
    const byPath = new Map(results.filter((r) => r && typeof r.path === 'string').map((r) => [r.path, r]));
    tx(db, () => {
      const ts = now();
      for (const [file, a] of files) {
        out.processed++;
        const r = byPath.get(file);
        if (!r) { fail(a, 'no result for file', ms); continue; }
        if (r.error != null || typeof r.text !== 'string') { fail(a, String(r.error ?? 'missing text'), ms); continue; }
        const cleaned = cleanText(r.text);
        const n = charCount(cleaned);
        for (const { id } of oldIds.all(a.id, OCR_ENGINE)) { delFts.run(id); delOcr.run(id); }
        const ocrId = Number(insOcr.run(a.id, OCR_ENGINE, OCR_LANG, r.text, cleaned, n, ts).lastInsertRowid);
        if (cleaned) insFts.run(cleaned, ocrId);
        dropLow.run(a.id, lowYieldTag);
        if (n < LOW_YIELD_CHARS) { addLow.run(a.id, lowYieldTag, ts); out.lowYield++; }
        recordRun(db, { assetId: a.id, stage: 'ocr', model: OCR_ENGINE, status: 'ok', ms });
        out.ok++;
      }
      logEvent(db, 'ocr.batch', { engine: OCR_ENGINE, files: files.size });
    });
    onBatch?.({ ...out });
  }
  return out;
}
