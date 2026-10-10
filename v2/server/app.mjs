import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { assetFilePath, openLibrary } from './library.mjs';
import { importFolder, validateSource } from './importer.mjs';
import { ensureThumb, THUMB_SIZES } from './thumbs.mjs';
import { createCatalog } from './catalog.mjs';
import { registerCatalogRoutes } from './routes-catalog.mjs';

const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
export const HOST = '127.0.0.1';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/**
 * Builds the Fastify app bound to one library.
 *
 * @param {{libraryDir: string, logger?: boolean}} opts
 * @returns {Promise<import('fastify').FastifyInstance & {lib: ReturnType<typeof openLibrary>}>}
 */
export async function buildApp({ libraryDir, logger = false }) {
  const lib = openLibrary(libraryDir);
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  app.decorate('lib', lib);
  app.addHook('onClose', async () => lib.db.close());

  const getAsset = lib.db.prepare('SELECT * FROM assets WHERE id = ?');

  function parseId(raw) {
    if (!/^\d+$/.test(raw)) throw Object.assign(new Error('invalid id'), { statusCode: 400 });
    const asset = getAsset.get(Number(raw));
    if (!asset) throw Object.assign(new Error('asset not found'), { statusCode: 404 });
    return asset;
  }

  // ---- library API ---------------------------------------------------------

  app.get('/api/health', async () => ({
    ok: true,
    library: lib.dir,
    schema: lib.db.prepare('PRAGMA user_version').get().user_version,
  }));

  app.get('/api/stats', async () => {
    const rows = lib.db.prepare('SELECT status, count(*) AS n, sum(bytes) AS bytes FROM assets GROUP BY status').all();
    return Object.fromEntries(rows.map((r) => [r.status, { count: r.n, bytes: r.bytes }]));
  });

  const catalog = createCatalog(lib.db);
  registerCatalogRoutes(app, catalog);

  /** Ordered id list of the current view (optional ?q= filter); the grid virtualises over it. */
  app.get('/api/assets', async (req) => {
    const sort = ['imported', 'mtime', 'name'].includes(req.query.sort) ? req.query.sort : 'imported';
    const order = req.query.order === 'asc' ? 'asc' : 'desc';
    const { total, ids } = catalog.query({ q: req.query.q, sort, order });
    return { total, sort, order, ids };
  });

  app.get('/api/assets/:id', async (req) => {
    const a = parseId(req.params.id);
    return {
      id: a.id, filename: a.filename, ext: a.ext, width: a.width, height: a.height, bytes: a.bytes,
      sha256: a.sha256, file_mtime: a.file_mtime, imported_at: a.imported_at,
      source_path: a.source_path, status: a.status, rating: a.rating, note: a.note,
      ...catalog.assetMembership(a.id),
    };
  });

  // ---- media ---------------------------------------------------------------

  app.get('/media/original/:id', async (req, reply) => {
    const a = parseId(req.params.id);
    const file = assetFilePath(lib, a);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'original file missing' });
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.type(MIME[a.ext] ?? 'application/octet-stream').send(fs.createReadStream(file));
  });

  app.get('/media/thumb/:id', async (req, reply) => {
    const a = parseId(req.params.id);
    const size = Number(req.query.size ?? 256);
    if (!THUMB_SIZES.has(size)) return reply.code(400).send({ error: `size must be one of ${[...THUMB_SIZES]}` });
    const file = assetFilePath(lib, a);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'original file missing' });
    const thumb = await ensureThumb(lib.thumbsDir, file, a.sha256, size);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.type('image/webp').send(fs.createReadStream(thumb));
  });

  // ---- import job (one at a time) -----------------------------------------

  let job = null;

  app.post('/api/import', async (req, reply) => {
    if (job?.state === 'running') return reply.code(409).send({ error: 'an import is already running' });
    const { path: src, recursive = true } = req.body ?? {};
    const source = validateSource(lib, src);
    job = { state: 'running', source, recursive: Boolean(recursive), progress: null, result: null, error: null,
      started_at: new Date().toISOString() };
    const current = job;
    importFolder(lib, source, { recursive: Boolean(recursive), onProgress: (p) => { current.progress = p; } })
      .then((r) => { current.result = r; current.state = 'done'; })
      .catch((e) => { current.error = e.message; current.state = 'failed'; });
    return reply.code(202).send(job);
  });

  app.get('/api/import', async () => job ?? { state: 'idle' });

  // ---- web UI --------------------------------------------------------------

  if (fs.existsSync(DIST_DIR)) {
    await app.register(fastifyStatic, { root: DIST_DIR });
  } else {
    app.get('/', async (req, reply) => reply.type('text/plain; charset=utf-8')
      .send('Web UI not built. Run `npm run build` in v2/ (or `npm run dev:web` for development).'));
  }

  return app;
}

/**
 * Builds the app and listens on 127.0.0.1 only.
 *
 * @param {{libraryDir: string, port?: number, logger?: boolean}} opts
 */
export async function startServer({ libraryDir, port = 3040, logger = false }) {
  const app = await buildApp({ libraryDir, logger });
  await app.listen({ host: HOST, port });
  return app;
}
