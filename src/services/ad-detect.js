import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FINGERPRINTABLE_EXTENSIONS,
  FINGERPRINT_VERSION,
  HOLD_REASONS,
  SEGMENT_SOURCES,
  SEGMENT_STATUS,
  TRIM_STATUS,
} from '../constants.js';
import { nowIso } from '../lib/dates.js';
import { notFound } from '../lib/errors.js';
import { EVENTS } from '../lib/events.js';
import { decodeFingerprint, encodeFingerprint, frameToMs } from '../lib/fingerprint-file.js';
import { frameProfile } from '../lib/mp3-frames.js';
import { findRepeatedSegments, safeToApproveAutomatically } from '../lib/repeated-segments.js';
import { newId } from '../lib/tokens.js';

/**
 * Cataloguing the audio a show repeats (spec §19).
 *
 * Two detectors feed one catalogue. Repetition across a show's episodes finds what was
 * cut in at production time; comparing two downloads of one episode finds what a host
 * stitches in per request. Both produce the same thing — a stretch of audio, where it
 * occurs, and how confident we are — and neither is allowed to decide whether it is an
 * advert.
 *
 * That last point is the design, not a limitation. A theme tune, a sponsor read, a
 * standing intro and a recurring stinger repeat identically, and nothing in the audio
 * separates them. So everything found is catalogued and offered, and the only thing
 * automatic mode changes is whether the owner is asked first.
 *
 * Nothing here decodes audio or runs a subprocess. Detection reads MP3 frame headers,
 * which is fast enough to be uninteresting: an hour-long episode fingerprints in well
 * under a second.
 */
export function createAdDetect({ db, config, events, logger, shows, episodes }) {
  const selectFingerprint = db.prepare('SELECT * FROM episode_fingerprints WHERE episode_id = ?');
  const upsertFingerprint = db.prepare(
    `INSERT INTO episode_fingerprints
       (episode_id, algorithm_version, frame_count, sample_rate, duration_ms, sha256, bytes, created_at)
     VALUES (@episode_id, @algorithm_version, @frame_count, @sample_rate, @duration_ms, @sha256, @bytes, @created_at)
     ON CONFLICT(episode_id) DO UPDATE SET
       algorithm_version = excluded.algorithm_version,
       frame_count = excluded.frame_count,
       sample_rate = excluded.sample_rate,
       duration_ms = excluded.duration_ms,
       sha256 = excluded.sha256,
       bytes = excluded.bytes,
       created_at = excluded.created_at`,
  );

  const selectSegments = db.prepare(
    'SELECT * FROM ad_segments WHERE show_id = ? ORDER BY episode_count DESC, duration_ms DESC',
  );
  const selectSegment = db.prepare('SELECT * FROM ad_segments WHERE id = ?');
  const selectBySignature = db.prepare(
    'SELECT * FROM ad_segments WHERE show_id = ? AND signature = ?',
  );

  function fingerprintPath(showId, episodeId) {
    return join(config.fingerprintDir, showId, `${episodeId}.${FINGERPRINT_VERSION}.fp`);
  }

  /* ---- fingerprints -------------------------------------------------------- */

  /**
   * Reads an episode's frames and stores the fingerprint.
   *
   * Skipped when the stored one already describes this exact file: the audio's own
   * digest is the key, so a rename costs nothing and a genuinely replaced file is
   * noticed. `force` exists for the case where the algorithm changed under it.
   */
  async function fingerprintEpisode(episode, { force = false } = {}) {
    const show = shows.get(episode.show_id);
    if (!show) return null;

    const extension = episode.filename.slice(episode.filename.lastIndexOf('.')).toLowerCase();
    if (!FINGERPRINTABLE_EXTENSIONS.includes(extension)) {
      // Only MP3 frames can be read without decoding. Everything else would need
      // ffmpeg and a full decode, which is not a cost worth paying before anyone has
      // asked for it — and saying so plainly beats a silent skip.
      return { skipped: 'unsupported_format', extension };
    }

    const path = join(shows.dirFor(show), episode.filename);
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (error) {
      logger?.debug({ err: error, episodeId: episode.id }, 'could not read episode for fingerprinting');
      return { skipped: 'unreadable' };
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const existing = selectFingerprint.get(episode.id);
    if (!force && existing?.sha256 === sha256 && existing.algorithm_version === FINGERPRINT_VERSION) {
      return { skipped: 'unchanged', frameCount: existing.frame_count };
    }

    const profile = frameProfile(bytes);
    if (!profile) return { skipped: 'no_frames' };

    const samplesPerFrame = profile.frames[0]?.samplesPerFrame ?? 1152;
    const encoded = encodeFingerprint({
      hashes: profile.hashes,
      sampleRate: profile.sampleRate,
      samplesPerFrame,
      durationMs: profile.durationMs,
    });

    const target = fingerprintPath(show.id, episode.id);
    await mkdir(join(config.fingerprintDir, show.id), { recursive: true });
    await writeFile(target, encoded);

    upsertFingerprint.run({
      episode_id: episode.id,
      algorithm_version: FINGERPRINT_VERSION,
      frame_count: profile.frameCount,
      sample_rate: profile.sampleRate,
      duration_ms: profile.durationMs,
      sha256,
      bytes: bytes.length,
      created_at: nowIso(),
    });

    return {
      frameCount: profile.frameCount,
      durationMs: profile.durationMs,
      discontinuities: profile.discontinuities.length,
    };
  }

  /** The stored fingerprint for an episode, or null when there is none to read. */
  async function loadFingerprint(episode) {
    const row = selectFingerprint.get(episode.id);
    if (!row || row.algorithm_version !== FINGERPRINT_VERSION) return null;
    try {
      const decoded = decodeFingerprint(await readFile(fingerprintPath(episode.show_id, episode.id)));
      return decoded ? { ...decoded, episodeId: episode.id } : null;
    } catch {
      // The row says there is a fingerprint and the file disagrees. That is a cache
      // miss, not a fault: the caller recomputes.
      return null;
    }
  }

  /* ---- the catalogue ------------------------------------------------------- */

  /**
   * Marks every episode a segment occurs in as needing its audio cut again.
   *
   * Called wherever an approval appears — the owner deciding, and automatic mode
   * deciding for them. It has to be both: an auto-approved segment that never marked
   * its episodes would leave them looking settled, and the publish gate would let them
   * out before the cut carrying that very approval had been made.
   */
  function markForRecut(segmentId, only = null) {
    const rows = db
      .prepare('SELECT DISTINCT episode_id FROM ad_segment_occurrences WHERE segment_id = ?')
      .all(segmentId)
      .map((row) => row.episode_id)
      .filter((id) => !only || only.has(id));
    if (!rows.length) return;
    const mark = db.prepare(
      `UPDATE episodes SET trim_status = '${TRIM_STATUS.PENDING}', updated_at = @now WHERE id = @id`,
    );
    const now = nowIso();
    for (const id of rows) mark.run({ id, now });
  }

  /**
   * Records a segment, or updates what is known about one already recorded.
   *
   * A segment already decided about keeps its decision. Re-running detection after a
   * new episode arrives must not quietly un-reject something the owner has already
   * said no to, nor re-ask about something they approved.
   */
  function upsertSegment(showId, segment) {
    const existing = selectBySignature.get(showId, segment.signature);
    const now = nowIso();

    if (existing) {
      db.prepare(
        `UPDATE ad_segments SET
            episode_count = @episode_count,
            occurrence_count = @occurrence_count,
            duration_ms = @duration_ms,
            hold_reason = CASE WHEN status = 'candidate' THEN @hold_reason ELSE hold_reason END,
            updated_at = @now
          WHERE id = @id`,
      ).run({
        id: existing.id,
        episode_count: segment.episodeCount,
        occurrence_count: segment.occurrenceCount,
        duration_ms: segment.durationMs,
        hold_reason: segment.holdReason ?? null,
        now,
      });
      const moved = replaceOccurrences(existing.id, segment.occurrences);
      // Only what actually moved, so a tick that finds the same thing again rewrites
      // no audio, and an episode whose cut list genuinely grew is not left behind.
      if (existing.status === SEGMENT_STATUS.APPROVED && moved.size) markForRecut(existing.id, moved);
      return { ...selectSegment.get(existing.id), isNew: false };
    }

    const id = newId();
    const exemplar = segment.occurrences[0] ?? null;
    db.prepare(
      `INSERT INTO ad_segments
         (id, show_id, signature, source, status, auto_approved, hold_reason, duration_ms,
          episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
          first_seen_at, decided_at, created_at, updated_at)
       VALUES
         (@id, @show_id, @signature, @source, @status, @auto_approved, @hold_reason, @duration_ms,
          @episode_count, @occurrence_count, @exemplar_episode_id, @exemplar_start_ms, @exemplar_end_ms,
          @now, @decided_at, @now, @now)`,
    ).run({
      id,
      show_id: showId,
      signature: segment.signature,
      source: segment.source,
      status: segment.status ?? SEGMENT_STATUS.CANDIDATE,
      auto_approved: segment.autoApproved ? 1 : 0,
      hold_reason: segment.holdReason ?? null,
      duration_ms: segment.durationMs,
      episode_count: segment.episodeCount,
      occurrence_count: segment.occurrenceCount,
      exemplar_episode_id: exemplar?.episodeId ?? null,
      exemplar_start_ms: exemplar?.startMs ?? null,
      exemplar_end_ms: exemplar?.endMs ?? null,
      decided_at: segment.status === SEGMENT_STATUS.APPROVED ? nowIso() : null,
      now,
    });
    replaceOccurrences(id, segment.occurrences);
    if ((segment.status ?? SEGMENT_STATUS.CANDIDATE) === SEGMENT_STATUS.APPROVED) markForRecut(id);
    return { ...selectSegment.get(id), isNew: true };
  }

  /**
   * Rewrites a segment's occurrences, and reports which episodes' cut lists changed.
   *
   * The return value is the point. Detection runs again every time a new episode
   * arrives, and re-marking every approved segment's episodes would re-cut the whole
   * library on every scheduler tick. Marking none of them is worse and quieter: an
   * episode already trimmed that gains a new occurrence of an already-approved segment
   * would keep its old cut for good, because the trimmer skips what is already done.
   */
  function replaceOccurrences(segmentId, occurrences) {
    const key = (row) => `${row.episode_id ?? row.episodeId}:${row.start_frame ?? row.start ?? 0}:${row.end_frame ?? row.end ?? 0}`;
    const before = new Set(
      db
        .prepare('SELECT episode_id, start_frame, end_frame FROM ad_segment_occurrences WHERE segment_id = ?')
        .all(segmentId)
        .map(key),
    );
    const changed = new Set();
    for (const occurrence of occurrences) {
      if (!before.has(key(occurrence))) changed.add(occurrence.episodeId);
    }
    for (const row of db
      .prepare('SELECT episode_id, start_frame, end_frame FROM ad_segment_occurrences WHERE segment_id = ?')
      .all(segmentId)) {
      if (!occurrences.some((occurrence) => key(occurrence) === key(row))) changed.add(row.episode_id);
    }

    const apply = db.transaction(() => {
      db.prepare('DELETE FROM ad_segment_occurrences WHERE segment_id = ?').run(segmentId);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO ad_segment_occurrences
           (segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const occurrence of occurrences) {
        insert.run(
          segmentId,
          occurrence.episodeId,
          occurrence.start ?? 0,
          occurrence.end ?? 0,
          occurrence.startMs ?? 0,
          occurrence.endMs ?? 0,
        );
      }
    });
    apply();
    return changed;
  }

  const api = {
    fingerprintEpisode,
    loadFingerprint,

    /** Fingerprints every episode of a show that needs it. */
    async fingerprintShow(showId, { force = false } = {}) {
      const show = shows.getOrThrow(showId);
      let done = 0;
      let skipped = 0;
      for (const episode of episodes.listByShow(show.id)) {
        const result = await fingerprintEpisode(episode, { force });
        if (result?.skipped) skipped += 1;
        else if (result) done += 1;
      }
      return { fingerprinted: done, skipped };
    },

    /**
     * Looks for repetition across a show's episodes and updates the catalogue.
     *
     * Episodes are loaded one at a time and their hashes handed straight to the
     * search, rather than the whole corpus being assembled first: five hundred
     * episodes is several hundred megabytes of hashes, and there is no reason for all
     * of it to be resident at once.
     */
    async detectForShow(showId, { minEpisodes = null } = {}) {
      const show = shows.getOrThrow(showId);
      if (show.ad_trim_mode === 'off') return { segments: 0, skipped: 'mode_off' };

      const threshold = minEpisodes ?? show.ad_auto_min_episodes ?? 3;
      const corpus = [];
      const durations = {};
      for (const episode of episodes.listByShow(show.id)) {
        const fingerprint = await loadFingerprint(episode);
        if (!fingerprint?.hashes?.length) continue;
        corpus.push({ id: episode.id, hashes: fingerprint.hashes, timing: fingerprint });
        durations[episode.id] = fingerprint.durationMs ?? 0;
      }
      if (corpus.length < 2) return { segments: 0, skipped: 'not_enough_episodes' };

      const timingFor = Object.fromEntries(corpus.map((entry) => [entry.id, entry.timing]));
      const found = findRepeatedSegments(corpus, { minEpisodes: Math.min(threshold, 2) });

      let recorded = 0;
      // Counted apart from `recorded`, because "found three things" and "found three
      // things you have already been shown" are different sentences. Detection runs on
      // every tick and re-finds the same audio every time; only what is new is worth
      // telling anyone about.
      let fresh = 0;
      for (const segment of found) {
        const occurrences = segment.occurrences.map((occurrence) => ({
          ...occurrence,
          startMs: frameToMs(occurrence.start, timingFor[occurrence.episodeId] ?? {}),
          endMs: frameToMs(occurrence.end, timingFor[occurrence.episodeId] ?? {}),
        }));
        const durationMs = frameToMs(segment.frames, timingFor[occurrences[0].episodeId] ?? {});

        const verdict = safeToApproveAutomatically(
          { ...segment, durationMs, occurrences },
          { episodeDurations: durations, minEpisodes: threshold, source: SEGMENT_SOURCES.CORPUS },
        );
        const auto = show.ad_trim_mode === 'auto' && verdict.safe;

        const stored = upsertSegment(show.id, {
          signature: segment.signature,
          source: SEGMENT_SOURCES.CORPUS,
          durationMs,
          episodeCount: segment.episodeCount,
          occurrenceCount: segment.occurrenceCount,
          occurrences,
          status: auto ? SEGMENT_STATUS.APPROVED : SEGMENT_STATUS.CANDIDATE,
          autoApproved: auto,
          holdReason: verdict.safe ? null : verdict.reason,
        });
        recorded += 1;
        if (stored.isNew) fresh += 1;
      }

      events?.emit(EVENTS.SHOW_CHANGED, { showId: show.id });
      logger?.info({ showId: show.id, segments: recorded, fresh }, 'looked for repeated audio');
      return { segments: recorded, newSegments: fresh, episodes: corpus.length };
    },

    /**
     * Records what differed between two downloads of one episode.
     *
     * A stronger signal than repetition, and treated as such: a theme tune is in both
     * copies, so it can never be what differs between them. Anything found this way is
     * an advert by construction, and automatic mode may take it without the position
     * and length guards that hold back a merely-repeated segment.
     */
    recordDiffSegments(episode, ranges, { timing }) {
      const show = shows.get(episode.show_id);
      if (!show || !ranges.length) return { segments: 0 };

      let recorded = 0;
      for (const range of ranges) {
        const signature = createHash('sha256')
          .update(`${episode.id}:${range.startMs}:${range.endMs}`)
          .digest('hex')
          .slice(0, 24);
        const auto = show.ad_trim_mode === 'auto';
        upsertSegment(show.id, {
          signature,
          source: SEGMENT_SOURCES.DIFF,
          durationMs: range.durationMs ?? range.endMs - range.startMs,
          episodeCount: 1,
          occurrenceCount: 1,
          occurrences: [
            {
              episodeId: episode.id,
              // Frames are what the trimmer cuts by, so a range that arrives without
              // them is not a cut at all — it is a row in the catalogue that can be
              // approved, shown as removed, and quietly do nothing.
              start: range.startFrame ?? range.start ?? 0,
              end: range.endFrame ?? range.end ?? 0,
              startMs: range.startMs,
              endMs: range.endMs,
            },
          ],
          status: auto ? SEGMENT_STATUS.APPROVED : SEGMENT_STATUS.CANDIDATE,
          autoApproved: auto,
          holdReason: null,
        });
        recorded += 1;
      }
      void timing;
      events?.emit(EVENTS.SHOW_CHANGED, { showId: show.id });
      return { segments: recorded };
    },

    listSegments(showId) {
      return selectSegments.all(showId).map((row) => ({
        ...row,
        holdMessage: row.hold_reason ? (HOLD_REASONS[row.hold_reason] ?? null) : null,
        occurrences: db
          .prepare('SELECT * FROM ad_segment_occurrences WHERE segment_id = ? ORDER BY start_ms')
          .all(row.id),
      }));
    },

    getSegment(id) {
      return selectSegment.get(id) ?? null;
    },

    /** Approving or rejecting is one call, because it is one decision. */
    decide(segmentId, status) {
      if (!Object.values(SEGMENT_STATUS).includes(status)) {
        throw notFound('That is not a decision SelfPod records.', 'unknown_status');
      }
      const segment = selectSegment.get(segmentId);
      if (!segment) throw notFound('That segment no longer exists.', 'segment_not_found');

      db.prepare(
        `UPDATE ad_segments
            SET status = @status, auto_approved = 0, decided_at = @now, updated_at = @now
          WHERE id = @id`,
      ).run({ id: segmentId, status, now: nowIso() });

      // Every episode this segment occurs in now has a trimmed copy that disagrees with
      // the decisions — approving adds a cut to it, rejecting takes one away. Marking
      // them is what makes a decision reach the audio; without it a rejection would
      // show as reversed in the UI while subscribers kept getting the old cut.
      markForRecut(segmentId);

      events?.emit(EVENTS.SHOW_CHANGED, { showId: segment.show_id });
      return selectSegment.get(segmentId);
    },

    /**
     * What to remove from one episode: every approved segment's occurrences in it.
     *
     * Returned merged and in order, because two approved segments can overlap — the
     * same audio found once by repetition and once by diffing — and cutting overlapping
     * ranges twice would remove more than either of them describes.
     */
    cutListFor(episodeId) {
      const rows = db
        .prepare(
          `SELECT o.start_frame, o.end_frame, o.start_ms, o.end_ms
             FROM ad_segment_occurrences o
             JOIN ad_segments s ON s.id = o.segment_id
            WHERE o.episode_id = ? AND s.status = '${SEGMENT_STATUS.APPROVED}'
            ORDER BY o.start_frame`,
        )
        .all(episodeId);

      const merged = [];
      for (const row of rows) {
        const last = merged[merged.length - 1];
        if (last && row.start_frame <= last.endFrame) {
          last.endFrame = Math.max(last.endFrame, row.end_frame);
          last.endMs = Math.max(last.endMs, row.end_ms);
          continue;
        }
        merged.push({
          startFrame: row.start_frame,
          endFrame: row.end_frame,
          startMs: row.start_ms,
          endMs: row.end_ms,
        });
      }
      return merged;
    },

    /** Removes an episode's derived fingerprint, for when the episode itself goes. */
    async forgetEpisode(episode) {
      db.prepare('DELETE FROM episode_fingerprints WHERE episode_id = ?').run(episode.id);
      await rm(fingerprintPath(episode.show_id, episode.id), { force: true }).catch(() => {});
    },
  };

  return api;
}
