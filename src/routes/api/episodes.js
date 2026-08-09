import { notFound, unprocessable } from '../../lib/errors.js';

export default async function episodeRoutes(fastify, { config, episodes, shows, presentEpisode }) {
  fastify.addHook('onRequest', fastify.requireAdminApi);

  function load(id) {
    const episode = episodes.get(id);
    if (!episode) throw notFound('That episode no longer exists.', 'episode_not_found');
    const show = shows.get(episode.show_id);
    if (!show) throw notFound('That episode’s show no longer exists.', 'show_not_found');
    return { episode, show };
  }

  fastify.get('/episodes/:id', async (request) => {
    const { episode, show } = load(request.params.id);
    return { episode: presentEpisode(episode, show) };
  });

  fastify.patch('/episodes/:id', async (request) => {
    const { episode, show } = load(request.params.id);
    const updated = episodes.update(episode.id, request.body ?? {}, { timeZone: config.timeZone });
    return { episode: presentEpisode(updated, show) };
  });

  /**
   * Two clearly distinct outcomes (spec §11.3): remove from the feed but keep the
   * audio, or delete the file for good. The second needs an explicit confirmation
   * flag, because nothing brings the file back.
   */
  fastify.delete('/episodes/:id', async (request) => {
    const { episode, show } = load(request.params.id);
    const deleteFile = isTrue(request.query?.deleteFile) || isTrue(request.body?.deleteFile);

    if (!deleteFile) {
      const updated = episodes.removeFromFeed(episode.id);
      return {
        ok: true,
        mode: 'removed_from_feed',
        episode: presentEpisode(updated, show),
        note: 'Removed from the feed. The audio file is untouched, and a rescan will not bring the episode back — use Restore for that.',
      };
    }

    const confirm = request.query?.confirm ?? request.body?.confirm;
    if (!isTrue(confirm)) {
      throw unprocessable(
        'Deleting the audio file cannot be undone. Confirm to continue.',
        'confirmation_required',
        { confirm: 'Tick the box to confirm you want the file deleted.' },
      );
    }

    const result = await episodes.deleteWithFile(episode.id);
    return { ok: true, mode: 'deleted_file', ...result };
  });

  fastify.post('/episodes/:id/restore', async (request) => {
    const { episode, show } = load(request.params.id);
    const updated = episodes.restoreToFeed(episode.id);
    return { ok: true, episode: presentEpisode(updated, show) };
  });
}

function isTrue(value) {
  return value === true || value === 'true' || value === '1' || value === 'on' || value === 'yes';
}
