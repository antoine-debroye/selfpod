import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  EMBEDDED_ART_MAX_BYTES,
  EPISODE_ART_SIDECAR_EXTENSIONS,
  EPISODE_STATUS,
  SCAN_TRIGGER,
  SHOW_STATUS,
  audioMimeType,
  imageMimeType,
  isSupportedAudioFile,
} from '../constants.js';
import { nowIso } from '../lib/dates.js';
import { EVENTS } from '../lib/events.js';
import { initialPublishHold } from '../lib/publish-hold.js';
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
  episodeArt,
  metadata,
  activity,
  health,
}) {
  /** showId → pending trigger, so overlapping requests collapse into one scan. */
  const queued = new Map();
  let globalQueued = null;
  let running = false;
  let currentScan = null;

  /**
   * Every scan runs through here, one at a time.
   *
   * Two scans overlapping is not merely wasteful, it is incorrect: the database
   * writes are synchronous but the scan body awaits on hashing and metadata, so a
   * second scan can insert a row between the first scan's read and its write —
   * producing a UNIQUE constraint failure, or worse, marking a file that is
   * present as missing because it was absent from the other scan's directory
   * listing. The scheduled rescan colliding with the startup scan is enough to
   * trigger it, so serialising is not optional.
   */
  let chain = Promise.resolve();
  let inFlight = 0;
  function serialise(task) {
    inFlight += 1;
    const result = chain.then(task, task).finally(() => {
      inFlight -= 1;
    });
    // The chain must survive a failed scan, or every later scan is skipped.
    chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Set of showIds whose next scan must re-hash every file (manual rescans). */
  const forceRehash = new Set();

  const api = {
    get isScanning() {
      return inFlight > 0 || running;
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
      const ignored = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (!isUsableSlug(entry.name)) {
          skipped.push(entry.name);
          continue;
        }
        onDisk.add(entry.name);
        if (!shows.getBySlug(entry.name)) {
          // The user removed this show but chose to keep its folder. Re-adopting it
          // would mint a new feed token and new episode GUIDs, breaking every
          // subscriber — so it is left alone until they explicitly add it back.
          if (shows.isFolderRemoved(entry.name)) {
            ignored.push(entry.name);
            continue;
          }
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

      return { found: onDisk.size, created, missing, skipped, ignored };
    },

    /** Queues a scan of one show; repeated calls collapse until it runs. */
    enqueueShow(showId, trigger = SCAN_TRIGGER.WATCHER, { rehash = false } = {}) {
      if (!showId) return;
      if (rehash) forceRehash.add(showId);
      const existing = queued.get(showId);
      // A manual request outranks a background one for logging purposes.
      if (!existing || trigger === SCAN_TRIGGER.MANUAL) queued.set(showId, trigger);
      drainSafely();
    },

    enqueueAll(trigger = SCAN_TRIGGER.SCHEDULED, { rehash = false } = {}) {
      if (rehash) for (const show of shows.list()) forceRehash.add(show.id);
      if (!globalQueued || trigger === SCAN_TRIGGER.MANUAL) globalQueued = trigger;
      drainSafely();
    },

    /** Awaits the queue draining — used by tests and by "rescan then respond" flows. */
    async settle() {
      await drain();
      while (running) await new Promise((resolve) => setTimeout(resolve, 15));
    },

    async scanShowNow(showId, trigger = SCAN_TRIGGER.MANUAL, options = {}) {
      return serialise(() => scanShow(showId, trigger, options));
    },

    async scanAllNow(trigger = SCAN_TRIGGER.MANUAL, options = {}) {
      return serialise(() => scanAll(trigger, options));
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
          await serialise(() => scanAll(trigger));
          continue;
        }
        const next = queued.entries().next();
        if (next.done) break;
        const [showId, trigger] = next.value;
        queued.delete(showId);
        await serialise(() => scanShow(showId, trigger));
      }
    } finally {
      running = false;
      currentScan = null;
    }
  }

  /** Queued work is fire-and-forget, so its failures have to be caught here. */
  function drainSafely() {
    drain().catch((err) => logger?.error({ err }, 'library scan failed'));
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
    for (const name of discovery.ignored ?? []) {
      warnings.push({
        file: name,
        message: `The folder \`${name}\` is still on disk but you removed its show, so SelfPod is leaving it alone. Create a show with the folder name \`${name}\` to publish it again.`,
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
    /**
     * lowercased image filename → the name as it really is on disk.
     *
     * Built once from the listing the scan already has, so looking for
     * `ep-one.jpg` beside `ep-one.mp3` costs a Map lookup rather than a readdir or
     * four stat calls per episode. Case-insensitive because the shares these files
     * arrive over usually are.
     */
    const imagesByLower = new Map();

    for (const entry of entries) {
      if (entry.isDirectory()) continue; // subdirectories are reserved (spec §5)
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue;
      if (isSupportedAudioFile(entry.name)) audioFiles.push(entry.name);
      else if (isNoteworthyNonAudio(entry.name)) unsupported.push(entry.name);
      if (imageMimeType(entry.name)) imagesByLower.set(entry.name.toLowerCase(), entry.name);
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
      let mtimeIso;
      try {
        stats = await stat(path);
        // A filesystem can report a timestamp Date cannot represent, which would
        // throw RangeError out of the whole scan; the fallback keeps one odd file
        // from stopping the library.
        mtimeIso = stats.mtime.toISOString();
      } catch (err) {
        if (stats && err instanceof RangeError) {
          mtimeIso = nowIso();
          warnings.push({
            file: filename,
            message: `\`${filename}\` has a modification time SelfPod cannot read, so today's date is used as its publish date. You can set the publish date yourself on the episode page.`,
          });
        } else {
          errors.push(activity.formatFileError(filename, err));
          continue;
        }
      }

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

          const fastFields = {};
          if (
            byName.status === EPISODE_STATUS.MISSING ||
            byName.status === EPISODE_STATUS.EXPIRED
          ) {
            fastFields.status = EPISODE_STATUS.ACTIVE;
            fastFields.missing_since = null;
            fastFields.removed_at = null;
            if (byName.status === EPISODE_STATUS.EXPIRED) {
              warnings.push({ file: filename, message: returnedFromExpiry(filename) });
            }
          }

          // Artwork is checked even here, where nothing about the audio changed,
          // for two reasons the fast path cannot see on its own. A sidecar image is
          // a *different file*: replacing `ep-one.jpg` does not move `ep-one.mp3`'s
          // name, size or mtime, so without this a swapped sidecar would never be
          // noticed. And `/data/.art` is a cache that can be lost while the database
          // survives — restore `db.sqlite` from a backup and every row still names an
          // image that is not there. Neither costs a read when nothing is wrong.
          const fastArt = await syncEpisodeArt({
            show,
            dir,
            filename,
            path,
            episode: byName,
            imagesByLower,
          });
          for (const warning of fastArt.warnings) warnings.push(warning);
          Object.assign(fastFields, fastArt.fields);

          if (Object.keys(fastFields).length) {
            episodes.setSystemFields(byName.id, fastFields);
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

        // A user's "remove from feed" is permanent until they undo it. An expired
        // one is not: it fell out of the feed because the file was gone, so the
        // file returning is exactly the signal to bring it back — with the same
        // GUID, which is the whole point of keeping the row.
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
          fields.removed_at = null;
          if (existing.status === EPISODE_STATUS.EXPIRED) {
            warnings.push({ file: filename, message: returnedFromExpiry(filename) });
          }
        }

        // Re-read duration only when the bytes actually changed.
        let meta = null;
        if (existing.duration_seconds === null || fields.file_size_bytes !== undefined) {
          meta = await metadata.read(path);
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

        const changedArt = await syncEpisodeArt({
          show,
          dir,
          filename,
          path,
          episode: existing,
          imagesByLower,
          meta,
          // A forced rescan means "re-derive everything from the files", and it is
          // also the one route by which a library that predates per-episode artwork
          // picks it up: nothing about those files changes, so no other path would
          // ever look inside their tags again.
          probeEmbedded: shouldRehash,
        });
        for (const warning of changedArt.warnings) warnings.push(warning);
        Object.assign(fields, changedArt.fields);

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
        // Applied here rather than in a pass afterwards. This folder's scan invalidates
        // the feed cache when it finishes, so an episode inserted unheld and held a
        // moment later would still have had a window in which the feed could be built
        // with the untrimmed audio in it — a window nobody will ever reproduce, and
        // which gets reported as "sometimes an episode goes out with the ads still in".
        publish_hold: initialPublishHold(show),
      });
      seenEpisodeIds.add(created.id);
      added += 1;
      changed = true;

      const newArt = await syncEpisodeArt({
        show,
        dir,
        filename,
        path,
        episode: created,
        imagesByLower,
        meta,
        probeEmbedded: true,
      });
      for (const warning of newArt.warnings) warnings.push(warning);
      if (Object.keys(newArt.fields).length) episodes.setSystemFields(created.id, newArt.fields);

      logger?.info({ slug: show.slug, filename }, 'new episode');
    }

    // Files that disappeared: soft-mark only. The grace sweep in the scheduler
    // is what eventually drops them from the feed.
    for (const episode of episodes.listByShow(showId)) {
      if (seenEpisodeIds.has(episode.id)) continue;
      if (episode.status === EPISODE_STATUS.REMOVED) continue;
      if (episode.status === EPISODE_STATUS.EXPIRED) continue;
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

  /**
   * Brings one episode's artwork into line with what is on disk.
   *
   * Sources, first match wins: a sidecar image beside the audio with the same stem;
   * then the picture in the file's own tags; then nothing, which leaves the episode
   * on the show cover exactly as before this feature existed. Sidecar first because
   * it is the one an owner can change without re-tagging — dropping `ep-one.jpg`
   * beside `ep-one.mp3` is the whole interface.
   *
   * **It returns only the columns that actually changed, and that is the point.**
   * `episodes.setSystemFields` bumps `updated_at`; `updated_at` feeds `lastBuildDate`;
   * `lastBuildDate` feeds the feed's ETag. Re-extracting byte-identical artwork and
   * writing it back unconditionally would therefore re-date every episode in the
   * library and hand every subscriber's app a feed it has to download in full — for a
   * change that did not happen. So the freshly computed `art_etag` is compared against
   * the stored one, and when they agree nothing is written at all.
   *
   * Nothing here throws: one unreadable image becomes a warning naming the file, and
   * the scan carries on.
   */
  async function syncEpisodeArt({
    show,
    dir,
    filename,
    path,
    episode,
    imagesByLower,
    meta = null,
    probeEmbedded = false,
  }) {
    const warnings = [];
    const none = { fields: {}, warnings };
    if (!episodeArt || !episode) return none;
    // A removed episode is not in the feed and is not served, so its artwork is left
    // exactly as it was — restoring it should bring back everything, not a blank.
    if (episode.status === EPISODE_STATUS.REMOVED) return none;

    const next = {
      art_source: null,
      art_filename: null,
      art_sidecar_name: null,
      art_sidecar_mtime: null,
      art_width: null,
      art_height: null,
      art_etag: null,
    };

    const sidecarName = findSidecar(filename, imagesByLower);

    // Does the file this row points at still exist? Restoring `db.sqlite` without
    // `/data/.art` leaves a whole library of rows naming images that are not there.
    const cached = episode.art_filename
      ? await fileExists(episodeArt.pathFor(show.id, episode.art_filename))
      : false;

    if (sidecarName) {
      const sidecarPath = join(dir, sidecarName);
      let sidecarMtime;
      try {
        sidecarMtime = (await stat(sidecarPath)).mtime.toISOString();
      } catch (err) {
        warnings.push(activity.formatFileError(sidecarName, err));
        return none;
      }

      const unchanged =
        episode.art_source === 'sidecar' &&
        episode.art_sidecar_name === sidecarName &&
        episode.art_sidecar_mtime === sidecarMtime &&
        Boolean(episode.art_etag) &&
        cached;
      if (unchanged) return none;

      try {
        const stored = await episodeArt.store({
          showId: show.id,
          episodeId: episode.id,
          buffer: await readFile(sidecarPath),
          sourceFormat: imageMimeType(sidecarName),
        });
        next.art_source = 'sidecar';
        next.art_filename = stored.filename;
        next.art_sidecar_name = sidecarName;
        next.art_sidecar_mtime = sidecarMtime;
        next.art_width = stored.width;
        next.art_height = stored.height;
        next.art_etag = stored.etag;
        if (stored.warning) warnings.push({ file: sidecarName, message: stored.warning.message });
      } catch (err) {
        warnings.push({
          file: sidecarName,
          message: `\`${sidecarName}\` could not be used as artwork for \`${filename}\`, so this episode keeps using the show's cover. ${
            activity.formatFileError(sidecarName, err).message
          }`,
        });
        return none;
      }
      return { fields: diffArtFields(episode, next), warnings };
    }

    // No sidecar, so the answer is the file's own tags or nothing. Reading tags is
    // only worth it when something could actually have changed — otherwise a
    // five-minute poll would open every file in the library for no reason.
    const needsTags =
      Boolean(meta) ||
      probeEmbedded ||
      // The cache was lost but the row says there was artwork: rebuild it.
      (episode.art_source === 'embedded' && !cached) ||
      // The sidecar that was the source has gone; fall back to whatever is left.
      episode.art_source === 'sidecar';
    if (!needsTags) return none;

    const tags = meta ?? (await metadata.read(path));

    // The file could not be read at all. That is already reported by the caller, and
    // it says nothing about the artwork — so whatever is stored is left exactly as it
    // is. Clearing it here would turn one unreadable moment on a network share into a
    // re-dated episode with its artwork thrown away.
    if (tags.error) return none;

    if (tags.pictureTooLarge) {
      warnings.push({
        file: filename,
        message: `The artwork embedded in \`${filename}\` is larger than ${Math.round(
          EMBEDDED_ART_MAX_BYTES / (1024 * 1024),
        )} MB, so SelfPod has left it alone and this episode uses the show's cover. Embed a smaller image, or put one called \`${sidecarSuggestion(
          filename,
        )}\` beside the file.`,
      });
      return { fields: diffArtFields(episode, next), warnings };
    }

    if (!tags.picture?.data?.byteLength) {
      // Nothing to store. The columns are cleared rather than left stale, so an
      // episode whose artwork was removed goes back to the show cover.
      return { fields: diffArtFields(episode, next), warnings };
    }

    try {
      const stored = await episodeArt.store({
        showId: show.id,
        episodeId: episode.id,
        buffer: tags.picture.data,
        sourceFormat: tags.picture.format,
      });
      next.art_source = 'embedded';
      next.art_filename = stored.filename;
      next.art_width = stored.width;
      next.art_height = stored.height;
      next.art_etag = stored.etag;
      if (stored.warning) warnings.push({ file: filename, message: stored.warning.message });
    } catch (err) {
      warnings.push({
        file: filename,
        message: `The artwork embedded in \`${filename}\` could not be read, so this episode uses the show's cover. ${
          activity.formatFileError(filename, err).message
        }`,
      });
      return none;
    }
    return { fields: diffArtFields(episode, next), warnings };
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

/** The seven scanner-owned artwork columns, in the order the migration adds them. */
const ART_COLUMNS = Object.freeze([
  'art_source',
  'art_filename',
  'art_sidecar_name',
  'art_sidecar_mtime',
  'art_width',
  'art_height',
  'art_etag',
]);

/**
 * Only the artwork columns whose value genuinely differs.
 *
 * The whole point of the `art_etag` column: identical bytes hash identically, so
 * re-extracting artwork that has not changed produces an empty object here, no
 * `setSystemFields` call, no new `updated_at`, no new feed ETag, and no subscriber
 * re-downloading a library that did not change.
 */
function diffArtFields(episode, next) {
  const fields = {};
  for (const key of ART_COLUMNS) {
    const before = episode[key] ?? null;
    const after = next[key] ?? null;
    if (before !== after) fields[key] = after;
  }
  return fields;
}

/** `ep-one.mp3` → the real-cased `ep-one.JPG` on disk, or null. First match wins. */
function findSidecar(filename, imagesByLower) {
  if (!imagesByLower?.size) return null;
  const dot = filename.lastIndexOf('.');
  const stem = (dot > 0 ? filename.slice(0, dot) : filename).toLowerCase();
  for (const extension of EPISODE_ART_SIDECAR_EXTENSIONS) {
    const actual = imagesByLower.get(stem + extension);
    if (actual) return actual;
  }
  return null;
}

/** The filename to tell the owner to use, in their own file's terms. */
function sidecarSuggestion(filename) {
  const dot = filename.lastIndexOf('.');
  return `${dot > 0 ? filename.slice(0, dot) : filename}.jpg`;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Shared by both scan paths, since either can be the one to notice the return. */
function returnedFromExpiry(filename) {
  return `\`${filename}\` is back after being gone longer than the grace period, so it has returned to the feed with its original episode identity — subscribers keep their played state.`;
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
