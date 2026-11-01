/**
 * HTTP routes for AI-suggestion decisions (accept / reject / undo) and
 * tag → action bindings. Business rules live in decisions.mjs.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {ReturnType<import('./decisions.mjs').createDecisions>} decisions
 */
export function registerDecisionRoutes(app, decisions) {
  const id = (req) => {
    if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error('invalid id'), { statusCode: 400 });
    return Number(req.params.id);
  };
  const body = (req) => req.body ?? {};

  // ---- suggestions ---------------------------------------------------------

  app.get('/api/assets/:id/suggestions', async (req) => decisions.listSuggestions(id(req)));
  app.post('/api/suggestions/accept', async (req) => decisions.acceptSuggestions(body(req).ids));
  app.post('/api/suggestions/reject', async (req) => decisions.rejectSuggestions(body(req).ids));
  app.post('/api/suggestions/undo', async (req) => decisions.undoDecision(body(req).event_id));

  // ---- tag actions ---------------------------------------------------------

  app.get('/api/tag-actions', async () => decisions.listTagActions());
  app.post('/api/tag-actions', async (req, reply) => reply.code(201).send(decisions.createTagAction(body(req))));
  app.patch('/api/tag-actions/:id', async (req) => decisions.updateTagAction(id(req), body(req)));
  app.delete('/api/tag-actions/:id', async (req) => decisions.deleteTagAction(id(req)));
}
