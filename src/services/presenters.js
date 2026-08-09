import { SHOW_STATUS } from '../constants.js';
import { coverUrl, feedUrl, mediaUrl } from '../lib/urls.js';

/**
 * Turns database rows into the shape the API returns and the templates render.
 *
 * There is exactly one presenter so the JSON API and the server-rendered pages
 * can never drift: a field the dashboard relies on is the same field an API
 * consumer sees.
 */
export function createPresenters({ settings, shows, episodes, covers, activity }) {
  function presentShow(show, { includeEpisodes = false } = {}) {
    const baseUrl = settings.publicBaseUrl();
    const counts = episodes.counts(show.id);
    const lastScan = activity.latestForShow(show.id);
    const coverWarning =
      show.cover_filename && show.cover_width
        ? covers.describeDimensions({ width: show.cover_width, height: show.cover_height })
        : null;

    const folder = shows.dirFor(show);
    const warnings = [];

    if (show.status === SHOW_STATUS.FOLDER_MISSING) {
      warnings.push({
        key: 'folder_missing',
        message: `The folder \`${folder}\` is gone, so this feed is paused. Put the folder back, or remove the show.`,
      });
    }
    if (!show.cover_filename) {
      warnings.push({
        key: 'no_cover',
        message: `No cover art yet. Drop a cover.jpg (or .png/.webp) into ${folder}, or upload one here.`,
      });
    }
    if (coverWarning) {
      warnings.push({ key: 'cover_dimensions', message: coverWarning.message, detail: coverWarning });
    }
    if (!show.author_email?.trim()) {
      warnings.push({
        key: 'no_owner_email',
        message: 'Add an author email — podcast directories require one to verify ownership.',
      });
    }
    if (!show.author_name?.trim()) {
      warnings.push({
        key: 'no_author_name',
        message: `No author name set, so the feed falls back to the show title. Set one here, or in Settings as a default for every show.`,
      });
    }

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
      ...(includeEpisodes
        ? { episodes: episodes.listByShow(show.id).map((episode) => presentEpisode(episode, show)) }
        : {}),
    };
  }

  function presentEpisode(episode, show) {
    const baseUrl = settings.publicBaseUrl();
    const tokenPath = `${encodeURIComponent(show.slug)}/${encodeURIComponent(show.feed_token)}`;
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
      resolvedExplicit: episodes.resolveExplicit(episode, show),
      pubDate: episode.pub_date,
      pubDateIsCustom: episode.pub_date_is_custom === 1,
      durationSeconds: episode.duration_seconds,
      bitrateKbps: episode.bitrate_kbps,
      fileSizeBytes: episode.file_size_bytes,
      mimeType: episode.mime_type,
      status: episode.status,
      missingSince: episode.missing_since,
      mediaUrl: baseUrl
        ? mediaUrl(baseUrl, show.slug, show.feed_token, episode.id, episode.filename)
        : null,
      localMediaUrl: `/media/${tokenPath}/${encodeURIComponent(episode.id)}/${encodeURIComponent(episode.filename)}`,
      updatedAt: episode.updated_at,
    };
  }

  return { presentShow, presentEpisode };
}
