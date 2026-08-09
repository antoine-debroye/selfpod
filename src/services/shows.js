import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FILE_NAMES, SHOW_STATUS } from '../constants.js';
import { nowIso } from '../lib/dates.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { EVENTS } from '../lib/events.js';
import { humanizeSlug, isUsableSlug, slugify } from '../lib/slug.js';
import { newFeedToken, newId } from '../lib/tokens.js';
import {
  APPLE_CATEGORIES,
  isValidCategory,
  isValidSubcategory,
  matchLegacyCategory,
} from '../web/lib/apple-categories.js';

/**
 * Show repository, plus the `show.json` import/export.
 *
 * `show.json` is a convenience export, not the runtime source of truth: it is
 * read exactly once, when a folder is discovered that has no database row yet,
 * and written back after edits so a user can keep their configuration in version
 * control if they like (spec §5, §7.1). The feed token is deliberately excluded
 * from it — that value is a credential.
 */
export function createShows({ db, config, events, logger, settings }) {
  const selectById = db.prepare('SELECT * FROM shows WHERE id = ?');
  const selectBySlug = db.prepare('SELECT * FROM shows WHERE slug = ?');
  const selectAll = db.prepare('SELECT * FROM shows ORDER BY title COLLATE NOCASE ASC');
  const insertShow = db.prepare(
    `INSERT INTO shows (id, slug, title, description, author_name, author_email, language,
                        itunes_category, itunes_subcategory, explicit, feed_token, status,
                        created_at, updated_at)
     VALUES (@id, @slug, @title, @description, @author_name, @author_email, @language,
             @itunes_category, @itunes_subcategory, @explicit, @feed_token, @status,
             @created_at, @updated_at)`,
  );
  const deleteShow = db.prepare('DELETE FROM shows WHERE id = ?');

  const exportTimers = new Map();

  function dirFor(slugOrShow) {
    const slug = typeof slugOrShow === 'string' ? slugOrShow : slugOrShow.slug;
    return join(config.showsDir, slug);
  }

  const api = {
    dirFor,

    get(id) {
      return selectById.get(id) ?? null;
    },

    getOrThrow(id) {
      const show = api.get(id);
      if (!show) throw notFound('That show no longer exists.', 'show_not_found');
      return show;
    },

    getBySlug(slug) {
      return selectBySlug.get(slug) ?? null;
    },

    list() {
      return selectAll.all();
    },

    listActive() {
      return selectAll.all().filter((show) => show.status === SHOW_STATUS.ACTIVE);
    },

    /**
     * Creates the database row for a folder that already exists on disk,
     * importing `show.json` if the user left one there.
     */
    async createFromFolder(slug) {
      const existing = api.getBySlug(slug);
      if (existing) return existing;

      const defaults = settings.defaults();
      const imported = await api.readShowConfig(slug);

      const title = imported.title ?? humanizeSlug(slug);
      const row = {
        id: newId(),
        slug,
        title,
        description: imported.description ?? '',
        // Left genuinely empty when there is nothing to use, rather than seeded
        // with the title: "empty" has to stay detectable so instance defaults can
        // fill it in later. The feed builder falls back to the title at render
        // time, so an empty author never produces an invalid feed.
        author_name: firstNonEmpty(imported.authorName, defaults.authorName) ?? '',
        author_email: firstNonEmpty(imported.authorEmail, defaults.authorEmail) ?? '',
        language: imported.language ?? defaults.language,
        itunes_category: imported.category ?? defaults.category,
        itunes_subcategory: imported.subcategory ?? defaults.subcategory ?? null,
        explicit: (imported.explicit ?? defaults.explicit) ? 1 : 0,
        feed_token: newFeedToken(),
        status: SHOW_STATUS.ACTIVE,
        created_at: nowIso(),
        updated_at: nowIso(),
      };

      insertShow.run(row);
      logger?.info({ slug, imported: imported.found }, 'discovered new show');
      events?.emit(EVENTS.SHOWS_CHANGED, {});
      return api.get(row.id);
    },

    /** Creates a brand new show: makes the folder, then the row. */
    async create({ title, slug: requestedSlug } = {}) {
      const trimmedTitle = String(title ?? '').trim();
      if (!trimmedTitle) throw badRequest('A show needs a name.', 'title_required');

      const slug = requestedSlug ? String(requestedSlug).trim() : slugify(trimmedTitle);
      if (!isUsableSlug(slug)) {
        throw badRequest(
          `"${slug}" can't be used as a folder name. Use letters, numbers, dots, dashes and underscores.`,
          'invalid_slug',
        );
      }
      if (api.getBySlug(slug)) {
        throw conflict(`A show already uses the folder name "${slug}".`, 'slug_taken');
      }

      // Asking for this show again is the explicit signal that overrides a previous
      // removal, so the tombstone goes.
      api.forgetRemovedFolder(slug);

      const dir = dirFor(slug);
      try {
        await mkdir(dir, { recursive: false });
      } catch (err) {
        if (err.code === 'EEXIST') {
          // The folder exists but has no row — adopt it rather than refusing.
          const adopted = await api.createFromFolder(slug);
          if (trimmedTitle && adopted.title !== trimmedTitle) {
            return api.update(adopted.id, { title: trimmedTitle });
          }
          return adopted;
        }
        throw badRequest(
          `SelfPod could not create the folder \`${dir}\`: ${err.message}. Check that PUID ${config.puid} can write there.`,
          'mkdir_failed',
        );
      }

      const created = await api.createFromFolder(slug);
      const withTitle =
        created.title === trimmedTitle ? created : api.update(created.id, { title: trimmedTitle });
      return withTitle;
    },

    /** Applies validated metadata changes and mirrors them to show.json. */
    update(id, patch) {
      const show = api.getOrThrow(id);
      const fields = {};
      const invalid = {};

      if (patch.title !== undefined) {
        const title = String(patch.title).trim();
        if (!title) invalid.title = 'A show needs a name.';
        else fields.title = title.slice(0, 300);
      }
      if (patch.description !== undefined) {
        fields.description = String(patch.description ?? '').trim().slice(0, 8000);
      }
      if (patch.authorName !== undefined) {
        fields.author_name = String(patch.authorName ?? '').trim().slice(0, 200);
      }
      if (patch.authorEmail !== undefined) {
        const email = String(patch.authorEmail ?? '').trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          invalid.authorEmail = "That doesn't look like an email address.";
        } else {
          fields.author_email = email.slice(0, 200);
        }
      }
      if (patch.language !== undefined) {
        const language = String(patch.language ?? '').trim().toLowerCase();
        if (language && !/^[a-z]{2}(-[a-z]{2})?$/.test(language)) {
          invalid.language = 'Use a language code like "en" or "en-gb".';
        } else {
          fields.language = language || 'en';
        }
      }
      if (patch.category !== undefined) {
        const category = String(patch.category ?? '').trim();
        if (!isValidCategory(category)) {
          invalid.category = 'Choose a category from the list — podcast directories reject anything else.';
        } else {
          fields.itunes_category = category;
        }
      }
      if (patch.subcategory !== undefined) {
        const category = fields.itunes_category ?? show.itunes_category;
        const subcategory = String(patch.subcategory ?? '').trim();
        if (subcategory && !isValidSubcategory(category, subcategory)) {
          invalid.subcategory = `"${subcategory}" isn't a subcategory of ${category}.`;
        } else {
          fields.itunes_subcategory = subcategory || null;
        }
      }
      if (patch.explicit !== undefined) {
        fields.explicit = toBoolInt(patch.explicit);
      }

      if (Object.keys(invalid).length) {
        const err = badRequest('Some of those values need fixing.', 'validation_failed');
        err.status = 422;
        err.fields = invalid;
        throw err;
      }
      if (Object.keys(fields).length === 0) return show;

      fields.updated_at = nowIso();
      const assignments = Object.keys(fields).map((key) => `${key} = @${key}`).join(', ');
      db.prepare(`UPDATE shows SET ${assignments} WHERE id = @id`).run({ ...fields, id });

      const updated = api.get(id);
      events?.emit(EVENTS.SHOW_CHANGED, { showId: id, slug: updated.slug });
      api.scheduleConfigExport(id);
      return updated;
    },

    /**
     * Internal setter for scanner-owned columns (cover, status, last scan).
     *
     * `last_scan_id` alone does not touch `updated_at`: it records that a scan
     * happened, not that anything changed, and treating it as a change made the
     * feed's ETag and lastBuildDate move on every single scan.
     */
    setSystemFields(id, fields) {
      const allowed = [
        'cover_filename',
        'cover_width',
        'cover_height',
        'cover_format',
        'cover_mtime',
        'status',
        'folder_missing_since',
        'last_scan_id',
      ];
      const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
      if (!entries.length) return api.get(id);
      const payload = Object.fromEntries(entries);
      const bookkeepingOnly = entries.every(([key]) => key === 'last_scan_id');
      if (!bookkeepingOnly) payload.updated_at = nowIso();
      payload.id = id;
      const assignments = Object.keys(payload)
        .filter((key) => key !== 'id')
        .map((key) => `${key} = @${key}`)
        .join(', ');
      db.prepare(`UPDATE shows SET ${assignments} WHERE id = @id`).run(payload);
      return api.get(id);
    },

    rotateToken(id) {
      const show = api.getOrThrow(id);
      const token = newFeedToken();
      db.prepare('UPDATE shows SET feed_token = @token, updated_at = @now WHERE id = @id').run({
        token,
        now: nowIso(),
        id,
      });
      logger?.info({ slug: show.slug }, 'rotated feed token');
      events?.emit(EVENTS.SHOW_CHANGED, { showId: id, slug: show.slug });
      return api.get(id);
    },

    markFolderMissing(id) {
      const show = api.getOrThrow(id);
      if (show.status === SHOW_STATUS.FOLDER_MISSING) return show;
      logger?.warn({ slug: show.slug }, 'show folder is gone from disk');
      const updated = api.setSystemFields(id, {
        status: SHOW_STATUS.FOLDER_MISSING,
        folder_missing_since: nowIso(),
      });
      events?.emit(EVENTS.SHOW_CHANGED, { showId: id, slug: show.slug });
      events?.emit(EVENTS.SHOWS_CHANGED, {});
      return updated;
    },

    markFolderPresent(id) {
      const show = api.getOrThrow(id);
      if (show.status === SHOW_STATUS.ACTIVE) return show;
      logger?.info({ slug: show.slug }, 'show folder is back');
      const updated = api.setSystemFields(id, {
        status: SHOW_STATUS.ACTIVE,
        folder_missing_since: null,
      });
      events?.emit(EVENTS.SHOW_CHANGED, { showId: id, slug: show.slug });
      events?.emit(EVENTS.SHOWS_CHANGED, {});
      return updated;
    },

    /**
     * Removes a show. Deleting the underlying audio is a separate, explicit
     * choice — the two are never conflated (spec §11.3, §11.6).
     */
    async remove(id, { deleteFiles = false } = {}) {
      const show = api.getOrThrow(id);
      const dir = dirFor(show);

      // Files first: if this fails — a permission problem on a NAS, say — the show
      // is left completely intact rather than half-deleted with its audio gone and
      // its database row already destroyed.
      if (deleteFiles) {
        try {
          await rm(dir, { recursive: true, force: true });
          logger?.warn({ slug: show.slug, dir }, 'deleted show folder and its files');
        } catch (err) {
          logger?.error({ err, dir }, 'could not delete show folder');
          throw badRequest(
            `\`${dir}\` could not be deleted: ${err.message}. Nothing has been removed from SelfPod, so you can fix the permissions and try again.`,
            'rmdir_failed',
          );
        }
      }

      deleteShow.run(id); // cascades to episodes and scan_log rows

      // When the folder stays, remember that its removal was deliberate. Without
      // this, the next scan re-adopts the folder with a new id, a new feed token
      // and new episode GUIDs — breaking every subscriber.
      if (!deleteFiles) {
        db.prepare(
          'INSERT INTO removed_folders (slug, removed_at) VALUES (?, ?) ON CONFLICT(slug) DO UPDATE SET removed_at = excluded.removed_at',
        ).run(show.slug, nowIso());
      }

      events?.emit(EVENTS.SHOWS_CHANGED, {});
      events?.emit(EVENTS.SHOW_CHANGED, { showId: id, slug: show.slug });
      return { slug: show.slug, filesDeleted: deleteFiles };
    },

    /** Folders the user removed on purpose, which discovery must skip. */
    isFolderRemoved(slug) {
      return db.prepare('SELECT 1 FROM removed_folders WHERE slug = ?').get(slug) !== undefined;
    },

    listRemovedFolders() {
      return db.prepare('SELECT slug, removed_at FROM removed_folders ORDER BY removed_at DESC').all();
    },

    /** Asking for the show back clears the tombstone so discovery adopts it again. */
    forgetRemovedFolder(slug) {
      db.prepare('DELETE FROM removed_folders WHERE slug = ?').run(slug);
    },

    /* ---- show.json ---- */

    /** Read once at discovery. Never consulted again (spec §7.1). */
    async readShowConfig(slug) {
      const path = join(dirFor(slug), FILE_NAMES.SHOW_CONFIG);
      try {
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw);
        const legacy = parsed.category
          ? matchLegacyCategory(String(parsed.category))
          : null;
        return {
          found: true,
          title: cleanString(parsed.title),
          description: cleanString(parsed.description),
          authorName: cleanString(parsed.author_name ?? parsed.authorName ?? parsed.author),
          authorEmail: cleanString(parsed.author_email ?? parsed.authorEmail ?? parsed.email),
          language: cleanString(parsed.language)?.toLowerCase(),
          category: legacy?.category ?? null,
          subcategory: legacy?.subcategory ?? cleanString(parsed.subcategory) ?? null,
          explicit:
            parsed.explicit === undefined ? null : parsed.explicit === true || parsed.explicit === 'true',
        };
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger?.warn({ err, path }, 'could not read show.json; using defaults');
        }
        return { found: false };
      }
    },

    scheduleConfigExport(id) {
      const existing = exportTimers.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        exportTimers.delete(id);
        api.writeShowConfig(id).catch(() => {});
      }, 900);
      if (typeof timer.unref === 'function') timer.unref();
      exportTimers.set(id, timer);
    },

    /**
     * Atomic write (temp file + rename) so a reader never sees a half-written
     * file. Failure is logged and swallowed: the database already holds the
     * truth, and losing the export must not fail the user's save.
     */
    async writeShowConfig(id) {
      const show = api.get(id);
      if (!show) return false;
      const dir = dirFor(show);
      const target = join(dir, FILE_NAMES.SHOW_CONFIG);
      const tmp = join(dir, `.${FILE_NAMES.SHOW_CONFIG}.tmp`);
      const payload = {
        _comment:
          'Exported by SelfPod so your show settings are portable. SelfPod reads this only when first discovering a folder; after that its database is authoritative.',
        title: show.title,
        description: show.description,
        author_name: show.author_name,
        author_email: show.author_email,
        language: show.language,
        category: show.itunes_category,
        subcategory: show.itunes_subcategory,
        explicit: show.explicit === 1,
      };
      try {
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await rename(tmp, target);
        return true;
      } catch (err) {
        logger?.warn(
          { err, path: target },
          'could not write show.json; your settings are safely stored in the database',
        );
        return false;
      }
    },

    /**
     * Fills in author details on shows that were discovered before the instance
     * defaults existed — the common case on first run, where the startup scan
     * finds folders before the setup wizard has been completed. Only ever fills
     * blanks, so a value the user chose is never touched.
     */
    applyDefaultsToBlankShows() {
      const defaults = settings.defaults();
      const updated = [];
      for (const show of api.list()) {
        const fields = {};
        if (!show.author_name?.trim() && defaults.authorName) fields.author_name = defaults.authorName;
        if (!show.author_email?.trim() && defaults.authorEmail) fields.author_email = defaults.authorEmail;
        if (!Object.keys(fields).length) continue;

        fields.updated_at = nowIso();
        const assignments = Object.keys(fields).map((key) => `${key} = @${key}`).join(', ');
        db.prepare(`UPDATE shows SET ${assignments} WHERE id = @id`).run({ ...fields, id: show.id });
        events?.emit(EVENTS.SHOW_CHANGED, { showId: show.id, slug: show.slug });
        api.scheduleConfigExport(show.id);
        updated.push(show.slug);
      }
      if (updated.length) {
        logger?.info({ shows: updated }, 'applied instance defaults to shows that had none');
      }
      return updated;
    },

    categories() {
      return APPLE_CATEGORIES;
    },

    stop() {
      for (const timer of exportTimers.values()) clearTimeout(timer);
      exportTimers.clear();
    },
  };

  return api;
}

/** `??` is not enough here: an empty settings default must fall through too. */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function cleanString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toBoolInt(value) {
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on') return 1;
  return 0;
}
