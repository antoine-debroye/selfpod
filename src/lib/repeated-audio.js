import { HOP, bitErrorRate } from './acoustic-fingerprint.js';
import { TARGET_RATE } from './decode-audio.js';

/**
 * Finding audio a show repeats, by what it sounds like (spec §19.3).
 *
 * This replaced a search that compared MP3 frames byte for byte. That one was cheaper —
 * no decoding at all — and it found only audio that had been *copied*: a ready-made
 * file dropped into an edit, or an advert a host stitches at serve time. Audio that was
 * re-encoded, which is what a producer mastering a whole episode in one pass produces,
 * it could not see. On three real Planet Money episodes that meant nine matching frames
 * out of ninety thousand and nothing found, for ever.
 *
 * Comparing the sound finds both, since audio that is byte-identical is also
 * acoustically identical. So there is one search here rather than two, and the byte one
 * was deleted rather than kept as an optimisation nobody would maintain.
 *
 * ## Seeding on exact matches, verifying on the sound
 *
 * Sub-fingerprints of the same audio are not identical — that is the point of them —
 * so an index of exact values sounds useless. It is not, and the arithmetic is why. A
 * genuine match runs at about eight per cent of bits wrong, so a given 32-bit word
 * survives intact with probability 0.92³² ≈ 0.07: roughly one word in fourteen. Across
 * a three-second window that is a dozen or more exact hits, and one is all a seed needs.
 *
 * So: index every sub-fingerprint exactly, seed on collisions, and then decide with the
 * bit error rate over a window. The index is a cheap way to guess where to look; the
 * error rate is what actually says yes.
 */

/** 11.6ms of audio per sub-fingerprint. */
const SUB_MS = (HOP / TARGET_RATE) * 1000;

/**
 * How wrong a match may be.
 *
 * Unrelated audio does not score 0.5 here, as it would for independent bits — adjacent
 * bands share an energy, so the bits are correlated and unrelated audio settles around
 * 0.43. Measured on real episodes: 0.08 for the same audio, 0.435 for different audio.
 * A quarter sits well clear of both, which is what a threshold should do.
 */
const MATCH_BER = 0.25;

/** The window a decision is made over: about a second and a half. */
const WINDOW = 128;

/** Shorter than this is a sting or a join, not something worth offering to cut. */
const MIN_SECONDS = 5;

/** How many places one repeated sub-fingerprint is tried. Silence recurs constantly. */
const MAX_SEED_OCCURRENCES = 6;

/**
 * One seed every ~46ms.
 *
 * Denser than it looks like it needs to be, because a seed only fires when a
 * sub-fingerprint survives re-encoding *exactly*. Measured against a real pair of
 * episodes sharing a theme at 0.147 error, that happens at about one seed in
 * twenty-three — so the shortest segment worth finding, five seconds, offers roughly
 * a thousand chances and needs one.
 */
const SEED_STRIDE = 4;

/**
 * How often a sub-fingerprint may occur across the corpus before it is ignored.
 *
 * Silence and room tone recur thousands of times and identify nothing. Indexing them
 * buries the rare keys that do.
 */
const MAX_KEY_OCCURRENCES = 32;

/** How much of an episode is read to work out where a segment sits in another. ~6s. */
const VOTE_SPAN = WINDOW * 4;

/**
 * The window used to find the exact edge of a segment. About 370ms.
 *
 * Short enough that it stops matching as soon as it is mostly outside the shared audio,
 * which is what puts the boundary in the right place.
 */
const EDGE_WINDOW = 32;

/**
 * How far each edge is pushed outwards to undo the comparison window's own width. ~420ms.
 *
 * Slightly more than the half-span it corrects, so the error that remains is a little
 * programme rather than a little advert.
 */
const EDGE_MARGIN = 36;

/** How far a boundary is pushed at a time while growing a match. About 190ms. */
const EXTEND_STEP = 16;

/**
 * @param {Array<{id: string, fingerprint: Uint32Array}>} episodes
 * @returns {Array<{signature: string, durationMs: number, episodeCount: number,
 *   occurrenceCount: number, occurrences: Array<{episodeId: string, startMs: number, endMs: number}>}>}
 */
export function findRepeatedAudio(episodes, { minEpisodes = 2, minSeconds = MIN_SECONDS } = {}) {
  const usable = episodes.filter((episode) => episode.fingerprint?.length > WINDOW);
  if (usable.length < 2) return [];

  /*
   * Counted first, then indexed — and a key that occurs too often is left out entirely
   * rather than truncated.
   *
   * Truncating was the bug this replaces. Silence and room tone produce the same
   * sub-fingerprint thousands of times, so keeping "the first twenty-four occurrences"
   * of every key filled those buckets with noise and, for any key that was even
   * moderately common, threw away the one occurrence that mattered. The search then
   * found nothing and looked like the algorithm was wrong.
   *
   * A key shared by half the episode identifies nothing anyway. Dropping it costs no
   * sensitivity and keeps the rare, informative keys complete, which is where every
   * real match is found.
   */
  const counts = new Map();
  for (const episode of usable) {
    for (const key of episode.fingerprint) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const index = new Map();
  usable.forEach((episode, e) => {
    for (let i = 0; i < episode.fingerprint.length; i += 1) {
      const key = episode.fingerprint[i];
      if (counts.get(key) > MAX_KEY_OCCURRENCES) continue;
      const at = index.get(key);
      if (at) at.push((e << 24) | i);
      else index.set(key, [(e << 24) | i]);
    }
  });

  const minSubs = Math.ceil((minSeconds * 1000) / SUB_MS);
  /** Per episode, the stretches already accounted for, so one advert is found once. */
  const claimed = usable.map(() => []);
  const found = [];

  for (let e = 0; e < usable.length; e += 1) {
    const a = usable[e].fingerprint;
    for (let i = 0; i + WINDOW <= a.length; i += SEED_STRIDE) {
      if (covers(claimed[e], i)) continue;

      // One partner per episode, the closest match. An index lookup can return several
      // positions in the same episode — a theme tune that plays twice, or simply
      // similar audio nearby — and taking them all would report an advert as occurring
      // three times in an episode that contains it once, which is what the "seen in N
      // episodes" threshold reads.
      const best = new Map();
      for (const packed of index.get(a[i]) ?? []) {
        const other = packed >>> 24;
        const at = packed & 0xffffff;
        if (other === e) continue;
        if (at + WINDOW > usable[other].fingerprint.length) continue;
        const error = bitErrorRate(a, usable[other].fingerprint, i, at, WINDOW);
        if (error > MATCH_BER) continue;
        const held = best.get(other);
        if (!held || error < held.error) best.set(other, { episode: other, offset: at - i, error });
      }
      const partners = [...best.values()];
      if (!partners.length) continue;

      /** Whether every partner still agrees about the window starting at `from`. */
      const allAgree = (from, width = WINDOW) =>
        partners.every((p) => {
          const theirs = from + p.offset;
          const other = usable[p.episode].fingerprint;
          if (theirs < 0 || theirs + width > other.length) return false;
          return bitErrorRate(a, other, from, theirs, width) <= MATCH_BER;
        });

      /*
       * Look for the same audio in every episode that is not yet a partner — before
       * growing the match, not after.
       *
       * A seed fires only where a sub-fingerprint survived re-encoding exactly, which
       * for any given pair happens a few per cent of the time. So the first seed to hit
       * finds whichever episodes' copies are closest, and if the match is then grown
       * against only those, it grows to the audio *they* share. Four real episodes that
       * all open with the same theme were reported as two sharing seventeen seconds,
       * because two of them share a longer opening and the region ran past what the
       * other two have.
       *
       * Recruiting first makes the boundary the audio they *all* share, which is what
       * "seen in four episodes" has to mean if the threshold that gates unattended
       * cutting is to mean anything. The longer stretch two of them share is still
       * found — as its own segment, by a later seed beyond this one's claim.
       */
      const already = new Set(partners.map((p) => p.episode));
      already.add(e);
      for (let other = 0; other < usable.length; other += 1) {
        if (already.has(other)) continue;
        /*
         * Votes are gathered over a much wider stretch than the match is checked on.
         *
         * A seed fires a few per cent of the time, so a window's worth of them yields
         * one or two votes for the true offset — too few to outrank the coincidences.
         * Reading four windows' worth gives enough evidence to rank it first, while the
         * check stays on the seed window, which is the only part known to be shared.
         */
        const offset = alignmentOf(
          a,
          usable[other].fingerprint,
          {
            voteFrom: i,
            voteTo: Math.min(a.length, i + VOTE_SPAN),
            checkFrom: i,
            checkTo: i + WINDOW,
          },
          index,
          other,
        );
        if (offset !== null) partners.push({ episode: other, offset, error: MATCH_BER });
      }

      // Grown against *every* partner at once, not each on its own: a segment is the
      // audio they share, and letting one partner drag a boundary would include audio
      // the others do not have — which is how a cut takes a piece of the programme.
      //
      // In steps rather than one sub-fingerprint at a time. A sixty-second advert is
      // five thousand of them, and a full window comparison at each would be most of
      // the work in this file for a boundary already accurate to a fifth of a second.
      let start = i;
      let end = i + WINDOW;
      while (start - EXTEND_STEP >= 0 && allAgree(start - EXTEND_STEP)) start -= EXTEND_STEP;
      while (end + EXTEND_STEP <= a.length && allAgree(end + EXTEND_STEP - WINDOW)) end += EXTEND_STEP;

      /*
       * Then find the edges properly, with a short window pressed against each one.
       *
       * The pass above decides using a window a second and a half long, which keeps
       * agreeing while most of it is still inside the segment — so the boundary lands
       * up to a second past where the audio actually ends. Measured before this: a
       * forty-second sponsor read reported as 41.24 seconds. That difference is
       * programme, and cutting it is the thing an owner would notice.
       *
       * A quarter-second window is noisier per comparison and that is fine: it is a
       * thousand bits deciding between 0.08 and 0.43, which is not a close call.
       */
      while (end - EDGE_WINDOW > start && !allAgree(end - EDGE_WINDOW, EDGE_WINDOW)) end -= 1;
      while (start + EDGE_WINDOW < end && !allAgree(start, EDGE_WINDOW)) start += 1;

      /*
       * Then push both edges back out by a known amount.
       *
       * What the pass above finds is where the *comparison* still agrees, and a
       * comparison agrees only while it is entirely inside the shared audio. Each
       * sub-fingerprint already describes a 372ms analysis window, and the edge test
       * reads 32 of them, so the region it reports is the real one shrunk by roughly
       * half that span at each end. Measured against a segment placed at a known
       * position: 20.39s–49.47s for audio that truly ran 20.00–50.00.
       *
       * Left uncorrected the cut would leave four-tenths of a second of advert at each
       * end, which is a word of it. The correction is deliberately a shade generous,
       * because the two mistakes are not equal: a fraction of a second of programme
       * lost at the edge of an advert goes unnoticed, and a fraction of a second of
       * advert left behind is the thing somebody wrote in to complain about.
       */
      start = Math.max(0, start - EDGE_MARGIN);
      end = Math.min(a.length, end + EDGE_MARGIN);

      const length = end - start;
      if (length < minSubs) continue;
      if (partners.length + 1 < minEpisodes) continue;

      claimed[e].push({ start, end });
      // Clamped to each episode's own bounds: shared audio can begin before a shorter
      // episode does, and a cut range running off the front of a file is not a cut.
      const occurrences = [
        { episodeId: usable[e].id, start, end },
        ...partners.map((p) => {
          const length_ = usable[p.episode].fingerprint.length;
          return {
            episodeId: usable[p.episode].id,
            start: Math.max(0, start + p.offset),
            end: Math.min(length_, end + p.offset),
          };
        }),
      ];
      for (const p of partners) {
        claimed[p.episode].push({ start: Math.max(0, start + p.offset), end: end + p.offset });
      }

      found.push({
        signature: signatureOf(a, start, length),
        durationMs: Math.round(length * SUB_MS),
        episodeCount: new Set(occurrences.map((o) => o.episodeId)).size,
        occurrenceCount: occurrences.length,
        occurrences: occurrences.map((o) => ({
          episodeId: o.episodeId,
          startMs: Math.round(o.start * SUB_MS),
          endMs: Math.round(o.end * SUB_MS),
        })),
      });
    }
  }

  return found
    .filter((segment) => segment.episodeCount >= minEpisodes)
    .sort((x, y) => y.durationMs - x.durationMs);
}

/**
 * Where a known stretch of one episode occurs in another, or null.
 *
 * Votes rather than trusts: every seed across the region that finds an exact key in
 * the other episode votes for the offset it implies, and the offset with the most
 * votes is the one tested. A single coincidental collision cannot outvote a real
 * alignment, and a real alignment does not need every seed to fire — which is the
 * whole difficulty, since most of them do not.
 */
function alignmentOf(a, b, { voteFrom, voteTo, checkFrom, checkTo }, index, episode) {
  const votes = new Map();
  for (let i = voteFrom; i < voteTo; i += SEED_STRIDE) {
    for (const packed of index.get(a[i]) ?? []) {
      if (packed >>> 24 !== episode) continue;
      const offset = (packed & 0xffffff) - i;
      votes.set(offset, (votes.get(offset) ?? 0) + 1);
    }
  }
  if (!votes.size) return null;

  const ranked = [...votes.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
  for (const [offset] of ranked) {
    /*
     * Checked at three points across the region rather than one, so a segment that
     * agrees at its start and drifts apart later is not accepted whole.
     *
     * Points that fall outside the other episode are skipped rather than fatal, and
     * that is not a nicety. A theme tune at the very start of one episode sits a
     * fraction of a second earlier in another whose cold open is shorter — so the
     * shared audio runs off the front of it. Requiring the whole region to fit
     * rejected exactly the case this detector exists for: four real episodes sharing
     * an opening were reported as two, because two of them began a quarter of a
     * second sooner.
     */
    /*
     * Checked across the part of the region that both episodes actually have.
     *
     * Sampling fixed points and discarding the ones that fall outside sounds
     * equivalent and is not. A theme tune at the very start of one episode begins a
     * fraction of a second before a shorter episode does, so every point taken from
     * the front of the region lands before the other file starts — leaving nothing to
     * check and the match rejected, which is exactly the case this detector exists for.
     * The overlap is computed first, and the points are taken from inside it.
     */
    const from = Math.max(checkFrom, -offset, 0);
    const to = Math.min(checkTo, a.length, b.length - offset);
    if (to - from < WINDOW) continue;
    /*
     * Two windows from the start of the overlap, not points spread across a region
     * whose extent is still unknown.
     *
     * All that is known here is that the seed matched. How far the shared audio runs
     * is what the extension pass works out afterwards, against every partner at once —
     * so demanding agreement across a guessed extent rejects a partner for not having
     * audio nobody has yet claimed it has. Two windows is about two and a half seconds;
     * unrelated audio does not agree to within a quarter of its bits for that long.
     */
    const points = [from, from + WINDOW].filter((at) => at + WINDOW <= to);
    if (!points.length) continue;
    if (points.every((at) => bitErrorRate(a, b, at, at + offset, WINDOW) <= MATCH_BER)) return offset;
  }
  return null;
}

function covers(ranges, at) {
  return ranges.some((range) => at >= range.start && at < range.end);
}

/**
 * A stable name for a stretch of audio.
 *
 * Taken from the middle of the match rather than its edges, because the edges are where
 * two copies disagree — a fade differs, a join lands a frame out — and a name that
 * moved with the boundary would offer the same advert twice.
 */
function signatureOf(fingerprint, start, length) {
  const from = start + Math.floor(length / 3);
  let hash = 0x811c9dc5;
  for (let i = 0; i < 48 && from + i < fingerprint.length; i += 1) {
    // Only the high bits, which are the low frequencies: the ones a re-encode keeps.
    hash = Math.imul(hash ^ ((fingerprint[from + i] >>> 20) & 0xfff), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
