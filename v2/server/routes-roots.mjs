import { addRoot, listRoots, scanRoot } from './roots.mjs';

/**
 * Referenced-root routes (P2 原地引用).
 *
 *   GET  /api/roots                 → { roots: [...] }
 *   POST /api/roots {path}          → 201 root | 400
 *   POST /api/roots/:id/scan {dry_run?} → 202 job | 404 | 409 (a scan is running)
 *   GET  /api/roots/scan            → current/last scan job ({state: idle|running|done|failed, ...})
 *
 * Scans run as a background job (same pattern as /api/import): hashing a large
 * root can outlive an HTTP request timeout.
 *
 * @param {import('fastify').FastifyInstance & {lib: ReturnType<import('./library.mjs').openLibrary>}} app
 */
export function registerRootRoutes(app) {
  const { lib } = app;
  let job = null;

  app.get('/api/roots', async () => ({ roots: listRoots(lib) }));

  app.post('/api/roots', async (req, reply) => reply.code(201).send(addRoot(lib, req.body?.path)));

  app.post('/api/roots/:id/scan', async (req, reply) => {
    if (!/^\d+$/.test(req.params.id)) return reply.code(400).send({ error: 'invalid id' });
    const rootId = Number(req.params.id);
    const root = lib.db.prepare('SELECT mode FROM library_roots WHERE id = ?').get(rootId);
    if (!root) return reply.code(404).send({ error: 'root not found' });
    if (root.mode !== 'referenced') return reply.code(400).send({ error: 'only referenced roots can be scanned' });
    if (job?.state === 'running') return reply.code(409).send({ error: 'a scan is already running' });
    const dryRun = Boolean(req.body?.dry_run);
    job = { state: 'running', root_id: rootId, dry_run: dryRun, progress: null, result: null, error: null,
      started_at: new Date().toISOString() };
    const current = job;
    scanRoot(lib, rootId, { dryRun, onProgress: (p) => { current.progress = p; } })
      .then((r) => { current.result = r; current.state = 'done'; })
      .catch((e) => { current.error = e.message; current.state = 'failed'; });
    return reply.code(202).send(job);
  });

  app.get('/api/roots/scan', async () => job ?? { state: 'idle' });
}
