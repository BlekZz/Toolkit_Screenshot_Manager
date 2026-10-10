/**
 * HTTP routes for the catalogue: query / facets, tags, album folders, albums,
 * smart albums. All business rules live in catalog.mjs; handlers only map
 * params and bodies.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {ReturnType<import('./catalog.mjs').createCatalog>} catalog
 */
export function registerCatalogRoutes(app, catalog) {
  const id = (req) => {
    if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error('invalid id'), { statusCode: 400 });
    return Number(req.params.id);
  };
  const body = (req) => req.body ?? {};

  // ---- query ---------------------------------------------------------------

  /** Ordered id list for a filter: body {ast?, q?, sort?, order?, album_id?}. */
  app.post('/api/query', async (req) => catalog.query(body(req)));
  app.post('/api/facets', async (req) => catalog.facets(body(req)));

  /** Everything the sidebar needs in one round-trip. */
  app.get('/api/catalog', async () => ({
    tags: catalog.listTags(),
    folders: catalog.listFolders(),
    albums: catalog.listAlbums(),
    smart: catalog.listSmart(),
  }));

  // ---- tags ----------------------------------------------------------------

  app.get('/api/tags', async () => catalog.listTags());
  app.post('/api/tags', async (req, reply) => {
    const tag = catalog.createTag(body(req));
    return reply.code(tag.created ? 201 : 200).send(tag);
  });
  app.patch('/api/tags/:id', async (req) => catalog.updateTag(id(req), body(req)));
  app.delete('/api/tags/:id', async (req) => catalog.deleteTag(id(req)));
  app.post('/api/tags/apply', async (req) => catalog.applyTags(body(req)));

  // ---- album folders -------------------------------------------------------

  app.get('/api/folders', async () => catalog.listFolders());
  app.post('/api/folders', async (req, reply) => reply.code(201).send(catalog.createFolder(body(req))));
  app.patch('/api/folders/:id', async (req) => catalog.updateFolder(id(req), body(req)));
  app.delete('/api/folders/:id', async (req) => catalog.deleteFolder(id(req)));

  // ---- albums --------------------------------------------------------------

  app.get('/api/albums', async () => catalog.listAlbums());
  app.post('/api/albums', async (req, reply) => reply.code(201).send(catalog.createAlbum(body(req))));
  app.patch('/api/albums/:id', async (req) => catalog.updateAlbum(id(req), body(req)));
  app.delete('/api/albums/:id', async (req) => catalog.deleteAlbum(id(req)));
  app.post('/api/albums/:id/add', async (req) => catalog.addToAlbum(id(req), body(req).asset_ids));
  app.post('/api/albums/:id/remove', async (req) => catalog.removeFromAlbum(id(req), body(req).asset_ids));
  app.post('/api/albums/:id/reorder', async (req) => catalog.reorderAlbum(id(req), body(req)));

  // ---- smart albums --------------------------------------------------------

  app.get('/api/smart', async () => catalog.listSmart());
  app.post('/api/smart', async (req, reply) => reply.code(201).send(catalog.createSmart(body(req))));
  app.patch('/api/smart/:id', async (req) => catalog.updateSmart(id(req), body(req)));
  app.delete('/api/smart/:id', async (req) => catalog.deleteSmart(id(req)));
}
