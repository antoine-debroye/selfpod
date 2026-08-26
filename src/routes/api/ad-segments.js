import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AD_TRIM_MODES, SEGMENT_STATUS } from '../../constants.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { cutFrames } from '../../lib/mp3-cut.js';
import { frameProfile } from '../../lib/mp3-frames.js';
import { presentSegment } from '../../lib/present-segment.js';

/**
 * The JSON API for advert detection (spec §19.9).
 *
 * Admin-only, like everything else under /api. The one route worth a second look is
 * `sample.mp3`: it reads an episode off the disk and returns part of it. It is behind
 * the admin session rather than a feed token because it is a tool for deciding, not a
 * way to publish — and the segment it returns is only ever the stretch already
 * catalogued, never an arbitrary range someone asks for.
 */

/** Running detection reads every episode of a show off the disk. */
const DETECT_LIMIT = { max: 6, timeWindow: '1 hour' };

export default async function adSegmentRoutes(fastify, services) {
  const { adDetect, adPipeline, shows, episodes, config } = services;

  fastify.addHook('onRequest', fastify.requireAdminApi);

  fastify.get('/shows/:id/ad-segments', async (request) => {
    const show = shows.getOrThrow(request.params.id);
    const segments = adDetect.listSegments(show.id).map((row) => presentSegment(row, { episodes }));
    const counts = episodes.counts(show.id);

    return {
      mode: show.ad_trim_mode ?? 'off',
      minEpisodes: show.ad_auto_min_episodes ?? 3,
      // The number of episodes SelfPod is sitting on. Without this the page can say
      // "waiting" without ever saying what for, and a feed that quietly stopped is
      // the failure this whole app is built against.
      held: counts.held,
      segments,
      awaiting: segments.filter((row) => row.status === SEGMENT_STATUS.CANDIDATE).length,
    };
  });

  /**
   * Turning the feature on, or changing how cautious it is.
   *
   * Settling the holds afterwards is part of the same request rather than left to the
   * next scheduler tick: switching a show to `off` has to actually let its episodes
   * out, and having to wait five minutes to find out whether it worked is how an
   * operator concludes it did not.
   */
  fastify.patch('/shows/:id/ad-trim', async (request) => {
    const show = shows.getOrThrow(request.params.id);
    const body = request.body ?? {};
    const fields = {};

    if (body.mode !== undefined) {
      if (!AD_TRIM_MODES.includes(body.mode)) {
        throw badRequest(
          `"${body.mode}" is not one of ${AD_TRIM_MODES.join(', ')}.`,
          'unknown_ad_trim_mode',
        );
      }
      fields.ad_trim_mode = body.mode;
    }

    if (body.minEpisodes !== undefined) {
      const value = Number(body.minEpisodes);
      if (!Number.isInteger(value) || value < 2 || value > 20) {
        throw badRequest(
          'The number of episodes to compare has to be between 2 and 20. Two is the fewest that can be compared at all, and anything above twenty means waiting months before a new show is trimmed.',
          'invalid_min_episodes',
        );
      }
      fields.ad_auto_min_episodes = value;
    }

    if (!Object.keys(fields).length) throw badRequest('Nothing to change.', 'no_fields');

    const assignments = Object.keys(fields)
      .map((key) => `${key} = @${key}`)
      .join(', ');
    services.db
      .prepare(`UPDATE shows SET ${assignments}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...fields, id: show.id, updated_at: new Date().toISOString() });

    const settled = adPipeline.settle(show.id);
    const updated = shows.get(show.id);
    return {
      mode: updated.ad_trim_mode,
      minEpisodes: updated.ad_auto_min_episodes,
      released: settled.released,
      held: settled.held,
    };
  });

  fastify.post('/shows/:id/ad-detect', { preHandler: [fastify.rateLimit(DETECT_LIMIT)] }, async (request) => {
    const show = shows.getOrThrow(request.params.id);
    if (!show.ad_trim_mode || show.ad_trim_mode === 'off') {
      throw badRequest(
        'Advert detection is off for this show. Turn it on first — SelfPod will not read your episodes otherwise.',
        'ad_trim_off',
      );
    }
    const result = await adPipeline.processShow(show.id);
    return {
      segments: adDetect.listSegments(show.id).map((row) => presentSegment(row, { episodes })),
      trimmed: result.trimmed?.trimmed ?? 0,
      held: result.held ?? 0,
    };
  });

  /**
   * One decision, and the audio it implies.
   *
   * The trim runs here rather than on the next tick for the same reason as above: a
   * decision that has not reached the audio has not really been taken, and watching
   * the episode appear is how you know it worked.
   */
  fastify.post('/ad-segments/:id/decide', async (request) => {
    const segment = adDetect.getSegment(request.params.id);
    if (!segment) throw notFound('That segment no longer exists.', 'segment_not_found');

    const status = request.body?.status;
    if (status !== SEGMENT_STATUS.APPROVED && status !== SEGMENT_STATUS.REJECTED) {
      throw badRequest('A segment is either approved or rejected.', 'unknown_status');
    }

    adDetect.decide(segment.id, status);
    const result = await adPipeline.processShow(segment.show_id);

    return {
      segment: presentSegment(adDetect.listSegments(segment.show_id).find((row) => row.id === segment.id), {
        episodes,
      }),
      trimmed: result.trimmed?.trimmed ?? 0,
      held: result.held ?? 0,
    };
  });

  /**
   * The segment on its own, as audio, so a decision can be made by listening.
   *
   * Built by cutting everything *except* the segment out of the exemplar episode,
   * which is the trimmer's own operation run the other way round — so what you hear
   * is exactly the frames that would be removed, not an approximation of them.
   */
  fastify.get('/ad-segments/:id/sample.mp3', async (request, reply) => {
    const segment = adDetect.getSegment(request.params.id);
    if (!segment) throw notFound('That segment no longer exists.', 'segment_not_found');

    const occurrence = services.db
      .prepare('SELECT * FROM ad_segment_occurrences WHERE segment_id = ? ORDER BY start_frame LIMIT 1')
      .get(segment.id);
    const episode = occurrence ? episodes.get(occurrence.episode_id) : null;
    if (!episode) throw notFound('There is no episode to play this from.', 'no_exemplar');

    let buffer;
    try {
      buffer = await readFile(join(shows.dirFor(shows.getOrThrow(episode.show_id)), episode.filename));
    } catch {
      throw notFound('That episode is not readable right now.', 'file_missing');
    }

    const total = frameProfile(buffer)?.frameCount ?? 0;
    const sample = cutFrames(buffer, [
      { startFrame: 0, endFrame: occurrence.start_frame },
      { startFrame: occurrence.end_frame, endFrame: total },
    ]);
    if (!sample) throw notFound('That segment could not be played.', 'not_playable');

    return reply
      .header('content-type', 'audio/mpeg')
      .header('content-length', String(sample.buffer.length))
      // Derived from files that can change, and only ever a few seconds long.
      .header('cache-control', 'private, no-store')
      .send(sample.buffer);
  });
}
