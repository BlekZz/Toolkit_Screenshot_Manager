import { parseArgs } from 'node:util';
import { openLibrary, resolveLibraryDir } from '../server/library.mjs';
import { addRoot, listRoots, scanRoot } from '../server/roots.mjs';

const USAGE = 'Usage: node cli/roots.mjs <list | add <abs-path> | scan <root-id> [--dry-run]> [--library <dir>]';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { library: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});

const [cmd, arg] = positionals;
const valid = (cmd === 'list' && positionals.length === 1)
  || (cmd === 'add' && positionals.length === 2)
  || (cmd === 'scan' && positionals.length === 2 && /^\d+$/.test(arg));
if (!valid) {
  console.error(USAGE);
  process.exit(2);
}

const lib = openLibrary(resolveLibraryDir(values.library));
let code = 0;
try {
  if (cmd === 'list') {
    console.log(JSON.stringify(listRoots(lib), null, 2));
  } else if (cmd === 'add') {
    // Relative paths are rejected on purpose (same contract as the API); no implicit cwd resolution.
    console.log(JSON.stringify(addRoot(lib, arg), null, 2));
  } else {
    const result = await scanRoot(lib, Number(arg), {
      dryRun: values['dry-run'],
      onProgress: (p) => { if (p.done === p.total || p.done % 200 === 0) console.error(`  ${p.phase} ${p.done}/${p.total}`); },
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) code = 1;
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  code = err.statusCode === 400 || err.statusCode === 404 ? 2 : 1;
} finally {
  lib.db.close();
}
process.exit(code);
