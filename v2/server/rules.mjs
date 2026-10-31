/**
 * S1 rule engine (Sprint_Screenshot_AI_Triage §3, Paperless-ngx style matchers):
 * `tag_matchers` rows are checked against an asset's OCR text, filename and
 * dimensions; every hit becomes a stage 'rule' suggestion.
 *
 * Privacy: the reason is only 「命中規則「<rule name>」」 — never the matched text.
 *
 * Re-runs: the run key (suggestion_runs.prompt_hash) is a hash of the enabled rule
 * set, so editing rules re-evaluates every asset; an asset is also re-evaluated when
 * its OCR result is newer than its last rule run. Pending rule suggestions whose
 * tag no longer hits become 'superseded'; a later hit revives them to 'pending'.
 */
import { createHash } from 'node:crypto';
import { logEvent, now, tx } from './db.mjs';
import { recordRun, suggestionWriter } from './suggestions.mjs';

export const RULE_MODEL = 'rules';
export const KINDS = ['any', 'all', 'regex', 'filename', 'dimension'];
const DIM_RE = /^(w|h|ratio)(>=|<=|>|<|=)(\d+(?:\.\d+)?)$/;

const splitTerms = (pattern) => String(pattern).split(/[,、，\n]/).map((s) => s.trim()).filter(Boolean);
/** Lowercase, whitespace removed: OCR often inserts or drops spaces inside words. */
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');

/**
 * Builds a predicate for one matcher row; throws on an invalid pattern.
 *
 * @param {{kind: string, pattern: string}} m
 * @returns {(ctx: {text: string, filename: string, width: number, height: number}) => boolean}
 */
export function compileMatcher(m) {
  switch (m.kind) {
    case 'any':
    case 'all': {
      const terms = splitTerms(m.pattern).map(norm);
      if (!terms.length) throw new Error('no terms');
      return m.kind === 'any'
        ? (c) => { const t = norm(c.text); return terms.some((x) => t.includes(x)); }
        : (c) => { const t = norm(c.text); return terms.every((x) => t.includes(x)); };
    }
    case 'regex': {
      const re = new RegExp(m.pattern, 'iu');
      return (c) => re.test(c.text ?? '');
    }
    case 'filename': {
      const re = new RegExp(m.pattern, 'iu');
      return (c) => re.test(c.filename ?? '');
    }
    case 'dimension': {
      const conds = String(m.pattern).split(',').map((s) => s.replace(/\s+/g, '')).filter(Boolean).map((s) => {
        const x = DIM_RE.exec(s);
        if (!x) throw new Error(`bad dimension condition: ${s}`);
        return { key: x[1], cmp: x[2], value: Number(x[3]) };
      });
      if (!conds.length) throw new Error('no conditions');
      const ops = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b, '=': (a, b) => a === b };
      return (c) => conds.every(({ key, cmp, value }) => {
        const v = key === 'w' ? c.width : key === 'h' ? c.height : c.height / c.width; // ratio = h / w
        return Number.isFinite(v) && ops[cmp](v, value);
      });
    }
    default:
      throw new Error(`unknown kind: ${m.kind}`);
  }
}

/** Enabled matchers, compiled; invalid ones are reported instead of crashing the run. */
export function loadMatchers(db) {
  const rows = db.prepare('SELECT * FROM tag_matchers WHERE enabled = 1 ORDER BY id').all();
  const ok = [];
  const invalid = [];
  for (const r of rows) {
    try { ok.push({ ...r, test: compileMatcher(r) }); } catch (err) { invalid.push({ id: r.id, name: r.name, error: err.message }); }
  }
  const hash = createHash('sha256')
    .update(JSON.stringify(ok.map((r) => [r.id, r.tag_id, r.name, r.kind, r.pattern, r.confidence])))
    .digest('hex').slice(0, 16);
  return { matchers: ok, invalid, hash };
}

/**
 * Evaluates matchers for one asset context. Per tag, the highest-confidence hit wins.
 *
 * @returns {Map<number, {confidence: number, rule: string}>} tag id → best hit
 */
export function evaluateRules(matchers, ctx) {
  const hits = new Map();
  for (const m of matchers) {
    if (!m.test(ctx)) continue;
    const prev = hits.get(m.tag_id);
    if (!prev || m.confidence > prev.confidence) hits.set(m.tag_id, { confidence: m.confidence, rule: m.name });
  }
  return hits;
}

/** Reason text: rule name only, never the matched OCR string. */
export const ruleReason = (ruleName) => `命中規則「${ruleName}」`;

/**
 * Runs the rule engine over active assets that need (re-)evaluation.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{dryRun?: boolean, limit?: number, all?: boolean}} [opts] `all` re-evaluates every active asset.
 * @returns {{rulesHash: string, rules: number, invalid: object[], evaluated: number, hitAssets: number,
 *   inserted: number, skipped: number, revived: number, superseded: number}}
 */
export function runRules(db, { dryRun = false, limit = Infinity, all = false } = {}) {
  const { matchers, invalid, hash } = loadMatchers(db);
  // The latest rule run per asset decides: a different rule-set hash (including a return to an
  // older rule set) or OCR newer than that run ⇒ re-evaluate.
  const assets = db.prepare(`SELECT a.id, a.filename, a.width, a.height, r.prompt_hash AS ran_hash, r.created_at AS ran_at,
      (SELECT MAX(o.created_at) FROM ocr_results o WHERE o.asset_id = a.id AND o.crop_id IS NULL) AS ocr_at
    FROM assets a LEFT JOIN suggestion_runs r ON r.id = (SELECT r2.id FROM suggestion_runs r2 WHERE r2.asset_id = a.id
      AND r2.stage = 'rule' AND r2.model = ? AND r2.status = 'ok' ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1)
    WHERE a.status = 'active' ORDER BY a.id`).all(RULE_MODEL);
  const todo = assets.filter((a) => all || a.ran_hash !== hash || (a.ocr_at && a.ocr_at > a.ran_at)).slice(0, limit);

  const ocrText = db.prepare(`SELECT cleaned_text FROM ocr_results WHERE asset_id = ? AND crop_id IS NULL
    ORDER BY created_at DESC, id DESC LIMIT 1`);
  const pendingRule = db.prepare(`SELECT id, tag_id, status FROM asset_suggestions
    WHERE asset_id = ? AND stage = 'rule' AND model = ? AND prompt_hash = ''`);
  const setStatus = db.prepare('UPDATE asset_suggestions SET status = ?, decided_at = ? WHERE id = ?');
  const write = suggestionWriter(db, { stage: 'rule', model: RULE_MODEL });
  const out = { rulesHash: hash, rules: matchers.length, invalid, evaluated: 0, hitAssets: 0, inserted: 0, skipped: 0, revived: 0, superseded: 0 };

  const DRY = Symbol('dry-run');
  try {
    tx(db, () => {
      const ts = now();
      for (const a of todo) {
        const t0 = Date.now();
        const hits = evaluateRules(matchers, { text: ocrText.get(a.id)?.cleaned_text ?? '', filename: a.filename, width: a.width, height: a.height });
        // Existing rule suggestions: revive re-hit superseded ones, supersede pending ones no longer hit.
        for (const s of pendingRule.all(a.id, RULE_MODEL)) {
          if (hits.has(s.tag_id) && s.status === 'superseded') { setStatus.run('pending', null, s.id); out.revived++; }
          else if (!hits.has(s.tag_id) && s.status === 'pending') { setStatus.run('superseded', ts, s.id); out.superseded++; }
        }
        const r = write(a.id, [...hits].map(([tagId, h]) => ({ tagId, confidence: h.confidence, reason: ruleReason(h.rule) })));
        out.inserted += r.inserted;
        out.skipped += r.skipped;
        if (hits.size) out.hitAssets++;
        out.evaluated++;
        recordRun(db, { assetId: a.id, stage: 'rule', model: RULE_MODEL, promptHash: hash, status: 'ok', ms: Date.now() - t0 });
      }
      logEvent(db, 'rules.run', { rules_hash: hash, evaluated: out.evaluated, inserted: out.inserted, superseded: out.superseded });
      if (dryRun) throw DRY;
    });
  } catch (err) {
    if (err !== DRY) throw err;
  }
  return out;
}
