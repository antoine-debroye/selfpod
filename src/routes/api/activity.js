export default async function activityRoutes(fastify, { activity, shows }) {
  fastify.addHook('onRequest', fastify.requireAdminApi);

  fastify.get('/activity', async (request) => {
    const { showId: showParam, limit, offset } = request.query ?? {};
    const show = showParam ? shows.get(showParam) ?? shows.getBySlug(showParam) : null;
    const parsedLimit = Number.parseInt(limit ?? '25', 10);
    const parsedOffset = Number.parseInt(offset ?? '0', 10);

    const entries = activity.list({
      showId: show?.id ?? null,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 25,
      offset: Number.isFinite(parsedOffset) ? parsedOffset : 0,
    });

    return {
      entries,
      total: activity.count({ showId: show?.id ?? null }),
      filter: show ? { id: show.id, slug: show.slug, title: show.title } : null,
    };
  });
}
