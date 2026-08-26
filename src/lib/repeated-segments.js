/**
 * Finding the audio a show repeats across its episodes (spec §19.3).
 *
 * The other half of ad detection. Diffing two downloads catches adverts a host
 * stitches in per request; this catches the ones already in the file — a sponsor read
 * cut into the episode at production time, a theme tune, a standing outro.
 *
 * ## Why this works on frame hashes, and not on decoded audio
 *
 * The plan for this was acoustic fingerprinting: decode every episode, take spectral
 * features, hash them in a way that survives re-encoding. That is the right tool for
 * matching audio that has been through different encoders — and it costs a decode of
 * every episode, which is minutes each on a NAS, and it needs ffmpeg.
 *
 * It is also, for this problem, usually unnecessary. A repeated segment inside a
 * podcast arrives one of two ways, and both leave the frames alone:
 *
 *  - the producer drops the same audio into the edit and encodes the episode. The
 *    same PCM through the same encoder at the same settings gives the same frames,
 *    apart from a handful either side of the join where the bit reservoir has not yet
 *    settled;
 *  - or the segment is concatenated after encoding, in which case the frames are
 *    literally the same bytes.
 *
 * So this looks for repeated *frames* first, which is free — the hashes already exist
 * from reading the file — and needs no decoding, no ffmpeg, and no second copy of
 * anything. Where it finds nothing and a user is certain there is something to find,
 * acoustic fingerprinting remains the fallback, and it can be added behind the same
 * interface without changing anything above it.
 *
 * ## What it cannot tell you
 *
 * Which of the repeated things is an advert. A theme tune, a sponsor read, a standard
 * intro and a recurring stinger all repeat identically, and nothing in the audio
 * separates them. This module surfaces what recurs; the person decides what to cut.
 */

import { createHash } from 'node:crypto';

/** Runs shorter than this are stings and joins, not segments worth naming. */
const MIN_RUN_FRAMES = 150; // ~4 seconds at 44.1 kHz

/**
 * A hash appearing more often than this within one episode is not a landmark.
 *
 * Digital silence, a held tone, and encoder padding all produce identical frames
 * scattered through a file. Seeding a search from one of those means starting
 * thousands of extensions that go nowhere, which is most of the cost of a naive
 * implementation and none of the value.
 */
const MAX_SEED_OCCURRENCES = 8;

/**
 * How many frames to ignore at each end of a run when identifying it.
 *
 * Two occurrences of the same segment rarely agree exactly at the edges: the bit
 * reservoir carries state across a join, so the first frames after a splice differ
 * even when the audio is identical. Trimming before taking the signature means the
 * same segment gets the same identity wherever it was spliced in.
 */
const SIGNATURE_TRIM = 8;
const SIGNATURE_FRAMES = 48;

/**
 * @param {Array<{id: string, hashes: number[]|Uint32Array, frames?: object[]}>} episodes
 * @returns {Array<{
 *   signature: string,
 *   episodeCount: number,
 *   occurrenceCount: number,
 *   frames: number,
 *   occurrences: Array<{episodeId: string, start: number, end: number, frames: number}>,
 * }>}
 */
export function findRepeatedSegments(
  episodes,
  { minRunFrames = MIN_RUN_FRAMES, minEpisodes = 3, maxSeedOccurrences = MAX_SEED_OCCURRENCES } = {},
) {
  const usable = (episodes ?? []).filter((episode) => episode?.hashes?.length);
  if (usable.length < 2) return [];

  const index = buildIndex(usable, maxSeedOccurrences);
  // Frames already covered by a run, so the same segment is not rediscovered from
  // every one of its own frames in turn.
  const claimed = usable.map(() => new Set());
  const runs = [];

  for (let e = 0; e < usable.length; e += 1) {
    const hashes = usable[e].hashes;
    for (let i = 0; i < hashes.length; i += 1) {
      if (claimed[e].has(i)) continue;
      const candidates = index.get(hashes[i]);
      if (!candidates || candidates.length < 2) continue;

      // One seed finds every occurrence of its segment, everywhere, in one pass —
      // including further occurrences inside its own episode.
      //
      // Both halves of that were bugs. Stopping at the first match pairs the episodes
      // off two at a time (0 with 1, 2 with 3), so with an odd number the last one is
      // never paired and a segment in all five is reported as being in four. And
      // skipping the seed's own episode loses the second occurrence of a sponsor read
      // that a show plays twice, because by the time that occurrence seeds, every
      // partner it could have matched is already claimed. Both undercount, and the
      // count is what a threshold reads.
      let seedRecorded = false;
      let seedRun = null;
      for (const candidate of candidates) {
        if (candidate.e === e && candidate.i === i) continue;
        if (claimed[candidate.e].has(candidate.i)) continue;

        const run = extend(usable[e].hashes, usable[candidate.e].hashes, i, candidate.i);
        if (run.length < minRunFrames) continue;
        if (!seedRecorded) {
          seedRun = { episodeIndex: e, start: run.aStart, end: run.aStart + run.length };
          runs.push(seedRun);
          for (let k = 0; k < run.length; k += 1) claimed[e].add(run.aStart + k);
          seedRecorded = true;
        }
        for (let k = 0; k < run.length; k += 1) claimed[candidate.e].add(run.bStart + k);
        runs.push({ episodeIndex: candidate.e, start: run.bStart, end: run.bStart + run.length });
      }
    }
  }

  return cluster(runs, usable, minEpisodes);
}

/** hash → where it occurs, minus the hashes too common to be landmarks. */
function buildIndex(episodes, maxSeedOccurrences) {
  const perEpisodeCount = new Map();
  const index = new Map();

  for (let e = 0; e < episodes.length; e += 1) {
    const hashes = episodes[e].hashes;
    perEpisodeCount.clear();
    for (let i = 0; i < hashes.length; i += 1) {
      const hash = hashes[i];
      const seen = (perEpisodeCount.get(hash) ?? 0) + 1;
      perEpisodeCount.set(hash, seen);
      if (seen > maxSeedOccurrences) continue;
      let bucket = index.get(hash);
      if (!bucket) {
        bucket = [];
        index.set(hash, bucket);
      }
      bucket.push({ e, i });
    }
  }

  // A hash present in only one place cannot start a match, and dropping those is most
  // of the memory back.
  for (const [hash, bucket] of index) if (bucket.length < 2) index.delete(hash);
  return index;
}

/** Grows a match as far as it goes in both directions from a matching pair. */
function extend(a, b, ai, bi) {
  let start = 0;
  while (ai - start - 1 >= 0 && bi - start - 1 >= 0 && a[ai - start - 1] === b[bi - start - 1]) {
    start += 1;
  }
  let end = 1;
  while (ai + end < a.length && bi + end < b.length && a[ai + end] === b[bi + end]) end += 1;

  return { aStart: ai - start, bStart: bi - start, length: start + end };
}

/**
 * Groups occurrences of the same audio under one identity.
 *
 * Two things must not be conflated here. `occurrenceCount` is how many times the
 * segment appears in total; `episodeCount` is how many *distinct* episodes it appears
 * in, and that is what a threshold reads. A show that plays the same sponsor read
 * twice in one episode produces several occurrences from a single file, and counting
 * those as episodes is how "appears in three episodes" fires on one.
 *
 * Occurrences within one episode really can overlap, and the merge below is not
 * defensive padding. Claiming is per frame and checked only at a run's *seed*, so a
 * later run may begin on an unclaimed frame and then extend backwards across frames
 * an earlier run already covered. A theme tune that is the same bar looped four times
 * produces exactly that: one occurrence at frames 0–600 and another at 200–800, in
 * the same episode, describing the same audio twice.
 *
 * Worth recording how that was established, because it was nearly got wrong. Comparing
 * the *summary* of the results with and without this step showed no difference, which
 * looked like proof the step never ran — and it was removed on that basis. Asserting
 * the invariant directly, on the occurrence ranges rather than on the counts derived
 * from them, showed the overlap immediately. A shallow check of an output can agree
 * for the wrong reason.
 */
function cluster(runs, episodes, minEpisodes) {
  const clusters = new Map();

  for (const run of runs) {
    const episode = episodes[run.episodeIndex];
    const signature = signatureOf(episode.hashes, run.start, run.end);
    if (!signature) continue;

    let entry = clusters.get(signature);
    if (!entry) {
      entry = { signature, occurrences: [] };
      clusters.set(signature, entry);
    }
    entry.occurrences.push({
      episodeId: episode.id,
      start: run.start,
      end: run.end,
      frames: run.end - run.start,
    });
  }

  const out = [];
  for (const entry of clusters.values()) {
    const merged = mergeOverlapping(entry.occurrences);
    const episodeIds = new Set(merged.map((occurrence) => occurrence.episodeId));
    if (episodeIds.size < minEpisodes) continue;
    out.push({
      signature: entry.signature,
      episodeCount: episodeIds.size,
      occurrenceCount: merged.length,
      // The typical length, not the longest: one occurrence that happened to extend
      // into neighbouring audio should not stretch everyone's idea of the segment.
      frames: median(merged.map((occurrence) => occurrence.frames)),
      occurrences: merged,
    });
  }

  return out.sort((a, b) => b.episodeCount - a.episodeCount || b.frames - a.frames);
}

/**
 * Merges occurrences that describe the same stretch of one episode.
 *
 * Without this, one advert matched from several seeds is reported several times, and
 * a rule reading "appears in three episodes" can be satisfied by a single file.
 */
function mergeOverlapping(occurrences) {
  const byEpisode = new Map();
  for (const occurrence of occurrences) {
    if (!byEpisode.has(occurrence.episodeId)) byEpisode.set(occurrence.episodeId, []);
    byEpisode.get(occurrence.episodeId).push(occurrence);
  }

  const merged = [];
  for (const [episodeId, list] of byEpisode) {
    list.sort((a, b) => a.start - b.start);
    let current = null;
    for (const occurrence of list) {
      if (current && occurrence.start < current.end) {
        current.end = Math.max(current.end, occurrence.end);
        current.frames = current.end - current.start;
        continue;
      }
      if (current) merged.push(current);
      current = {
        episodeId,
        start: occurrence.start,
        end: occurrence.end,
        frames: occurrence.frames,
      };
    }
    if (current) merged.push(current);
  }
  return merged;
}

/** A stable identity for a run's content, ignoring its unreliable edges. */
function signatureOf(hashes, start, end) {
  const from = start + SIGNATURE_TRIM;
  const to = Math.min(from + SIGNATURE_FRAMES, end - SIGNATURE_TRIM);
  if (to - from < 8) return null;

  const digest = createHash('sha256');
  const buffer = Buffer.alloc(4);
  for (let i = from; i < to; i += 1) {
    buffer.writeUInt32BE(hashes[i] >>> 0, 0);
    digest.update(buffer);
  }
  return digest.digest('hex').slice(0, 24);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Whether a segment may be cut without anyone looking at it first.
 *
 * Separate from finding it, and deliberately so: everything found is offered for
 * review whatever this says. This only gates *unattended* cutting, and it exists
 * because the obvious threshold — "appears in at least three episodes" — cuts the
 * theme tune on episode three. That is not a corner case; it is the guaranteed first
 * behaviour of automatic mode on any show with a theme.
 */
export function safeToApproveAutomatically(
  segment,
  { episodeDurations, minEpisodes = 3, source = 'corpus' } = {},
) {
  // A segment found by diffing two downloads of one episode is safe by construction:
  // a theme tune is in both copies, so it can never be what differs between them.
  if (source === 'diff') return { safe: true, reason: null };

  if (segment.episodeCount < minEpisodes) {
    return { safe: false, reason: 'seen_too_few_times' };
  }

  const seconds = segment.durationMs ? segment.durationMs / 1000 : null;
  if (seconds !== null && seconds < 15) {
    return { safe: false, reason: 'too_short_to_be_an_advert' };
  }
  if (seconds !== null && seconds > 120) {
    // Longer than any advert, and very likely a recurring *segment* of the programme.
    return { safe: false, reason: 'too_long_to_be_an_advert' };
  }

  // The intro/outro signature: every occurrence hugging the start or the end.
  const durations = episodeDurations ?? {};
  const positions = segment.occurrences.map((occurrence) => {
    const total = durations[occurrence.episodeId];
    if (!total) return null;
    return { fromStartMs: occurrence.startMs ?? null, fromEndMs: total - (occurrence.endMs ?? 0) };
  });
  const known = positions.filter(Boolean);
  if (known.length && known.every((position) => position.fromStartMs !== null && position.fromStartMs < 5000)) {
    return { safe: false, reason: 'always_at_the_start' };
  }
  if (known.length && known.every((position) => position.fromEndMs < 15000)) {
    return { safe: false, reason: 'always_at_the_end' };
  }

  return { safe: true, reason: null };
}
