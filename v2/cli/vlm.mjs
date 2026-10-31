// Local VLM suggestions (Sprint_Screenshot_AI_Triage A3).
//   node cli/vlm.mjs run [--model qwen3-vl:4b] [--q "<query>"] [--limit N] [--timeout 120]
//   node cli/vlm.mjs compare [--model qwen3-vl:4b] [--against <model of another source>]
//   node cli/vlm.mjs prompt                 # print current prompt + hash
// Common: [--library <dir>]
import { parseArgs } from 'node:util';
import { createCatalog } from '../server/catalog.mjs';
import { openLibrary, resolveLibraryDir } from '../server/library.mjs';
import { buildPrompt, buildTaxonomy, DEFAULT_MODEL, runVlm } from '../server/vlm.mjs';
import { compareSources } from '../server/vlm-compare.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    library: { type: 'string' },
    model: { type: 'string', default: DEFAULT_MODEL },
    against: { type: 'string', default: 'claude-sonnet-subagent-2026-11-01' },
    q: { type: 'string' },
    limit: { type: 'string' },
    timeout: { type: 'string', default: '120' },
  },
});
const [cmd] = positionals;
if (!['run', 'compare', 'prompt'].includes(cmd)) {
  console.error('Usage: node cli/vlm.mjs <run|compare|prompt> [options]');
  process.exit(2);
}

const lib = openLibrary(resolveLibraryDir(values.library));
try {
  if (cmd === 'prompt') {
    const p = buildPrompt(buildTaxonomy(lib.db));
    console.log(`prompt_hash=${p.promptHash}\n\n${p.prompt}\n\n${JSON.stringify(p.schema)}`);
  } else if (cmd === 'run') {
    const assetIds = values.q ? createCatalog(lib.db).query({ q: values.q }).ids : null;
    const t0 = Date.now();
    let lastLog = 0;
    const r = await runVlm(lib, {
      model: values.model, assetIds, limit: values.limit ? Number(values.limit) : Infinity, timeoutMs: Number(values.timeout) * 1000,
      onProgress: (p) => {
        if (p.done - lastLog >= 25 || p.done === p.total || p.last.status === 'error') {
          lastLog = p.done;
          console.log(`  ${p.done}/${p.total} ok=${p.ok} err=${p.errors}${p.last.status === 'error' ? `  last error #${p.last.id}: ${p.last.detail}` : ''}`);
        }
      },
    });
    const ms = [...r.ms].sort((a, b) => a - b);
    console.log(JSON.stringify({
      model: r.model, prompt_hash: r.promptHash, total: r.total, ok: r.ok, errors: r.errors, inserted: r.inserted, paused: r.paused,
      ms_median: ms[Math.floor(ms.length / 2)] ?? null, ms_p90: ms[Math.floor(ms.length * 0.9)] ?? null, wall_s: Math.round((Date.now() - t0) / 1000),
    }, null, 1));
    process.exitCode = r.paused ? 3 : r.errors ? 1 : 0;
  } else {
    console.log(JSON.stringify(compareSources(lib.db, { a: { stage: 'vlm', model: values.model }, b: { model: values.against } }), null, 1));
  }
} finally {
  lib.db.close();
}
