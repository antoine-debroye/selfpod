import { SHOW_STATUS } from '../constants.js';
import { publishedAudio } from '../lib/published-audio.js';
import { coverUrl, episodeArtUrl, feedUrl, mediaUrl } from '../lib/urls.js';
import { NO_ACCESS } from './stats.js';

/**
 * Turns database rows into the shape the API returns and the templates render.
 *
 * There is exactly one presenter so the JSON API and the server-rendered pages
 * can never drift: a field the dashboard relies on is the same field an API
 * consumer sees.
 */
/**
 * Which failed readiness checks earn a warning on the dashboard card.
 *
 * Deliberately not all of them. The card badge answers "is SelfPod working for this
 * show", asked on every visit; readiness answers "would a podcast directory accept
 * this", asked once per show. Most SelfPod feeds are private and will never be
 * submitted anywhere, so lighting the dashboard for every one of them is the banner
 * this project has already walked back twice. These are the same five conditions the
 * card has always shown — readiness now owns the wording, so the two cannot drift.
 */
const BADGE_CHECKS = new Set([
  'folder_present',
  'artwork_present',
  'artwork_size',
  'owner_email',
  'author_name',
]);

export function createPresenters({ settings, shows, episodes, covers, activity, stats, readiness }) {
  function presentShow(show, { includeEpisodes = false, includeReadiness = false } = {}) {
    const baseUrl = settings.publicBaseUrl();
    const counts = episodes.counts(show.id);
    const lastScan = activity.latestForShow(show.id);
    const coverWarning =
      show.cover_filename && show.cover_width
        ? covers.describeDimensions({ width: show.cover_width, height: show.cover_height })
        : null;

    const folder = shows.dirFor(show);

    // One computation of "this show has no cover", not two. Readiness owns the
    // conditions and their wording; this picks which of them are worth a card warning.
    const report = readiness.forShow(show, { counts, baseUrl, folder });
    const warnings = report.failed
      .filter((check) => BADGE_CHECKS.has(check.id))
      .map((check) => ({ key: check.id, message: check.detail }));

    const errorCount = lastScan?.errors?.length ?? 0;
    const tokenPath = `${encodeURIComponent(show.slug)}/${encodeURIComponent(show.feed_token)}`;

    return {
      id: show.id,
      slug: show.slug,
      title: show.title,
      description: show.description,
      authorName: show.author_name,
      authorEmail: show.author_email,
      language: show.language,
      category: show.itunes_category,
      subcategory: show.itunes_subcategory,
      explicit: show.explicit === 1,
      itunesType: show.itunes_type ?? 'episodic',
      directoryListing: show.directory_listing ?? 'allowed',
      status: show.status,
      folderMissingSince: show.folder_missing_since,
      folder,
      cover: show.cover_filename
        ? {
            filename: show.cover_filename,
            width: show.cover_width,
            height: show.cover_height,
            format: show.cover_format,
            url: baseUrl
              ? coverUrl(baseUrl, show.slug, show.feed_token, { cacheBust: show.cover_mtime })
              : null,
            // Same-origin variant, so the admin UI shows artwork even before a
            // public base URL has been configured.
            localUrl: `/media/${tokenPath}/cover.jpg?v=${encodeURIComponent(show.cover_mtime ?? '')}`,
            warning: coverWarning,
            needsResize: Boolean(coverWarning),
          }
        : null,
      feedUrl: baseUrl ? feedUrl(baseUrl, show.slug, show.feed_token) : null,
      feedToken: show.feed_token,
      counts,
      warnings,
      // The summary always; the full list only where one show is being looked at, since
      // fifty shows' worth of mostly-passing rows is a lot of payload nobody asked for.
      readiness: {
        ready: report.ready,
        blocking: report.blocking,
        advisory: report.advisory,
        ...(includeReadiness ? { checks: report.checks } : {}),
      },
      health: errorCount > 0 ? 'error' : warnings.length > 0 ? 'warn' : 'ok',
      lastScan: lastScan
        ? {
            id: lastScan.id,
            finishedAt: lastScan.finishedAt,
            trigger: lastScan.trigger,
            added: lastScan.added,
            errors: lastScan.errors,
            warnings: lastScan.warnings,
          }
        : null,
      createdAt: show.created_at,
      updatedAt: show.updated_at,
      stats: stats?.forShow(show.id) ?? null,
      ...(includeEpisodes ? { episodes: presentEpisodesOf(show) } : {}),
    };
  }

  /**
   * Every episode of a show, with its access counts attached.
   *
   * The counts are fetched as one grouped query rather than per episode: a show
   * with 300 episodes would otherwise issue 300 queries to render one page.
   */
  function presentEpisodesOf(show) {
    const access = stats?.forShowEpisodes(show.id) ?? {};
    return episodes
      .listByShow(show.id)
      // An episode with no rows gets an explicit zero rather than being left to
      // fall through to a per-episode lookup, which would reintroduce the N+1.
      .map((episode) => presentEpisode(episode, show, { access: access[episode.id] ?? NO_ACCESS }));
  }

  function presentEpisode(episode, show, { access } = {}) {
    const baseUrl = settings.publicBaseUrl();
    const tokenPath = `${encodeURIComponent(show.slug)}/${encodeURIComponent(show.feed_token)}`;
    const audio = publishedAudio(episode);
    return {
      id: episode.id,
      showId: episode.show_id,
      showSlug: show.slug,
      filename: episode.filename,
      title: episode.title,
      titleIsCustom: episode.title_is_custom === 1,
      description: episode.description,
      season: episode.season,
      episodeNumber: episode.episode_number,
      explicit: episode.explicit === null ? null : episode.explicit === 1,
      episodeType: episode.episode_type ?? 'full',
      resolvedExplicit: episodes.resolveExplicit(episode, show),
      pubDate: episode.pub_date,
      pubDateIsCustom: episode.pub_date_is_custom === 1,
      durationSeconds: episode.duration_seconds,
      bitrateKbps: episode.bitrate_kbps,
      fileSizeBytes: episode.file_size_bytes,
      mimeType: episode.mime_type,
      status: episode.status,
      // Derived, not stored — see episodes.isScheduled. A consumer that wants the rule
      // rather than the answer has pubDate right here.
      scheduled: episodes.isScheduled(episode),
      missingSince: episode.missing_since,
      // When SelfPod first saw the file, as opposed to the editorial publication date.
      // "Did my drop just get picked up?" is asked far more often than it is answered.
      createdAt: episode.created_at,
      removedAt: episode.removed_at,
      /*
       * The audio a subscriber actually gets: the original, or the copy with the
       * approved adverts cut out of it. Both URLs carry the content version, because
       * the media route *checks* it — the absence of one is the claim "the untrimmed
       * copy", and a page that linked an episode without it after it had been cut got
       * a 404 and a player that did nothing at all.
       */
      published: {
        isTrimmed: audio.isTrimmed,
        durationSeconds: audio.durationSeconds,
        sizeBytes: audio.sizeBytes,
        version: audio.version,
      },
      mediaUrl: baseUrl
        ? mediaUrl(baseUrl, show.slug, show.feed_token, episode.id, episode.filename, {
            cacheBust: audio.version ?? undefined,
          })
        : null,
      /*
       * For the admin's own player. It resolves the published copy when it is played
       * rather than when the page was drawn, so a re-cut between the two does not
       * leave a player that silently does nothing.
       */
      localMediaUrl: `/api/episodes/${encodeURIComponent(episode.id)}/audio`,
      // Null means "this episode uses the show's cover", which is what the feed does
      // for it too. The warning is the same arithmetic on the same numbers as a show
      // cover's, only labelled for an episode — see covers.describeDimensions.
      art: episode.art_filename
        ? {
            source: episode.art_source,
            sidecarName: episode.art_sidecar_name,
            width: episode.art_width,
            height: episode.art_height,
            url: baseUrl
              ? episodeArtUrl(baseUrl, show.slug, show.feed_token, episode.id, {
                  cacheBust: episode.art_etag,
                })
              : null,
            localUrl: `/media/${tokenPath}/${encodeURIComponent(episode.id)}/cover.jpg?v=${encodeURIComponent(
              episode.art_etag ?? '',
            )}`,
            warning: covers.describeDimensions(
              { width: episode.art_width, height: episode.art_height },
              { label: 'Episode artwork' },
            ),
          }
        : null,
      updatedAt: episode.updated_at,
      // Supplied by the caller when a whole list is being presented; looked up
      // otherwise, so a single episode still carries its numbers.
      stats: access ?? stats?.forEpisode(episode.id) ?? null,
    };
  }

  return { presentShow, presentEpisode };
}
