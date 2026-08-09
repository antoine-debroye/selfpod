import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { EPISODE_STATUS, SHOW_STATUS } from '../constants.js';
import { notFound } from '../lib/errors.js';
import { isSafeFilename } from '../lib/slug.js';
import { tokensMatch } from '../lib/tokens.js';
import { VERSION } from '../version.js';

/**
 * Unauthenticated, token-gated routes: the feed, the media files, and /health.
 *
 * Podcast apps cannot do interactive login, so the show's `feed_token` *is* the
 * credential (spec §12.2). A token that doesn't match its slug returns a plain
 * 404 rather than a 403, so the response never reveals whether a show exists.
 */
export default async function publicRoutes(fastify, { config, settings, shows, episodes, feeds, covers, health }) {
  /**
   * Resolves a slug+token pair to a show, or 404s. Both the "wrong token" and
   * "no such show" cases return exactly the same response.
   */
  function resolveShow(slug, token) {
    const show = shows.getBySlug(slug);
    if (!show) throw notFound('No feed here.', 'not_found');
    if (!tokensMatch(show.feed_token, token)) throw notFound('No feed here.', 'not_found');
    if (show.status === SHOW_STATUS.FOLDER_MISSING) {
      throw notFound('This show is currently unavailable.', 'show_unavailable');
    }
    return show;
  }

  /**
   * Health check (spec §12.3). Always HTTP 200, even when degraded: the container
   * must stay "healthy" to Docker so the admin UI carrying the diagnostic banner
   * stays reachable. The CORS header exists for the dashboard's "test it" button,
   * which fetches this from the browser to prove the reverse proxy really works.
   */
  fastify.get('/health', async (request, reply) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('cache-control', 'no-store');
    return health.summary({ version: VERSION });
  });

  fastify.options('/health', async (request, reply) => {
    reply
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-methods', 'GET, OPTIONS')
      .status(204)
      .send();
  });

  /** RSS feed, built on demand from the database (spec §8.1). */
  fastify.get('/feeds/:slug/:tokenFile', async (request, reply) => {
    const { slug, tokenFile } = request.params;
    if (!tokenFile.endsWith('.xml')) throw notFound('No feed here.', 'not_found');
    const token = tokenFile.slice(0, -4);
    const show = resolveShow(slug, token);

    const baseUrl = settings.publicBaseUrl();
    if (!baseUrl) {
      // Emitting URLs built from a guess would bake a wrong host into every
      // subscriber's app, so refuse instead (see §9 adjudication).
      reply.header('cache-control', 'no-store');
      return reply.status(503).type('text/plain; charset=utf-8').send(
        'SelfPod does not know its public address yet, so it cannot build this feed.\n' +
          'Sign in to SelfPod and set the public base URL in Settings, then reload this feed.\n',
      );
    }

    const built = feeds.build(show.id, { baseUrl });
    if (!built) throw notFound('No feed here.', 'not_found');

    if (request.headers['if-none-match'] === built.etag) {
      return reply.status(304).send();
    }

    reply
      .type('application/rss+xml; charset=utf-8')
      .header('etag', built.etag)
      // Short: a podcast app polling every few minutes should see edits quickly.
      .header('cache-control', 'public, max-age=60, must-revalidate');
    return built.xml;
  });

  /**
   * Cover art. The URL always ends in `cover.jpg` as a stable handle, but the
   * file served is whatever was actually detected — so a `cover.png` on disk
   * works without the feed's image URL changing (spec §10.3).
   */
  fastify.get('/media/:slug/:token/cover.jpg', async (request, reply) => {
    const { slug, token } = request.params;
    const show = resolveShow(slug, token);
    if (!show.cover_filename) throw notFound('No artwork for this show.', 'no_cover');

    const path = join(shows.dirFor(show), show.cover_filename);
    let stats;
    try {
      stats = await stat(path);
    } catch {
      throw notFound('No artwork for this show.', 'no_cover');
    }

    const etag = await covers.etag(path);
    if (etag && request.headers['if-none-match'] === etag) {
      reply.header('etag', etag);
      return reply.status(304).send();
    }

    reply
      .header('content-type', covers.mimeTypeFor(show.cover_filename))
      // Deliberately short (spec §10.3): artwork changes, and a long max-age at a
      // CDN meant an updated cover stayed stale for a day. The ETag is what keeps
      // well-behaved caches from re-downloading unchanged art anyway.
      .header('cache-control', 'public, max-age=3600');
    if (etag) reply.header('etag', etag);
    void stats;

    // Opting out of the static plugin's own content-type, caching and ETag is
    // what lets the headers above survive: left to itself it would send
    // `public, max-age=0` and a size/mtime ETag instead of a content hash.
    return reply.sendFile(show.cover_filename, shows.dirFor(show), {
      cacheControl: false,
      contentType: false,
      etag: false,
    });
  });

  /**
   * Episode audio. Range support is required for scrubbing and download resume,
   * so it is delegated to @fastify/static's `sendFile` rather than hand-rolled
   * (spec §8.4).
   */
  fastify.get('/media/:slug/:token/:episodeId/:filename', async (request, reply) => {
    const { slug, token, episodeId, filename } = request.params;
    const show = resolveShow(slug, token);

    // Lookup is by episode id; the filename in the URL exists only so podcast
    // apps that infer a type from the extension behave, and so downloads get a
    // sensible name. It is never trusted for resolution.
    const episode = episodes.get(episodeId);
    if (!episode || episode.show_id !== show.id) throw notFound('No episode here.', 'not_found');
    if (episode.status === EPISODE_STATUS.REMOVED) throw notFound('No episode here.', 'not_found');
    if (!isSafeFilename(episode.filename)) throw notFound('No episode here.', 'not_found');
    void filename;

    const showDir = shows.dirFor(show);
    const absolute = resolve(join(showDir, episode.filename));
    // Defence in depth: the resolved path must still be inside the show folder.
    if (!absolute.startsWith(resolve(showDir))) throw notFound('No episode here.', 'not_found');

    let stats;
    try {
      stats = await stat(absolute);
    } catch (err) {
      request.log.warn(
        { file: episode.filename, code: err.code },
        'a subscriber requested an episode whose file could not be read',
      );
      throw notFound(
        'That episode file is not readable right now.',
        err.code === 'EACCES' ? 'permission_denied' : 'file_missing',
      );
    }

    reply
      // Always from the shared MIME map, never sniffed. Left to itself the static
      // handler would send `audio/mp4` for a .m4a file, which is exactly the kind
      // of mismatch that made an episode fail to play in some apps.
      .header('content-type', episode.mime_type)
      // `private` rather than `public`: Cloudflare caches .mp3/.ogg/.flac at the
      // edge by default, which would keep serving a rotated token's media for up
      // to a day. Clients still cache; the CDN does not.
      .header('cache-control', 'private, max-age=86400')
      .header('content-disposition', contentDisposition(episode.filename));

    void stats;
    // Range handling (206 responses, `Accept-Ranges`, 416 for an unsatisfiable
    // range) comes from the static plugin — hand-rolling it is how seeking breaks.
    // Only its content-type and caching are overridden.
    return reply.sendFile(episode.filename, showDir, { cacheControl: false, contentType: false });
  });

  void config;
}

/**
 * `filename*=UTF-8''…` is what lets a downloaded file keep an emoji or accent in
 * its name; the plain `filename=` fallback is for older clients.
 */
function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
