import { nowIso } from '../lib/dates.js';

/**
 * Play and download statistics.
 *
 * What counts as a "download" in podcasting is genuinely ambiguous — a player that
 * seeks around a file issues many range requests, and counting each as a download
 * would inflate the numbers to the point of uselessness. So two things are counted
 * separately:
 *
 *  - a **download**: a request for the whole file, which is what a podcast app does
 *    when it fetches an episode for offline listening;
 *  - a **stream**: a range request, which is what a player does when it starts
 *    playing without downloading first, or seeks.
 *
 * Neither is a "listen" — no server can know that — and the UI says so rather than
 * implying otherwise.
 *
 * Failures are recorded too, and that is arguably the more valuable half: an episode
 * that fails to download was previously invisible here, discoverable only by someone
 * noticing it in their podcast app.
 */

/** What an episode nobody has fetched yet looks like — a real zero, not a null. */
export const NO_ACCESS = Object.freeze({
  downloads: 0,
  streams: 0,
  failures: 0,
  bytes: 0,
  lastAt: null,
});

/** Kinds of access worth distinguishing in the log. */
export const ACCESS_KIND = Object.freeze({
  DOWNLOAD: 'download',
  STREAM: 'stream',
  COVER: 'cover',
  FEED: 'feed',
});

/**
 * Coarse client identification.
 *
 * Storing raw user agents would mean keeping a long, needlessly identifying string
 * for every request; the family is what actually answers "which app is this?".
 */
const CLIENT_PATTERNS = [
  [/pocketcasts|pocket casts/i, 'Pocket Casts'],
  [/overcast/i, 'Overcast'],
  [/castro/i, 'Castro'],
  [/antennapod/i, 'AntennaPod'],
  [/podcastaddict/i, 'Podcast Addict'],
  [/downcast/i, 'Downcast'],
  [/breaker/i, 'Breaker'],
  [/spotify/i, 'Spotify'],
  [/itunes|apple ?podcasts|itms|applecoremedia|podcasts\//i, 'Apple Podcasts'],
  [/watchos|ios|iphone|ipad/i, 'iOS'],
  [/android/i, 'Android'],
  [/vlc/i, 'VLC'],
  [/curl|wget|httpie/i, 'Command line'],
  [/mozilla|chrome|safari|firefox|edge/i, 'Browser'],
];

export function classifyClient(userAgent) {
  if (!userAgent) return 'Unknown';
  for (const [pattern, label] of CLIENT_PATTERNS) {
    if (pattern.test(userAgent)) return label;
  }
  return 'Other';
}

export function createStats({ db, logger }) {
  const insert = db.prepare(
    `INSERT INTO media_access
       (episode_id, show_id, requested_at, kind, status_code, bytes_sent, total_bytes, range_header, client, error)
     VALUES (@episodeId, @showId, @requestedAt, @kind, @statusCode, @bytesSent, @totalBytes, @rangeHeader, @client, @error)`,
  );

  const trimOld = db.prepare('DELETE FROM media_access WHERE requested_at < ?');

  const api = {
    /** Records one access. Never throws: statistics must not break media serving. */
    record({
      episodeId = null,
      showId = null,
      kind,
      statusCode,
      bytesSent = null,
      totalBytes = null,
      rangeHeader = null,
      userAgent = null,
      error = null,
    }) {
      try {
        insert.run({
          episodeId,
          showId,
          requestedAt: nowIso(),
          kind,
          statusCode,
          bytesSent,
          totalBytes,
          // Kept verbatim but truncated: the exact range is what shows whether a
          // player was seeking or a download was resumed.
          rangeHeader: rangeHeader ? String(rangeHeader).slice(0, 80) : null,
          client: classifyClient(userAgent),
          error: error ? String(error).slice(0, 500) : null,
        });
      } catch (err) {
        logger?.debug({ err }, 'could not record a media access; serving is unaffected');
      }
    },

    /** Totals for one episode. */
    forEpisode(episodeId) {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN kind = 'download' AND status_code < 400 THEN 1 ELSE 0 END) AS downloads,
             SUM(CASE WHEN kind = 'stream'   AND status_code < 400 THEN 1 ELSE 0 END) AS streams,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failures,
             SUM(COALESCE(bytes_sent, 0)) AS bytes,
             MAX(requested_at) AS lastAt
           FROM media_access
           WHERE episode_id = ? AND kind IN ('download','stream')`,
        )
        .get(episodeId);
      return {
        downloads: row?.downloads ?? 0,
        streams: row?.streams ?? 0,
        failures: row?.failures ?? 0,
        bytes: row?.bytes ?? 0,
        lastAt: row?.lastAt ?? null,
      };
    },

    /** Totals for every episode of a show, keyed by episode id. */
    forShowEpisodes(showId) {
      const rows = db
        .prepare(
          `SELECT episode_id AS episodeId,
                  SUM(CASE WHEN kind = 'download' AND status_code < 400 THEN 1 ELSE 0 END) AS downloads,
                  SUM(CASE WHEN kind = 'stream'   AND status_code < 400 THEN 1 ELSE 0 END) AS streams,
                  SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failures,
                  SUM(COALESCE(bytes_sent, 0)) AS bytes,
                  MAX(requested_at) AS lastAt
             FROM media_access
            WHERE show_id = ? AND kind IN ('download','stream')
            GROUP BY episode_id`,
        )
        .all(showId);
      return Object.fromEntries(rows.map((row) => [row.episodeId, row]));
    },

    /** Show-level rollup, including how many distinct episodes saw any traffic. */
    forShow(showId) {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN kind = 'download' AND status_code < 400 THEN 1 ELSE 0 END) AS downloads,
             SUM(CASE WHEN kind = 'stream'   AND status_code < 400 THEN 1 ELSE 0 END) AS streams,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failures,
             SUM(COALESCE(bytes_sent, 0)) AS bytes,
             COUNT(DISTINCT episode_id) AS episodesTouched,
             MAX(requested_at) AS lastAt
           FROM media_access
           WHERE show_id = ? AND kind IN ('download','stream')`,
        )
        .get(showId);
      const feedFetches = db
        .prepare(
          `SELECT COUNT(*) AS n, MAX(requested_at) AS lastAt
             FROM media_access WHERE show_id = ? AND kind = 'feed' AND status_code < 400`,
        )
        .get(showId);
      const clients = db
        .prepare(
          `SELECT client, COUNT(*) AS n
             FROM media_access
            WHERE show_id = ? AND kind IN ('download','stream') AND status_code < 400
            GROUP BY client ORDER BY n DESC LIMIT 5`,
        )
        .all(showId);
      return {
        downloads: row?.downloads ?? 0,
        streams: row?.streams ?? 0,
        failures: row?.failures ?? 0,
        bytes: row?.bytes ?? 0,
        episodesTouched: row?.episodesTouched ?? 0,
        lastAt: row?.lastAt ?? null,
        feedFetches: feedFetches?.n ?? 0,
        feedLastAt: feedFetches?.lastAt ?? null,
        clients,
      };
    },

    /** Instance-wide rollup for the dashboard. */
    overview() {
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN kind = 'download' AND status_code < 400 THEN 1 ELSE 0 END) AS downloads,
             SUM(CASE WHEN kind = 'stream'   AND status_code < 400 THEN 1 ELSE 0 END) AS streams,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS failures,
             SUM(COALESCE(bytes_sent, 0)) AS bytes,
             MAX(requested_at) AS lastAt
           FROM media_access WHERE kind IN ('download','stream')`,
        )
        .get();
      return {
        downloads: row?.downloads ?? 0,
        streams: row?.streams ?? 0,
        failures: row?.failures ?? 0,
        bytes: row?.bytes ?? 0,
        lastAt: row?.lastAt ?? null,
      };
    },

    /**
     * The most fetched episodes across every show.
     *
     * Ordered by downloads first: a completed download is a stronger signal of
     * interest than a stream, of which one listener can generate dozens by seeking.
     */
    busiest(limit = 10) {
      return db
        .prepare(
          `SELECT a.episode_id AS episodeId,
                  e.title AS title,
                  s.title AS showTitle,
                  s.slug AS showSlug,
                  SUM(CASE WHEN a.kind = 'download' AND a.status_code < 400 THEN 1 ELSE 0 END) AS downloads,
                  SUM(CASE WHEN a.kind = 'stream'   AND a.status_code < 400 THEN 1 ELSE 0 END) AS streams,
                  SUM(COALESCE(a.bytes_sent, 0)) AS bytes,
                  MAX(a.requested_at) AS lastAt
             FROM media_access a
             JOIN episodes e ON e.id = a.episode_id
             JOIN shows s ON s.id = a.show_id
            WHERE a.kind IN ('download','stream') AND a.status_code < 400
            GROUP BY a.episode_id
            ORDER BY downloads DESC, streams DESC, bytes DESC
            LIMIT ?`,
        )
        .all(Math.min(Math.max(1, limit), 100));
    },

    /** The raw log, newest first — the "what actually happened" view. */
    list({ showId = null, episodeId = null, failuresOnly = false, limit = 50, offset = 0 } = {}) {
      const clauses = [];
      const params = { limit: Math.min(Math.max(1, limit), 500), offset: Math.max(0, offset) };
      if (showId) {
        clauses.push('a.show_id = @showId');
        params.showId = showId;
      }
      if (episodeId) {
        clauses.push('a.episode_id = @episodeId');
        params.episodeId = episodeId;
      }
      if (failuresOnly) clauses.push('a.status_code >= 400');
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

      return db
        .prepare(
          `SELECT a.*, e.title AS episode_title, e.filename AS episode_filename,
                  s.title AS show_title, s.slug AS show_slug
             FROM media_access a
             LEFT JOIN episodes e ON e.id = a.episode_id
             LEFT JOIN shows s ON s.id = a.show_id
             ${where}
             ORDER BY a.requested_at DESC, a.id DESC
             LIMIT @limit OFFSET @offset`,
        )
        .all(params)
        .map((row) => ({
          ...row,
          requestedAt: row.requested_at,
          statusCode: row.status_code,
          bytesSent: row.bytes_sent,
          totalBytes: row.total_bytes,
          rangeHeader: row.range_header,
          episodeTitle: row.episode_title,
          episodeFilename: row.episode_filename,
          showTitle: row.show_title,
          showSlug: row.show_slug,
          ok: row.status_code < 400,
          // A download that stopped well short of the file is worth flagging even
          // though the response itself succeeded — that is what a failed download
          // in a podcast app looks like from the server's side.
          incomplete:
            row.kind === 'download' &&
            row.status_code < 400 &&
            row.total_bytes > 0 &&
            row.bytes_sent !== null &&
            row.bytes_sent < row.total_bytes * 0.98,
        }));
    },

    count({ showId = null, episodeId = null, failuresOnly = false } = {}) {
      const clauses = [];
      const params = {};
      if (showId) {
        clauses.push('show_id = @showId');
        params.showId = showId;
      }
      if (episodeId) {
        clauses.push('episode_id = @episodeId');
        params.episodeId = episodeId;
      }
      if (failuresOnly) clauses.push('status_code >= 400');
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return db.prepare(`SELECT COUNT(*) AS n FROM media_access ${where}`).get(params).n;
    },

    /** Recent failures, for the surface that has to make them impossible to miss. */
    recentFailures(limit = 10) {
      return api.list({ failuresOnly: true, limit });
    },

    /** Keeps the log bounded; the default keeps a year, which is plenty of history. */
    trim(days = 365) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const info = trimOld.run(cutoff);
      if (info.changes) logger?.debug({ removed: info.changes }, 'trimmed the media access log');
      return info.changes;
    },
  };

  return api;
}
