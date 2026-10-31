import crypto from 'node:crypto';
import http from 'node:http';
import sharp from 'sharp';
import { tx } from './db.mjs';
import { assetFilePath } from './library.mjs';
import { recordRun, suggestionWriter, tagIdByPath } from './suggestions.mjs';

export const DEFAULT_MODEL = 'qwen3-vl:4b';
const MAX_EDGE = 1280;

/**
 * Reads the current tag taxonomy that the VLM may suggest: every child of
 * purpose/ and context/, described children of custom/, and described
 * children of sensitive (user-made subtypes such as sensitive/Adult).
 * Undescribed custom tags are left out on purpose: the model cannot know what they mean.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function buildTaxonomy(db) {
  const children = (root, { describedOnly = false } = {}) => {
    const id = tagIdByPath(db, root);
    if (!id) return [];
    return db.prepare('SELECT id, name, description FROM tags WHERE parent_id = ? ORDER BY name').all(id)
      .filter((t) => !describedOnly || (t.description && t.description.trim()))
      .map((t) => ({ id: t.id, name: t.name, description: (t.description || '').trim() }));
  };
  return {
    purposes: children('purpose'),
    contexts: children('context'),
    customs: children('custom', { describedOnly: true }),
    sensitiveSubs: children('sensitive', { describedOnly: true }),
    sensitiveId: tagIdByPath(db, 'sensitive'),
  };
}

/**
 * Builds the prompt and JSON schema for one taxonomy. The hash covers both,
 * so editing a tag description yields a new prompt_hash (and a fresh run).
 */
export function buildPrompt(tax) {
  const list = (items) => items.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ''}`).join('\n');
  const prompt = [
    'You classify one phone screenshot by what its owner most likely wants to do with it.',
    'Answer with JSON only, following the schema.',
    '',
    'purpose (exactly one; "unsure" if you cannot tell):',
    list(tax.purposes),
    '',
    'context (one; "unknown" if you cannot tell):',
    list(tax.contexts),
    '',
    'sensitive: true if the image shows passwords, verification codes, account or card numbers, ID documents,',
    'addresses or phone numbers, private conversations, or adult content.',
    ...(tax.sensitiveSubs.length ? ['sensitive_kind (only when sensitive is true; empty otherwise):', list(tax.sensitiveSubs)] : []),
    ...(tax.customs.length ? ['', 'topics (zero or more that clearly apply):', list(tax.customs)] : []),
    '',
    'confidence: 0..1 for the purpose choice.',
    'reason: at most 20 words in Traditional Chinese. Never copy names, numbers, codes, or message text from the image.',
  ].join('\n');

  const properties = {
    purpose: { type: 'string', enum: [...tax.purposes.map((t) => t.name), 'unsure'] },
    context: { type: 'string', enum: [...tax.contexts.map((t) => t.name), 'unknown'] },
    sensitive: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  };
  const required = ['purpose', 'context', 'sensitive', 'confidence', 'reason'];
  if (tax.sensitiveSubs.length) properties.sensitive_kind = { type: 'array', items: { type: 'string', enum: tax.sensitiveSubs.map((t) => t.name) } };
  if (tax.customs.length) properties.topics = { type: 'array', items: { type: 'string', enum: tax.customs.map((t) => t.name) } };
  const schema = { type: 'object', properties, required };
  const promptHash = crypto.createHash('sha256').update(prompt).update(JSON.stringify(schema)).digest('hex').slice(0, 16);
  return { prompt, schema, promptHash };
}

/**
 * Validates a model answer against the taxonomy and converts it to suggestion items.
 *
 * @returns {{ok: true, items: {tagId: number, confidence: number, reason: string}[]} | {ok: false, error: string}}
 */
export function toSuggestionItems(tax, answer) {
  if (!answer || typeof answer !== 'object') return { ok: false, error: 'not an object' };
  const { purpose, context, sensitive, confidence, reason } = answer;
  const conf = Number(confidence);
  if (!(conf >= 0 && conf <= 1)) return { ok: false, error: `confidence out of range: ${confidence}` };
  if (typeof sensitive !== 'boolean') return { ok: false, error: 'sensitive not boolean' };
  const byName = (list, name) => list.find((t) => t.name === name);
  if (purpose !== 'unsure' && !byName(tax.purposes, purpose)) return { ok: false, error: `unknown purpose: ${purpose}` };
  if (context !== 'unknown' && !byName(tax.contexts, context)) return { ok: false, error: `unknown context: ${context}` };

  const items = [];
  const push = (t) => t && items.push({ tagId: t.id, confidence: conf, reason });
  if (purpose !== 'unsure') push(byName(tax.purposes, purpose));
  if (context !== 'unknown') push(byName(tax.contexts, context));
  if (sensitive) {
    items.push({ tagId: tax.sensitiveId, confidence: conf, reason });
    for (const k of Array.isArray(answer.sensitive_kind) ? answer.sensitive_kind : []) push(byName(tax.sensitiveSubs, k));
  }
  for (const k of Array.isArray(answer.topics) ? answer.topics : []) push(byName(tax.customs, k));
  return { ok: true, items };
}

/**
 * Calls Ollama /api/chat with one image and a JSON schema.
 * Uses node:http (no global fetch header timeout) with an explicit overall timeout.
 *
 * @returns {Promise<{answer: object, ms: number}>}
 */
export function ollamaClassify({ host = '127.0.0.1', port = 11434, model, prompt, schema, image, timeoutMs = 120000 }) {
  const t0 = Date.now();
  const body = JSON.stringify({
    model, stream: false, format: schema, think: false, keep_alive: '10m', options: { temperature: 0 },
    messages: [{ role: 'user', content: prompt, images: [image.toString('base64')] }],
  });
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: '/api/chat', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode !== 200) return reject(new Error(`ollama ${res.statusCode}: ${j.error || data.slice(0, 200)}`));
          resolve({ answer: JSON.parse(j.message?.content ?? ''), ms: Date.now() - t0 });
        } catch (err) {
          reject(new Error(`bad ollama response: ${err.message}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`timeout after ${timeoutMs}ms`), { code: 'TIMEOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Classifies assets with a local VLM and stores stage 'vlm' suggestions.
 * Resumable: assets with an ok run for (model, prompt_hash) are skipped.
 * Stops early ("paused") after `maxConsecutiveErrors` failures in a row —
 * typically the GPU is busy (a game) or Ollama is down.
 *
 * @param {ReturnType<import('./library.mjs').openLibrary>} lib
 * @param {{model?: string, assetIds?: number[]|null, limit?: number, timeoutMs?: number,
 *   maxConsecutiveErrors?: number, classify?: typeof ollamaClassify, onProgress?: (p: object) => void}} [opts]
 */
export async function runVlm(lib, {
  model = DEFAULT_MODEL, assetIds = null, limit = Infinity, timeoutMs = 120000, maxConsecutiveErrors = 3,
  classify = ollamaClassify, onProgress,
} = {}) {
  const { db } = lib;
  const tax = buildTaxonomy(db);
  const { prompt, schema, promptHash } = buildPrompt(tax);
  const done = new Set(db.prepare(`SELECT asset_id FROM suggestion_runs
    WHERE stage = 'vlm' AND model = ? AND prompt_hash = ? AND status = 'ok'`).all(model, promptHash).map((r) => r.asset_id));
  let targets = db.prepare("SELECT id, root_id, rel_path FROM assets WHERE status = 'active' ORDER BY id").all();
  if (assetIds) { const want = new Set(assetIds); targets = targets.filter((a) => want.has(a.id)); }
  targets = targets.filter((a) => !done.has(a.id)).slice(0, limit);

  const write = suggestionWriter(db, { stage: 'vlm', model, promptHash });
  const result = { model, promptHash, total: targets.length, ok: 0, errors: 0, inserted: 0, paused: null, ms: [] };
  let streak = 0;
  for (const asset of targets) {
    let status = 'ok';
    let detail = null;
    let ms = null;
    try {
      const image = await sharp(assetFilePath(lib, asset)).rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      const r = await classify({ model, prompt, schema, image, timeoutMs });
      ms = r.ms;
      const conv = toSuggestionItems(tax, r.answer);
      if (!conv.ok) { status = 'error'; detail = `schema: ${conv.error}`; }
      else tx(db, () => { result.inserted += write(asset.id, conv.items).inserted; });
    } catch (err) {
      status = 'error';
      detail = err.message.slice(0, 300);
    }
    recordRun(db, { assetId: asset.id, stage: 'vlm', model, promptHash, status, detail, ms });
    // Only transport failures (timeout, connection, HTTP) suggest a busy GPU or dead server; bad answers do not.
    const transport = status === 'error' && !detail.startsWith('schema:');
    if (status === 'ok') { result.ok++; if (ms != null) result.ms.push(ms); } else result.errors++;
    streak = transport ? streak + 1 : 0;
    onProgress?.({ done: result.ok + result.errors, total: result.total, ok: result.ok, errors: result.errors, last: { id: asset.id, status, detail, ms } });
    if (streak >= maxConsecutiveErrors) { result.paused = `stopped after ${streak} consecutive errors (last: ${detail})`; break; }
  }
  return result;
}
