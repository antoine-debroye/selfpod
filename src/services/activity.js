import { SCAN_TRIGGER } from '../constants.js';
import { nowIso } from '../lib/dates.js';
import { describeFsError } from '../lib/errors.js';

/**
 * The activity log (spec §11.5).
 *
 * This is the single most important UX surface in the app. Every failure mode the
 * hand-rolled prototype hit was invisible until a podcast app failed to download
 * an episode; this log is what stops that recurring. Consequently every message
 * written here is a plain-language sentence naming the file, the path and the UID
 * the app runs as — never a stack trace.
 */
/**
 * Diagnostics per scan are capped. The point of the activity log is that a user can
 * understand what happened, and 5,000 copies of the same warning serve that worse
 * than 50 plus a count — while a blob that size is written on every scan interval
 * and parsed on every page load.
 */
const MAX_ENTRIES_PER_SCAN = 50;

const TRIGGERS = new Set(Object.values(SCAN_TRIGGER));

function capEntries(entries) {
  if (entries.length <= MAX_ENTRIES_PER_SCAN) return entries;
  const kept = entries.slice(0, MAX_ENTRIES_PER_SCAN);
  const hidden = entries.length - kept.length;
  kept.push({
    file: null,
    message: `…and ${hidden} more of the same kind. Fixing the ones above usually clears the rest.`,
  });
  return kept;
}

/**
 * What "how did it go?" can mean, as SQL.
 *
 * Each value maps to a fragment with no parameters of its own, so nothing a query
 * string supplied ever reaches the statement — the key is looked up, or the filter is
 * dropped. The COALESCE in `changes` matters: a scan still running has null counters,
 * and `NULL > 0` is null, which would quietly classify every in-flight scan as boring.
 */
const OUTCOME_CLAUSES = Object.freeze({
  problems: '(s.errors_json IS NOT NULL OR s.warnings_json IS NOT NULL)',
  errors: 's.errors_json IS NOT NULL',
  clean: '(s.finished_at IS NOT NULL AND s.errors_json IS NULL AND s.warnings_json IS NULL)',
  changes:
    '(COALESCE(s.added,0) + COALESCE(s.updated,0) + COALESCE(s.missing,0) + COALESCE(s.removed,0)) > 0',
  running: 's.finished_at IS NULL',
});

/** The outcome keys a caller may ask for, for whoever validates a query string. */
export const SCAN_OUTCOMES = Object.freeze(Object.keys(OUTCOME_CLAUSES));

/**
 * The one place a scan_log filter becomes SQL.
 *
 * `list` and `count` used to build this separately — one aliased `s.`, one not — which
 * is how a filter ends up applied to the rows but not the total.
 */
function scanWhere({
  showId = null,
  includeGlobal = true,
  triggers = null,
  outcome = null,
  from = null,
  to = null,
} = {}) {
  const clauses = [];
  const params = {};

  if (showId) {
    // A global scan covers every show, so it is part of one show's history too.
    clauses.push(includeGlobal ? '(s.show_id = @showId OR s.show_id IS NULL)' : 's.show_id = @showId');
    params.showId = showId;
  }

  const wanted = (Array.isArray(triggers) ? triggers : [])
    .map(String)
    .filter((trigger) => TRIGGERS.has(trigger));
  if (wanted.length && wanted.length < TRIGGERS.size) {
    clauses.push(`s.trigger IN (${wanted.map((_, i) => `@trigger${i}`).join(', ')})`);
    wanted.forEach((trigger, i) => {
      params[`trigger${i}`] = trigger;
    });
  }

  if (outcome && Object.hasOwn(OUTCOME_CLAUSES, outcome)) clauses.push(OUTCOME_CLAUSES[outcome]);

  if (from) {
    clauses.push('s.started_at >= @from');
    params.from = from;
  }
  if (to) {
    clauses.push('s.started_at < @to');
    params.to = to;
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function createActivity({ db, config, logger }) {
  const insertScan = db.prepare(
    `INSERT INTO scan_log (show_id, started_at, trigger, note)
     VALUES (@showId, @startedAt, @trigger, @note)`,
  );
  const finishScan = db.prepare(
    `UPDATE scan_log
        SET finished_at = @finishedAt,
            files_found = @filesFound,
            added = @added,
            updated = @updated,
            missing = @missing,
            removed = @removed,
            errors_json = @errorsJson,
            warnings_json = @warningsJson,
            note = COALESCE(@note, note)
      WHERE id = @id`,
  );
  const selectById = db.prepare('SELECT * FROM scan_log WHERE id = ?');
  const trimLog = db.prepare(
    `DELETE FROM scan_log
      WHERE id NOT IN (SELECT id FROM scan_log ORDER BY started_at DESC, id DESC LIMIT @keep)`,
  );

  /**
   * Rows keep their SQL column names, plus camelCase aliases for the counters so
   * templates and API responses read naturally without a mapping layer.
   */
  function hydrate(row) {
    if (!row) return null;
    return {
      ...row,
      errors: parseJsonArray(row.errors_json),
      warnings: parseJsonArray(row.warnings_json),
      showId: row.show_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      filesFound: row.files_found,
      showTitle: row.show_title,
      showSlug: row.show_slug,
    };
  }

  return {
    /** Opens a scan record; the id is threaded through the scan and closed at the end. */
    start({ showId = null, trigger, note = null }) {
      const info = insertScan.run({ showId, startedAt: nowIso(), trigger, note });
      return Number(info.lastInsertRowid);
    },

    finish(id, { filesFound = 0, added = 0, updated = 0, missing = 0, removed = 0, errors = [], warnings = [], note = null } = {}) {
      const cappedErrors = capEntries(errors);
      const cappedWarnings = capEntries(warnings);
      finishScan.run({
        id,
        finishedAt: nowIso(),
        filesFound,
        added,
        updated,
        missing,
        removed,
        errorsJson: cappedErrors.length ? JSON.stringify(cappedErrors) : null,
        warningsJson: cappedWarnings.length ? JSON.stringify(cappedWarnings) : null,
        note,
      });
      return hydrate(selectById.get(id));
    },

    get(id) {
      return hydrate(selectById.get(id));
    },

    /** Reverse-chronological, optionally filtered by show (spec §11.5, §14). */
    list({
      showId = null,
      limit = 25,
      offset = 0,
      includeGlobal = true,
      triggers = null,
      outcome = null,
      from = null,
      to = null,
    } = {}) {
      const { where, params } = scanWhere({ showId, includeGlobal, triggers, outcome, from, to });
      return db
        .prepare(
          `SELECT s.*, sh.title AS show_title, sh.slug AS show_slug
             FROM scan_log s
             LEFT JOIN shows sh ON sh.id = s.show_id
             ${where}
             ORDER BY s.started_at DESC, s.id DESC
             LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit: Math.min(Math.max(1, limit), 200), offset: Math.max(0, offset) })
        .map(hydrate);
    },

    count({
      showId = null,
      includeGlobal = true,
      triggers = null,
      outcome = null,
      from = null,
      to = null,
    } = {}) {
      const { where, params } = scanWhere({ showId, includeGlobal, triggers, outcome, from, to });
      return db.prepare(`SELECT COUNT(*) AS n FROM scan_log s ${where}`).get(params).n;
    },

    latestForShow(showId) {
      return hydrate(
        db
          .prepare(
            'SELECT * FROM scan_log WHERE show_id = ? AND finished_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1',
          )
          .get(showId),
      );
    },

    latestGlobal() {
      return hydrate(
        db
          .prepare(
            'SELECT * FROM scan_log WHERE show_id IS NULL AND finished_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1',
          )
          .get(),
      );
    },

    /** Keeps the log from growing without bound on a busy instance. */
    trim(keep = 500) {
      const info = trimLog.run({ keep });
      if (info.changes) logger?.debug({ removed: info.changes }, 'trimmed scan log');
      return info.changes;
    },

    /**
     * Formats a filesystem error for a specific file, naming the configured PUID
     * and the real path so the user knows exactly what to change (spec §11.5).
     */
    formatFileError(file, err) {
      return {
        file,
        message: describeFsError(err, {
          path: file,
          uid: config.runtimeUid ?? config.puid,
          gid: config.runtimeGid ?? config.pgid,
        }),
        code: err?.code ?? null,
      };
    },
  };
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
