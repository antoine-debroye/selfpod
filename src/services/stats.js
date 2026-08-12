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

/**
 * Sortable columns for the access log.
 *
 * A map rather than string interpolation: the text that reaches the SQL is always one
 * of these literals, never anything a query string supplied. `bytes_sent` is coalesced
 * so a null (an aborted request that sent nothing measurable) sorts as zero instead of
 * drifting to one end depending on direction.
 */
const SORT_COLUMNS = Object.freeze({
  time: 'a.requested_at',
  bytes: 'COALESCE(a.bytes_sent, 0)',
  status: 'a.status_code',
  kind: 'a.kind',
  client: 'a.client',
});

const SORT_DIRECTIONS = Object.freeze({ asc: 'ASC', desc: 'DESC' });

/** The sort keys a caller may ask for, for whoever has to validate a query string. */
export const SORT_KEYS = Object.freeze(Object.keys(SORT_COLUMNS));

const KINDS = new Set(Object.values(ACCESS_KIND));

/** Ceiling on one `list` call. Sized for the CSV export, not for a page of rows. */
const MAX_LIST_ROWS = 50_000;

/**
 * The one place a media_access filter becomes SQL.
 *
 * `list` and `count` used to build this twice, and differently — one with an `a.`
 * prefix and one without. Two builders that must agree is how a filter gets added to
 * the rows but not the total, and the log then reads "40 of 312" while showing
 * something else entirely. Everything that filters the log goes through here.
 */
function accessWhere({
  showId = null,
  episodeId = null,
  failuresOnly = false,
  from = null,
  to = null,
  kinds = null,
  client = null,
} = {}) {
  const clauses = [];
  const params = {};

  if (showId) {
    clauses.push('a.show_id = @showId');
    params.showId = showId;
  }
  if (episodeId) {
    clauses.push('a.episode_id = @episodeId');
    params.episodeId = episodeId;
  }
  if (failuresOnly) clauses.push('a.status_code >= 400');
  // Half-open, always: a request stamped exactly on the boundary belongs to the period
  // that starts there, so two adjacent ranges never both claim it.
  if (from) {
    clauses.push('a.requested_at >= @from');
    params.from = from;
  }
  if (to) {
    clauses.push('a.requested_at < @to');
    params.to = to;
  }

  // Placeholders are generated from the surviving whitelist entries, so the statement
  // text can only ever be one of a handful of shapes and no caller value is inlined.
  const wanted = (Array.isArray(kinds) ? kinds : []).map(String).filter((kind) => KINDS.has(kind));
  if (wanted.length && wanted.length < KINDS.size) {
    clauses.push(`a.kind IN (${wanted.map((_, i) => `@kind${i}`).join(', ')})`);
    wanted.forEach((kind, i) => {
      params[`kind${i}`] = kind;
    });
  }

  if (client) {
    clauses.push('a.client = @client');
    params.client = client;
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function accessOrder(sort, direction) {
  const column = SORT_COLUMNS[sort] ?? SORT_COLUMNS.time;
  const dir = SORT_DIRECTIONS[String(direction).toLowerCase()] ?? 'DESC';
  // The id tiebreaker is on every sort, not just time. Without it, paging by OFFSET
  // over a column full of ties — every successful request shares status code 200 —
  // reorders between pages, so rows appear twice and others are never seen.
  return `ORDER BY ${column} ${dir}, a.id DESC`;
}

/** Range-only clauses, for the aggregate queries that have their own fixed WHERE. */
function rangeClauses({ from = null, to = null } = {}) {
  const clauses = [];
  const params = {};
  if (from) {
    clauses.push('a.requested_at >= @from');
    params.from = from;
  }
  if (to) {
    clauses.push('a.requested_at < @to');
    params.to = to;
  }
  return { clauses, params };
}

/**
 * Period-over-period change for one figure.
 *
 * A rise from nothing has no percentage. "+100%" measured from zero is a number the
 * app would be inventing, so the change is reported without one and the UI says "new".
 * Direction is reported as a fact; whether up is good is the caller's business — more
 * downloads and more failures are not the same news.
 */
export function changeFrom(current, previous) {
  if (previous === null || previous === undefined) return null;
  const absolute = current - previous;
  return {
    absolute,
    previous,
    percent: previous === 0 ? null : (absolute / previous) * 100,
    direction: absolute === 0 ? 'flat' : absolute > 0 ? 'up' : 'down',
  };
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

    /** Totals for one episode, optionally within a period. */
    forEpisode(episodeId, range = {}) {
      const { clauses, params } = rangeClauses(range);
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN a.kind = 'download' AND a.status_code < 400 THEN 1 ELSE 0 END) AS downloads,
             SUM(CASE WHEN a.kind = 'stream'   AND a.status_code < 400 THEN 1 ELSE 0 END) AS streams,
             SUM(CASE WHEN a.status_code >= 400 THEN 1 ELSE 0 END) AS failures,
             SUM(COALESCE(a.bytes_sent, 0)) AS bytes,
             MAX(a.requested_at) AS lastAt
           FROM media_access a
           WHERE a.episode_id = @episodeId AND a.kind IN ('download','stream')
                 ${clauses.map((clause) => `AND ${clause}`).join(' ')}`,
        )
        .get({ ...params, episodeId });
      return {
        downloads: row?.downloads ?? 0,
        streams: row?.streams ?? 0,
        failures: row?.failures ?? 0,
        bytes: row?.bytes ?? 0,
        lastAt: row?.lastAt ?? null,
      };
    },

    /** Totals for every episode of a show, keyed by episode id. */
    forShowEpisodes(showId, range = {}) {
      const { clauses, params } = rangeClauses(range);
      const rows = db
        .prepare(
          `SELECT a.episode_id AS episodeId,
                  SUM(CASE WHEN a.kind = 'download' AND a.status_code < 400 THEN 1 ELSE 0 END) AS downloads,
                  SUM(CASE WHEN a.kind = 'stream'   AND a.status_code < 400 THEN 1 ELSE 0 END) AS streams,
                  SUM(CASE WHEN a.status_code >= 400 THEN 1 ELSE 0 END) AS failures,
                  SUM(COALESCE(a.bytes_sent, 0)) AS bytes,
                  MAX(a.requested_at) AS lastAt
             FROM media_access a
            WHERE a.show_id = @showId AND a.kind IN ('download','stream')
                  ${clauses.map((clause) => `AND ${clause}`).join(' ')}
            GROUP BY a.episode_id`,
        )
        .all({ ...params, showId });
      return Object.fromEntries(rows.map((row) => [row.episodeId, row]));
    },

    /**
     * Rollups for every show at once, keyed by show id.
     *
     * The stats page used to call `forShow` in a loop, which is four queries per show
     * on a page that renders them all. This is the same fix `forShowEpisodes` already
     * applies to episodes: two grouped queries regardless of how many shows there are.
     * It omits the per-show client list and last-feed-client, which only the show page
     * needs and which `forShow` still provides.
     */
    forShows(range = {}) {
      const { clauses, params } = rangeClauses(range);
      const extra = clauses.map((clause) => `AND ${clause}`).join(' ');

      const media = db
        .prepare(
          `SELECT a.show_id AS showId,
                  SUM(CASE WHEN a.kind = 'download' AND a.status_code < 400 THEN 1 ELSE 0 END) AS downloads,
                  SUM(CASE WHEN a.kind = 'stream'   AND a.status_code < 400 THEN 1 ELSE 0 END) AS streams,
                  SUM(CASE WHEN a.status_code >= 400 THEN 1 ELSE 0 END) AS failures,
                  SUM(COALESCE(a.bytes_sent, 0)) AS bytes,
                  COUNT(DISTINCT a.episode_id) AS episodesTouched,
                  MAX(a.requested_at) AS lastAt
             FROM media_access a
            WHERE a.kind IN ('download','stream') ${extra}
            GROUP BY a.show_id`,
        )
        .all(params);

      const feeds = db
        .prepare(
          `SELECT a.show_id AS showId, COUNT(*) AS feedFetches, MAX(a.requested_at) AS feedLastAt
             FROM media_access a
            WHERE a.kind = 'feed' AND a.status_code < 400 ${extra}
            GROUP BY a.show_id`,
        )
        .all(params);

      const byShow = {};
      for (const row of media) {
        const { showId, ...rest } = row;
        byShow[showId] = { ...rest, feedFetches: 0, feedLastAt: null };
      }
      for (const row of feeds) {
        byShow[row.showId] = {
          ...NO_ACCESS,
          episodesTouched: 0,
          ...byShow[row.showId],
          feedFetches: row.feedFetches,
          feedLastAt: row.feedLastAt,
        };
      }
      return byShow;
    },

    /** Show-level rollup, including how many distinct episodes saw any traffic. */
    forShow(showId, range = {}) {
      const { clauses, params } = rangeClauses(range);
      const extra = clauses.map((clause) => `AND ${clause}`).join(' ');
      const scoped = { ...params, showId };
      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN a.kind = 'download' AND a.status_code < 400 THEN 1 ELSE 0 END) AS downloads,
             SUM(CASE WHEN a.kind = 'stream'   AND a.status_code < 400 THEN 1 ELSE 0 END) AS streams,
             SUM(CASE WHEN a.status_code >= 400 THEN 1 ELSE 0 END) AS failures,
             SUM(COALESCE(a.bytes_sent, 0)) AS bytes,
             COUNT(DISTINCT a.episode_id) AS episodesTouched,
             MAX(a.requested_at) AS lastAt
           FROM media_access a
           WHERE a.show_id = @showId AND a.kind IN ('download','stream') ${extra}`,
        )
        .get(scoped);
      const feedFetches = db
        .prepare(
          `SELECT COUNT(*) AS n, MAX(a.requested_at) AS lastAt
             FROM media_access a
            WHERE a.show_id = @showId AND a.kind = 'feed' AND a.status_code < 400 ${extra}`,
        )
        .get(scoped);
      // Which app last asked, and when. "A new episode is not showing up in my
      // podcast app" is almost always answered by this one fact: podcast apps poll on
      // their own schedule — some of them server-side — so if nothing has fetched the
      // feed since the episode appeared, there is nothing wrong to find.
      const feedLast = db
        .prepare(
          `SELECT a.client AS client, a.requested_at AS at
             FROM media_access a
            WHERE a.show_id = @showId AND a.kind = 'feed' AND a.status_code < 400 ${extra}
            ORDER BY a.requested_at DESC, a.id DESC LIMIT 1`,
        )
        .get(scoped);
      const clients = db
        .prepare(
          `SELECT a.client AS client, COUNT(*) AS n
             FROM media_access a
            WHERE a.show_id = @showId AND a.kind IN ('download','stream')
                  AND a.status_code < 400 ${extra}
            GROUP BY a.client ORDER BY n DESC LIMIT 5`,
        )
        .all(scoped);
      return {
        downloads: row?.downloads ?? 0,
        streams: row?.streams ?? 0,
        failures: row?.failures ?? 0,
        bytes: row?.bytes ?? 0,
        episodesTouched: row?.episodesTouched ?? 0,
        lastAt: row?.lastAt ?? null,
        feedFetches: feedFetches?.n ?? 0,
        feedLastAt: feedFetches?.lastAt ?? null,
        feedLastClient: feedLast?.client ?? null,
        clients,
      };
    },

    /**
     * Instance-wide rollup, optionally within a period and compared with the one
     * before it.
     *
     * When `prevFrom` is given the comparison is one scan of `[prevFrom, to)` split by
     * a CASE rather than two scans of adjacent ranges — the index is seeked once and
     * most of the same pages are read either way.
     */
    overview({ from = null, to = null, prevFrom = null } = {}) {
      const lastEverAt =
        db.prepare(`SELECT MAX(a.requested_at) AS at FROM media_access a`).get()?.at ?? null;

      // All time. Comparing it with anything would mean inventing an earlier period,
      // and a CASE against a null boundary silently reports zeros rather than saying so.
      if (!from || !prevFrom) {
        const row = db
          .prepare(
            `SELECT
               SUM(CASE WHEN a.kind = 'download' AND a.status_code < 400 THEN 1 ELSE 0 END) AS downloads,
               SUM(CASE WHEN a.kind = 'stream'   AND a.status_code < 400 THEN 1 ELSE 0 END) AS streams,
               SUM(CASE WHEN a.status_code >= 400 THEN 1 ELSE 0 END) AS failures,
               SUM(COALESCE(a.bytes_sent, 0)) AS bytes,
               MAX(a.requested_at) AS lastAt
             FROM media_access a WHERE a.kind IN ('download','stream')`,
          )
          .get();
        return {
          downloads: row?.downloads ?? 0,
          streams: row?.streams ?? 0,
          failures: row?.failures ?? 0,
          bytes: row?.bytes ?? 0,
          lastAt: row?.lastAt ?? null,
          lastEverAt,
          previous: null,
          change: null,
        };
      }

      const row = db
        .prepare(
          `SELECT
             SUM(CASE WHEN a.requested_at >= @from AND a.kind = 'download' AND a.status_code < 400 THEN 1 ELSE 0 END) AS downloads,
             SUM(CASE WHEN a.requested_at >= @from AND a.kind = 'stream'   AND a.status_code < 400 THEN 1 ELSE 0 END) AS streams,
             SUM(CASE WHEN a.requested_at >= @from AND a.status_code >= 400 THEN 1 ELSE 0 END) AS failures,
             SUM(CASE WHEN a.requested_at >= @from THEN COALESCE(a.bytes_sent, 0) ELSE 0 END) AS bytes,
             MAX(CASE WHEN a.requested_at >= @from THEN a.requested_at END) AS lastAt,
             SUM(CASE WHEN a.requested_at < @from AND a.kind = 'download' AND a.status_code < 400 THEN 1 ELSE 0 END) AS prevDownloads,
             SUM(CASE WHEN a.requested_at < @from AND a.kind = 'stream'   AND a.status_code < 400 THEN 1 ELSE 0 END) AS prevStreams,
             SUM(CASE WHEN a.requested_at < @from AND a.status_code >= 400 THEN 1 ELSE 0 END) AS prevFailures,
             SUM(CASE WHEN a.requested_at < @from THEN COALESCE(a.bytes_sent, 0) ELSE 0 END) AS prevBytes
           FROM media_access a
           WHERE a.requested_at >= @prevFrom AND a.requested_at < @to
             AND a.kind IN ('download','stream')`,
        )
        .get({ from, to, prevFrom });

      const current = {
        downloads: row?.downloads ?? 0,
        streams: row?.streams ?? 0,
        failures: row?.failures ?? 0,
        bytes: row?.bytes ?? 0,
      };
      const previous = {
        downloads: row?.prevDownloads ?? 0,
        streams: row?.prevStreams ?? 0,
        failures: row?.prevFailures ?? 0,
        bytes: row?.prevBytes ?? 0,
      };

      return {
        ...current,
        lastAt: row?.lastAt ?? null,
        lastEverAt,
        previous,
        change: {
          downloads: changeFrom(current.downloads, previous.downloads),
          streams: changeFrom(current.streams, previous.streams),
          failures: changeFrom(current.failures, previous.failures),
          bytes: changeFrom(current.bytes, previous.bytes),
        },
      };
    },

    /**
     * Counts per time bucket, for the chart.
     *
     * Buckets arrive as explicit `[start, end)` instants rather than being derived in
     * SQL, because `date(requested_at)` groups by UTC days and a single fixed offset is
     * wrong on either side of a clock change — which is exactly the week someone looks
     * at a chart and finds it disagrees with the log. Every bucket comes back, zeros
     * included: a quiet Tuesday is a fact, and a chart that closes the gap tells a
     * different story from the data.
     */
    daily({ buckets = [], showId = null } = {}) {
      if (!buckets.length) return [];

      const args = [];
      buckets.forEach((bucket, index) => args.push(index, bucket.start, bucket.end));
      // The show filter belongs in the JOIN condition, not a WHERE: a WHERE against a
      // column of the right-hand table turns the LEFT JOIN into an inner one and the
      // empty days vanish from the chart instead of being drawn as zero.
      const showClause = showId ? 'AND a.show_id = ?' : '';
      if (showId) args.push(showId);

      const rows = db
        .prepare(
          `WITH bucket(idx, start_at, end_at) AS (VALUES ${buckets.map(() => '(?,?,?)').join(', ')})
           SELECT b.idx AS idx,
                  SUM(CASE WHEN a.kind = 'download' AND a.status_code < 400 THEN 1 ELSE 0 END) AS downloads,
                  SUM(CASE WHEN a.kind = 'stream'   AND a.status_code < 400 THEN 1 ELSE 0 END) AS streams,
                  SUM(CASE WHEN a.status_code >= 400 THEN 1 ELSE 0 END) AS failures,
                  SUM(COALESCE(a.bytes_sent, 0)) AS bytes
             FROM bucket b
             LEFT JOIN media_access a
               ON a.requested_at >= b.start_at
              AND a.requested_at <  b.end_at
              AND a.kind IN ('download','stream')
              ${showClause}
            GROUP BY b.idx
            ORDER BY b.idx`,
        )
        .all(...args);

      const byIndex = new Map(rows.map((row) => [row.idx, row]));
      return buckets.map((bucket, index) => {
        const row = byIndex.get(index);
        return {
          ...bucket,
          downloads: row?.downloads ?? 0,
          streams: row?.streams ?? 0,
          failures: row?.failures ?? 0,
          bytes: row?.bytes ?? 0,
        };
      });
    },

    /** Which app families are fetching, busiest first. */
    byClient({ from = null, to = null, showId = null } = {}) {
      const { clauses, params } = rangeClauses({ from, to });
      if (showId) {
        clauses.push('a.show_id = @showId');
        params.showId = showId;
      }
      const extra = clauses.map((clause) => `AND ${clause}`).join(' ');
      return db
        .prepare(
          `SELECT COALESCE(a.client, 'Unknown') AS client,
                  SUM(CASE WHEN a.kind = 'download' THEN 1 ELSE 0 END) AS downloads,
                  SUM(CASE WHEN a.kind = 'stream'   THEN 1 ELSE 0 END) AS streams,
                  COUNT(*) AS n,
                  SUM(COALESCE(a.bytes_sent, 0)) AS bytes
             FROM media_access a
            WHERE a.kind IN ('download','stream') AND a.status_code < 400 ${extra}
            GROUP BY COALESCE(a.client, 'Unknown')
            ORDER BY n DESC, client ASC`,
        )
        .all(params);
    },

    /** The oldest request still on record — where "all time" actually starts. */
    firstAccessAt() {
      return db.prepare(`SELECT MIN(a.requested_at) AS at FROM media_access a`).get()?.at ?? null;
    },

    /**
     * The most fetched episodes across every show.
     *
     * Ordered by downloads first: a completed download is a stronger signal of
     * interest than a stream, of which one listener can generate dozens by seeking.
     */
    busiest(limit = 10, { from = null, to = null, showId = null } = {}) {
      const { clauses, params } = rangeClauses({ from, to });
      if (showId) {
        clauses.push('a.show_id = @showId');
        params.showId = showId;
      }
      const extra = clauses.map((clause) => `AND ${clause}`).join(' ');
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
            WHERE a.kind IN ('download','stream') AND a.status_code < 400 ${extra}
            GROUP BY a.episode_id
            ORDER BY downloads DESC, streams DESC, bytes DESC
            LIMIT @limit`,
        )
        .all({ ...params, limit: Math.min(Math.max(1, limit), 100) });
    },

    /** The raw log — the "what actually happened" view. Newest first by default. */
    list(filter = {}) {
      const { limit = 50, offset = 0, sort = 'time', dir = 'desc' } = filter;
      const { where, params } = accessWhere(filter);

      return db
        .prepare(
          `SELECT a.*, e.title AS episode_title, e.filename AS episode_filename,
                  s.title AS show_title, s.slug AS show_slug
             FROM media_access a
             LEFT JOIN episodes e ON e.id = a.episode_id
             LEFT JOIN shows s ON s.id = a.show_id
             ${where}
             ${accessOrder(sort, dir)}
             LIMIT @limit OFFSET @offset`,
        )
        .all({
          ...params,
          // The ceiling is high because the CSV export is one call for a whole filtered
          // period. Routes that take a limit from a query string clamp it themselves to
          // something a page can render.
          limit: Math.min(Math.max(1, limit), MAX_LIST_ROWS),
          offset: Math.max(0, offset),
        })
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

    /** How many rows `list` would return for the same filter, ignoring paging. */
    count(filter = {}) {
      const { where, params } = accessWhere(filter);
      return db.prepare(`SELECT COUNT(*) AS n FROM media_access a ${where}`).get(params).n;
    },

    /** Recent failures, for the surface that has to make them impossible to miss. */
    recentFailures(limit = 10, { from = null, to = null, showId = null } = {}) {
      return api.list({ failuresOnly: true, limit, from, to, showId });
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
