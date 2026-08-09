import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  EPISODE_STATUS,
  SCAN_TRIGGER,
  SHOW_STATUS,
  audioMimeType,
  isSupportedAudioFile,
} from '../constants.js';
import { nowIso } from '../lib/dates.js';
import { EVENTS } from '../lib/events.js';
import { computeIdentityKey } from '../lib/identity.js';
import { isUsableSlug } from '../lib/slug.js';
import { newId } from '../lib/tokens.js';

/**
 * The library scanner (spec §6).
 *
 * Design points that exist because the hand-rolled version got them wrong:
 *  - identity is content-derived, so renaming a file keeps its GUID (§7.2);
 *  - a file that disappears is marked `missing`, not deleted, so a network-share
 *    blip cannot drop episodes out of subscribers' feeds (§6.3);
 *  - every per-file failure becomes a plain-language activity-log line instead of
 *    silently skipping the file (§11.5);
 *  - user-edited titles are never overwritten (§6.3).
 */
export function createScanner({
  db,
  config,
  settings,
  events,
  logger,
  shows,
  episodes,
  covers,
  metadata,
  activity,
  health,
}) {
  /** showId → pending trigger, so overlapping requests collapse into one scan. */
  const queued = new Map();
  let globalQueued = null;
  let running = false;
  let currentScan = null;

  /** Set of showIds whose next scan must re-hash every file (manual rescans). */
  const forceRehash = new Set();

  const api = {
    get isScanning() {
      return running;
    },

    get current() {
      return currentScan;
    },

    /**
     * Discovers show folders one level under /data/shows. Creating a show is
     * "make a folder" — never an edit to docker-compose.yml (spec §5, §13 lesson 8).
     */
    async discoverShows() {
      let entries;
      try {
        entries = await readdir(config.showsDir, { withFileTypes: true });
        health.clear('shows_readable');
      } catch (err) {
        health.set('shows_readable', {
          level: 'error',
          message: `SelfPod cannot read your shows folder \`${config.showsDir}\`. ${
            activity.formatFileError(config.showsDir, err).message
          }`,
          detail: { path: config.showsDir, code: err.code ?? null },
        });
        return { found: 0, created: [], missing: [] };
      }

      const onDisk = new Set();
      const created = [];
      const skipped = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (!isUsableSlug(entry.name)) {
          skipped.push(entry.name);
          continue;
        }
        onDisk.add(entry.name);
        if (!shows.getBySlug(entry.name)) {
          const show = await shows.createFromFolder(entry.name);
          created.push(show);
        }
      }

      // A folder that vanished becomes a pending-purge state rather than an
      // immediate cascade delete — the user confirms before rows are destroyed.
      const missing = [];
      for (const show of shows.list()) {
        if (onDisk.has(show.slug)) {
          if (show.status === SHOW_STATUS.FOLDER_MISSING) shows.markFolderPresent(show.id);
        } else if (show.status !== SHOW_STATUS.FOLDER_MISSING) {
          shows.markFolderMissing(show.id);
          missing.push(show);
        }
      }

      if (skipped.length) {
        logger?.warn(
          { skipped },
          'ignored folders whose names cannot be used in a URL; rename them to use letters, numbers, dots, dashes and underscores',
        );
      }

      return { found: onDisk.size, created, missing, skipped };
    },

    /** Queues a scan of one show; repeated calls collapse until it runs. */
    enqueueShow(showId, trigger = SCAN_TRIGGER.WATCHER, { rehash = false } = {}) {
      if (!showId) return;
      if (rehash) forceRehash.add(showId);
      const existing = queued.get(showId);
      // A manual request outranks a background one for logging purposes.
      if (!existing || trigger === SCAN_TRIGGER.MANUAL) queued.set(showId, trigger);
      void drain();
    },

    enqueueAll(trigger = SCAN_TRIGGER.SCHEDULED, { rehash = false } = {}) {
      if (rehash) for (const show of shows.list()) forceRehash.add(show.id);
      if (!globalQueued || trigger === SCAN_TRIGGER.MANUAL) globalQueued = trigger;
      void drain();
    },

    /** Awaits the queue draining — used by tests and by "rescan then respond" flows. */
    async settle() {
      await drain();
      while (running) await new Promise((resolve) => setTimeout(resolve, 15));
    },

    async scanShowNow(showId, trigger = SCAN_TRIGGER.MANUAL, options = {}) {
      return scanShow(showId, trigger, options);
    },

    async scanAllNow(trigger = SCAN_TRIGGER.MANUAL, options = {}) {
      return scanAll(trigger, options);
    },
  };

  async function drain() {
    if (running) return;
    running = true;
    try {
      // Loop rather than recurse: new work queued mid-scan is picked up here.
      for (;;) {
        if (globalQueued) {
          const trigger = globalQueued;
          globalQueued = null;
          await scanAll(trigger);
          continue;
        }
        const next = queued.entries().next();
        if (next.done) break;
        const [showId, trigger] = next.value;
        queued.delete(showId);
        await scanShow(showId, trigger);
      }
    } finally {
      running = false;
      currentScan = null;
    }
  }

  async function scanAll(trigger, { rehash = false } = {}) {
    const scanId = activity.start({ showId: null, trigger, note: null });
    const started = Date.now();
    events?.emit(EVENTS.SCAN_STARTED, { scope: 'all', trigger, scanId });

    const discovery = await api.discoverShows();
    const totals = { filesFound: 0, added: 0, updated: 0, missing: 0, removed: 0 };
    const errors = [];
    const warnings = [];

    const list = shows.list().filter((show) => show.status === SHOW_STATUS.ACTIVE);
    for (const [index, show] of list.entries()) {
      events?.emit(EVENTS.SCAN_PROGRESS, {
        scope: 'all',
        scanId,
        showId: show.id,
        slug: show.slug,
        title: show.title,
        index: index + 1,
        total: list.length,
      });
      // Nested scans get their own log rows: the per-show detail is what the
      // activity page shows, while this row summarises the sweep.
      const result = await scanShow(show.id, trigger, { rehash, parentScanId: scanId });
      if (!result) continue;
      totals.filesFound += result.filesFound;
      totals.added += result.added;
      totals.updated += result.updated;
      totals.missing += result.missing;
      totals.removed += result.removed;
      for (const error of result.errors) errors.push({ ...error, show: show.slug });
      for (const warning of result.warnings) warnings.push({ ...warning, show: show.slug });
    }

    for (const show of discovery.missing) {
      warnings.push({
        file: show.slug,
        message: `The folder for "${show.title}" is no longer in \`${config.showsDir}\`. Its feed is paused; you can restore the folder or remove the show from the dashboard.`,
      });
    }
    for (const name of discovery.skipped ?? []) {
      warnings.push({
        file: name,
        message: `The folder \`${name}\` was ignored because its name can't be used in a feed URL. Rename it using letters, numbers, dots, dashes or underscores.`,
      });
    }

    const record = activity.finish(scanId, {
      ...totals,
      errors,
      warnings,
      note: `${list.length} show${list.length === 1 ? '' : 's'} scanned`,
    });
    activity.trim(500);
    logger?.info(
      { trigger, ms: Date.now() - started, ...totals, shows: list.length },
      'library scan complete',
    );
    events?.emit(EVENTS.SCAN_FINISHED, { scope: 'all', trigger, scanId, totals });
    return record;
  }

  async function scanShow(showId, trigger, { rehash = false, parentScanId = null } = {}) {
    const show = shows.get(showId);
    if (!show) return null;
    if (show.status === SHOW_STATUS.FOLDER_MISSING) {
      // Confirm the folder really is gone before doing anything else.
      const discovery = await api.discoverShows();
      const refreshed = shows.get(showId);
      if (!refreshed || refreshed.status === SHOW_STATUS.FOLDER_MISSING) return null;
      void discovery;
    }

    const shouldRehash = rehash || forceRehash.delete(showId);
    const dir = shows.dirFor(show);
    const scanId = activity.start({ showId, trigger, note: null });
    currentScan = { scanId, showId, slug: show.slug, title: show.title, startedAt: nowIso() };
    events?.emit(EVENTS.SCAN_STARTED, { scope: 'show', showId, slug: show.slug, trigger, scanId });

    const errors = [];
    const warnings = [];
    let filesFound = 0;
    let added = 0;
    let updated = 0;
    let missingCount = 0;
    let changed = false;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        shows.markFolderMissing(showId);
        const record = activity.finish(scanId, {
          errors: [
            {
              file: dir,
              message: `The folder \`${dir}\` is gone. "${show.title}" is paused until it comes back, or you remove the show.`,
            },
          ],
        });
        events?.emit(EVENTS.SCAN_FINISHED, { scope: 'show', showId, slug: show.slug, trigger, scanId });
        return { filesFound: 0, added: 0, updated: 0, missing: 0, removed: 0, errors: record.errors, warnings: [] };
      }
      const formatted = activity.formatFileError(dir, err);
      health.set(`show_read_${showId}`, { level: 'error', message: formatted.message });
      const record = activity.finish(scanId, { errors: [formatted] });
      events?.emit(EVENTS.SCAN_FINISHED, { scope: 'show', showId, slug: show.slug, trigger, scanId });
      return { filesFound: 0, added: 0, updated: 0, missing: 0, removed: 0, errors: record.errors, warnings: [] };
    }
    health.clear(`show_read_${showId}`);
    shows.markFolderPresent(showId);

    const seenEpisodeIds = new Set();
    /** identity_key → filename, so byte-identical files can be reported. */
    const claimedIdentities = new Map();
    const audioFiles = [];
    const unsupported = [];

    for (const entry of entries) {
      if (entry.isDirectory()) continue; // subdirectories are reserved (spec §5)
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue;
      if (isSupportedAudioFile(entry.name)) audioFiles.push(entry.name);
      else if (isNoteworthyNonAudio(entry.name)) unsupported.push(entry.name);
    }

    filesFound = audioFiles.length;

    // A file the user clearly meant as audio but that isn't supported must be
    // *visible*: the prototype silently ignored .m4a files and an entire episode
    // just never appeared (spec §13 lesson 1).
    for (const name of unsupported) {
      warnings.push({
        file: name,
        message: `\`${name}\` was ignored because SelfPod doesn't serve that file type. Supported audio: mp3, m4a, aac, ogg, opus, wav, flac.`,
      });
    }

    for (const filename of audioFiles) {
      const path = join(dir, filename);
      let stats;
      try {
        stats = await stat(path);
      } catch (err) {
        errors.push(activity.formatFileError(filename, err));
        continue;
      }

      const mtimeIso = stats.mtime.toISOString();
      const mimeType = audioMimeType(filename);

      // Fast path: same name, same size, same mtime as a row we already have →
      // nothing can have changed that matters, so skip the hash. A 5-minute
      // full-library poll has to be cheap on a NAS.
      if (!shouldRehash) {
        const byName = episodes.findByFilename(showId, filename);
        if (
          byName &&
          byName.file_size_bytes === stats.size &&
          byName.file_mtime === mtimeIso &&
          byName.mime_type === mimeType
        ) {
          seenEpisodeIds.add(byName.id);
          // Claim the identity even on the fast path, so a byte-identical sibling
          // later in this scan is reported rather than quietly stealing the row.
          claimedIdentities.set(byName.identity_key, filename);
          if (byName.status === EPISODE_STATUS.MISSING) {
            episodes.setSystemFields(byName.id, {
              status: EPISODE_STATUS.ACTIVE,
              missing_since: null,
            });
            updated += 1;
            changed = true;
          }
          continue;
        }
      }

      let identityKey;
      try {
        identityKey = await computeIdentityKey(path, { size: stats.size });
      } catch (err) {
        errors.push(activity.formatFileError(filename, err));
        continue;
      }

      // Two files with identical audio are one episode, because identity is
      // content-derived (spec §7.2). That is correct, but it must not be silent:
      // the first filename wins and the duplicate is reported, so a user who
      // expected two episodes finds out here rather than from a short feed.
      const alreadyClaimedBy = claimedIdentities.get(identityKey);
      if (alreadyClaimedBy) {
        warnings.push({
          file: filename,
          message: `\`${filename}\` has exactly the same audio as \`${alreadyClaimedBy}\`, so it is not published as a separate episode. If these are meant to be different episodes, one of them needs different audio.`,
        });
        continue;
      }
      claimedIdentities.set(identityKey, filename);

      const existing = episodes.findByIdentity(showId, identityKey);

      if (existing) {
        seenEpisodeIds.add(existing.id);

        // A user-removed episode stays removed even though its file is present.
        if (existing.status === EPISODE_STATUS.REMOVED) {
          if (existing.filename !== filename) {
            episodes.setSystemFields(existing.id, { filename, file_mtime: mtimeIso });
          }
          continue;
        }

        const fields = {};
        if (existing.filename !== filename) fields.filename = filename; // rename: GUID untouched
        if (existing.file_size_bytes !== stats.size) fields.file_size_bytes = stats.size;
        if (existing.file_mtime !== mtimeIso) fields.file_mtime = mtimeIso;
        if (existing.mime_type !== mimeType) fields.mime_type = mimeType;
        if (existing.status !== EPISODE_STATUS.ACTIVE) {
          fields.status = EPISODE_STATUS.ACTIVE;
          fields.missing_since = null;
        }

        // Re-read duration only when the bytes actually changed.
        if (existing.duration_seconds === null || fields.file_size_bytes !== undefined) {
          const meta = await metadata.read(path);
          if (meta.error) {
            warnings.push({
              file: filename,
              message: `SelfPod could not read the length of \`${filename}\`. It will still play; the duration is left out of the feed rather than guessed.`,
            });
          }
          if (meta.durationSeconds !== null) fields.duration_seconds = meta.durationSeconds;
          if (meta.bitrateKbps !== null) fields.bitrate_kbps = meta.bitrateKbps;
          if (meta.title && meta.title !== existing.tag_title) fields.tag_title = meta.title;
          // Only a title the user has never touched may follow the file's tags.
          if (meta.title && existing.title_is_custom === 0 && meta.title !== existing.title) {
            fields.title = meta.title;
          }
        }

        if (Object.keys(fields).length) {
          episodes.setSystemFields(existing.id, fields);
          updated += 1;
          changed = true;
        }
        continue;
      }

      // Genuinely new file → fresh random GUID (never derived from the filename).
      const meta = await metadata.read(path);
      if (meta.error) {
        warnings.push({
          file: filename,
          message: `SelfPod could not read tags or length from \`${filename}\`. It's still published; the duration is left out of the feed rather than guessed.`,
        });
      }
      const created = episodes.insert({
        id: newId(),
        show_id: showId,
        filename,
        identity_key: identityKey,
        title: meta.title ?? titleFromFilename(filename),
        title_is_custom: 0,
        tag_title: meta.title ?? null,
        description: meta.description ?? '',
        season: meta.season ?? null,
        episode_number: meta.episodeNumber ?? null,
        pub_date: mtimeIso,
        duration_seconds: meta.durationSeconds,
        bitrate_kbps: meta.bitrateKbps,
        file_size_bytes: stats.size,
        file_mtime: mtimeIso,
        mime_type: mimeType,
      });
      seenEpisodeIds.add(created.id);
      added += 1;
      changed = true;
      logger?.info({ slug: show.slug, filename }, 'new episode');
    }

    // Files that disappeared: soft-mark only. The grace sweep in the scheduler
    // is what eventually drops them from the feed.
    for (const episode of episodes.listByShow(showId)) {
      if (seenEpisodeIds.has(episode.id)) continue;
      if (episode.status === EPISODE_STATUS.REMOVED) continue;
      if (episode.status !== EPISODE_STATUS.MISSING) {
        episodes.setSystemFields(episode.id, {
          status: EPISODE_STATUS.MISSING,
          missing_since: nowIso(),
        });
        changed = true;
        warnings.push({
          file: episode.filename,
          message: `\`${episode.filename}\` is no longer on disk. It stays in the feed for now in case this is a temporary blip, and drops out automatically after the grace period.`,
        });
      }
      missingCount += 1;
    }

    // Cover art.
    const coverResult = await syncCover(show, dir);
    if (coverResult.changed) changed = true;
    if (coverResult.warning) warnings.push(coverResult.warning);

    const record = activity.finish(scanId, {
      filesFound,
      added,
      updated,
      missing: missingCount,
      removed: 0,
      errors,
      warnings,
      note: parentScanId ? `part of scan #${parentScanId}` : null,
    });
    shows.setSystemFields(showId, { last_scan_id: scanId });

    if (changed) events?.emit(EVENTS.SHOW_CHANGED, { showId, slug: show.slug });
    events?.emit(EVENTS.SCAN_FINISHED, {
      scope: 'show',
      showId,
      slug: show.slug,
      trigger,
      scanId,
      totals: { filesFound, added, updated, missing: missingCount },
    });

    return { filesFound, added, updated, missing: missingCount, removed: 0, errors, warnings };
  }

  async function syncCover(show, dir) {
    const detected = await covers.detect(dir);
    if (!detected) {
      if (show.cover_filename) {
        shows.setSystemFields(show.id, {
          cover_filename: null,
          cover_width: null,
          cover_height: null,
          cover_format: null,
          cover_mtime: null,
        });
        return {
          changed: true,
          warning: {
            file: show.slug,
            message: `No cover art found in \`${dir}\`. Add cover.jpg (or .png/.webp) to the folder, or upload one from the show page.`,
          },
        };
      }
      return {
        changed: false,
        warning: {
          file: show.slug,
          message: `"${show.title}" has no cover art. Add cover.jpg (or .png/.webp) to \`${dir}\`, or upload one from the show page.`,
        },
      };
    }

    const info = await covers.inspect(join(dir, detected));
    const unchanged =
      show.cover_filename === detected &&
      show.cover_mtime === info.mtime &&
      show.cover_width === info.width;
    if (unchanged) {
      return {
        changed: false,
        warning: info.warning ? { file: detected, message: info.warning.message } : null,
      };
    }

    shows.setSystemFields(show.id, {
      cover_filename: detected,
      cover_width: info.width,
      cover_height: info.height,
      cover_format: info.format,
      cover_mtime: info.mtime,
    });
    covers.invalidate(join(dir, detected));

    return {
      changed: true,
      warning: info.warning ? { file: detected, message: info.warning.message } : null,
    };
  }

  return api;
}

/** "2026-08-07-episode-one.m4a" → "Episode One" (a suggestion, never a lock). */
function titleFromFilename(filename) {
  const withoutExt = filename.replace(/\.[^.]+$/, '');
  const withoutDatePrefix = withoutExt.replace(/^\d{4}[-_.]?\d{2}[-_.]?\d{2}[\s\-_.]*/, '');
  const words = (withoutDatePrefix || withoutExt)
    .replace(/[_]+/g, ' ')
    .replace(/-+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return filename;
  return words
    .split(' ')
    .map((word) => (/^[A-Z0-9]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * Distinguishes "a file the user probably meant as audio" from ordinary clutter,
 * so the activity log warns about `.wma` but not about `.txt` or `show.json`.
 */
function isNoteworthyNonAudio(name) {
  const lower = name.toLowerCase();
  const ignore = ['show.json', 'thumbs.db', 'desktop.ini', '.ds_store'];
  if (ignore.includes(lower)) return false;
  const knownNonAudio = [
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.txt', '.md', '.json', '.nfo', '.pdf',
    '.srt', '.vtt', '.cue', '.log', '.tmp', '.part', '.crdownload', '.db', '.ini',
  ];
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false;
  return !knownNonAudio.includes(lower.slice(dot));
}
