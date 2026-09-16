import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CUE_OFFER_ALONE,
  FINGERPRINTABLE_EXTENSIONS,
  FINGERPRINT_VERSION,
  HOLD_REASONS,
  SEGMENT_KINDS,
  SEGMENT_SOURCES,
  SEGMENT_STATUS,
  TRIM_STATUS,
  sourceForKind,
} from '../constants.js';
import { OWNER_KINDS, inferKind } from '../lib/segment-kind.js';
import { nowIso } from '../lib/dates.js';
import { badRequest, notFound } from '../lib/errors.js';
import { EVENTS } from '../lib/events.js';
import { decodeFingerprint, encodeFingerprint, msToFrame } from '../lib/fingerprint-file.js';
import { createFingerprinter } from '../lib/acoustic-fingerprint.js';
import { decodeToMono } from '../lib/decode-audio.js';
import { frameProfile } from '../lib/mp3-frames.js';
import { createAudioSearch } from '../lib/audio-search.js';
import {
  ANCHOR_MATCH_BER,
  DEFAULT_SEARCH_MS,
  MIN_ANCHOR_CUT_MS,
  SUB_MS,
  anchorClipFrom,
  locateAnchor,
} from '../lib/audio-anchor.js';
import { safeToApproveAutomatically } from '../lib/auto-approve.js';
import { newId } from '../lib/tokens.js';
import { normaliseText, normaliseTokens } from '../lib/text-normalise.js';
import { MIN_SIMILARITY, findRepeatedText, locatePhrase, sameSpokenRead, signatureOf, tokenSimilarity } from '../lib/repeated-text.js';
import { scoreAdvertCues } from '../lib/advert-cues.js';
import { snapToDip } from '../lib/snap-edges.js';
import { findSponsorBlocks } from '../lib/sponsor-blocks.js';
import { meanConfidence, rawTextOf } from '../lib/transcript.js';
import { restoreCovers as sharedRestoreCovers } from '../lib/cut-bar.js';

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
export function createAdDetect({ db, config, events, logger, shows, episodes, transcriber = null, audioSearch = null }) {
  const search = audioSearch ?? createAudioSearch({ logger });
  const selectFingerprint = db.prepare('SELECT * FROM episode_fingerprints WHERE episode_id = ?');
  const upsertFingerprint = db.prepare(
    `INSERT INTO episode_fingerprints
       (episode_id, algorithm_version, frame_count, sample_rate, duration_ms, sha256, bytes, file_mtime_ms, searched_at, created_at)
     VALUES (@episode_id, @algorithm_version, @frame_count, @sample_rate, @duration_ms, @sha256, @bytes, @file_mtime_ms, NULL, @created_at)
     ON CONFLICT(episode_id) DO UPDATE SET
       file_mtime_ms = excluded.file_mtime_ms,
       searched_at = NULL,
       algorithm_version = excluded.algorithm_version,
       frame_count = excluded.frame_count,
       sample_rate = excluded.sample_rate,
       duration_ms = excluded.duration_ms,
       sha256 = excluded.sha256,
       bytes = excluded.bytes,
       created_at = excluded.created_at`,
  );
  const touchFingerprint = db.prepare('UPDATE episode_fingerprints SET file_mtime_ms = ? WHERE episode_id = ?');

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
    const existing = selectFingerprint.get(episode.id);

    /*
     * Asked of the file system before the file is read. Every pass visits every
     * episode, and reading and hashing each one to learn that nothing changed was
     * the single largest cost of a pass that found nothing — the whole library off
     * the disk every few minutes. The size and modification time answer the same
     * question for the price of a stat; the digest is still the authority whenever
     * they disagree, and a file rewritten in place at the same size and within the
     * same millisecond is caught by the trimmer, which checks the digest again before
     * it cuts anything.
     */
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      logger?.debug({ err: error, episodeId: episode.id }, 'could not read episode for fingerprinting');
      return { skipped: 'unreadable' };
    }
    const mtimeMs = Math.trunc(info.mtimeMs);
    if (
      !force &&
      existing &&
      existing.algorithm_version === FINGERPRINT_VERSION &&
      existing.bytes === info.size &&
      existing.file_mtime_ms === mtimeMs
    ) {
      return { skipped: 'unchanged', frameCount: existing.frame_count, read: false };
    }

    let bytes;
    try {
      bytes = await readFile(path);
    } catch (error) {
      logger?.debug({ err: error, episodeId: episode.id }, 'could not read episode for fingerprinting');
      return { skipped: 'unreadable' };
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!force && existing?.sha256 === sha256 && existing.algorithm_version === FINGERPRINT_VERSION) {
      // Touched but not changed: remember the new time so the next pass does not read it.
      touchFingerprint.run(mtimeMs, episode.id);
      return { skipped: 'unchanged', frameCount: existing.frame_count, read: true };
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
      file_mtime_ms: mtimeMs,
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
  /**
   * `only`, when given, is the exact set of episode ids to mark — never re-derived
   * from the segment's *current* occurrences. `replaceOccurrences` has always already
   * run by the time this is called with one, and an episode `only` names precisely
   * because its occurrence was just *removed* would otherwise vanish from the very
   * query meant to find it: `SELECT ... FROM ad_segment_occurrences WHERE segment_id`
   * no longer has a row for it at all, so it could never be marked for the re-cut
   * that puts its audio back. Losing an occurrence is exactly when a re-cut matters
   * most — it is what un-trims an episode a segment no longer covers.
   */
  function markForRecut(segmentId, only = null) {
    const rows = only
      ? [...only]
      : db
          .prepare('SELECT DISTINCT episode_id FROM ad_segment_occurrences WHERE segment_id = ?')
          .all(segmentId)
          .map((row) => row.episode_id);
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
    // Said by the caller where it knows; otherwise read from the same evidence the
    // migration used. `source` always follows the kind, for an older image's sake.
    // A row already recorded keeps its kind unless the caller says otherwise: several
    // passes re-find known rows without the evidence that first classified them.
    const kind =
      segment.kind ??
      existing?.kind ??
      inferKind({ signature: segment.signature, source: segment.source, cues: segment.cues ?? null });

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
            kind = CASE WHEN kind IN (${OWNER_KINDS.map((k) => `'${k}'`).join(', ')}) THEN kind ELSE @kind END,
            source = CASE WHEN kind IN (${OWNER_KINDS.map((k) => `'${k}'`).join(', ')}) THEN source ELSE @source END,
            marker_id = COALESCE(@marker_id, marker_id),
            anchor_id = COALESCE(@anchor_id, anchor_id),
            updated_at = @now
          WHERE id = @id`,
      ).run({
        id: existing.id,
        kind,
        source: sourceForKind(kind),
        marker_id: segment.markerId ?? null,
        anchor_id: segment.anchorId ?? null,
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
         (id, show_id, signature, source, kind, marker_id, anchor_id, status, auto_approved, hold_reason, duration_ms,
          episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
          first_seen_at, decided_at, created_at, updated_at, text, raw_text, cue_score, cues, language)
       VALUES
         (@id, @show_id, @signature, @source, @kind, @marker_id, @anchor_id, @status, @auto_approved, @hold_reason, @duration_ms,
          @episode_count, @occurrence_count, @exemplar_episode_id, @exemplar_start_ms, @exemplar_end_ms,
          @now, @decided_at, @now, @now, @text, @raw_text, @cue_score, @cues, @language)`,
    ).run({
      id,
      show_id: showId,
      signature: segment.signature,
      source: sourceForKind(kind),
      kind,
      marker_id: segment.markerId ?? null,
      anchor_id: segment.anchorId ?? null,
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

  /**
   * How many of a show's newest episodes the two repeated-stretch searches compare.
   *
   * Never more than 32. The acoustic search leaves out any sub-fingerprint seen more
   * than 32 times — silence recurs constantly, and this is what keeps it from swamping
   * the index — so a stretch shared by 33 episodes has every one of its keys left out
   * and is never found: measured, found in 32, nothing in 33. The words search has the
   * same rule at 64. Keeping the window under both is what lets a read in every episode
   * be found at all.
   */
  function corpusWindow() {
    return Math.min(32, Math.max(2, config?.adCorpusWindow ?? 24));
  }

  /* ---- restores ------------------------------------------------------------- */

  const selectOverrides = db.prepare('SELECT * FROM ad_cut_overrides WHERE episode_id = ? ORDER BY start_ms');
  // Whether a restore covers a cut: shared with the page, so the two cannot disagree.
  const restoreCovers = sharedRestoreCovers;

  /* ---- the words ------------------------------------------------------------ */

  const selectTranscriptSegments = db.prepare(
    `SELECT * FROM ad_segments WHERE show_id = ?
        AND kind IN ('${SEGMENT_KINDS.BOUNDARY_WORDS}', '${SEGMENT_KINDS.REMEMBERED_WORDS}', '${SEGMENT_KINDS.REPEATED_WORDS}')`,
  );
  const selectOccurrencesOf = db.prepare('SELECT * FROM ad_segment_occurrences WHERE segment_id = ?');
  const selectCorpusOccurrencesIn = db.prepare(
    /*
     * An anchor's cut also carries `source = 'corpus'` — accurately, since it too is
     * found by comparing sound — which would otherwise put it in front of this query
     * and let a pre-roll's transcribed words attach to it as though it were an
     * ordinary repeated stretch. Its signature is excluded here for the same reason a
     * taught boundary's `marker:` signature never appears among "the words already
     * decided about": an anchor is decided by the owner confirming it, never by what
     * a transcript happens to say about the audio in front of it.
     */
    `SELECT o.*, s.id AS segment_id, s.status, s.text
       FROM ad_segment_occurrences o
       JOIN ad_segments s ON s.id = o.segment_id
      WHERE o.episode_id = ? AND s.kind = '${SEGMENT_KINDS.REPEATED_AUDIO}'`,
  );
  const selectMarkers = db.prepare('SELECT * FROM ad_markers WHERE show_id = ? ORDER BY created_at');
  const selectMarker = db.prepare('SELECT * FROM ad_markers WHERE id = ?');

  /** The outward bias at a cut edge: better a breath of programme lost than a syllable of advert kept. */
  const START_BIAS_MS = 40;
  const END_BIAS_MS = 80;
  /** A pre-roll shorter than this is a lead-in, not an advert. */
  const MIN_MARKER_CUT_MS = 2000;
  /** The most of an episode a taught boundary may cut. */
  const MAX_BOUNDARY_SHARE = 0.8;
  /** How far past a jingle's matched span its own audio may still be found again. */
  const ANCHOR_CLAIM_MARGIN_MS = 1000;
  /** How much of an acoustic occurrence a spoken one has to cover to be the same thing. */
  const SAME_THING_OVERLAP = 0.7;

  /**
   * Everything known about a heard episode, in one shape: the words, the tokens the
   * matcher reads, and what is needed to turn a millisecond into a frame.
   */
  async function hearShow(show, { episodeIds = null } = {}) {
    const heard = [];
    const wanted = episodeIds ? new Set(episodeIds) : null;
    for (const episode of episodes.listByShow(show.id)) {
      if (wanted && !wanted.has(episode.id)) continue;
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

  /** The last token that starts before `ms` — the token-index equivalent of a millisecond edge. */
  function lastTokenBefore(entry, ms) {
    let last = -1;
    for (let i = 0; i < entry.tokens.length; i += 1) {
      if (entry.tokens[i].startMs < ms) last = i;
    }
    return last;
  }

  /** The segment of this show whose words are these, allowing for a recogniser's variation. */
  function knownSegmentFor(showId, text, { except = null } = {}) {
    const phrase = text.split(' ');
    for (const row of selectTranscriptSegments.all(showId)) {
      if (!row.text || row.kind === SEGMENT_KINDS.BOUNDARY_WORDS || row.id === except) continue;
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
  /**
   * Gives rows the kind their evidence says, where the column still holds its default.
   *
   * Only an older image writes such rows — 1.8 cannot know the column exists — so this
   * is what makes rolling back and forward again harmless. Cheap enough to run before
   * anything reads the catalogue: one indexed UPDATE per rule, touching nothing that
   * already has a kind other than the default.
   */
  const reconcileStatements = [
    `UPDATE ad_segments SET kind = '${SEGMENT_KINDS.BOUNDARY_WORDS}', marker_id = substr(signature, 8)
      WHERE show_id = @show AND kind = '${SEGMENT_KINDS.REPEATED_AUDIO}' AND signature LIKE 'marker:%'
        AND substr(signature, 8) IN (SELECT id FROM ad_markers)`,
    `UPDATE ad_segments SET kind = '${SEGMENT_KINDS.JINGLE}', anchor_id = substr(signature, 8)
      WHERE show_id = @show AND kind = '${SEGMENT_KINDS.REPEATED_AUDIO}' AND signature LIKE 'anchor:%'
        AND substr(signature, 8) IN (SELECT id FROM ad_anchors)`,
    `UPDATE ad_segments SET kind = '${SEGMENT_KINDS.DIFF}'
      WHERE show_id = @show AND kind = '${SEGMENT_KINDS.REPEATED_AUDIO}' AND source = '${SEGMENT_SOURCES.DIFF}'`,
    `UPDATE ad_segments SET kind = CASE WHEN cues IS NULL THEN '${SEGMENT_KINDS.REMEMBERED_WORDS}' ELSE '${SEGMENT_KINDS.REPEATED_WORDS}' END
      WHERE show_id = @show AND kind = '${SEGMENT_KINDS.REPEATED_AUDIO}' AND source = '${SEGMENT_SOURCES.TRANSCRIPT}'
        AND signature NOT LIKE 'marker:%'`,
  ].map((sql) => db.prepare(sql));
  const selectShowIds = db.prepare('SELECT id FROM shows');
  function reconcileKinds(showId) {
    const ids = showId ? [showId] : selectShowIds.all().map((row) => row.id);
    db.transaction(() => {
      for (const show of ids) for (const statement of reconcileStatements) statement.run({ show });
    })();
  }

  function mergeDuplicateReads(showId) {
    reconcileKinds(showId);
    const rows = selectSegments
      .all(showId)
      /*
       * Anything carrying words, however it was first found. The acoustic search
       * produces overlapping variants of one stretch as a matter of course — eight
       * rows for one ten-second tag, at eight different episode counts — and once the
       * words are attached to them there is nothing to tell those eight apart.
       */
      .filter((row) => row.text && row.kind !== SEGMENT_KINDS.BOUNDARY_WORDS && row.kind !== SEGMENT_KINDS.JINGLE)
      .sort((a, b) => {
        /*
         * A read found by its words wins over the same read found by ear, because its
         * signature is the hash of those words and that is what a later episode is
         * matched against. Fold the other way and the words stop being findable, so
         * the duplicate comes straight back. Within a kind, the oldest wins: those are
         * the words that were decided about.
         */
        const byWords = (row) => (row.kind === SEGMENT_KINDS.REPEATED_AUDIO ? 1 : 0);
        return byWords(a) - byWords(b) || String(a.first_seen_at).localeCompare(String(b.first_seen_at));
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

  /* ---- the sound of a jingle -------------------------------------------------- */

  /** How many of a show's newest episodes are searched when proposing a jingle. */
  const MAX_PROPOSAL_EPISODES = 20;

  const selectAnchors = db.prepare('SELECT * FROM ad_anchors WHERE show_id = ? ORDER BY created_at');
  const selectAnchor = db.prepare('SELECT * FROM ad_anchors WHERE id = ?');
  const insertAnchorRow = db.prepare(
    `INSERT INTO ad_anchors
       (id, show_id, role, marker_id, origin, confirmed_at, dismissed_at, algorithm_version, clip, lead_ms,
        match_span_ms, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms, created_at, updated_at)
     VALUES
       (@id, @show_id, 'programme_starts', @marker_id, @origin, @confirmed_at, NULL, @algorithm_version, @clip,
        @lead_ms, @match_span_ms, @exemplar_episode_id, @exemplar_start_ms, @exemplar_end_ms, @now, @now)`,
  );
  const upsertAnchorHit = db.prepare(
    `INSERT INTO ad_anchor_hits (anchor_id, episode_id, heard, at_ms, ber, checked_at)
     VALUES (@anchor_id, @episode_id, @heard, @at_ms, @ber, @checked_at)
     ON CONFLICT(anchor_id, episode_id) DO UPDATE SET
       heard = excluded.heard, at_ms = excluded.at_ms, ber = excluded.ber, checked_at = excluded.checked_at`,
  );
  const selectAnchorHits = db.prepare('SELECT * FROM ad_anchor_hits WHERE anchor_id = ?');

  /**
   * Whether two clips are close enough to call the same jingle.
   *
   * Used only to stop a dismissed proposal coming straight back: without it, a "no,
   * that's not the jingle" is forgotten the moment the next pass runs and the same
   * audio is proposed again under a new id. `locateAnchor` already does exactly this
   * comparison — one clip slid over a longer array — so the shorter of the two is
   * searched for inside the longer rather than writing a second matcher.
   */
  function clipsMatch(a, b) {
    if (!a?.length || !b?.length) return false;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return Boolean(locateAnchor(shorter, longer, { searchMs: longer.length * SUB_MS, maxBer: ANCHOR_MATCH_BER }));
  }

  function insertAnchor(showId, { origin, markerId = null, confirmed = false, clip }) {
    const id = newId();
    const now = nowIso();
    const encoded = encodeFingerprint({
      hashes: clip.hashes,
      sampleRate: 0,
      samplesPerFrame: 0,
      durationMs: Math.round(clip.hashes.length * SUB_MS),
    });
    insertAnchorRow.run({
      id,
      show_id: showId,
      marker_id: markerId,
      origin,
      confirmed_at: confirmed ? now : null,
      algorithm_version: FINGERPRINT_VERSION,
      clip: encoded,
      lead_ms: clip.leadMs,
      match_span_ms: clip.matchSpanMs ?? 0,
      exemplar_episode_id: clip.exemplarEpisodeId,
      exemplar_start_ms: clip.exemplarStartMs,
      exemplar_end_ms: clip.exemplarEndMs,
      now,
    });
    events?.emit(EVENTS.SHOW_CHANGED, { showId });
    return selectAnchor.get(id);
  }

  /**
   * A `programme_starts` marker whose *already located* words agree with where the
   * jingle was just heard, so the boundary the owner taught can be carried straight
   * over instead of asking the same question a second way.
   *
   * Reads what stage 0 of `detectFromTranscripts` last found for that marker — never
   * what this same pass finds, because `detectAnchors` runs *before* the words are
   * read at all (it has to, so the anchor can claim the head before stage 0 gets a
   * look at it). So a marker taught on the same pass an anchor is first proposed can
   * never link that pass; it links the next time `detectAnchors` runs and finds the
   * marker's segment already there from the pass in between. That is deliberate: this
   * only ever *raises* SelfPod's confidence enough to skip asking, so a pass where it
   * is not yet possible costs nothing, and one pass' delay is the whole price of not
   * re-locating the words a second way in a file that already does that job.
   *
   * @param {string} showId
   * @param {Map<string, number>} onsetByEpisode where the jingle was heard, this pass,
   *   in every episode it was heard in — including one where it sits too close to
   *   0:00 to be worth cutting, because that is still where the marker's own words
   *   would agree with it.
   */
  function linkableMarker(showId, onsetByEpisode) {
    for (const marker of selectMarkers.all(showId)) {
      if (marker.role !== 'programme_starts') continue;
      const segment = selectBySignature.get(showId, `marker:${marker.id}`);
      if (!segment) continue;
      const markerEndByEpisode = new Map(selectOccurrencesOf.all(segment.id).map((row) => [row.episode_id, row.end_ms]));
      let compared = 0;
      let agree = 0;
      for (const [episodeId, onsetMs] of onsetByEpisode) {
        const markerEnd = markerEndByEpisode.get(episodeId);
        if (markerEnd == null) continue;
        compared += 1;
        // Within a second: generous next to the sub-fingerprint's own 11.6ms
        // resolution, because the marker's edge was placed by a recognizer's word
        // timing and snapped to a pause, not by the sound itself.
        if (Math.abs(markerEnd - onsetMs) <= 1000) agree += 1;
      }
      if (compared > 0 && agree === compared) return marker;
    }
    return null;
  }

  /**
   * Re-derives a stale anchor's clip from the exemplar episode it was originally
   * taken from, if that episode and its fingerprint both still exist.
   *
   * A version bump means the stored bits mean nothing against today's fingerprints —
   * mixing them would produce matches that mean nothing, the same reason
   * `FINGERPRINT_VERSION` exists at all — so this never trusts the old clip, only the
   * millisecond range it was taken from.
   */
  async function rebuildAnchorClip(anchor) {
    if (!anchor.exemplar_episode_id) return null;
    const exemplarEpisode = episodes.get(anchor.exemplar_episode_id);
    if (!exemplarEpisode) return null;
    const fingerprint = await loadFingerprint(exemplarEpisode);
    if (!fingerprint?.hashes?.length) return null;
    const from = Math.round(anchor.exemplar_start_ms / SUB_MS);
    const to = Math.round(anchor.exemplar_end_ms / SUB_MS);
    if (to <= from || to > fingerprint.hashes.length) return null;
    return fingerprint.hashes.slice(from, to);
  }

  /** A cut from 0:00 to `cutEndMs`, rounded outwards the same way `detectForShow` rounds an acoustic cut. */
  function occurrenceFromAnchor(episode, fingerprint, cutEndMs) {
    const clampedMs = Math.max(0, Math.min(fingerprint.durationMs ?? cutEndMs, cutEndMs));
    return {
      episodeId: episode.id,
      start: 0,
      startMs: 0,
      end: msToFrame(clampedMs, fingerprint) + 1,
      endMs: clampedMs,
    };
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

    /** The digest of the file an episode was fingerprinted from, or null. The trimmer checks it before cutting. */
    fingerprintDigest(episodeId) {
      return selectFingerprint.get(episodeId)?.sha256 ?? null;
    },

    /** Stops the search worker. Called on shutdown, and by tests between instances. */
    async close() {
      await search.close();
    },

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
     * Looks for repetition across a show's newest episodes and updates the catalogue.
     *
     * The search is quadratic in episode count — measured at 137,000 frames an episode:
     * five episodes 0.3 s, twenty 4.3 s, forty 16.5 s — and it holds every fingerprint it
     * compares in memory, about 1.2 MB an hour of audio at fingerprint version 2. So it
     * compares only the newest `adCorpusWindow` episodes (forty by default), and it runs
     * in a worker thread, where it cannot hold up a listener's download or the health
     * check. What was already found in older episodes is not searched for again but is
     * kept: a cut in an episode outside the window stays exactly as it was.
     */
    async detectForShow(showId, { minEpisodes = null } = {}) {
      const show = shows.getOrThrow(showId);
      reconcileKinds(show.id);
      if (show.ad_trim_mode === 'off') return { segments: 0, skipped: 'mode_off' };

      const threshold = minEpisodes ?? show.ad_auto_min_episodes ?? 3;
      // A little under the window: each known stretch's own exemplar joins the search
      // too, and a stretch in every windowed episode plus its exemplar must still be
      // under the acoustic search's limit of 32.
      const windowSize = Math.min(corpusWindow(), 28);
      const corpus = [];
      const durations = {};
      const addToCorpus = async (episode) => {
        if (!episode || durations[episode.id] !== undefined) return;
        const fingerprint = await loadFingerprint(episode);
        if (!fingerprint?.hashes?.length) return;
        corpus.push({ id: episode.id, hashes: fingerprint.hashes, timing: fingerprint });
        durations[episode.id] = fingerprint.durationMs ?? 0;
      };
      // Newest first (episodes.listByShow), so the window is the most recent episodes.
      for (const episode of episodes.listByShow(show.id)) {
        if (corpus.length >= windowSize) break;
        await addToCorpus(episode);
      }
      /*
       * Plus the episode each known stretch of sound was first found in, whatever its
       * age. Without it a read the owner already decided about is compared only among
       * new episodes, found again from scratch, and offered as something new — while
       * the new episodes it is in go uncut. With it the known stretch is always in the
       * search, and the new finds overlap it where it already is.
       */
      const knownAudio = selectSegments
        .all(show.id)
        .filter((row) => row.kind === SEGMENT_KINDS.REPEATED_AUDIO && row.exemplar_episode_id);
      for (const row of knownAudio) await addToCorpus(episodes.get(row.exemplar_episode_id));
      if (corpus.length < 2) return { segments: 0, skipped: 'not_enough_episodes' };
      const inWindow = new Set(corpus.map((entry) => entry.id));

      /*
       * Which known row a find is, by where it is rather than by its signature. The
       * signature is taken from whichever episode seeded the search, and that changes
       * as episodes arrive — the same ten-second tag once stood on the page as eight
       * rows. The same stretch of the same episode is the same thing.
       */
      const knownOccurrences = knownAudio.map((row) => ({ row, occurrences: selectOccurrencesOf.all(row.id) }));
      const knownFor = (occurrences) => {
        for (const { row, occurrences: stored } of knownOccurrences) {
          for (const found of occurrences) {
            const length = found.endMs - found.startMs;
            if (length <= 0) continue;
            const same = stored.some(
              (o) =>
                o.episode_id === found.episodeId &&
                Math.min(o.end_ms, found.endMs) - Math.max(o.start_ms, found.startMs) >=
                  SAME_THING_OVERLAP * Math.max(length, o.end_ms - o.start_ms),
            );
            if (same) return row;
          }
        }
        return null;
      };

      const timingFor = Object.fromEntries(corpus.map((entry) => [entry.id, entry.timing]));
      const found = await search.repeatedAudio(
        corpus.map((entry) => ({ id: entry.id, fingerprint: entry.hashes })),
        { minEpisodes: Math.min(threshold, 2) },
      );

      /*
       * Ground a confirmed anchor already explains, per episode — not only the
       * pre-roll it cuts, but the jingle itself. A pre-roll cut ends exactly where the
       * jingle starts, on purpose (§19.4's outward bias never applies at a boundary),
       * so the two never overlap; without the jingle's own span added in here, this
       * search would still offer the jingle back as "audio this show repeats" the
       * moment it sees a second episode carry it — which is true, and also not a
       * question worth asking, since the anchor already explains why.
       *
       * Read from `ad_anchor_hits`, not from the cut list: a hit right at 0:00 (no
       * pre-roll that day) explains its four seconds of audio just as much as a hit
       * behind a thirty-second one, even though only the second ever produces a cut.
       */
      const anchorClaimsByEpisode = new Map();
      for (const anchorRow of selectAnchors.all(show.id)) {
        if (!anchorRow.confirmed_at) continue;
        // The *whole* region this anchor was originally found in, not merely the
        // (shorter, deliberately inset) clip taken from inside it — the corpus search
        // below works over the same episodes and can otherwise still find the far
        // side of the very same jingle as a match of its own.
        const spanMs = anchorRow.match_span_ms || 0;
        for (const hit of selectAnchorHits.all(anchorRow.id)) {
          if (!hit.heard) continue;
          const timing = timingFor[hit.episode_id];
          if (!timing) continue;
          let ranges = anchorClaimsByEpisode.get(hit.episode_id);
          if (!ranges) anchorClaimsByEpisode.set(hit.episode_id, (ranges = []));
          // A second's margin past the matched span: the search here pushes its own edges
          // outwards by a few hundred milliseconds, so the same jingle found again ended
          // just past the span and was offered back as "the same 14 seconds of sound" —
          // seen on the real show, beside the very cut that already explained it.
          ranges.push([0, msToFrame(hit.at_ms - anchorRow.lead_ms + spanMs + ANCHOR_CLAIM_MARGIN_MS, timing) + 1]);
        }
      }
      const coveredByAnchor = (occurrence) =>
        (anchorClaimsByEpisode.get(occurrence.episodeId) ?? []).some(
          ([from, to]) => occurrence.start >= from && occurrence.end <= to,
        );

      const updatedThisPass = new Set();
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
        const known = selectBySignature.get(show.id, segment.signature) ?? knownFor(occurrences);
        // The search returns overlapping variants of one stretch, longest first. The
        // first one to reach a known row is it; a later variant rewriting the same row
        // would shrink its cut and re-cut every episode on every pass.
        if (known && updatedThisPass.has(known.id)) continue;

        // Anchor-covered occurrences are dropped before anything else asks about this
        // segment — an approved anchor cut is not offered a second time as "audio this
        // show repeats." A brand new segment left with fewer than two occurrences by
        // that filtering is not worth creating; an existing one is still upserted with
        // whatever survives, so it shrinks (or empties) rather than going stale.
        const inSearch = occurrences.filter((occurrence) => !coveredByAnchor(occurrence));
        if (!known && inSearch.length < 2) continue;
        // Occurrences in episodes this search did not look at are carried forward
        // untouched: not being compared this pass is not the same as not being there.
        const carried = known
          ? selectOccurrencesOf
              .all(known.id)
              .filter((row) => !inWindow.has(row.episode_id))
              .map((row) => ({ episodeId: row.episode_id, start: row.start_frame, end: row.end_frame, startMs: row.start_ms, endMs: row.end_ms }))
          : [];
        const filtered = [...inSearch, ...carried];

        const verdict = safeToApproveAutomatically(
          { ...segment, durationMs, occurrences: filtered, cueScore: known?.cue_score ?? 0 },
          { episodeDurations: durations, minEpisodes: threshold, source: SEGMENT_SOURCES.CORPUS },
        );
        const auto = show.ad_trim_mode === 'auto' && verdict.safe;

        const stored = upsertSegment(show.id, {
          signature: known?.signature ?? segment.signature,
          kind: known?.kind ?? SEGMENT_KINDS.REPEATED_AUDIO,
          durationMs,
          episodeCount: new Set(filtered.map((occurrence) => occurrence.episodeId)).size,
          occurrenceCount: filtered.length,
          occurrences: filtered,
          status: auto ? SEGMENT_STATUS.APPROVED : SEGMENT_STATUS.CANDIDATE,
          autoApproved: auto,
          holdReason: verdict.safe ? null : verdict.reason,
        });
        updatedThisPass.add(stored.id);
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
        // The length guard has always been written for this case and was never asked:
        // a difference chosen by whoever serves the audio can be ten minutes long, and
        // that is not an advert to take out of an episode nobody looked at.
        const durationMs = range.durationMs ?? range.endMs - range.startMs;
        const verdict = safeToApproveAutomatically(
          { durationMs, episodeCount: 1, occurrences: [{ episodeId: episode.id, startMs: range.startMs, endMs: range.endMs }] },
          { source: SEGMENT_SOURCES.DIFF },
        );
        const auto = show.ad_trim_mode === 'auto' && verdict.safe;
        upsertSegment(show.id, {
          signature,
          kind: SEGMENT_KINDS.DIFF,
          durationMs,
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
          holdReason: verdict.safe ? null : verdict.reason,
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
     * What sounds like a sponsor read in one episode and is not already cut, kept or
     * waiting — for highlighting in the words, where it can be taught from. Worked out
     * each time rather than stored (spec §19.6): a few hundred tokens of arithmetic.
     */
    async sponsorSuggestions(episodeId) {
      if (!transcriber) return [];
      const episode = episodes.get(episodeId);
      const show = episode ? shows.get(episode.show_id) : null;
      if (!show) return [];
      const [entry] = await hearShow(show, { episodeIds: [episodeId] });
      if (!entry) return [];
      const covered = db
        .prepare('SELECT start_ms, end_ms FROM ad_segment_occurrences WHERE episode_id = ?')
        .all(episodeId);
      const overlapsStored = (startMs, endMs) =>
        covered.some((row) => Math.min(endMs, row.end_ms) - Math.max(startMs, row.start_ms) > 0.5 * (endMs - startMs));
      const suggestions = [];
      for (const block of findSponsorBlocks(entry)) {
        const cues = cuesFor(entry, block.tokenStart, block.tokenEnd);
        if (cues.score < CUE_OFFER_ALONE) continue;
        if (overlapsStored(block.startMs, block.endMs)) continue;
        const firstWord = entry.tokens[block.tokenStart]?.word ?? 0;
        const lastWord = entry.tokens[block.tokenEnd]?.word ?? firstWord;
        suggestions.push({
          startMs: block.startMs,
          endMs: block.endMs,
          startWord: firstWord,
          endWord: lastWord,
          rawText: cues.rawText,
          cueScore: cues.score,
          cues: cues.cues,
        });
      }
      return suggestions;
    },

    /** See reconcileKinds. Run once at boot for every show, and before every pass. */
    reconcileKinds(showId = null) {
      reconcileKinds(showId);
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

      /*
       * What the sound already decided, before a single word is looked at.
       *
       * `detectAnchors` runs earlier in the pipeline and needs no transcript at all —
       * this only reads what it already found. Where the jingle was heard, the head
       * is claimed here so stages 0–3 leave it alone, the same way a marker's own
       * words claim their ground below. Where it was not, nothing new may be offered
       * or auto-approved at the head (see the loop after stage 0), but a read the
       * owner already decided about is still applied there — that is stage 1, and it
       * runs before this file adds anything to that block list.
       */
      const confirmedAnchor = selectAnchors.all(show.id).find((row) => row.confirmed_at);
      const anchorHitsByEpisode = confirmedAnchor
        ? new Map(selectAnchorHits.all(confirmedAnchor.id).map((row) => [row.episode_id, row]))
        : new Map();
      if (confirmedAnchor) {
        for (const entry of heard) {
          const hit = anchorHitsByEpisode.get(entry.episode.id);
          if (!hit?.heard) continue;
          const cutEndMs = hit.at_ms - confirmedAnchor.lead_ms;
          if (cutEndMs < MIN_ANCHOR_CUT_MS) continue;
          const upTo = lastTokenBefore(entry, cutEndMs);
          if (upTo >= 0) claimRange(claimed, entry.episode.id, 0, upTo);
        }
      }

      /* 0. Boundaries the owner taught. */
      for (const marker of selectMarkers.all(show.id)) {
        const phrase = marker.text.split(' ');
        const atStart = marker.role === 'programme_starts';
        // A marker the owner taught by words, once its own located boundary agreed
        // with a jingle's sound closely enough to link the two (`detectAnchors`,
        // `linkableMarker`), stops matching by words for any episode the anchor has
        // already spoken for — heard or missed, either way deferring to the sound
        // rather than asking the same question twice. An episode with no fingerprint
        // has no hit row and falls straight through to the words below, as it always
        // has.
        const linkedToAnchor = atStart && confirmedAnchor?.marker_id === marker.id;
        const occurrences = [];
        const before = selectBySignature.get(show.id, `marker:${marker.id}`);
        const already = new Set(before ? selectOccurrencesOf.all(before.id).map((row) => row.episode_id) : []);
        for (const entry of heard) {
          if (linkedToAnchor && anchorHitsByEpisode.has(entry.episode.id)) continue;
          // Only the window the marker belongs to: the opening for a start, the closing
          // for an end. "Vous écoutez RMC" said again at minute forty is not the start.
          //
          // And only the half of the episode it belongs to. A short episode is heard as
          // one window, so "the closing window" is the whole episode — and a host who
          // reads the same sponsor tag to open one episode and close the next had
          // "cut from these words to the end" match at 0:00 and ask for the whole
          // episode to go. Measured on the show this was built for: four episodes of
          // six. The start of a programme is in its first half; its end in its second —
          // or, in an episode too short for halves to mean much, its first or last minute.
          const windowIndex = atStart ? 0 : entry.transcript.windows.length - 1;
          const halfMs = entry.durationMs / 2;
          const startsBefore = Math.max(halfMs, 60_000);
          const endsAfter = Math.min(halfMs, Math.max(0, entry.durationMs - 60_000));
          const inHalf = (token) =>
            token.window === windowIndex && (atStart ? token.startMs < startsBefore : token.startMs >= endsAfter);
          const first = entry.tokens.findIndex(inHalf);
          if (first < 0) continue;
          let last = entry.tokens.length - 1;
          while (last > first && !inHalf(entry.tokens[last])) last -= 1;
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
          // A boundary that would take most of an episode has matched in the wrong place
          // — the programme is not a fifth of its own length. The trimmer would refuse
          // the cut and flag the episode; better never to ask.
          if (occurrence.endMs - occurrence.startMs > MAX_BOUNDARY_SHARE * entry.durationMs) continue;
          occurrences.push(occurrence);
        }
        const lengths = occurrences.map((o) => o.endMs - o.startMs).sort((a, b) => a - b);
        const stored = upsertSegment(show.id, {
          signature: `marker:${marker.id}`,
          kind: SEGMENT_KINDS.BOUNDARY_WORDS,
          markerId: marker.id,
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
        if (!known.text || known.kind === SEGMENT_KINDS.BOUNDARY_WORDS) continue;
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

      /*
       * A jingle SelfPod listened for and did not hear blocks nothing above this
       * line — stage 1 has already run, and a read the owner previously decided
       * about is applied whether or not the anchor found anything this time. From
       * here on, though, nothing new is guessed at in the same ground: no offer, and
       * so no automatic approval of one either. The owner was told plainly (by
       * `detectAnchors`) that the jingle went unheard; SelfPod does not also start
       * inventing candidates in the dark where it usually has a boundary to trust.
       */
      if (confirmedAnchor) {
        for (const entry of heard) {
          const hit = anchorHitsByEpisode.get(entry.episode.id);
          if (!hit || hit.heard) continue;
          const upTo = lastTokenBefore(entry, DEFAULT_SEARCH_MS);
          if (upTo >= 0) claimRange(claimed, entry.episode.id, 0, upTo);
        }
      }

      /*
       * 2. What repeats — among the newest episodes only.
       *
       * The search leaves out any four-word run seen more than MAX_KEY_OCCURRENCES (64)
       * times, which is what keeps silence and filler from swamping it — and which also
       * meant that once a show had more than 64 episodes, a read in every one of them
       * could never be found again. Measured: found in 64 episodes, nothing in 65. The
       * window keeps the search under that. Reads already known are matched in every
       * episode by stage 1 above, whatever its age.
       */
      const searchWindow = new Set(heard.slice(0, corpusWindow()).map((entry) => entry.episode.id));
      const found = findRepeatedText(
        heard.filter((entry) => searchWindow.has(entry.episode.id)).map((entry) => ({ id: entry.episode.id, tokens: entry.tokens })),
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
        // Where this read was already found outside the window, it stays found.
        if (known) {
          for (const row of selectOccurrencesOf.all(known.id)) {
            if (searchWindow.has(row.episode_id)) continue;
            occurrences.push({ episodeId: row.episode_id, start: row.start_frame, end: row.end_frame, startMs: row.start_ms, endMs: row.end_ms });
          }
        }
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

      /*
       * 3. What sounds like a sponsor read, heard once.
       *
       * No longer a row: a read heard in one episode was never cut on its own, and one
       * row per episode per read was most of the noise on the Adverts page. It is
       * highlighted where the words are shown (sponsorSuggestions) and taught from
       * there. What remains here is the one useful side effect — words that fall on
       * audio already found by ear are attached to that row, so its card can quote them.
       */
      for (const entry of heard) {
        const blocks = findSponsorBlocks(entry, {
          isClaimed: (tokenStart, tokenEnd) => isClaimed(claimed, entry.episode.id, tokenStart, tokenEnd),
        });
        for (const candidate of blocks) {
          const cues = cuesFor(entry, candidate.tokenStart, candidate.tokenEnd);
          if (cues.score < CUE_OFFER_ALONE) continue;
          const text = entry.tokens.slice(candidate.tokenStart, candidate.tokenEnd + 1).map((t) => t.t).join(' ');
          const cut = occurrenceFrom(entry, candidate.startMs, candidate.endMs);
          annotateCorpus(entry, cut, { ...cues, text }, show, durations, threshold);
        }
      }

      events?.emit(EVENTS.SHOW_CHANGED, { showId: show.id });
      logger?.info({ showId: show.id, ...counts }, 'looked for spoken adverts');
      return counts;
    },

    /**
     * Cutting a pre-roll by the sound of the jingle that follows it, not by its words
     * (spec §19.6). Reads no transcript and needs none: this works with
     * `ad_transcribe = 'off'` and with no recognizer at all, which is why it is its
     * own stage rather than part of `detectFromTranscripts` — that function gives up
     * the moment nothing was heard — and why it runs *before* that stage in the
     * pipeline: whatever it claims at the head of an episode, the words never see,
     * because `detectFromTranscripts` reads `ad_anchor_hits` before touching stage 0.
     *
     * With no confirmed anchor yet, this proposes one from what every recent
     * episode's opening shares (`findHeadAnchors`) and stops there — unless a
     * `programme_starts` marker's own located words already agree with the proposal,
     * in which case the boundary the owner already taught is carried straight over
     * rather than asked a second way. A proposal on its own cuts nothing; only a
     * confirmed anchor is searched for and cut here.
     */
    async detectAnchors(showId) {
      const show = shows.getOrThrow(showId);
      reconcileKinds(show.id);
      if (show.ad_trim_mode === 'off') return { skipped: 'mode_off' };

      const rows = selectAnchors.all(showId);
      // Confirmed wins if one somehow exists alongside a pending row; otherwise the
      // one proposal still waiting on the owner is what this pass continues working
      // on — never a fresh one minted under a new id every time this runs.
      let anchor = rows.find((row) => row.confirmed_at) ?? rows.find((row) => !row.confirmed_at && !row.dismissed_at) ?? null;

      const episodeList = episodes.listByShow(show.id);
      const withFingerprints = [];
      const fingerprintsById = new Map();
      for (const episode of episodeList) {
        const fingerprint = await loadFingerprint(episode);
        if (!fingerprint?.hashes?.length) continue;
        withFingerprints.push({ id: episode.id, fingerprint: fingerprint.hashes });
        fingerprintsById.set(episode.id, fingerprint);
      }

      let proposed = false;
      let autoConfirmed = false;
      if (!anchor && withFingerprints.length >= 2) {
        const dismissedClips = rows
          .filter((row) => row.dismissed_at)
          .map((row) => decodeFingerprint(row.clip)?.hashes)
          .filter(Boolean);
        /*
         * The newest episodes only, not the show's whole history. `findHeadAnchors`
         * insists the jingle be present in *every* episode it is given — deliberately
         * strict, see that function's own reasoning — and a show that changed its
         * ident once, or carries one genuinely bonus episode without it, would
         * otherwise be unable to ever get a proposal at all: one episode with no
         * jingle anywhere in a library's history is enough to veto every candidate,
         * for ever. `episodeList` is already newest first (`episodes.listByShow`).
         */
        const recentWithFingerprints = withFingerprints.slice(0, MAX_PROPOSAL_EPISODES);
        for (const candidate of await search.headAnchors(recentWithFingerprints)) {
          const clip = anchorClipFrom(candidate, fingerprintsById);
          if (!clip) continue;
          // "No, that's not the jingle" must stay answered: a dismissed clip is never
          // proposed again under a new id just because the corpus shifted.
          if (dismissedClips.some((dismissed) => clipsMatch(clip.hashes, dismissed))) continue;
          anchor = insertAnchor(show.id, { origin: 'proposed', confirmed: false, clip });
          proposed = true;
          break;
        }
      }
      if (!anchor) return { skipped: rows.length ? 'awaiting_decision' : 'nothing_found', proposed };

      let clipHashes;
      const stored = decodeFingerprint(anchor.clip);
      if (stored?.hashes?.length) {
        clipHashes = stored.hashes;
      } else {
        /*
         * The algorithm moved on since this clip was taken. Mixing a fingerprint from
         * one algorithm with a clip from another would produce matches that mean
         * nothing, so the clip is never trusted here — only the millisecond range it
         * was taken from, re-read against today's fingerprint of the same exemplar.
         * If that episode is gone too, this anchor cuts nothing until the owner
         * points at the jingle again: never a wrong cut from a stale clip.
         */
        clipHashes = await rebuildAnchorClip(anchor);
        if (clipHashes) {
          db.prepare('UPDATE ad_anchors SET clip = @clip, algorithm_version = @version, updated_at = @now WHERE id = @id').run({
            clip: encodeFingerprint({
              hashes: clipHashes,
              sampleRate: 0,
              samplesPerFrame: 0,
              durationMs: Math.round(clipHashes.length * SUB_MS),
            }),
            version: FINGERPRINT_VERSION,
            now: nowIso(),
            id: anchor.id,
          });
        }
      }
      if (!clipHashes) return { skipped: 'anchor_stale', anchorId: anchor.id, proposed };

      /*
       * Heard or missed, in every fingerprinted episode — run whether or not the
       * anchor is confirmed yet. A pending proposal gets no cut from this, but it
       * does get the chance below to link to a marker whose words now agree with it,
       * and it does let the owner hear the right exemplar on the review card.
       */
      const previousHits = new Map(selectAnchorHits.all(anchor.id).map((row) => [row.episode_id, row]));
      const onsetByEpisode = new Map();
      const checkedAt = nowIso();
      let heard = 0;
      let missed = 0;
      let newlyMissed = 0;
      for (const episode of episodeList) {
        const fingerprint = fingerprintsById.get(episode.id);
        // No fingerprint (not an MP3, unreadable, too long): not checked, not a miss —
        // the word marker applies to this episode exactly as it does today.
        if (!fingerprint) continue;
        const hit = locateAnchor(clipHashes, fingerprint.hashes);
        upsertAnchorHit.run({
          anchor_id: anchor.id,
          episode_id: episode.id,
          heard: hit ? 1 : 0,
          at_ms: hit?.atMs ?? null,
          ber: hit?.ber ?? null,
          checked_at: checkedAt,
        });
        if (!hit) {
          missed += 1;
          const previous = previousHits.get(episode.id);
          if (!previous || previous.heard) newlyMissed += 1;
          continue;
        }
        heard += 1;
        onsetByEpisode.set(episode.id, hit.atMs - anchor.lead_ms);
      }

      /*
       * A marker the owner already taught, whose *last-known* located words agree
       * with where the jingle was just heard, links and confirms here — never on the
       * same pass it was first proposed on, since the words for a brand new marker
       * have not been read yet by the time this runs (see `linkableMarker`), but on
       * whichever later pass finds them agreeing.
       */
      if (!anchor.confirmed_at) {
        const marker = linkableMarker(show.id, onsetByEpisode);
        if (marker) {
          db.prepare(
            `UPDATE ad_anchors SET origin = 'from_marker', marker_id = @marker_id, confirmed_at = @now, updated_at = @now WHERE id = @id`,
          ).run({ marker_id: marker.id, now: nowIso(), id: anchor.id });
          anchor = selectAnchor.get(anchor.id);
        }
      }

      /*
       * In automatic mode, a jingle SelfPod found for itself is cut without being asked
       * — when it is heard in every one of the recent episodes it was proposed from.
       * That is the owner's own rule for automatic mode: cut what SelfPod is sure of,
       * say so, and make it one press to undo. Measured on the real show this was built
       * for, the same clip was heard in six upstream episodes out of six at a bit-error
       * rate of 0.11 or less, where anything else scores above 0.43. Forgetting an
       * automatically confirmed jingle dismisses it, so it is never proposed again.
       * In review mode it stays a question.
       */
      if (!anchor.confirmed_at && show.ad_trim_mode === 'auto' && anchor.origin === 'proposed') {
        const recent = withFingerprints.slice(0, MAX_PROPOSAL_EPISODES);
        if (recent.length >= 2 && recent.every((entry) => onsetByEpisode.has(entry.id))) {
          db.prepare(
            'UPDATE ad_anchors SET confirmed_at = @now, auto_confirmed = 1, updated_at = @now WHERE id = @id',
          ).run({ now: nowIso(), id: anchor.id });
          anchor = selectAnchor.get(anchor.id);
          autoConfirmed = true;
        }
      }

      // A proposal is not a decision. Stopping here leaves the hits recorded — the
      // review card can already say how many episodes the jingle was heard in — but
      // cuts nothing until the owner, or a linked marker, actually decides.
      if (!anchor.confirmed_at) return { skipped: 'awaiting_decision', anchorId: anchor.id, proposed };

      const occurrences = [];
      for (const [episodeId, onsetMs] of onsetByEpisode) {
        if (onsetMs < MIN_ANCHOR_CUT_MS) continue; // heard right at the start — nothing to cut
        occurrences.push(occurrenceFromAnchor({ id: episodeId }, fingerprintsById.get(episodeId), onsetMs));
      }

      const signature = `anchor:${anchor.id}`;
      const existingSegment = selectBySignature.get(show.id, signature);
      // An empty cut list still needs recording when a segment already exists, so a
      // jingle that stops appearing anywhere shrinks the cut back to nothing rather
      // than leaving a stale approval with no episodes behind it.
      if (occurrences.length || existingSegment) {
        const lengths = occurrences.map((o) => o.endMs - o.startMs).sort((a, b) => a - b);
        upsertSegment(show.id, {
          signature,
          kind: SEGMENT_KINDS.JINGLE,
          anchorId: anchor.id,
          status: SEGMENT_STATUS.APPROVED,
          autoApproved: false,
          holdReason: null,
          durationMs: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0,
          episodeCount: new Set(occurrences.map((o) => o.episodeId)).size,
          occurrenceCount: occurrences.length,
          occurrences,
        });
      }

      events?.emit(EVENTS.SHOW_CHANGED, { showId: show.id });
      return { anchorId: anchor.id, proposed, autoConfirmed, heard, missed, newlyMissed, cuts: occurrences.length };
    },

    /* ---- what the owner teaches ---------------------------------------------- */

    listAnchors(showId) {
      return selectAnchors.all(showId);
    },

    getAnchor(id) {
      return selectAnchor.get(id) ?? null;
    },

    /** "Heard in 12 of 14 episodes" — the anchor card's own summary, over every episode last checked. */
    anchorSummary(id) {
      const hits = selectAnchorHits.all(id);
      return { total: hits.length, heard: hits.filter((row) => row.heard).length, missed: hits.filter((row) => !row.heard).length };
    },

    /** What the current anchor found (or didn't) in one episode, for the episode page and its ledger. */
    anchorStatusFor(episodeId) {
      const hit = db
        .prepare(
          `SELECT h.*, a.id AS anchor_id, a.confirmed_at
             FROM ad_anchor_hits h
             JOIN ad_anchors a ON a.id = h.anchor_id
            WHERE h.episode_id = ? AND a.confirmed_at IS NOT NULL
            ORDER BY h.checked_at DESC LIMIT 1`,
        )
        .get(episodeId);
      if (!hit) return null;
      return { anchorId: hit.anchor_id, heard: Boolean(hit.heard), atMs: hit.at_ms, ber: hit.ber };
    },

    /**
     * "This is the jingle" — pointed at by hand, on an episode that has a fingerprint.
     * Confirmed on arrival: the owner just made the decision, so there is nothing left
     * to ask.
     */
    async addAnchorFromRange({ showId, episodeId, startMs, endMs }) {
      const episode = episodes.getOrThrow(episodeId);
      const fingerprint = await loadFingerprint(episode);
      if (!fingerprint?.hashes?.length) {
        throw badRequest('SelfPod has not fingerprinted this episode yet, so there is nothing to anchor to.', 'no_fingerprint');
      }
      const clip = anchorClipFrom(
        { occurrences: [{ episodeId, startMs, endMs }] },
        new Map([[episodeId, fingerprint]]),
      );
      if (!clip) throw badRequest('Select a few seconds of the jingle — at least a couple of seconds either side of any silence.', 'anchor_too_short');
      return insertAnchor(showId, { origin: 'pointed_at', confirmed: true, clip });
    },

    /**
     * "This stretch is an advert", pointed at by time rather than by words.
     *
     * Where SelfPod heard words there, it is taught by those words, so the same read is
     * cut from later episodes too — the same as picking the words in the transcript.
     * Where it heard none (no recogniser, listening switched off, a mid-roll outside the
     * listening window, music) it is cut from this episode only, by time: nothing about
     * a stretch of sound says where it will be tomorrow.
     */
    async teachRange({ showId, episodeId, startMs, endMs }) {
      const show = shows.getOrThrow(showId);
      const episode = episodes.getOrThrow(episodeId);
      if (episode.show_id !== show.id) throw notFound('That episode is not in this show.', 'episode_not_found');
      const fingerprint = await loadFingerprint(episode);
      const durationMs = fingerprint?.durationMs ?? (episode.duration_seconds ?? 0) * 1000;
      if (!fingerprint?.sampleRate || !fingerprint?.samplesPerFrame) {
        throw badRequest('SelfPod has not read this episode yet, so it cannot cut it. Try again after the next check.', 'no_fingerprint');
      }
      if (!(startMs >= 0 && endMs > startMs && endMs <= durationMs + 500)) {
        throw badRequest('Say a first and a last moment, in that order, within the episode.', 'invalid_range');
      }
      if (endMs - startMs < 1000) throw badRequest('That is less than a second — select the whole advert.', 'range_too_short');

      const transcript = transcriber ? await transcriber.loadTranscript(episode) : null;
      if (transcript) {
        const words = transcript.windows
          .flatMap((window) => window.sentences.flatMap((sentence) => sentence.words))
          .filter((word) => (word.s + word.e) / 2 >= startMs && (word.s + word.e) / 2 <= endMs);
        const rawText = rawTextOf(words);
        if (normaliseText(rawText).length >= 3) {
          return api.teachSegment({ showId, episodeId, startMs, endMs, rawText, status: SEGMENT_STATUS.APPROVED, language: transcript.language ?? null });
        }
      }

      const clampedEnd = Math.min(endMs, durationMs);
      const occurrence = {
        episodeId,
        startMs,
        endMs: clampedEnd,
        // Outwards, as every cut edge is: a breath of programme lost beats a syllable of advert kept.
        start: msToFrame(startMs, fingerprint),
        end: msToFrame(clampedEnd, fingerprint) + 1,
      };
      const signature = `range:${createHash('sha256').update(`${episodeId}:${startMs}:${clampedEnd}`).digest('hex').slice(0, 24)}`;
      return upsertSegment(show.id, {
        signature,
        kind: SEGMENT_KINDS.TAUGHT_RANGE,
        status: SEGMENT_STATUS.APPROVED,
        autoApproved: false,
        holdReason: null,
        durationMs: clampedEnd - startMs,
        episodeCount: 1,
        occurrenceCount: 1,
        occurrences: [occurrence],
      });
    },

    /**
     * "Restore everywhere and stop": the rule behind a cut, undone for the whole show.
     *
     * Dispatched by kind, because a cut is the effect of different things: a jingle and
     * a boundary are rules with their own rows, and removing only their cut would leave
     * the rule standing and the cut back on the next pass. Anything else is a decision
     * about a stretch, and becomes "keep it" — remembered, so it is not offered again.
     */
    stopRule(segmentId) {
      const segment = selectSegment.get(segmentId);
      if (!segment) throw notFound('That cut no longer exists.', 'segment_not_found');
      if (segment.kind === SEGMENT_KINDS.JINGLE && segment.anchor_id) return { removed: 'jingle', anchor: api.removeAnchor(segment.anchor_id) };
      if (segment.kind === SEGMENT_KINDS.BOUNDARY_WORDS && segment.marker_id) return { removed: 'boundary', marker: api.removeMarker(segment.marker_id) };
      if (segment.kind === SEGMENT_KINDS.TAUGHT_RANGE) {
        // A range means nothing outside its own episode; keeping it as "not an advert" would remember nothing.
        return { removed: 'range', segment: api.forgetSegment(segmentId) };
      }
      return { removed: 'decision', segment: api.decide(segmentId, SEGMENT_STATUS.REJECTED) };
    },

    /**
     * Forgets a decision entirely, so what it was about can be offered again.
     *
     * For a "keep it" the owner has changed their mind about, and for a range taught by
     * time. The cut it made, if any, is put back first.
     */
    forgetSegment(segmentId) {
      const segment = selectSegment.get(segmentId);
      if (!segment) throw notFound('That decision no longer exists.', 'segment_not_found');
      if (segment.kind === SEGMENT_KINDS.JINGLE || segment.kind === SEGMENT_KINDS.BOUNDARY_WORDS) {
        return api.stopRule(segmentId);
      }
      if (segment.status === SEGMENT_STATUS.APPROVED) markForRecut(segment.id);
      db.prepare('DELETE FROM ad_segments WHERE id = ?').run(segment.id);
      events?.emit(EVENTS.SHOW_CHANGED, { showId: segment.show_id });
      return segment;
    },

    /** "Yes, that's the jingle" — confirmed, so the next pass starts cutting to it. */
    confirmAnchor(id) {
      const anchor = selectAnchor.get(id);
      if (!anchor) throw notFound('That jingle no longer exists.', 'anchor_not_found');
      if (!anchor.confirmed_at) {
        db.prepare('UPDATE ad_anchors SET confirmed_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
      }
      events?.emit(EVENTS.SHOW_CHANGED, { showId: anchor.show_id });
      return selectAnchor.get(id);
    },

    /** "No, that's not the jingle" — a proposal only; nothing was ever cut by it. */
    dismissAnchor(id) {
      const anchor = selectAnchor.get(id);
      if (!anchor) throw notFound('That proposal no longer exists.', 'anchor_not_found');
      db.prepare('UPDATE ad_anchors SET dismissed_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
      events?.emit(EVENTS.SHOW_CHANGED, { showId: anchor.show_id });
      return selectAnchor.get(id);
    },

    /**
     * Forgets a confirmed anchor and puts back everything it cut.
     *
     * One SelfPod found for itself is dismissed rather than deleted: its clip is what
     * stops the same jingle being proposed — or, in automatic mode, confirmed — again
     * on the very next pass. One the owner pointed at is simply gone.
     */
    removeAnchor(id) {
      const anchor = selectAnchor.get(id);
      if (!anchor) throw notFound('That jingle no longer exists.', 'anchor_not_found');
      const segment = selectBySignature.get(anchor.show_id, `anchor:${id}`);
      if (segment) {
        markForRecut(segment.id);
        db.prepare('DELETE FROM ad_segments WHERE id = ?').run(segment.id);
      }
      if (anchor.origin === 'proposed') {
        db.prepare(
          'UPDATE ad_anchors SET confirmed_at = NULL, auto_confirmed = 0, dismissed_at = @now, updated_at = @now WHERE id = @id',
        ).run({ now: nowIso(), id });
      } else {
        db.prepare('DELETE FROM ad_anchors WHERE id = ?').run(id);
      }
      events?.emit(EVENTS.SHOW_CHANGED, { showId: anchor.show_id });
      return anchor;
    },

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
        ? (await hearShow(show, { episodeIds: [episodeId] }))[0] ?? null
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
        if (row.exemplar_episode_id && row.text) wanted.add(row.exemplar_episode_id);
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
            WHERE o.episode_id = ? AND (s.kind IN ('${SEGMENT_KINDS.BOUNDARY_WORDS}', '${SEGMENT_KINDS.REMEMBERED_WORDS}', '${SEGMENT_KINDS.REPEATED_WORDS}') OR s.text IS NOT NULL)
            ORDER BY o.start_ms`,
        )
        .all(episodeId);
    },

    /** The anchor's own cut in one episode, if it made one — kept deliberately apart from `spokenIn`, which an anchor's occurrence never appears in (it carries no text). */
    anchorCutFor(episodeId) {
      return (
        db
          .prepare(
            `SELECT s.id AS segment_id, o.start_ms, o.end_ms
               FROM ad_segment_occurrences o
               JOIN ad_segments s ON s.id = o.segment_id
              WHERE o.episode_id = ? AND s.kind = '${SEGMENT_KINDS.JINGLE}' AND s.status = '${SEGMENT_STATUS.APPROVED}'
              LIMIT 1`,
          )
          .get(episodeId) ?? null
      );
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
      const entry = (await hearShow(show, { episodeIds: [episodeId] }))[0];
      const occurrence = entry ? occurrenceFrom(entry, startMs, endMs) : { episodeId, startMs, endMs, start: 0, end: 0 };
      const text = normaliseText(rawText).join(' ');
      const others = selectOccurrencesOf
        .all(segmentId)
        .filter((row) => row.episode_id !== episodeId)
        .map((row) => ({ episodeId: row.episode_id, start: row.start_frame, end: row.end_frame, startMs: row.start_ms, endMs: row.end_ms }));
      // The cues belong to the words: new edges, new words, cues read again — otherwise
      // the card goes on quoting what the old edges happened to include.
      let cues = null;
      if (entry) {
        const inRange = entry.tokens
          .map((token, index) => ({ token, index }))
          .filter(({ token }) => (token.startMs + token.endMs) / 2 >= occurrence.startMs && (token.startMs + token.endMs) / 2 <= occurrence.endMs);
        if (inRange.length) cues = cuesFor(entry, inRange[0].index, inRange[inRange.length - 1].index);
      }
      db.prepare(
        `UPDATE ad_segments SET text = @text, raw_text = @raw_text, duration_ms = @duration_ms,
                cue_score = COALESCE(@cue_score, cue_score), cues = COALESCE(@cues, cues),
                exemplar_episode_id = @episode_id, exemplar_start_ms = @start_ms, exemplar_end_ms = @end_ms, updated_at = @now
          WHERE id = @id`,
      ).run({
        id: segmentId,
        cue_score: cues ? cues.score : null,
        cues: cues ? JSON.stringify(cues.cues) : null,
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
    /**
     * "Restore here": leaves one cut out of one episode, whatever rule makes it.
     *
     * The rule goes on cutting everywhere else. Only this episode is cut again, so the
     * published copies of every other episode keep their bytes and their addresses.
     */
    restoreHere({ segmentId, episodeId }) {
      const segment = selectSegment.get(segmentId);
      if (!segment) throw notFound('That cut no longer exists.', 'segment_not_found');
      const occurrence = db
        .prepare('SELECT * FROM ad_segment_occurrences WHERE segment_id = ? AND episode_id = ? ORDER BY start_ms LIMIT 1')
        .get(segmentId, episodeId);
      if (!occurrence) throw notFound('That cut is not in this episode.', 'occurrence_not_found');
      const existing = selectOverrides.all(episodeId).find((restore) => restoreCovers(restore, occurrence));
      if (existing) return existing;
      const id = newId();
      db.prepare(
        `INSERT INTO ad_cut_overrides (id, episode_id, segment_id, start_ms, end_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, episodeId, segmentId, occurrence.start_ms, occurrence.end_ms, nowIso());
      markForRecut(segmentId, [episodeId]);
      events?.emit(EVENTS.SHOW_CHANGED, { showId: segment.show_id });
      return db.prepare('SELECT * FROM ad_cut_overrides WHERE id = ?').get(id);
    },

    /** Takes a "restore here" back, so the rule cuts that stretch of the episode again. */
    undoRestore(overrideId) {
      const restore = db.prepare('SELECT * FROM ad_cut_overrides WHERE id = ?').get(overrideId);
      if (!restore) throw notFound('That restore no longer exists.', 'override_not_found');
      db.prepare('DELETE FROM ad_cut_overrides WHERE id = ?').run(overrideId);
      markForRecut(restore.segment_id, [restore.episode_id]);
      const episode = episodes.get(restore.episode_id);
      if (episode) events?.emit(EVENTS.SHOW_CHANGED, { showId: episode.show_id });
      return restore;
    },

    /** Every restore in one episode. */
    restoresIn(episodeId) {
      return selectOverrides.all(episodeId);
    },

    /** Whether a stored occurrence is left in its episode by a restore. */
    isRestored(episodeId, occurrence) {
      return selectOverrides.all(episodeId).some((restore) => restoreCovers(restore, occurrence));
    },

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
      const restores = selectOverrides.all(episodeId);
      const rows = db
        .prepare(
          `SELECT o.start_frame, o.end_frame, o.start_ms, o.end_ms
             FROM ad_segment_occurrences o
             JOIN ad_segments s ON s.id = o.segment_id
            WHERE o.episode_id = ? AND s.status = '${SEGMENT_STATUS.APPROVED}'
            ORDER BY o.start_frame`,
        )
        .all(episodeId)
        // "Restore here" wins over every rule, in this episode only.
        .filter((row) => !restores.some((restore) => restoreCovers(restore, row)));

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
