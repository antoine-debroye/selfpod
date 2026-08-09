import { notFound } from '../../lib/errors.js';

/**
 * Play, download and failure statistics (§14 extension).
 *
 * `/api/stats` answers "how is this instance being used?" and `/api/stats/log`
 * answers "what exactly happened, and what failed?". The log is the one that
 * matters when a subscriber reports that an episode will not download: it shows
 * the request, the status code, and a plain-language reason.
 */
export default async function statsRoutes(fastify, { stats, shows, episodes }) {
  fastify.addHook('onRequest', fastify.requireAdminApi);

  fastify.get('/stats', async () => ({
    overview: stats.overview(),
    shows: shows.list().map((show) => ({
      id: show.id,
      slug: show.slug,
      title: show.title,
      ...stats.forShow(show.id),
    })),
    recentFailures: stats.recentFailures(10),
  }));

  fastify.get('/stats/log', async (request) => {
    const query = request.query ?? {};
    const show = query.showId ? (shows.get(query.showId) ?? shows.getBySlug(query.showId)) : null;
    const episode = query.episodeId ? episodes.get(query.episodeId) : null;
    const filter = {
      showId: show?.id ?? null,
      episodeId: episode?.id ?? null,
      failuresOnly: query.failuresOnly === '1' || query.failuresOnly === 'true',
    };

    return {
      entries: stats.list({
        ...filter,
        limit: intOr(query.limit, 50),
        offset: intOr(query.offset, 0),
      }),
      total: stats.count(filter),
      filter: {
        show: show ? { id: show.id, slug: show.slug, title: show.title } : null,
        episode: episode ? { id: episode.id, title: episode.title } : null,
        failuresOnly: filter.failuresOnly,
      },
    };
  });

  fastify.get('/shows/:id/stats', async (request) => {
    const show = shows.get(request.params.id) ?? shows.getBySlug(request.params.id);
    if (!show) throw notFound('That show does not exist.', 'show_not_found');
    return {
      show: { id: show.id, slug: show.slug, title: show.title },
      totals: stats.forShow(show.id),
      episodes: episodes.listByShow(show.id).map((episode) => ({
        id: episode.id,
        title: episode.title,
        filename: episode.filename,
        ...stats.forEpisode(episode.id),
      })),
    };
  });
}

function intOr(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
