// AI triage cheap layer (Sprint_Screenshot_AI_Triage A1): local, no GPU.
//   node cli/cheap.mjs <dup|ocr|rules|all> [--library <dir>] [--dry-run] [--limit N]
//     dup:   [--max-distance 4]
//     ocr:   [--batch-size 50] [--ocr-runner <module.mjs>]  (default: powershell.exe extract-ocr.ps1)
//     rules: [--all]  re-evaluate every asset, not only new / re-OCR'd / rule-set changed
// `all` runs dup → ocr → rules. Prints a JSON summary; exits 1 when any error occurred.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { detectDuplicates } from '../server/dhash.mjs';
import { openLibrary, resolveLibraryDir } from '../server/library.mjs';
import { runOcr } from '../server/ocr.mjs';
import { runRules } from '../server/rules.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    library: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    limit: { type: 'string' },
    'max-distance': { type: 'string', default: '4' },
    'batch-size': { type: 'string', default: '50' },
    'ocr-runner': { type: 'string' },
    all: { type: 'boolean', default: false },
  },
});

const [cmd] = positionals;
if (!['dup', 'ocr', 'rules', 'all'].includes(cmd)) {
  console.error('Usage: node cli/cheap.mjs <dup|ocr|rules|all> [--library <dir>] [--dry-run] [--limit N]');
  process.exit(2);
}
const int = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) { console.error(`--${name} must be a non-negative integer`); process.exit(2); }
  return n;
};
const limit = values.limit == null ? Infinity : int(values.limit, 'limit');
const dryRun = values['dry-run'];

let runner;
if (values['ocr-runner']) runner = (await import(pathToFileURL(path.resolve(values['ocr-runner'])).href)).default;

const lib = openLibrary(resolveLibraryDir(values.library));
const summary = { dryRun };
let errors = 0;
try {
  if (cmd === 'dup' || cmd === 'all') {
    const r = await detectDuplicates(lib.db, lib, { maxDistance: int(values['max-distance'], 'max-distance'), dryRun, limit });
    summary.dup = { ...r, errors: r.errors.slice(0, 20), errorCount: r.errors.length };
    errors += r.errors.length;
  }
  if (cmd === 'ocr' || cmd === 'all') {
    const r = await runOcr(lib, {
      ...(runner ? { runner } : {}), batchSize: Math.max(1, int(values['batch-size'], 'batch-size')), limit, dryRun,
      onBatch: (s) => console.error(`ocr: ${s.processed}/${Math.min(s.pending, limit)} ok=${s.ok} err=${s.errors.length}`),
    });
    summary.ocr = { ...r, errors: r.errors.slice(0, 20), errorCount: r.errors.length };
    errors += r.errors.length;
  }
  if (cmd === 'rules' || cmd === 'all') {
    const r = runRules(lib.db, { dryRun, limit, all: values.all });
    summary.rules = r;
    errors += r.invalid.length;
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  errors++;
} finally {
  lib.db.close();
}
console.log(JSON.stringify(summary, null, 1));
process.exit(errors ? 1 : 0);
