// Imports the legacy triage tool's decided folders into the library, tagging each image with its decision.
//   node cli/migrate-legacy.mjs <legacy-tool-root> [--library <dir>] [--dry-run]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { migrateLegacy } from '../server/legacy.mjs';
import { openLibrary, resolveLibraryDir } from '../server/library.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { library: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
});
if (positionals.length !== 1) {
  console.error('Usage: node cli/migrate-legacy.mjs <legacy-tool-root> [--library <dir>] [--dry-run]');
  process.exit(2);
}
const lib = openLibrary(resolveLibraryDir(values.library));
try {
  const { folders } = await migrateLegacy(lib, path.resolve(positionals[0]), { dryRun: values['dry-run'] });
  console.log(`dryRun=${values['dry-run']}`);
  console.log('folder'.padEnd(26), 'files imported dup tagged errors');
  for (const f of folders) {
    console.log(f.dir.padEnd(26), String(f.files).padStart(5), String(f.imported).padStart(8), String(f.duplicates).padStart(3),
      String(f.tagged).padStart(6), String(f.errors.length).padStart(6));
  }
  process.exitCode = folders.some((f) => f.errors.length) ? 1 : 0;
} finally {
  lib.db.close();
}
