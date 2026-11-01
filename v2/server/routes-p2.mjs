import fs from 'node:fs';
import { assetFilePath } from './library.mjs';
import { ensureCrop } from './crops.mjs';

/**
 * HTTP routes for P2a (Triage backend): generic undo, trash / restore, crops,
 * bundles, triage slots, album grouping. Business rules live in triage.mjs
 * and undo.mjs; handlers only map params and bodies.
 *
 * @param {import('fastify').FastifyInstance & {lib: object}} app
 * @param {{triage: ReturnType<import('./triage.mjs').createTriage>, undo: ReturnType<import('./undo.mjs').createUndo>}} deps
 */
export function registerP2Routes(app, { triage, undo }) {
  const num = (raw) => {
    if (!/^\d+$/.test(raw)) throw Object.assign(new Error('invalid id'), { statusCode: 400 });
    return Number(raw);
  };
  const body = (req) => req.body ?? {};

  // ---- undo ----------------------------------------------------------------

  app.get('/api/undo', async () => undo.listUndoable());
  /** No body (or no event_id) = undo the most recent undoable event. */
  app.post('/api/undo', async (req) => undo.undo(body(req).event_id));

  // ---- trash ---------------------------------------------------------------

  app.post('/api/assets/trash', async (req) => triage.trashAssets(body(req).ids));
  app.post('/api/assets/restore', async (req) => triage.restoreAssets(body(req).ids));

  // ---- album grouping ------------------------------------------------------

  app.post('/api/assets/albums', async (req) => triage.albumsOf(body(req).ids));

  // ---- crops ---------------------------------------------------------------

  app.get('/api/assets/:id/crops', async (req) => triage.listCrops(num(req.params.id)));
  app.post('/api/assets/:id/crops', async (req, reply) => reply.code(201).send(triage.createCrop(num(req.params.id), body(req))));
  app.delete('/api/crops/:id', async (req) => triage.deleteCrop(num(req.params.id)));

  app.get('/media/crop/:id', async (req, reply) => {
    const { crop, asset } = triage.cropWithAsset(num(req.params.id));
    const file = assetFilePath(app.lib, asset);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'original file missing' });
    const out = await ensureCrop(app.lib.thumbsDir, file, asset.sha256, crop);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.type('image/png').send(fs.createReadStream(out.file));
  });

  // ---- bundles -------------------------------------------------------------

  app.get('/api/bundles', async (req) => triage.listBundles({ status: req.query.status }));
  app.post('/api/bundles', async (req, reply) => reply.code(201).send(triage.createBundle(body(req))));
  app.get('/api/bundles/:id', async (req) => triage.getBundle(num(req.params.id)));
  app.patch('/api/bundles/:id', async (req) => triage.updateBundle(num(req.params.id), body(req)));
  app.post('/api/bundles/:id/items', async (req, reply) => reply.code(201).send(triage.addBundleItem(num(req.params.id), body(req))));
  app.delete('/api/bundles/:id/items/:itemId', async (req) => triage.removeBundleItem(num(req.params.id), num(req.params.itemId)));

  // ---- triage slots --------------------------------------------------------

  app.get('/api/settings/triage-slots', async () => triage.getSlots());
  app.put('/api/settings/triage-slots', async (req) => triage.putSlots(Array.isArray(req.body) ? req.body : body(req).slots));
}
