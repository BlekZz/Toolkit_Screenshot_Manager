import { tagIdByPath } from './suggestions.mjs';

/**
 * Compares two suggestion sources asset by asset, over assets that both sources covered.
 * Per source and asset: purpose = highest-confidence purpose/* suggestion (or none),
 * context = highest-confidence context/* suggestion (or none), sensitive = has a sensitive suggestion.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{a: {stage?: string, model?: string}, b: {stage?: string, model?: string}}} sources
 */
export function compareSources(db, { a, b }) {
  const purposeRoot = tagIdByPath(db, 'purpose');
  const contextRoot = tagIdByPath(db, 'context');
  const sensitiveRoot = tagIdByPath(db, 'sensitive');
  const load = ({ stage = null, model = null }) => {
    const rows = db.prepare(`SELECT s.asset_id, s.confidence, t.id AS tag_id, t.name, t.parent_id
      FROM asset_suggestions s JOIN tags t ON t.id = s.tag_id
      WHERE (? IS NULL OR s.stage = ?) AND (? IS NULL OR s.model = ?)
      ORDER BY s.asset_id, s.confidence DESC, s.id`).all(stage, stage, model, model);
    const covered = new Set(db.prepare(`SELECT DISTINCT asset_id FROM suggestion_runs WHERE status = 'ok'
      AND (? IS NULL OR stage = ?) AND (? IS NULL OR model = ?)`).all(stage, stage, model, model).map((r) => r.asset_id));
    const per = new Map();
    for (const r of rows) {
      covered.add(r.asset_id);
      const e = per.get(r.asset_id) ?? { purpose: null, context: null, sensitive: false };
      if (r.parent_id === purposeRoot && !e.purpose) e.purpose = r.name;
      if (r.parent_id === contextRoot && !e.context) e.context = r.name;
      if (r.tag_id === sensitiveRoot) e.sensitive = true;
      per.set(r.asset_id, e);
    }
    return { covered, get: (id) => per.get(id) ?? { purpose: null, context: null, sensitive: false } };
  };
  const A = load(a);
  const B = load(b);
  const both = [...A.covered].filter((id) => B.covered.has(id));

  const out = { assets: both.length, purposeAgree: 0, contextAgree: 0, sensitive: { bothTrue: 0, onlyA: 0, onlyB: 0, bothFalse: 0 }, purposePairs: {} };
  for (const id of both) {
    const x = A.get(id);
    const y = B.get(id);
    if (x.purpose === y.purpose) out.purposeAgree++;
    else { const k = `${y.purpose ?? '-'}→${x.purpose ?? '-'}`; out.purposePairs[k] = (out.purposePairs[k] || 0) + 1; }
    if (x.context === y.context) out.contextAgree++;
    out.sensitive[x.sensitive && y.sensitive ? 'bothTrue' : x.sensitive ? 'onlyA' : y.sensitive ? 'onlyB' : 'bothFalse']++;
  }
  out.purposePairs = Object.fromEntries(Object.entries(out.purposePairs).sort((p, q) => q[1] - p[1]));
  return out;
}
