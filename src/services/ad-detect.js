import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CUE_OFFER_ALONE,
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
import { decodeFingerprint, encodeFingerprint, msToFrame } from '../lib/fingerprint-file.js';
import { createFingerprinter } from '../lib/acoustic-fingerprint.js';
import { decodeToMono } from '../lib/decode-audio.js';
import { frameProfile } from '../lib/mp3-frames.js';
import { findRepeatedAudio } from '../lib/repeated-audio.js';
import { safeToApproveAutomatically } from '../lib/auto-approve.js';
import { newId } from '../lib/tokens.js';
import { normaliseText, normaliseTokens } from '../lib/text-normalise.js';
import { MIN_SIMILARITY, findRepeatedText, locatePhrase, sameSpokenRead, signatureOf, tokenSimilarity } from '../lib/repeated-text.js';
import { scoreAdvertCues } from '../lib/advert-cues.js';
import { snapToDip } from '../lib/snap-edges.js';
import { meanConfidence, rawTextOf } from '../lib/transcript.js';

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
export function createAdDetect({ db, config, events, logger, shows, episodes, transcriber = null }) {
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
    // Only part of the file was read, so a fingerprint of it would describe an episode
    // that stops hours before this one does — and would then be compared against other
    // episodes as though it were whole.
    if (profile.truncated) return { skipped: 'too_long' };

    /*
     * Decoded, and fingerprinted by what it sounds like.
     *
     * This is the expensive line in the whole feature and it is spent deliberately.
     * Comparing the encoded bytes was free and found nothing on a professionally
     * produced show, because such a show is mastered and encoded in one pass and its
     * theme tune comes out as different data every episode. Measured on three real
     * Planet Money episodes: nine matching frames out of ninety thousand.
     *
     * Decoding runs at about a thousand times real time and the fingerprint at about
     * two hundred, so an hour-long episode is a few seconds here on a desktop and
     * perhaps a minute on a NAS — once per episode, behind a publish hold, on the one
     * chain that already serialises this kind of work.
     */
    const fingerprinter = createFingerprinter();
    const decoded = await decodeToMono(bytes, profile.frames, (samples) => fingerprinter.push(samples));
    const subFingerprints = fingerprinter.finish();
    if (!subFingerprints.length) return { skipped: 'too_short_to_fingerprint' };

    const samplesPerFrame = profile.frames[0]?.samplesPerFrame ?? 1152;
    const encoded = encodeFingerprint({
      hashes: subFingerprints,
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
      subFingerprints: subFingerprints.length,
      decodeErrors: decoded.errors,
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
      // A candidate that automatic mode now finds safe — it reached the threshold, or
      // its words turned up — is approved here. A decided segment is never touched.
      const promote =
        existing.status === SEGMENT_STATUS.CANDIDATE &&
        segment.status === SEGMENT_STATUS.APPROVED &&
        segment.autoApproved;
      db.prepare(
        `UPDATE ad_segments SET
            episode_count = @episode_count,
            occurrence_count = @occurrence_count,
            duration_ms = @duration_ms,
            hold_reason = CASE WHEN status = 'candidate' THEN @hold_reason ELSE hold_reason END,
            status = CASE WHEN @promote THEN 'approved' ELSE status END,
            auto_approved = CASE WHEN @promote THEN 1 ELSE auto_approved END,
            decided_at = CASE WHEN @promote THEN @now ELSE decided_at END,
            text = COALESCE(@text, text),
            raw_text = COALESCE(@raw_text, raw_text),
            cue_score = COALESCE(@cue_score, cue_score),
            cues = COALESCE(@cues, cues),
            language = COALESCE(@language, language),
            updated_at = @now
          WHERE id = @id`,
      ).run({
        id: existing.id,
        episode_count: segment.episodeCount,
        occurrence_count: segment.occurrenceCount,
        duration_ms: segment.durationMs,
        hold_reason: promote ? null : segment.holdReason ?? null,
        promote: promote ? 1 : 0,
        text: segment.text ?? null,
        raw_text: segment.rawText ?? null,
        cue_score: segment.cueScore ?? null,
        cues: segment.cues ? JSON.stringify(segment.cues) : null,
        language: segment.language ?? null,
        now,
      });
      const moved = replaceOccurrences(existing.id, segment.occurrences);
      // Only what actually moved, so a tick that finds the same thing again rewrites
      // no audio, and an episode whose cut list genuinely grew is not left behind.
      if (promote) markForRecut(existing.id);
      else if (existing.status === SEGMENT_STATUS.APPROVED && moved.size) markForRecut(existing.id, moved);
      return { ...selectSegment.get(existing.id), isNew: false, promoted: promote };
    }

    const id = newId();
    const exemplar = segment.exemplar ?? segment.occurrences[0] ?? null;
    db.prepare(
      `INSERT INTO ad_segments
         (id, show_id, signature, source, status, auto_approved, hold_reason, duration_ms,
          episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
          first_seen_at, decided_at, created_at, updated_at, text, raw_text, cue_score, cues, language)
       VALUES
         (@id, @show_id, @signature, @source, @status, @auto_approved, @hold_reason, @duration_ms,
          @episode_count, @occurrence_count, @exemplar_episode_id, @exemplar_start_ms, @exemplar_end_ms,
          @now, @decided_at, @now, @now, @text, @raw_text, @cue_score, @cues, @language)`,
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
      decided_at: segment.status === SEGMENT_STATUS.APPROVED || segment.status === SEGMENT_STATUS.REJECTED ? nowIso() : null,
      now,
      text: segment.text ?? null,
      raw_text: segment.rawText ?? null,
      cue_score: segment.cueScore ?? null,
      cues: segment.cues ? JSON.stringify(segment.cues) : null,
      language: segment.language ?? null,
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

  /* ---- the words ------------------------------------------------------------ */

  const selectTranscriptSegments = db.prepare(
    `SELECT * FROM ad_segments WHERE show_id = ? AND source = '${SEGMENT_SOURCES.TRANSCRIPT}'`,
  );
  const selectOccurrencesOf = db.prepare('SELECT * FROM ad_segment_occurrences WHERE segment_id = ?');
  const selectCorpusOccurrencesIn = db.prepare(
    `SELECT o.*, s.id AS segment_id, s.status, s.text
       FROM ad_segment_occurrences o
       JOIN ad_segments s ON s.id = o.segment_id
      WHERE o.episode_id = ? AND s.source = '${SEGMENT_SOURCES.CORPUS}'`,
  );
  const selectMarkers = db.prepare('SELECT * FROM ad_markers WHERE show_id = ? ORDER BY created_at');
  const selectMarker = db.prepare('SELECT * FROM ad_markers WHERE id = ?');

  /** The outward bias at a cut edge: better a breath of programme lost than a syllable of advert kept. */
  const START_BIAS_MS = 40;
  const END_BIAS_MS = 80;
  /** A pre-roll shorter than this is a lead-in, not an advert. */
  const MIN_MARKER_CUT_MS = 2000;
  /** How much of an acoustic occurrence a spoken one has to cover to be the same thing. */
  const SAME_THING_OVERLAP = 0.7;

  /**
   * Everything known about a heard episode, in one shape: the words, the tokens the
   * matcher reads, and what is needed to turn a millisecond into a frame.
   */
  async function hearShow(show) {
    const heard = [];
    for (const episode of episodes.listByShow(show.id)) {
      const transcript = await transcriber.loadTranscript(episode);
      if (!transcript) continue;
      const words = [];
      const sentences = [];
      transcript.windows.forEach((window, index) => {
        for (const sentence of window.sentences) {
          const wordStart = words.length;
          for (const word of sentence.words) words.push({ ...word, window: index });
          sentences.push({ ...sentence, window: index, wordStart, wordEnd: words.length - 1 });
        }
      });
      const tokens = normaliseTokens(words);
      // First and last token of each word, so a range of words is a range of tokens.
      const tokenRange = new Map();
      tokens.forEach((token, index) => {
        const range = tokenRange.get(token.word);
        if (range) range[1] = index;
        else tokenRange.set(token.word, [index, index]);
      });
      heard.push({
        episode,
        transcript,
        words,
        tokens,
        sentences,
        tokenRange,
        durationMs: transcript.durationMs,
        timing: { sampleRate: transcript.sampleRate, samplesPerFrame: transcript.samplesPerFrame },
      });
    }
    return heard;
  }

  /** The envelope window that contains a moment, for snapping an edge to a pause. */
  function envelopeAt(entry, ms) {
    for (const window of entry.transcript.windows) {
      if (ms >= window.fromMs && ms <= window.toMs && window.envelopeBytes) return window;
    }
    return null;
  }

  function snapped(entry, ms, edge, { direction = 'both', bias = true } = {}) {
    const window = envelopeAt(entry, ms);
    const at = window
      ? snapToDip(ms, window.envelopeBytes, { fromMs: window.fromMs, hopMs: window.hopMs ?? 10, direction })
      : ms;
    const biased = !bias ? at : edge === 'start' ? at - START_BIAS_MS : at + END_BIAS_MS;
    return Math.max(0, Math.min(entry.durationMs, biased));
  }

  /**
   * A cut from words: edges on pauses, then frames, rounded outwards.
   *
   * `keepStart` / `keepEnd` say the far side of that edge is programme the owner has
   * pointed at — a boundary's words — so the edge may only move away from it and gets
   * no outward bias: a syllable of advert left behind is a complaint, a syllable of
   * the jingle removed is a different complaint, and here the second one wins.
   */
  function occurrenceFrom(entry, startMs, endMs, { snapStart = true, snapEnd = true, keepStart = false, keepEnd = false } = {}) {
    const start = snapStart ? snapped(entry, startMs, 'start', keepStart ? { direction: 'after', bias: false } : {}) : startMs;
    const end = snapEnd ? snapped(entry, endMs, 'end', keepEnd ? { direction: 'before', bias: false } : {}) : endMs;
    return {
      episodeId: entry.episode.id,
      startMs: start,
      endMs: end,
      start: msToFrame(start, entry.timing),
      end: msToFrame(end, entry.timing) + 1,
    };
  }

  function tokensOfWords(entry, wordStart, wordEnd) {
    const first = entry.tokenRange.get(wordStart)?.[0];
    let last = entry.tokenRange.get(wordEnd)?.[1];
    if (first === undefined) return [];
    if (last === undefined) last = entry.tokens.length - 1;
    return entry.tokens.slice(first, last + 1);
  }

  function claimRange(claimed, episodeId, start, end) {
    let ranges = claimed.get(episodeId);
    if (!ranges) claimed.set(episodeId, (ranges = []));
    ranges.push([start, end]);
  }

  function isClaimed(claimed, episodeId, start, end) {
    return (claimed.get(episodeId) ?? []).some(([a, b]) => start <= b && end >= a);
  }

  /** The segment of this show whose words are these, allowing for a recogniser's variation. */
  function knownSegmentFor(showId, text, { except = null } = {}) {
    const phrase = text.split(' ');
    for (const row of selectTranscriptSegments.all(showId)) {
      if (!row.text || row.signature.startsWith('marker:') || row.id === except) continue;
      const known = row.text.split(' ');
      // Whole against whole first, then the shorter aligned inside the longer: the
      // second is what recognises the same read heard a word early or a word late.
      if (tokenSimilarity(phrase, known) >= MIN_SIMILARITY) return row;
      if (sameSpokenRead(phrase, known)) return row;
    }
    return null;
  }

  /**
   * Folds variants of one read back into a single segment.
   *
   * The catalogue is keyed on a hash of the words, so every way the recogniser wrote
   * the same closing tag became a row of its own: the owner was asked about one read
   * four times, and their page listed four decisions that were all the same decision.
   * Same words, same decision, one row — and never across a disagreement, because two
   * segments the owner decided differently are two decisions whatever they say.
   *
   * The oldest wins the words, since those are the ones that were decided about.
   */
  function mergeDuplicateReads(showId) {
    const rows = selectSegments
      .all(showId)
      /*
       * Anything carrying words, however it was first found. The acoustic search
       * produces overlapping variants of one stretch as a matter of course — eight
       * rows for one ten-second tag, at eight different episode counts — and once the
       * words are attached to them there is nothing to tell those eight apart.
       */
      .filter((row) => row.text && !row.signature.startsWith('marker:'))
      .sort((a, b) => {
        /*
         * A read found by its words wins over the same read found by ear, because its
         * signature is the hash of those words and that is what a later episode is
         * matched against. Fold the other way and the words stop being findable, so
         * the duplicate comes straight back. Within a kind, the oldest wins: those are
         * the words that were decided about.
         */
        const kind = (row) => (row.source === SEGMENT_SOURCES.TRANSCRIPT ? 0 : 1);
        return kind(a) - kind(b) || String(a.first_seen_at).localeCompare(String(b.first_seen_at));
      });
    const gone = new Set();
    let merged = 0;

    for (const keep of rows) {
      if (gone.has(keep.id)) continue;
      const moved = new Set();
      for (const drop of rows) {
        if (drop.id === keep.id || gone.has(drop.id)) continue;
        if (drop.status !== keep.status) continue;
        if (!sameSpokenRead(keep.text, drop.text)) continue;

        // Read the occurrences before the delete: they go with it, by cascade.
        const carried = selectOccurrencesOf.all(drop.id);
        const insert = db.prepare(
          `INSERT OR IGNORE INTO ad_segment_occurrences
             (segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        db.transaction(() => {
          db.prepare('DELETE FROM ad_segments WHERE id = ?').run(drop.id);
          for (const row of carried) {
            insert.run(keep.id, row.episode_id, row.start_frame, row.end_frame, row.start_ms, row.end_ms);
            moved.add(row.episode_id);
          }
        })();
        gone.add(drop.id);
        merged += 1;
      }
      if (!moved.size) continue;

      const all = selectOccurrencesOf.all(keep.id);
      db.prepare(
        'UPDATE ad_segments SET episode_count = ?, occurrence_count = ?, updated_at = ? WHERE id = ?',
      ).run(new Set(all.map((row) => row.episode_id)).size, all.length, nowIso(), keep.id);
      // The cut list of every episode that gained a range has changed, and the audio
      // it already has was cut from a list that no longer exists.
      if (keep.status === SEGMENT_STATUS.APPROVED) markForRecut(keep.id, moved);
    }
    if (merged) logger?.info({ showId, merged }, 'folded variants of the same read together');
    return merged;
  }

  function cuesFor(entry, tokenStart, tokenEnd) {
    const tokens = entry.tokens.slice(tokenStart, tokenEnd + 1);
    const words = entry.words.slice(tokens[0]?.word ?? 0, (tokens[tokens.length - 1]?.word ?? -1) + 1);
    const scored = scoreAdvertCues(tokens, { rawText: rawTextOf(words) });
    return { ...scored, rawText: rawTextOf(words), confidence: meanConfidence(words) };
  }

  /**
   * Whether an acoustic segment already covers this stretch of this episode. If so the
   * words are attached to *that* segment rather than offered again under a new name —
   * and a pre-roll first found by ear and held as "always at the start" is re-judged
   * with its words known.
   */
  function annotateCorpus(entry, occurrence, cues, show, durations, threshold) {
    for (const row of selectCorpusOccurrencesIn.all(entry.episode.id)) {
      const overlap = Math.min(row.end_ms, occurrence.endMs) - Math.max(row.start_ms, occurrence.startMs);
      const span = Math.min(row.end_ms - row.start_ms, occurrence.endMs - occurrence.startMs);
      if (span <= 0 || overlap / span < SAME_THING_OVERLAP) continue;
      const segment = selectSegment.get(row.segment_id);
      if (!segment) continue;
      if (!segment.text) {
        db.prepare(
          `UPDATE ad_segments SET text = @text, raw_text = @raw_text, cue_score = @cue_score, cues = @cues,
                  language = @language, updated_at = @now WHERE id = @id`,
        ).run({
          id: segment.id,
          text: cues.text,
          raw_text: cues.rawText,
          cue_score: cues.score,
          cues: JSON.stringify(cues.cues),
          language: entry.transcript.language ?? null,
          now: nowIso(),
        });
      }
      if (segment.status === SEGMENT_STATUS.CANDIDATE) {
        const occurrences = selectOccurrencesOf.all(segment.id).map((o) => ({
          episodeId: o.episode_id, start: o.start_frame, end: o.end_frame, startMs: o.start_ms, endMs: o.end_ms,
        }));
        const verdict = safeToApproveAutomatically(
          { ...segment, durationMs: segment.duration_ms, episodeCount: segment.episode_count, occurrences, cueScore: Math.max(segment.cue_score ?? 0, cues.score) },
          { episodeDurations: durations, minEpisodes: threshold, source: SEGMENT_SOURCES.CORPUS },
        );
        const auto = show.ad_trim_mode === 'auto' && verdict.safe;
        db.prepare(
          `UPDATE ad_segments SET
              hold_reason = @hold_reason,
              status = CASE WHEN @promote THEN 'approved' ELSE status END,
              auto_approved = CASE WHEN @promote THEN 1 ELSE auto_approved END,
              decided_at = CASE WHEN @promote THEN @now ELSE decided_at END,
              updated_at = @now
            WHERE id = @id AND status = 'candidate'`,
        ).run({ id: segment.id, hold_reason: verdict.safe ? null : verdict.reason, promote: auto ? 1 : 0, now: nowIso() });
        if (auto) markForRecut(segment.id);
      }
      return true;
    }
    return false;
  }

  const countFingerprints = db.prepare(
    `SELECT COUNT(*) AS n
       FROM episode_fingerprints f
       JOIN episodes e ON e.id = f.episode_id
      WHERE e.show_id = ?`,
  );

  const api = {
    fingerprintEpisode,
    loadFingerprint,

    /**
     * How many of a show's episodes SelfPod has actually listened to.
     *
     * Not the same as how many MP3s are in the folder, and the difference is the whole
     * point: reading a show decodes every episode, so for as long as that takes the two
     * numbers disagree — and a page that used the second one told people their show had
     * nothing repeated in it before anything had been compared.
     */
    countFingerprinted(showId) {
      return countFingerprints.get(showId)?.n ?? 0;
    },

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
     * The whole corpus is resident while this runs — one Uint32Array of frame hashes
     * per episode, about 550 kB for an hour — so a five-hundred-episode show is a few
     * hundred megabytes. That is a real cost on the hardware this targets and it is
     * stated here rather than described as something it is not: an earlier version of
     * this comment claimed episodes were streamed one at a time, which they never were.
     *
     * The search is also quadratic in episode count, because a segment present in
     * every episode is extended against every other. Measured at 137,000 frames an
     * episode: five episodes 0.3 s, twenty 4.3 s, forty 16.5 s — synchronously, on a
     * box that is also serving audio. It runs behind a publish hold and on one chain,
     * so nobody is waiting on it, but a large library will feel it.
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
      const found = findRepeatedAudio(
        corpus.map((entry) => ({ id: entry.id, fingerprint: entry.hashes })),
        { minEpisodes: Math.min(threshold, 2) },
      );

      let recorded = 0;
      // Counted apart from `recorded`, because "found three things" and "found three
      // things you have already been shown" are different sentences. Detection runs on
      // every tick and re-finds the same audio every time; only what is new is worth
      // telling anyone about.
      let fresh = 0;
      for (const segment of found) {
        /*
         * The search works in sub-fingerprints, which are 11.6ms of sound. A cut is
         * made of MP3 frames, which are 26.1ms of audio. So each occurrence is
         * converted here, once, and both units are stored: frames because that is what
         * the trimmer removes, milliseconds because that is what a person is shown.
         *
         * Rounding outwards on purpose. A cut that starts a frame late leaves the first
         * moment of an advert audible, which is the failure a listener notices; a cut
         * that starts a frame early takes 26ms of silence before it, which nobody does.
         */
        const occurrences = segment.occurrences.map((occurrence) => {
          const timing = timingFor[occurrence.episodeId] ?? {};
          return {
            episodeId: occurrence.episodeId,
            start: msToFrame(occurrence.startMs, timing),
            end: msToFrame(occurrence.endMs, timing) + 1,
            startMs: occurrence.startMs,
            endMs: occurrence.endMs,
          };
        });
        const durationMs = segment.durationMs;

        // The words attached to this audio on an earlier run, if any: they are what
        // lets a pre-roll past the theme-tune guard, and the guard must not close again
        // on the next tick just because this detector has never heard them.
        const known = selectBySignature.get(show.id, segment.signature);
        const verdict = safeToApproveAutomatically(
          { ...segment, durationMs, occurrences, cueScore: known?.cue_score ?? 0 },
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

    /**
     * One read, one row, however many ways it has been written down.
     *
     * Separate from detection and called before it, because it is arithmetic on words
     * already stored — no audio is read and nothing is decoded — while everything else
     * in a pass is minutes of work an episode. Folded in with detection, a tidy-up that
     * takes milliseconds queued behind hours of recogniser time, and the owner watched
     * eight rows of one advert sit there for an afternoon while the show was re-read.
     */
    foldDuplicateReads(showId) {
      return mergeDuplicateReads(showId);
    },

    /**
     * Everything the words say about a show, in the order that matters (spec §19.6):
     * the boundaries the owner taught, then the reads it already knows, then what
     * repeats, then what sounds like a sponsor read in a single episode.
     */
    async detectFromTranscripts(showId) {
      const show = shows.getOrThrow(showId);
      if (show.ad_trim_mode === 'off' || !transcriber) return { segments: 0, skipped: 'mode_off' };
      const threshold = show.ad_auto_min_episodes ?? 3;
      // Already done by the pipeline before any of the slow stages, and cheap enough
      // to repeat here for anything that calls this directly.
      const foldedIn = mergeDuplicateReads(show.id);

      const heard = await hearShow(show);
      if (!heard.length) return { segments: 0, skipped: 'nothing_heard', foldedIn };

      const durations = Object.fromEntries(heard.map((entry) => [entry.episode.id, entry.durationMs]));
      const byId = new Map(heard.map((entry) => [entry.episode.id, entry]));
      const claimed = new Map();
      const counts = { segments: 0, newSegments: 0, markerCuts: 0, rememberedCuts: 0, heard: heard.length, foldedIn };
      const auto = show.ad_trim_mode === 'auto';

      /* 0. Boundaries the owner taught. */
      for (const marker of selectMarkers.all(show.id)) {
        const phrase = marker.text.split(' ');
        const atStart = marker.role === 'programme_starts';
        const occurrences = [];
        const before = selectBySignature.get(show.id, `marker:${marker.id}`);
        const already = new Set(before ? selectOccurrencesOf.all(before.id).map((row) => row.episode_id) : []);
        for (const entry of heard) {
          // Only the window the marker belongs to: the opening for a start, the closing
          // for an end. "Vous écoutez RMC" said again at minute forty is not the start.
          const windowIndex = atStart ? 0 : entry.transcript.windows.length - 1;
          const first = entry.tokens.findIndex((token) => token.window === windowIndex);
          if (first < 0) continue;
          let last = entry.tokens.length - 1;
          while (last > first && entry.tokens[last].window !== windowIndex) last -= 1;
          const hit = locatePhrase(entry.tokens.slice(first, last + 1), phrase);
          if (!hit) continue;
          const hitStart = first + hit.start;
          const hitEnd = first + hit.end;
          let occurrence;
          if (atStart) {
            const cutEndMs = marker.inclusive ? hit.endMs : hit.startMs;
            claimRange(claimed, entry.episode.id, 0, hitEnd);
            if (cutEndMs < MIN_MARKER_CUT_MS) continue;
            occurrence = occurrenceFrom(entry, 0, cutEndMs, { snapStart: false, keepEnd: !marker.inclusive });
            occurrence.start = 0;
            occurrence.startMs = 0;
          } else {
            const cutStartMs = marker.inclusive ? hit.startMs : hit.endMs;
            claimRange(claimed, entry.episode.id, hitStart, entry.tokens.length - 1);
            if (entry.durationMs - cutStartMs < MIN_MARKER_CUT_MS) continue;
            occurrence = occurrenceFrom(entry, cutStartMs, entry.durationMs, { snapEnd: false, keepStart: !marker.inclusive });
            occurrence.end = msToFrame(entry.durationMs, entry.timing) + 1;
          }
          occurrences.push(occurrence);
        }
        const lengths = occurrences.map((o) => o.endMs - o.startMs).sort((a, b) => a - b);
        const stored = upsertSegment(show.id, {
          signature: `marker:${marker.id}`,
          source: SEGMENT_SOURCES.TRANSCRIPT,
          status: SEGMENT_STATUS.APPROVED,
          autoApproved: false,
          durationMs: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0,
          episodeCount: occurrences.length,
          occurrenceCount: occurrences.length,
          occurrences,
          text: marker.text,
          rawText: marker.raw_text,
          language: marker.language,
        });
        counts.markerCuts += occurrences.filter((o) => !already.has(o.episodeId)).length;
        counts.segments += 1;
        if (stored.isNew) counts.newSegments += 1;
      }

      /*
       * 1. Reads already decided about — or already offered — matched by their words.
       *
       * Decided first, undecided after. Both claim the ground they are heard on, and
       * whichever gets there first owns it: with a candidate going first, a question
       * the owner had already answered elsewhere took the words away from their own
       * decision, and the answer stopped being applied.
       */
      const knownFirst = selectTranscriptSegments
        .all(show.id)
        .sort((a, b) => (a.status === SEGMENT_STATUS.CANDIDATE ? 1 : 0) - (b.status === SEGMENT_STATUS.CANDIDATE ? 1 : 0));
      for (const known of knownFirst) {
        if (!known.text || known.signature.startsWith('marker:')) continue;
        const phrase = known.text.split(' ');
        const existing = selectOccurrencesOf.all(known.id);
        const occurrences = [];
        let attached = 0;
        for (const entry of heard) {
          const hit = locatePhrase(entry.tokens, phrase);
          if (!hit || isClaimed(claimed, entry.episode.id, hit.start, hit.end)) continue;
          claimRange(claimed, entry.episode.id, hit.start, hit.end);
          if (!existing.some((row) => row.episode_id === entry.episode.id)) attached += 1;
          occurrences.push(occurrenceFrom(entry, hit.startMs, hit.endMs));
        }
        // Episodes not heard this time keep the occurrence they had.
        for (const row of existing) {
          if (byId.has(row.episode_id) && occurrences.some((o) => o.episodeId === row.episode_id)) continue;
          if (byId.has(row.episode_id)) continue;
          occurrences.push({ episodeId: row.episode_id, start: row.start_frame, end: row.end_frame, startMs: row.start_ms, endMs: row.end_ms });
        }
        if (!occurrences.length) {
          // Every place these words were heard is now spoken for by something else —
          // a boundary, usually. A candidate nobody has decided about is withdrawn
          // rather than left on the page describing a cut that would never be made.
          if (known.status === SEGMENT_STATUS.CANDIDATE) {
            db.prepare('DELETE FROM ad_segments WHERE id = ?').run(known.id);
          }
          continue;
        }
        const episodeCount = new Set(occurrences.map((o) => o.episodeId)).size;
        const verdict = safeToApproveAutomatically(
          { durationMs: known.duration_ms, episodeCount, occurrences, cueScore: known.cue_score ?? 0 },
          { episodeDurations: durations, minEpisodes: threshold, source: SEGMENT_SOURCES.TRANSCRIPT },
        );
        upsertSegment(show.id, {
          signature: known.signature,
          source: SEGMENT_SOURCES.TRANSCRIPT,
          status: auto && verdict.safe ? SEGMENT_STATUS.APPROVED : SEGMENT_STATUS.CANDIDATE,
          autoApproved: auto && verdict.safe,
          holdReason: verdict.safe ? null : verdict.reason,
          durationMs: known.duration_ms,
          episodeCount,
          occurrenceCount: occurrences.length,
          occurrences,
        });
        if (attached && known.status === SEGMENT_STATUS.APPROVED) counts.rememberedCuts += attached;
        if (attached && known.status === SEGMENT_STATUS.REJECTED) {
          // Visible rather than silent: the page says the words were heard and kept.
          db.prepare(`UPDATE ad_segments SET hold_reason = 'matches_kept_words', updated_at = ? WHERE id = ?`).run(nowIso(), known.id);
        }
        counts.segments += 1;
      }

      /* 2. What repeats. */
      const found = findRepeatedText(
        heard.map((entry) => ({ id: entry.episode.id, tokens: entry.tokens })),
        { claimed },
      );
      for (const segment of found) {
        const exemplar = byId.get(segment.exemplar.episodeId);
        const cues = cuesFor(exemplar, segment.exemplar.start, segment.exemplar.end);
        const text = segment.canonicalText;
        const occurrences = [];
        for (const occurrence of segment.occurrences) {
          const entry = byId.get(occurrence.episodeId);
          const cut = occurrenceFrom(entry, occurrence.startMs, occurrence.endMs);
          if (annotateCorpus(entry, cut, { ...cues, text }, show, durations, threshold)) continue;
          occurrences.push(cut);
        }
        if (occurrences.length < 2) continue;
        for (const o of segment.occurrences) claimRange(claimed, o.episodeId, o.start, o.end);
        const known = knownSegmentFor(show.id, text);
        const episodeCount = new Set(occurrences.map((o) => o.episodeId)).size;
        const verdict = safeToApproveAutomatically(
          { durationMs: segment.durationMs, episodeCount, occurrences, cueScore: cues.score },
          { episodeDurations: durations, minEpisodes: threshold, source: SEGMENT_SOURCES.TRANSCRIPT },
        );
        const stored = upsertSegment(show.id, {
          signature: known?.signature ?? segment.signature,
          source: SEGMENT_SOURCES.TRANSCRIPT,
          status: auto && verdict.safe ? SEGMENT_STATUS.APPROVED : SEGMENT_STATUS.CANDIDATE,
          autoApproved: auto && verdict.safe,
          holdReason: verdict.safe ? null : verdict.reason,
          durationMs: segment.durationMs,
          episodeCount,
          occurrenceCount: occurrences.length,
          occurrences,
          exemplar: occurrences.find((o) => o.episodeId === exemplar.episode.id) ?? occurrences[0],
          text,
          rawText: cues.rawText,
          cueScore: cues.score,
          cues: cues.cues,
          language: exemplar.transcript.language,
        });
        counts.segments += 1;
        if (stored.isNew) counts.newSegments += 1;
      }

      /* 3. What sounds like a sponsor read, heard once. Offered, never cut. */
      for (const entry of heard) {
        let block = null;
        const blocks = [];
        // A block ends at the last sentence that sounded like an advert. The quiet
        // sentences that may have followed were only ever kept in case another cue
        // came along; if none did, they are the programme starting.
        const flush = () => {
          if (block && block.raw >= 4 && block.cueEndMs - block.startMs >= 10_000) {
            blocks.push({ ...block, endMs: block.cueEndMs, tokenEnd: block.cueTokenEnd });
          }
          block = null;
        };
        for (const sentence of entry.sentences) {
          const [tokenStart] = entry.tokenRange.get(sentence.wordStart) ?? [];
          const tokenEnd = entry.tokenRange.get(sentence.wordEnd)?.[1];
          if (tokenStart === undefined || tokenEnd === undefined) continue;
          if (isClaimed(claimed, entry.episode.id, tokenStart, tokenEnd)) {
            flush();
            continue;
          }
          const scored = scoreAdvertCues(entry.tokens.slice(tokenStart, tokenEnd + 1), { rawText: sentence.text });
          if (block && (sentence.startMs - block.endMs > 6000 || sentence.endMs - block.startMs > 120_000 || sentence.window !== block.window)) flush();
          if (!block) {
            if (!scored.raw) continue;
            block = {
              startMs: sentence.startMs, endMs: sentence.endMs, tokenStart, tokenEnd,
              cueEndMs: sentence.endMs, cueTokenEnd: tokenEnd, raw: 0, quiet: 0, window: sentence.window,
            };
          }
          block.endMs = sentence.endMs;
          block.tokenEnd = tokenEnd;
          if (scored.raw) {
            block.raw += scored.raw;
            block.quiet = 0;
            block.cueEndMs = sentence.endMs;
            block.cueTokenEnd = tokenEnd;
          } else {
            block.quiet += 1;
            if (block.quiet >= 3) flush();
          }
        }
        flush();
        for (const candidate of blocks) {
          const cues = cuesFor(entry, candidate.tokenStart, candidate.tokenEnd);
          if (cues.score < CUE_OFFER_ALONE) continue;
          const text = entry.tokens.slice(candidate.tokenStart, candidate.tokenEnd + 1).map((t) => t.t).join(' ');
          const cut = occurrenceFrom(entry, candidate.startMs, candidate.endMs);
          if (annotateCorpus(entry, cut, { ...cues, text }, show, durations, threshold)) continue;
          claimRange(claimed, entry.episode.id, candidate.tokenStart, candidate.tokenEnd);
          const stored = upsertSegment(show.id, {
            signature: knownSegmentFor(show.id, text)?.signature ?? signatureOf(text),
            source: SEGMENT_SOURCES.TRANSCRIPT,
            status: SEGMENT_STATUS.CANDIDATE,
            autoApproved: false,
            holdReason: 'only_heard_once',
            durationMs: cut.endMs - cut.startMs,
            episodeCount: 1,
            occurrenceCount: 1,
            occurrences: [cut],
            text,
            rawText: cues.rawText,
            cueScore: cues.score,
            cues: cues.cues,
            language: entry.transcript.language,
          });
          counts.segments += 1;
          if (stored.isNew) counts.newSegments += 1;
        }
      }

      events?.emit(EVENTS.SHOW_CHANGED, { showId: show.id });
      logger?.info({ showId: show.id, ...counts }, 'looked for spoken adverts');
      return counts;
    },

    /* ---- what the owner teaches ---------------------------------------------- */

    listMarkers(showId) {
      return selectMarkers.all(showId);
    },

    getMarker(id) {
      return selectMarker.get(id) ?? null;
    },

    /**
     * "The programme starts when it says this." Recorded, and applied on the next run:
     * the caller queues one, so the owner sees the cuts land rather than wait a tick.
     */
    addMarker({ showId, role, inclusive = false, rawText, language = null }) {
      const text = normaliseText(rawText).join(' ');
      if (!text) throw notFound('Those words have nothing SelfPod can listen for.', 'empty_marker');
      const id = newId();
      db.prepare(
        `INSERT INTO ad_markers (id, show_id, role, inclusive, text, raw_text, language, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, showId, role, inclusive ? 1 : 0, text, rawText.trim(), language, nowIso());
      events?.emit(EVENTS.SHOW_CHANGED, { showId });
      return selectMarker.get(id);
    },

    /** Forgets a boundary and puts back everything it cut. */
    removeMarker(id) {
      const marker = selectMarker.get(id);
      if (!marker) throw notFound('That boundary no longer exists.', 'marker_not_found');
      const segment = selectBySignature.get(marker.show_id, `marker:${id}`);
      if (segment) {
        markForRecut(segment.id);
        db.prepare('DELETE FROM ad_segments WHERE id = ?').run(segment.id);
      }
      db.prepare('DELETE FROM ad_markers WHERE id = ?').run(id);
      events?.emit(EVENTS.SHOW_CHANGED, { showId: marker.show_id });
      return marker;
    },

    /**
     * "These words are an advert" (or "are not"), pointed at in one episode.
     *
     * Becomes a segment with that decision already taken and one occurrence; the next
     * run matches the words in every other episode and attaches those. Approving is
     * remembering: there is no separate list of phrases to keep in step.
     */
    async teachSegment({ showId, episodeId, startMs, endMs, rawText, status, language = null }) {
      const show = shows.getOrThrow(showId);
      const episode = episodes.get?.(episodeId) ?? episodes.getOrThrow(episodeId);
      const text = normaliseText(rawText).join(' ');
      if (!text) throw notFound('Those words have nothing SelfPod can listen for.', 'empty_phrase');
      const transcript = await transcriber.loadTranscript(episode);
      const entry = transcript
        ? (await hearShow(show)).find((candidate) => candidate.episode.id === episodeId)
        : null;
      const occurrence = entry
        ? occurrenceFrom(entry, startMs, endMs)
        : { episodeId, startMs, endMs, start: 0, end: 0 };
      const known = knownSegmentFor(showId, text);
      const stored = upsertSegment(showId, {
        signature: known?.signature ?? signatureOf(text),
        source: SEGMENT_SOURCES.TRANSCRIPT,
        status,
        autoApproved: false,
        durationMs: occurrence.endMs - occurrence.startMs,
        episodeCount: 1,
        occurrenceCount: 1,
        occurrences: [occurrence],
        text,
        rawText: rawText.trim(),
        language,
      });
      // upsertSegment never changes a decision on its own; this *is* the decision.
      if (stored.status !== status) return api.decide(stored.id, status);
      return stored;
    },

    /**
     * The transcripts the review page needs: one per exemplar episode of every segment
     * that carries words. A handful of small files, read once per render.
     */
    async exemplarTranscripts(showId) {
      const wanted = new Set();
      for (const row of selectSegments.all(showId)) {
        if (row.exemplar_episode_id && (row.source === SEGMENT_SOURCES.TRANSCRIPT || row.text)) wanted.add(row.exemplar_episode_id);
      }
      const transcripts = new Map();
      for (const episodeId of wanted) {
        const episode = episodes.get(episodeId);
        if (!episode || !transcriber) continue;
        const transcript = await transcriber.loadTranscript(episode);
        if (transcript) transcripts.set(episodeId, transcript);
      }
      return transcripts;
    },

    /** Every spoken segment that touches an episode, with the occurrence in it. */
    spokenIn(episodeId) {
      return db
        .prepare(
          `SELECT s.*, o.start_ms, o.end_ms, o.start_frame, o.end_frame
             FROM ad_segment_occurrences o
             JOIN ad_segments s ON s.id = o.segment_id
            WHERE o.episode_id = ? AND (s.source = '${SEGMENT_SOURCES.TRANSCRIPT}' OR s.text IS NOT NULL)
            ORDER BY o.start_ms`,
        )
        .all(episodeId);
    },

    /**
     * Moves the edges of a spoken segment to the words the owner chose.
     *
     * The words *are* the segment: changing them changes what every later episode is
     * matched against, so the text is rewritten along with this episode's cut and the
     * next run re-finds the new words everywhere else.
     */
    async reshapeSegment(segmentId, { episodeId, startMs, endMs, rawText }) {
      const segment = selectSegment.get(segmentId);
      if (!segment) throw notFound('That segment no longer exists.', 'segment_not_found');
      const show = shows.getOrThrow(segment.show_id);
      const entry = (await hearShow(show)).find((candidate) => candidate.episode.id === episodeId);
      const occurrence = entry ? occurrenceFrom(entry, startMs, endMs) : { episodeId, startMs, endMs, start: 0, end: 0 };
      const text = normaliseText(rawText).join(' ');
      const others = selectOccurrencesOf
        .all(segmentId)
        .filter((row) => row.episode_id !== episodeId)
        .map((row) => ({ episodeId: row.episode_id, start: row.start_frame, end: row.end_frame, startMs: row.start_ms, endMs: row.end_ms }));
      db.prepare(
        `UPDATE ad_segments SET text = @text, raw_text = @raw_text, duration_ms = @duration_ms,
                exemplar_episode_id = @episode_id, exemplar_start_ms = @start_ms, exemplar_end_ms = @end_ms, updated_at = @now
          WHERE id = @id`,
      ).run({
        id: segmentId,
        text: text || segment.text,
        raw_text: rawText.trim() || segment.raw_text,
        duration_ms: occurrence.endMs - occurrence.startMs,
        episode_id: episodeId,
        start_ms: occurrence.startMs,
        end_ms: occurrence.endMs,
        now: nowIso(),
      });
      const moved = replaceOccurrences(segmentId, [occurrence, ...others]);
      if (segment.status === SEGMENT_STATUS.APPROVED && moved.size) markForRecut(segmentId, moved);
      return selectSegment.get(segmentId);
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

  };

  return api;
}
