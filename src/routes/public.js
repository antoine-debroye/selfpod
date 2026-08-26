import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { EPISODE_STATUS, SHOW_STATUS, TRIM_STATUS, imageMimeType } from '../constants.js';
import { ACCESS_KIND } from '../services/stats.js';
import { resolveContained } from '../lib/contained-path.js';
import { notFound } from '../lib/errors.js';
import { publishedAudio } from '../lib/published-audio.js';
import { etagMatches, notModifiedSince, preferredEncoding } from '../lib/http-headers.js';
import { signPing } from '../lib/instance-proof.js';
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
export default async function publicRoutes(fastify, { config, settings, shows, episodes, feeds, covers, health, stats }) {
  /**
   * True when this request came from the owner's own admin session.
   *
   * The episode editor previews audio through this very route, and the dashboard
   * shows artwork through it, so without this check the owner clicking play would
   * inflate their own figures — and the statistics page says in as many words that
   * it does not. A podcast app never carries the session cookie.
   */
  function isOwnRequest(request) {
    try {
      return Boolean(fastify.isAuthenticated?.(request));
    } catch {
      return false;
    }
  }

  /**
   * Records how a media response actually ended.
   *
   * Waiting for the response to finish rather than recording in the handler is what
   * makes the numbers trustworthy: only by then is the real status code known, and
   * only then can a transfer that died halfway be told apart from one that
   * completed. A handler-time log would count every attempt as a success — which is
   * precisely the case the owner needs to see.
   *
   * `close` always fires, `finish` only on a complete response, so a `close`
   * without a preceding `finish` is a client that hung up mid-download. The `done`
   * latch means one response can only ever produce one row, whatever order and
   * however many times those events arrive.
   */
  function trackAccess(request, reply, extra) {
    if (isOwnRequest(request)) return;
    let done = false;
    const settle = (aborted) => {
      if (done) return;
      done = true;
      stats?.record({
        kind: extra.kind,
        episodeId: extra.episodeId ?? null,
        showId: extra.showId ?? null,
        statusCode: reply.statusCode,
        // On an abort the Content-Length header describes what was promised, not
        // what arrived, so claiming it as "sent" would be a lie. A 304 is the opposite
        // case — a response that completed and deliberately carried no body — so its
        // caller states the zero. `??` and not `||`, because `0 || null` is null, and
        // recording a zero that is a fact as the null that means "unknowable" is the
        // very confusion this line exists to avoid.
        bytesSent: aborted
          ? null
          : (extra.bytesSent ?? (Number(reply.getHeader('content-length')) || null)),
        totalBytes: extra.totalBytes ?? null,
        rangeHeader: request.headers.range ?? null,
        userAgent: request.headers['user-agent'] ?? null,
        error: aborted
          ? 'The app disconnected before the transfer finished, so this download is incomplete.'
          : (extra.error ?? explainFailure(reply.statusCode, extra)),
      });
    };
    reply.raw.once('finish', () => settle(false));
    reply.raw.once('close', () => settle(!reply.raw.writableFinished));
  }

  /**
   * A sentence for a failure nobody explained.
   *
   * Reading the file can still fail *after* the size check passed — the file is
   * deleted or the share drops between the two — and that arrives here as a bare
   * 500 from the static handler. A failure row with no reason is exactly as useless
   * as the silence this feature was built to replace, so every one gets a sentence.
   */
  function explainFailure(statusCode, { name } = {}) {
    if (!statusCode || statusCode < 400) return null;
    const file = name ? `\`${name}\`` : 'this file';
    if (statusCode >= 500) {
      return `SelfPod began sending ${file} and then could not finish reading it. The file may have been moved, deleted or made unreadable while it was being sent, or the storage it lives on became unavailable.`;
    }
    if (statusCode === 416) {
      return `A podcast app asked for a part of ${file} that does not exist. This usually means the app cached an older, longer version of the episode.`;
    }
    return `${file} could not be served (HTTP ${statusCode}).`;
  }
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
    const summary = health.summary({ version: VERSION });

    // `?ping=` lets the reachability check prove the public address reaches *this*
    // instance and not merely something that answers like SelfPod — an old container
    // left running, or a second install. Echoing the nonce would prove nothing,
    // since every SelfPod would echo it; the reply is therefore signed with a key
    // only this install holds. Input is restricted to a short alphanumeric token, so
    // nothing else can be reflected or signed.
    const ping = request.query?.ping;
    if (typeof ping === 'string' && /^[A-Za-z0-9]{1,64}$/.test(ping)) {
      return { ...summary, ping, pong: signPing(settings.sessionSecret(), ping) };
    }
    return summary;
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

    // Set before the answer is chosen, so a 304 carries its validators too. A 304 that
    // omits them leaves the app with nothing to revalidate against next time — the
    // cover route has always got this right and the feed never did. `vary` is what
    // stops a shared cache handing a compressed body to a client that never asked.
    reply
      .header('etag', built.etag)
      .header('last-modified', built.lastModified.toUTCString())
      // Short: a podcast app polling every few minutes should see edits quickly.
      .header('cache-control', 'public, max-age=60, must-revalidate')
      .header('vary', 'accept-encoding');

    // If-None-Match decides on its own when present; If-Modified-Since is consulted
    // only in its absence. An ETag is a statement about the bytes and a date is a guess
    // about them, and the two disagreeing is not this handler's to arbitrate.
    const ifNoneMatch = request.headers['if-none-match'];
    const stillFresh =
      ifNoneMatch === undefined
        ? notModifiedSince(request.headers['if-modified-since'], built.lastModified)
        : etagMatches(ifNoneMatch, built.etag);

    if (stillFresh) {
      // Recorded, and recorded *before* the reply goes out. This used to return above
      // trackAccess, so an app polling every fifteen minutes and correctly getting 304s
      // was invisible here — and the show page reported a "last checked" that could be
      // days stale while the app was doing everything right.
      trackAccess(request, reply, { kind: ACCESS_KIND.FEED, showId: show.id, bytesSent: 0 });
      return reply.status(304).send();
    }

    reply.type('application/rss+xml; charset=utf-8');

    // Negotiated here and nowhere else, which is what keeps compression away from
    // /media: that route serves already-compressed audio with byte ranges.
    const coding = preferredEncoding(request.headers['accept-encoding']);
    const body = coding ? built.encoded[coding] : null;
    if (body) reply.header('content-encoding', coding);

    trackAccess(request, reply, { kind: ACCESS_KIND.FEED, showId: show.id });
    return body ?? built.xml;
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

    // Same containment rule as episode audio: artwork is a file from a network
    // share, so a symlink there must not become a way to read the host.
    const resolvedCover = await resolveContained(shows.dirFor(show), show.cover_filename);
    if (!resolvedCover.path) {
      request.log.warn(
        { file: show.cover_filename, show: show.slug, reason: resolvedCover.reason },
        'artwork could not be served from inside its show folder',
      );
      throw notFound('No artwork for this show.', 'no_cover');
    }
    const path = resolvedCover.path;

    // Named for what it is, and to avoid shadowing the stats service.
    let coverStats;
    try {
      coverStats = await stat(path);
    } catch {
      throw notFound('No artwork for this show.', 'no_cover');
    }

    const etag = await covers.etag(path);
    // The same two fixes as the feed above, for the same reasons: a validator rewritten
    // in transit still has to match, and a conditional fetch is still a fetch. Two
    // routes answering the same question differently is where the next bug hides.
    if (etagMatches(request.headers['if-none-match'], etag)) {
      reply.header('etag', etag);
      trackAccess(request, reply, {
        kind: ACCESS_KIND.COVER,
        showId: show.id,
        totalBytes: coverStats.size,
        name: show.cover_filename,
        bytesSent: 0,
      });
      return reply.status(304).send();
    }

    reply
      .header('content-type', covers.mimeTypeFor(show.cover_filename))
      // Deliberately short (spec §10.3): artwork changes, and a long max-age at a
      // CDN meant an updated cover stayed stale for a day. The ETag is what keeps
      // well-behaved caches from re-downloading unchanged art anyway.
      .header('cache-control', 'public, max-age=3600');
    if (etag) reply.header('etag', etag);

    // Opting out of the static plugin's own content-type, caching and ETag is
    // what lets the headers above survive: left to itself it would send
    // `public, max-age=0` and a size/mtime ETag instead of a content hash.
    trackAccess(request, reply, {
      kind: ACCESS_KIND.COVER,
      showId: show.id,
      totalBytes: coverStats.size,
      name: show.cover_filename,
    });
    return reply.sendFile(basename(path), dirname(path), {
      cacheControl: false,
      contentType: false,
      etag: false,
    });
  });

  /**
   * Per-episode artwork, from the cache the scanner fills in `/data/.art`.
   *
   * The literal `cover.jpg` sits exactly where the audio route's `:filename`
   * parameter is, one segment deeper than the show cover. A static segment beats a
   * parametric one in Fastify's router, so this wins — and there is a test asserting
   * it rather than a comment trusting it, because "which route matched" is not the
   * kind of thing that should be discovered from a 404 in production.
   *
   * No content hashing per request: the ETag is the `art_etag` column, and only the
   * scanner writes this file — in the same step that updates that column.
   */
  fastify.get('/media/:slug/:token/:episodeId/cover.jpg', async (request, reply) => {
    const { slug, token, episodeId } = request.params;
    const show = resolveShow(slug, token);

    const episode = episodes.get(episodeId);
    if (!episode || episode.show_id !== show.id) throw notFound('No artwork here.', 'no_cover');
    if (episode.status === EPISODE_STATUS.REMOVED) throw notFound('No artwork here.', 'no_cover');
    // An episode with no artwork of its own is not an error: the feed points such an
    // item at the show cover, so nothing should ever ask for this URL.
    if (!episode.art_filename) throw notFound('No artwork for this episode.', 'no_cover');

    // Same containment rule as the two routes around it. This directory is SelfPod's
    // own and holds no symlinks, but `art_filename` is a database value, and a
    // restored or hand-edited database is exactly the input this check exists for.
    const resolvedArt = await resolveContained(
      join(config.episodeArtDir, episode.show_id),
      episode.art_filename,
    );
    if (!resolvedArt.path) {
      request.log.warn(
        { file: episode.art_filename, show: show.slug, reason: resolvedArt.reason },
        'episode artwork could not be served from inside the artwork cache',
      );
      throw notFound('No artwork for this episode.', 'no_cover');
    }
    const path = resolvedArt.path;

    let artStats;
    try {
      artStats = await stat(path);
    } catch {
      throw notFound('No artwork for this episode.', 'no_cover');
    }

    // Quoted here rather than in the column, so the stored value stays a plain hash
    // that the feed can use as a `?v=` buster without stripping anything.
    const etag = episode.art_etag ? `"${episode.art_etag}"` : null;
    if (etagMatches(request.headers['if-none-match'], etag)) {
      reply.header('etag', etag);
      trackAccess(request, reply, {
        kind: ACCESS_KIND.COVER,
        showId: show.id,
        episodeId: episode.id,
        totalBytes: artStats.size,
        name: episode.art_filename,
        bytesSent: 0,
      });
      return reply.status(304).send();
    }

    reply
      .header('content-type', imageMimeType(episode.art_filename) ?? 'application/octet-stream')
      // The same hour as the show cover, for the same reason: artwork changes, and
      // the ETag is what stops well-behaved caches refetching what has not.
      .header('cache-control', 'public, max-age=3600');
    if (etag) reply.header('etag', etag);

    // `kind` is deliberately COVER and not a new kind of its own. Artwork is artwork
    // as far as every existing statistics query is concerned, and adding a fifth kind
    // would split each of them for a distinction nobody has asked to see. The episode
    // id rides along, so the split is still available to anyone who wants it later.
    trackAccess(request, reply, {
      kind: ACCESS_KIND.COVER,
      showId: show.id,
      episodeId: episode.id,
      totalBytes: artStats.size,
      name: episode.art_filename,
    });
    return reply.sendFile(basename(path), dirname(path), {
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

    // The original, or the copy with the approved adverts cut out of it. The same
    // function the feed used to state this episode's length, so the size advertised
    // and the size served cannot disagree — which matters here more than anywhere
    // else, because this route answers byte-range requests against it.
    const audio = publishedAudio(episode);
    if (!isSafeFilename(audio.filename)) throw notFound('No episode here.', 'not_found');

    const sourceDir = audio.isTrimmed
      ? join(config.trimmedDir, episode.show_id)
      : shows.dirFor(show);
    // Resolves symlinks and proves the result is genuinely inside the folder it should
    // be in. A lexical prefix check is not sufficient: `/data/shows` is usually a
    // network share, and a symlink placed there by anyone who can write to it would
    // otherwise publish a file from elsewhere on the host through this feed. The
    // trimmed directory is SelfPod's own and holds no symlinks, but it is on the same
    // volume as the share, and the check costs one `realpath`.
    const showDir = sourceDir;
    const resolved = await resolveContained(sourceDir, audio.filename);

    /**
     * One place to record a file that could not be served, in the owner's language.
     * A subscriber failing to download is exactly the event they need to see, and it
     * used to be invisible here.
     */
    const refuse = (error, code) => {
      request.log.warn({ file: audio.filename, show: show.slug, code }, error);
      if (!isOwnRequest(request)) {
        stats?.record({
          kind: ACCESS_KIND.DOWNLOAD,
          episodeId: episode.id,
          showId: show.id,
          statusCode: 404,
          rangeHeader: request.headers.range ?? null,
          userAgent: request.headers['user-agent'] ?? null,
          error,
        });
      }
      return notFound(
        'That episode file is not readable right now.',
        code === 'EACCES' ? 'permission_denied' : 'file_missing',
      );
    };

    if (!resolved.path) {
      if (resolved.reason === 'escapes') {
        throw refuse(
          `${audio.filename} does not resolve to a file inside this show's folder, so SelfPod refused to serve it. If it is a symlink pointing elsewhere on the host, replace it with the real file — SelfPod only serves what is genuinely in the folder.`,
          null,
        );
      }
      if (resolved.code === 'EACCES') {
        throw refuse(
          `Permission denied reading ${audio.filename} as UID ${config.runtimeUid ?? config.puid}.`,
          'EACCES',
        );
      }
      throw refuse(`${audio.filename} is not on disk.`, resolved.code);
    }

    const absolute = resolved.path;
    let fileStats;
    try {
      fileStats = await stat(absolute);
    } catch (err) {
      throw refuse(
        err.code === 'EACCES'
          ? `Permission denied reading ${audio.filename} as UID ${config.runtimeUid ?? config.puid}.`
          : `${audio.filename} is not on disk.`,
        err.code,
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
      //
      // While a trim is outstanding these bytes are the ones this episode is about to
      // stop having. The swap is versioned, so a cached copy is stale rather than
      // corrupt — but a day is a long time to keep handing out adverts the owner has
      // already told SelfPod to remove.
      .header(
        'cache-control',
        episode.trim_status === TRIM_STATUS.PENDING || episode.trim_status === TRIM_STATUS.TRIMMING
          ? 'private, no-cache'
          : 'private, max-age=86400',
      )
      // Named after the original either way: a listener saving the file wants the
      // episode's name, not SelfPod's internal one for the copy.
      .header('content-disposition', contentDisposition(episode.filename));

    // A range request is a player streaming or seeking; a plain GET is an app
    // fetching the episode for offline listening. They are counted separately
    // because conflating them makes the download figure meaningless.
    const kind = request.headers.range ? ACCESS_KIND.STREAM : ACCESS_KIND.DOWNLOAD;
    trackAccess(request, reply, {
      kind,
      episodeId: episode.id,
      showId: show.id,
      totalBytes: fileStats.size,
      name: audio.filename,
    });

    // Range handling (206 responses, `Accept-Ranges`, 416 for an unsatisfiable
    // range) comes from the static plugin — hand-rolling it is how seeking breaks.
    // Only its content-type and caching are overridden.
    //
    // The *resolved* path is handed over, not the stored filename: passing the name
    // again would make the static handler walk the symlink a second time, after the
    // containment check, and re-open the question that check just answered.
    return reply.sendFile(basename(absolute), dirname(absolute), {
      cacheControl: false,
      contentType: false,
    });
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
