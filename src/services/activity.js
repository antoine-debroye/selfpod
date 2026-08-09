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
      finishScan.run({
        id,
        finishedAt: nowIso(),
        filesFound,
        added,
        updated,
        missing,
        removed,
        errorsJson: errors.length ? JSON.stringify(errors) : null,
        warningsJson: warnings.length ? JSON.stringify(warnings) : null,
        note,
      });
      return hydrate(selectById.get(id));
    },

    get(id) {
      return hydrate(selectById.get(id));
    },

    /** Reverse-chronological, optionally filtered by show (spec §11.5, §14). */
    list({ showId = null, limit = 25, offset = 0, includeGlobal = true } = {}) {
      const cappedLimit = Math.min(Math.max(1, limit), 200);
      let sql = `SELECT s.*, sh.title AS show_title, sh.slug AS show_slug
                   FROM scan_log s
                   LEFT JOIN shows sh ON sh.id = s.show_id`;
      const params = { limit: cappedLimit, offset: Math.max(0, offset) };
      if (showId) {
        sql += includeGlobal ? ' WHERE (s.show_id = @showId OR s.show_id IS NULL)' : ' WHERE s.show_id = @showId';
        params.showId = showId;
      }
      sql += ' ORDER BY s.started_at DESC, s.id DESC LIMIT @limit OFFSET @offset';
      return db.prepare(sql).all(params).map(hydrate);
    },

    count({ showId = null, includeGlobal = true } = {}) {
      if (!showId) return db.prepare('SELECT COUNT(*) AS n FROM scan_log').get().n;
      const sql = includeGlobal
        ? 'SELECT COUNT(*) AS n FROM scan_log WHERE show_id = ? OR show_id IS NULL'
        : 'SELECT COUNT(*) AS n FROM scan_log WHERE show_id = ?';
      return db.prepare(sql).get(showId).n;
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
