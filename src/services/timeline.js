/**
 * The episode timeline.
 *
 * `scan_log` answers "what did the last scan do?" — but only in aggregate. It says
 * `added: 3` and never which three files, so the question people actually ask ("when
 * did that episode appear, and when did it go?") had no answer anywhere in the app.
 *
 * Rather than start an append-only event table — which would only ever describe
 * episodes scanned after the feature shipped, leaving every existing library blank —
 * this derives the timeline from columns `episodes` has carried since the first
 * migration: `created_at`, `missing_since` and `removed_at`. That makes the whole
 * history retroactive on the first page load, with no migration and no new writes.
 *
 * An episode row can legitimately produce more than one event: `episodes.sweepMissing`
 * sets `removed_at` while deliberately leaving `missing_since` in place, so an expired
 * episode reports both "went missing" and "expired". That is why the query is a
 * UNION ALL rather than a single SELECT with a CASE — one row in, up to three out.
 *
 * ## The known limit
 *
 * This is a derived view of *current* state, not a log. The columns it reads are the
 * same ones the app clears when an episode comes back: `episodes.restoreToFeed`
 * (`src/services/episodes.js:250`) and the scanner's two re-adoption paths
 * (`src/services/scanner.js:403` and `:461`) null `missing_since` and `removed_at`.
 * So an episode that went missing and returned leaves no trace of ever having gone,
 * and un-removing an episode erases its removal.
 *
 * That is deliberate, and it is stated rather than papered over — the same instinct
 * that stops `src/services/stats.js` calling a download a "listen". A view that
 * quietly invented the events it cannot know would be worse than one with an
 * honest edge.
 */

export const TIMELINE_EVENT = Object.freeze({
  ADDED: 'added',
  MISSING: 'missing',
  REMOVED: 'removed',
  EXPIRED: 'expired',
});

const ALL_EVENTS = Object.freeze(Object.values(TIMELINE_EVENT));

/**
 * Defined exactly once, and concatenated into both `list` and `count`. Two copies of
 * this — one per method — is how a paginator ends up reporting a total that does not
 * match the rows it can actually reach.
 */
const EVENTS_CTE = `WITH events AS (
  SELECT e.id AS episode_id, e.show_id AS show_id, e.title AS title,
         e.filename AS filename, e.status AS status,
         'added' AS event, e.created_at AS at
    FROM episodes e
  UNION ALL
  SELECT e.id, e.show_id, e.title, e.filename, e.status, 'missing', e.missing_since
    FROM episodes e WHERE e.missing_since IS NOT NULL
  UNION ALL
  SELECT e.id, e.show_id, e.title, e.filename, e.status,
         CASE e.status WHEN 'expired' THEN 'expired' ELSE 'removed' END, e.removed_at
    FROM episodes e WHERE e.removed_at IS NOT NULL AND e.status IN ('removed','expired')
)`;

/** A plain JOIN, not a LEFT JOIN: `episodes.show_id` is NOT NULL and cascades on delete. */
const FROM_EVENTS = 'FROM events v JOIN shows s ON s.id = v.show_id';

const SELECT_COLUMNS = `SELECT v.episode_id AS episodeId, v.show_id AS showId, v.title AS episodeTitle,
       v.filename, v.status, v.event, v.at,
       s.title AS showTitle, s.slug AS showSlug`;

/**
 * The `v.episode_id` tiebreaker is load-bearing, not decoration. A scan adds twenty
 * files inside the same millisecond, so twenty rows share an `at`; ordering by `at`
 * alone leaves SQLite free to return them in a different order per query, and OFFSET
 * paging over an unstable order repeats some rows and silently skips others.
 */
const ORDER_BY = 'ORDER BY v.at DESC, v.episode_id DESC';

/**
 * Builds the shared WHERE clause and its parameters.
 *
 * The event filter is the only place a caller's value gets near the SQL text, so it
 * never travels that way: the list is intersected with the known event names and the
 * placeholders are generated from the survivors. What the caller passed can only ever
 * decide *how many* `@eventN` placeholders exist, never what they say.
 */
function buildWhere({ showId, events, from, to }) {
  const clauses = [];
  const params = {};

  if (showId) {
    clauses.push('v.show_id = @showId');
    params.showId = showId;
  }
  if (from) {
    clauses.push('v.at >= @from');
    params.from = from;
  }
  if (to) {
    // Half-open, so a caller can page day by day without double-counting midnight.
    clauses.push('v.at < @to');
    params.to = to;
  }

  if (Array.isArray(events)) {
    const wanted = ALL_EVENTS.filter((event) => events.includes(event));
    // Nothing recognised, or everything recognised: either way the clause would only
    // restate the whole set, so it is left out entirely.
    if (wanted.length && wanted.length < ALL_EVENTS.length) {
      const placeholders = wanted.map((event, index) => {
        params[`event${index}`] = event;
        return `@event${index}`;
      });
      clauses.push(`v.event IN (${placeholders.join(', ')})`);
    }
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function listSql(where) {
  return `${EVENTS_CTE}
${SELECT_COLUMNS}
  ${FROM_EVENTS}
 ${where}
 ${ORDER_BY}
 LIMIT @limit OFFSET @offset`;
}

function countSql(where) {
  return `${EVENTS_CTE}
SELECT COUNT(*) AS n ${FROM_EVENTS} ${where}`;
}

export function createTimeline({ db, logger }) {
  // The unfiltered pair is what the dashboard asks for on every page load, so those
  // two are prepared once. Anything with a filter varies in shape and is built per
  // call, exactly as `activity.list` does.
  const listAll = db.prepare(listSql(''));
  const countAll = db.prepare(countSql(''));

  return {
    /** Reverse-chronological episode events, newest first. */
    list({ showId = null, events = null, from = null, to = null, limit = 25, offset = 0 } = {}) {
      const { where, params } = buildWhere({ showId, events, from, to });
      const bound = {
        ...params,
        limit: Math.min(Math.max(1, limit), 200),
        offset: Math.max(0, offset),
      };
      const statement = where ? db.prepare(listSql(where)) : listAll;
      return statement.all(bound);
    },

    /** How many events the same filters match, so a pager can size itself honestly. */
    count({ showId = null, events = null, from = null, to = null } = {}) {
      const { where, params } = buildWhere({ showId, events, from, to });
      const statement = where ? db.prepare(countSql(where)) : countAll;
      const row = where ? statement.get(params) : statement.get();
      logger?.trace({ showId, events, from, to, n: row?.n }, 'counted timeline events');
      return row?.n ?? 0;
    },
  };
}
