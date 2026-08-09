import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { EPISODE_STATUS } from '../constants.js';
import { fromLocalInputValue, nowIso, toIso } from '../lib/dates.js';
import { badRequest, notFound } from '../lib/errors.js';
import { EVENTS } from '../lib/events.js';

/**
 * Episode repository.
 *
 * Two invariants protect user intent against the scanner:
 *  - `title_is_custom` means the scanner may never touch the title again.
 *  - a `removed` episode stays removed even though its file is still on disk,
 *    so "remove from feed only" is not silently undone by the next rescan.
 */
export function createEpisodes({ db, config, events, shows, logger }) {
  const selectById = db.prepare('SELECT * FROM episodes WHERE id = ?');
  const selectByIdentity = db.prepare(
    'SELECT * FROM episodes WHERE show_id = ? AND identity_key = ?',
  );
  const selectByShow = db.prepare(
    'SELECT * FROM episodes WHERE show_id = ? ORDER BY pub_date DESC, created_at DESC',
  );
  const selectFeedItems = db.prepare(
    `SELECT * FROM episodes
      WHERE show_id = ? AND status IN ('active','missing')
      ORDER BY pub_date DESC, created_at DESC`,
  );
  const countByShow = db.prepare(
    `SELECT
       SUM(CASE WHEN status = 'active'  THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'missing' THEN 1 ELSE 0 END) AS missing,
       SUM(CASE WHEN status = 'removed' THEN 1 ELSE 0 END) AS removed,
       SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
       COUNT(*) AS total
     FROM episodes WHERE show_id = ?`,
  );
  const insertEpisode = db.prepare(
    `INSERT INTO episodes (id, show_id, filename, identity_key, title, title_is_custom, tag_title,
                           description, season, episode_number, explicit, pub_date, pub_date_is_custom,
                           duration_seconds, bitrate_kbps, file_size_bytes, file_mtime, mime_type,
                           status, created_at, updated_at)
     VALUES (@id, @show_id, @filename, @identity_key, @title, @title_is_custom, @tag_title,
             @description, @season, @episode_number, @explicit, @pub_date, @pub_date_is_custom,
             @duration_seconds, @bitrate_kbps, @file_size_bytes, @file_mtime, @mime_type,
             @status, @created_at, @updated_at)`,
  );
  const deleteEpisode = db.prepare('DELETE FROM episodes WHERE id = ?');

  const api = {
    get(id) {
      return selectById.get(id) ?? null;
    },

    getOrThrow(id) {
      const episode = api.get(id);
      if (!episode) throw notFound('That episode no longer exists.', 'episode_not_found');
      return episode;
    },

    /**
     * Identity lookup includes `removed` rows on purpose: finding one is how the
     * scanner knows to leave a user-removed episode alone instead of re-adding it.
     */
    findByIdentity(showId, identityKey) {
      return selectByIdentity.get(showId, identityKey) ?? null;
    },

    /**
     * Two rows in one show can carry the same filename — delete a file, let it be
     * marked missing, then add a different file under the same name. The scanner's
     * fast path uses this, so the choice must be deterministic and must prefer the
     * row that is actually live, or it could attach the wrong GUID to the file.
     */
    findByFilename(showId, filename) {
      return (
        db
          .prepare(
            `SELECT * FROM episodes
              WHERE show_id = ? AND filename = ?
              ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'missing' THEN 1 WHEN 'expired' THEN 2 ELSE 3 END,
                       updated_at DESC
              LIMIT 1`,
          )
          .get(showId, filename) ?? null
      );
    },

    listByShow(showId, { status } = {}) {
      const rows = selectByShow.all(showId);
      return status ? rows.filter((row) => row.status === status) : rows;
    },

    /** Feed items: active plus missing-within-grace, newest first (spec §6.3, §8.3). */
    listForFeed(showId) {
      return selectFeedItems.all(showId);
    },

    counts(showId) {
      const row = countByShow.get(showId);
      return {
        active: row?.active ?? 0,
        missing: row?.missing ?? 0,
        removed: row?.removed ?? 0,
        expired: row?.expired ?? 0,
        total: row?.total ?? 0,
        inFeed: (row?.active ?? 0) + (row?.missing ?? 0),
      };
    },

    insert(row) {
      insertEpisode.run({
        description: '',
        season: null,
        episode_number: null,
        explicit: null,
        tag_title: null,
        title_is_custom: 0,
        pub_date_is_custom: 0,
        duration_seconds: null,
        bitrate_kbps: null,
        file_mtime: null,
        status: EPISODE_STATUS.ACTIVE,
        created_at: nowIso(),
        updated_at: nowIso(),
        ...row,
      });
      return api.get(row.id);
    },

    /** Scanner-owned columns only; never touches user-editable text. */
    setSystemFields(id, fields) {
      const allowed = [
        'filename',
        'identity_key',
        'file_size_bytes',
        'file_mtime',
        'mime_type',
        'duration_seconds',
        'bitrate_kbps',
        'status',
        'missing_since',
        'removed_at',
        'tag_title',
        'title',
        'description',
        'pub_date',
        'season',
        'episode_number',
      ];
      const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
      if (!entries.length) return api.get(id);
      const payload = Object.fromEntries(entries);
      payload.updated_at = nowIso();
      payload.id = id;
      const assignments = Object.keys(payload)
        .filter((key) => key !== 'id')
        .map((key) => `${key} = @${key}`)
        .join(', ');
      db.prepare(`UPDATE episodes SET ${assignments} WHERE id = @id`).run(payload);
      return api.get(id);
    },

    /** User edits from the UI/API. Sets the "custom" flags that lock the scanner out. */
    update(id, patch, { timeZone } = {}) {
      const episode = api.getOrThrow(id);
      const fields = {};
      const invalid = {};

      if (patch.title !== undefined) {
        const title = String(patch.title).trim();
        if (!title) invalid.title = 'An episode needs a title.';
        else {
          fields.title = title.slice(0, 400);
          // Once a human has named it, the scanner must never rename it again.
          fields.title_is_custom = fields.title === episode.tag_title ? 0 : 1;
        }
      }
      if (patch.description !== undefined) {
        fields.description = String(patch.description ?? '').trim().slice(0, 20000);
      }
      if (patch.season !== undefined) {
        const parsed = parseOptionalInt(patch.season);
        if (parsed === false) invalid.season = 'Season must be a whole number.';
        else fields.season = parsed;
      }
      if (patch.episodeNumber !== undefined) {
        const parsed = parseOptionalInt(patch.episodeNumber);
        if (parsed === false) invalid.episodeNumber = 'Episode number must be a whole number.';
        else fields.episode_number = parsed;
      }
      if (patch.explicit !== undefined) {
        const value = patch.explicit;
        if (value === null || value === '' || value === 'inherit') fields.explicit = null;
        else if (value === true || value === 1 || value === '1' || value === 'true' || value === 'yes')
          fields.explicit = 1;
        else fields.explicit = 0;
      }
      if (patch.pubDate !== undefined) {
        const iso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(String(patch.pubDate))
          ? fromLocalInputValue(patch.pubDate, { timeZone: timeZone ?? config.timeZone })
          : toIso(patch.pubDate);
        if (!iso) invalid.pubDate = "That date couldn't be read. Use the date picker or YYYY-MM-DD HH:MM.";
        else {
          fields.pub_date = iso;
          fields.pub_date_is_custom = 1;
        }
      }

      if (Object.keys(invalid).length) {
        const err = badRequest('Some of those values need fixing.', 'validation_failed');
        err.status = 422;
        err.fields = invalid;
        throw err;
      }
      if (!Object.keys(fields).length) return episode;

      fields.updated_at = nowIso();
      fields.id = id;
      const assignments = Object.keys(fields)
        .filter((key) => key !== 'id')
        .map((key) => `${key} = @${key}`)
        .join(', ');
      db.prepare(`UPDATE episodes SET ${assignments} WHERE id = @id`).run(fields);

      const updated = api.get(id);
      events?.emit(EVENTS.SHOW_CHANGED, { showId: episode.show_id });
      return updated;
    },

    /**
     * "Remove from feed" — reversible, leaves the audio untouched. The row is
     * kept (not deleted) precisely so a rescan recognises the file and knows not
     * to re-add it.
     */
    removeFromFeed(id) {
      const episode = api.getOrThrow(id);
      const updated = api.setSystemFields(id, {
        status: EPISODE_STATUS.REMOVED,
        removed_at: nowIso(),
        missing_since: null,
      });
      logger?.info({ id, filename: episode.filename }, 'episode removed from feed (file kept)');
      events?.emit(EVENTS.SHOW_CHANGED, { showId: episode.show_id });
      return updated;
    },

    /** Undo of the above — the only thing that may bring a `removed` row back. */
    restoreToFeed(id) {
      const episode = api.getOrThrow(id);
      const updated = api.setSystemFields(id, {
        status: EPISODE_STATUS.ACTIVE,
        removed_at: null,
        missing_since: null,
      });
      events?.emit(EVENTS.SHOW_CHANGED, { showId: episode.show_id });
      return updated;
    },

    /** "Delete the file" — irreversible, and a deliberately separate action. */
    async deleteWithFile(id) {
      const episode = api.getOrThrow(id);
      const show = shows.get(episode.show_id);
      if (!show) throw notFound('That episode’s show no longer exists.', 'show_not_found');
      const path = join(shows.dirFor(show), episode.filename);

      try {
        await unlink(path);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw badRequest(
            `The file \`${episode.filename}\` could not be deleted: ${err.message}. SelfPod runs as UID ${
              config.runtimeUid ?? config.puid
            }; check it has write access to that folder.`,
            'unlink_failed',
          );
        }
      }

      deleteEpisode.run(id);
      logger?.warn({ id, path }, 'deleted episode and its audio file');
      events?.emit(EVENTS.SHOW_CHANGED, { showId: episode.show_id });
      return { filename: episode.filename, showId: episode.show_id };
    },

    /** Purges the row entirely without touching disk (used by the grace sweep). */
    purge(id) {
      const episode = api.getOrThrow(id);
      deleteEpisode.run(id);
      events?.emit(EVENTS.SHOW_CHANGED, { showId: episode.show_id });
      return episode;
    },

    /**
     * Grace-period sweep (spec §6.3): a file that has been missing longer than
     * the configured window stops appearing in the feed. Runs from the scheduler,
     * not the scanner, so a brief network-share blip can never drop an episode.
     */
    sweepMissing(graceSeconds) {
      const cutoff = new Date(Date.now() - graceSeconds * 1000).toISOString();
      // The boundary is inclusive: "missing since at or before the cutoff". With
      // an exclusive compare, a zero grace period never fires, because the mark
      // and the sweep can land in the same millisecond.
      const stale = db
        .prepare(
          `SELECT id, show_id, filename FROM episodes
            WHERE status = 'missing' AND missing_since IS NOT NULL AND missing_since <= ?`,
        )
        .all(cutoff);
      if (!stale.length) return [];

      const markExpired = db.prepare(
        `UPDATE episodes SET status = 'expired', removed_at = @now, updated_at = @now WHERE id = @id`,
      );
      const now = nowIso();
      const run = db.transaction(() => {
        for (const row of stale) markExpired.run({ id: row.id, now });
      });
      run();

      const affectedShows = new Set(stale.map((row) => row.show_id));
      for (const showId of affectedShows) events?.emit(EVENTS.SHOW_CHANGED, { showId });
      logger?.info(
        { count: stale.length, graceSeconds },
        'dropped episodes whose files stayed missing past the grace period',
      );
      return stale;
    },

    /** Resolved explicit flag for the feed: episode override, else show value. */
    resolveExplicit(episode, show) {
      if (episode.explicit === null || episode.explicit === undefined) return show.explicit === 1;
      return episode.explicit === 1;
    },
  };

  return api;
}

function parseOptionalInt(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return false;
  return parsed;
}
