import { parseArgs } from 'node:util';
import { startServer } from './app.mjs';
import { resolveLibraryDir } from './library.mjs';

const { values } = parseArgs({
  options: { library: { type: 'string' }, port: { type: 'string' } },
});

const libraryDir = resolveLibraryDir(values.library);
const port = Number(values.port ?? process.env.PORT ?? 3040);
const app = await startServer({ libraryDir, port });
console.log(`Photo Library v2 — library: ${libraryDir}`);
console.log(`Listening on http://127.0.0.1:${app.server.address().port}`);
