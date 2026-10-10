import path from 'node:path';
import { parseArgs } from 'node:util';
import { importFolder } from '../server/importer.mjs';
import { openLibrary, resolveLibraryDir } from '../server/library.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { library: { type: 'string' }, 'no-recursive': { type: 'boolean', default: false } },
});

if (positionals.length !== 1) {
  console.error('Usage: node cli/import.mjs <source-dir> [--library <dir>] [--no-recursive]');
  process.exit(2);
}

const lib = openLibrary(resolveLibraryDir(values.library));
let last = 0;
const result = await importFolder(lib, path.resolve(positionals[0]), {
  recursive: !values['no-recursive'],
  onProgress: (p) => {
    if (p.done - last >= 50 || p.done === p.total) {
      last = p.done;
      console.log(`  ${p.done}/${p.total}  imported=${p.imported} dup=${p.duplicates} err=${p.errors.length}`);
    }
  },
});
lib.db.close();

console.log(`Library:     ${lib.dir}`);
console.log(`Scanned:     ${result.scanned}`);
console.log(`Imported:    ${result.imported}`);
console.log(`Duplicates:  ${result.duplicates}`);
console.log(`Unsupported: ${result.unsupported.length}${result.unsupported.length ? ` (e.g. ${result.unsupported[0]})` : ''}`);
console.log(`Errors:      ${result.errors.length}`);
for (const e of result.errors.slice(0, 20)) console.log(`  ${e.file}: ${e.error}`);
process.exit(result.errors.length ? 1 : 0);
