import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TRIMMABLE_EXTENSIONS, TRIM_STATUS } from '../constants.js';
import { EVENTS } from '../lib/events.js';
import { cutFrames } from '../lib/mp3-cut.js';
import { frameProfile } from '../lib/mp3-frames.js';
import { newId } from '../lib/tokens.js';

/**
 * Writing the trimmed copy of an episode (spec §19.6).
 *
 * Nothing here touches `publish_hold`. Whether an episode is ready to go out is
 * `resolvePublishHold`'s answer and the pipeline settles it once the whole show has
 * been through — and the difference is not bookkeeping. Clearing the hold as each
 * episode is cut publishes it the moment its own audio is ready, while segments that
 * would also have been cut out of it are still sitting undecided. A listener polling
 * during a run would take that episode, adverts and all, and once an app has
 * downloaded an episode the hold has bought nothing.
 *
 * The original is never touched. What the owner dropped on their share, or what a
 * subscription downloaded, stays exactly as it arrived — the trimmed copy lives under
 * `/data/.trimmed/{show_id}/` beside the other derived caches, and deleting the whole
 * directory costs nothing but the CPU to rebuild it. That is the point of keeping it:
 * a cut is a decision, decisions get revised, and revising one must not mean the audio
 * is gone.
 *
 * ## Why a failed trim publishes the original
 *
 * The tempting answer is to hold the episode back — it was going to have adverts
 * removed, and it doesn't. But an episode that silently never appears, with no
 * explanation, is the failure mode this codebase exists against, while an advert that
 * survives explains itself the moment you hear it. So a failure publishes the original,
 * loudly: a warning in the log and a health row naming the episode.
 *
 * This is only safe because the enclosure URL carries a content version. A retry that
 * later succeeds changes the bytes *and* the URL, so no client is left holding half of
 * one file and half of another — which is the hazard that made holding the default in
 * the first place.
 */
/** Reasons a trim did not happen that are not faults. */
const EXPECTED_OUTCOMES = new Set(['nothing_approved', 'unsupported_format', 'unknown_show']);

export function createTrimmer({ db, config, events, logger, health, shows, episodes, adDetect, metadata }) {
  function showDir(showId) {
    return join(config.trimmedDir, showId);
  }

  /** Where an episode's trimmed copy is, or null if it has none. */
  function pathFor(episode) {
    if (!episode?.trimmed_filename) return null;
    return join(showDir(episode.show_id), episode.trimmed_filename);
  }

  function isTrimmable(episode) {
    const at = episode.filename.lastIndexOf('.');
    if (at < 0) return false;
    return TRIMMABLE_EXTENSIONS.includes(episode.filename.slice(at).toLowerCase());
  }

  /**
   * Forgets the trimmed copy, returning the episode to publishing its original.
   *
   * Used when the cut list empties out — every segment that touched this episode was
   * rejected — and when the episode itself goes.
   */
  async function discard(episode) {
    const path = pathFor(episode);
    // The row first, the file second — the same order `trimEpisode` uses, and for the
    // same reason. Deleting first leaves a window in which the row names a file that
    // is not there, and in that window the feed advertises a length for bytes the
    // media route answers 404 for.
    const updated = episodes.setSystemFields(episode.id, {
      trim_status: null,
      trimmed_filename: null,
      trimmed_bytes: null,
      trimmed_duration_seconds: null,
      trimmed_etag: null,
    });
    if (path) await rm(path, { force: true }).catch(() => {});
    return updated;
  }

  function fail(episode, reason, detail) {
    logger?.warn({ episodeId: episode.id, reason, detail }, 'could not trim an episode');
    health?.set(`trim_${episode.id}`, {
      level: 'warn',
      message: `SelfPod could not remove the approved adverts from “${episode.title}”.`,
      detail: `${detail} The episode is published as it arrived, adverts included.`,
    });
    return {
      episode: episodes.setSystemFields(episode.id, {
        trim_status: TRIM_STATUS.FAILED,
      }),
      trimmed: false,
      reason,
    };
  }

  const api = {
    pathFor,

    /**
     * Produces the trimmed copy of one episode from its approved segments.
     *
     * Idempotent by content: the digest of the trimmed bytes is the version, so
     * re-running with an unchanged cut list rewrites an identical file and leaves the
     * enclosure URL alone.
     */
    async trimEpisode(episode) {
      const show = shows.get(episode.show_id);
      if (!show) return { trimmed: false, reason: 'unknown_show' };
      if (!isTrimmable(episode)) return { trimmed: false, reason: 'unsupported_format' };

      const cuts = adDetect.cutListFor(episode.id);
      if (!cuts.length) {
        // Not a failure — nothing has been approved for this episode, or everything
        // that was has since been rejected. Either way it publishes as it arrived.
        return { episode: await discard(episode), trimmed: false, reason: 'nothing_approved' };
      }

      const source = join(shows.dirFor(show), episode.filename);
      let buffer;
      try {
        buffer = await readFile(source);
      } catch (err) {
        return fail(episode, 'unreadable', `The file could not be read: ${err.message}.`);
      }

      episodes.setSystemFields(episode.id, { trim_status: TRIM_STATUS.TRIMMING });

      const result = cutFrames(buffer, cuts);
      if (!result) {
        // `cutFrames` refuses rather than returning something wrong, and there are two
        // ways to get here. Saying which matters: one is a bug upstream, the other is
        // a file SelfPod is not willing to cut, and only the second is the owner's to
        // act on.
        const profile = frameProfile(buffer);
        if (profile?.truncated) {
          return fail(
            episode,
            'too_long',
            'This episode is longer than SelfPod will read in one piece (about five hours).',
          );
        }
        return fail(
          episode,
          'nothing_left',
          `The approved segments cover the whole episode (${cuts.length} of them).`,
        );
      }

      // The version is part of the filename, not just of the URL. Writing every cut to
      // one name per episode leaves a window between the rename and the database write
      // where the columns describe the old file and the disk holds the new one — and a
      // byte-range request landing in that window is handed bytes from a file that is
      // not the length the feed just advertised. Naming the file after its own content
      // means the two can never disagree: the old cut stays readable at its own name
      // until the row has moved, and only then does it go.
      const version = createHash('sha256').update(result.buffer).digest('hex').slice(0, 12);
      const filename = `${episode.id}.${version}.mp3`;
      const directory = showDir(episode.show_id);
      const staging = join(directory, `.${newId()}.tmp`);
      const destination = join(directory, filename);
      const previous = pathFor(episode);
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(staging, result.buffer);
        await rename(staging, destination);
      } catch (err) {
        await rm(staging, { force: true }).catch(() => {});
        return fail(episode, 'unwritable', `The trimmed copy could not be written: ${err.message}.`);
      }

      // Measured from the file that was written, never computed as "original minus what
      // was cut". Cutting at frame boundaries adds a few tens of milliseconds at each
      // join, and the arithmetic answer would drift from what a player reports.
      const measured = await metadata.read(destination);
      const bytes = (await stat(destination)).size;

      const updated = episodes.setSystemFields(episode.id, {
        trim_status: TRIM_STATUS.TRIMMED,
        trimmed_filename: filename,
        trimmed_bytes: bytes,
        trimmed_duration_seconds: measured.durationSeconds ?? null,
        trimmed_etag: version,
      });

      // Only now, with nothing pointing at it any more.
      if (previous && previous !== destination) await rm(previous, { force: true }).catch(() => {});

      health?.clear(`trim_${episode.id}`);
      logger?.info(
        {
          episodeId: episode.id,
          cuts: cuts.length,
          framesRemoved: result.framesRemoved,
          removedSeconds: Math.round((result.durationMs - (measured.durationSeconds ?? 0) * 1000) / 1000),
          durationSeconds: measured.durationSeconds,
        },
        'trimmed an episode',
      );
      events?.emit(EVENTS.SHOW_CHANGED, { showId: episode.show_id });
      return { episode: updated, trimmed: true, framesRemoved: result.framesRemoved };
    },

    /**
     * Brings every episode of a show into line with the current decisions.
     *
     * Only the episodes whose trim is stale are touched, so approving one segment in a
     * 200-episode show does not rewrite 200 files.
     */
    async trimShow(showId, { force = false } = {}) {
      const rows = episodes.listByShow(showId);
      let trimmed = 0;
      let failed = 0;
      for (const episode of rows) {
        if (!force && episode.trim_status === TRIM_STATUS.TRIMMED) continue;
        const outcome = await api.trimEpisode(force ? { ...episode, trim_status: null } : episode);
        if (outcome.trimmed) trimmed += 1;
        // Only genuine failures count. "Nothing was approved" and "SelfPod cannot read
        // this format" are both ordinary answers, and counting them would put a
        // warning in the activity log — and therefore the episode under "Problems",
        // permanently — for a show where nothing is wrong.
        else if (!EXPECTED_OUTCOMES.has(outcome.reason)) failed += 1;
      }
      return { trimmed, failed, considered: rows.length };
    },

    /** Every episode whose trimmed copy no longer matches the decisions. */
    pending(showId) {
      return db
        .prepare(
          `SELECT * FROM episodes
            WHERE show_id = ? AND (trim_status = '${TRIM_STATUS.PENDING}' OR trim_status IS NULL)`,
        )
        .all(showId);
    },

  };

  return api;
}
