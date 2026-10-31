// AI suggestion maintenance (Sprint_Screenshot_AI_Triage A0).
//   node cli/suggest.mjs import <labels.jsonl> [--stage import] [--model <name>] [--prompt-hash <h>] [--dry-run]
//   node cli/suggest.mjs sample [--n 50] [--seed 1] [--album "AI 確認樣本"]
//   node cli/suggest.mjs eval [--album "AI 確認樣本"] [--finalize | --only-stage vlm --only-model qwen3-vl:4b]
// Common: [--library <dir>]
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { openLibrary, resolveLibraryDir } from '../server/library.mjs';
import { evaluate, importLabels, sampleForReview } from '../server/suggestions.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    library: { type: 'string' },
    stage: { type: 'string', default: 'import' },
    model: { type: 'string', default: '' },
    'prompt-hash': { type: 'string', default: '' },
    'dry-run': { type: 'boolean', default: false },
    n: { type: 'string', default: '50' },
    seed: { type: 'string', default: '1' },
    album: { type: 'string', default: 'AI 確認樣本' },
    finalize: { type: 'boolean', default: false },
    'only-stage': { type: 'string' },
    'only-model': { type: 'string' },
  },
});

const [cmd, file] = positionals;
const usage = () => { console.error('Usage: node cli/suggest.mjs <import <file.jsonl>|sample|eval> [options]'); process.exit(2); };
if (!['import', 'sample', 'eval'].includes(cmd) || (cmd === 'import' && !file)) usage();

const lib = openLibrary(resolveLibraryDir(values.library));
let exitCode = 0;
try {
  if (cmd === 'import') {
    const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
    const result = importLabels(lib.db, rows, {
      stage: values.stage, model: values.model, promptHash: values['prompt-hash'], dryRun: values['dry-run'],
    });
    console.log(JSON.stringify({ dryRun: values['dry-run'], ...result, unmatched: result.unmatched.slice(0, 20), ambiguous: result.ambiguous.slice(0, 20) }, null, 1));
    if (result.unmatched.length || result.ambiguous.length || result.invalid.length) exitCode = 1;
  } else if (cmd === 'sample') {
    console.log(JSON.stringify(sampleForReview(lib.db, { n: Number(values.n), seed: Number(values.seed), albumName: values.album }), null, 1));
  } else {
    const r = evaluate(lib.db, {
      albumName: values.album, finalize: values.finalize, stage: values['only-stage'] ?? null, model: values['only-model'] ?? null,
    });
    const pct = (x) => (x == null ? '   -' : `${(x * 100).toFixed(0).padStart(3)}%`);
    console.log(`assets=${r.assets}  finalize=${values.finalize}`);
    console.log('tag'.padEnd(24), '  tp  fp  fn  precision recall');
    for (const [tag, v] of Object.entries(r.perTag).sort()) {
      console.log(tag.padEnd(24), String(v.tp).padStart(4), String(v.fp).padStart(3), String(v.fn).padStart(3), `   ${pct(v.precision)}    ${pct(v.recall)}`);
    }
  }
} finally {
  lib.db.close();
}
process.exit(exitCode);
