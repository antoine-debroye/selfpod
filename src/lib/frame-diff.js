/**
 * Finding what two copies of the same episode do not have in common (spec §19.2).
 *
 * When a podcast host stitches adverts in per request, two downloads of the same
 * episode share the show and differ in the adverts. Diffing the two frame sequences
 * therefore locates the adverts exactly — they are the runs present in one copy and
 * absent from the other.
 *
 * This is a plain longest-common-subsequence diff over 32-bit frame hashes, which is
 * the right tool for a reason worth stating: **the two copies are not aligned**. A
 * pre-roll of thirty seconds in one and thirty-two and a half in the other shifts
 * everything after it by an amount that is not a whole number of anything. Any
 * comparison that assumes position — walking both sequences in step, or hashing a
 * fixed grid of decoded audio — matches nothing past the first difference and reports
 * that the entire rest of the episode differs. Acted on, that cuts the episode.
 *
 * Sequence diffing has no such assumption. It is also what `diff` has done since 1976,
 * which is a good sign that the problem is the one being solved rather than a new one.
 *
 * ## What this is not
 *
 * It is not a detector on its own. It says "these runs differ", and a run differing
 * has exactly one honest interpretation — *something* here is not the same between two
 * fetches. That is very strong evidence of dynamic insertion and no evidence at all
 * about what a listener would call an advert. The catalogue and the user decide that.
 */

/**
 * Runs shorter than this are noise, not adverts.
 *
 * Two encodes of the same audio can differ in a frame here and there — a stitcher that
 * re-writes a tag, an encoder that pads differently. The shortest thing anybody would
 * call an advert is several seconds; a handful of frames is 100 ms.
 */
const MIN_RUN_FRAMES = 40;

/**
 * How many identical frames in a row are enough to call two positions the same audio.
 *
 * Each frame hash is 32 bits over the frame's own payload, so even a handful of
 * consecutive matches is already conclusive — thirty-two is far past the point where a
 * coincidence is conceivable, and short enough to anchor on the last snatch of
 * programme between two adverts.
 */
const ANCHOR_FRAMES = 32;

/**
 * How many places a repeated frame is tried before moving on.
 *
 * A near-silent or tonal frame can occur thousands of times in an episode. Trying
 * every occurrence as a starting point is the difference between linear and quadratic.
 */
const MAX_SEED_OCCURRENCES = 8;

/**
 * How much of the shorter file has to be shared before the two are the same episode.
 *
 * Below this they are not two stitches of one programme — the publisher has replaced
 * the audio, or the wrong file came back — and the honest answer is "these are not
 * comparable" rather than a cut list that removes most of an episode.
 */
const MIN_COMMON_FRACTION = 0.5;

/**
 * Matched index pairs between two frame-hash sequences.
 *
 * This is not Myers' diff, and the reason is worth writing down because Myers is the
 * obvious choice and was the first thing here. Myers costs O(N·D) time and, as written
 * with a trace, O(D²) space, where D is the number of differing frames — so it needs a
 * ceiling on D, and that ceiling turns into a ceiling on how many adverts an episode
 * may contain. At four thousand it was about fifty-two seconds of advert per copy.
 * Thirty seconds pre-roll, a minute mid-roll and thirty seconds post-roll is an
 * entirely ordinary load and exceeds it — so the one signal SelfPod has that can tell
 * an advert from a theme tune was switched off for most ad-supported shows, and the
 * failure was reported to the owner as "the publisher replaced the audio".
 *
 * Anchoring instead has no such ceiling. Two copies of one episode share long stretches
 * of byte-identical programme; find those, and what lies between them is the adverts.
 * It is linear in space and, with the seed cap below, effectively linear in time.
 */
function commonSubsequence(a, b) {
  // Where each frame hash occurs in the second copy.
  const positions = new Map();
  for (let i = 0; i < b.length; i += 1) {
    const at = positions.get(b[i]);
    if (at) {
      if (at.length < MAX_SEED_OCCURRENCES) at.push(i);
    } else {
      positions.set(b[i], [i]);
    }
  }

  const matches = [];
  let ai = 0;
  let bi = 0;

  while (ai < a.length) {
    const candidates = positions.get(a[ai]);
    let bestStart = -1;
    let bestLength = 0;

    if (candidates) {
      for (const candidate of candidates) {
        // Anchors have to advance through both copies, or the "common" audio would be
        // allowed to appear in a different order in each.
        if (candidate < bi) continue;
        let length = 0;
        while (
          ai + length < a.length &&
          candidate + length < b.length &&
          a[ai + length] === b[candidate + length]
        ) {
          length += 1;
        }
        if (length > bestLength) {
          bestLength = length;
          bestStart = candidate;
        }
      }
    }

    if (bestLength >= ANCHOR_FRAMES) {
      for (let k = 0; k < bestLength; k += 1) matches.push([ai + k, bestStart + k]);
      ai += bestLength;
      bi = bestStart + bestLength;
      continue;
    }
    ai += 1;
  }

  return matches;
}

/**
 * Compares two frame-hash sequences and reports the runs unique to each.
 *
 * @returns {{
 *   comparable: boolean,
 *   identical: boolean,
 *   onlyInA: Array<{start: number, end: number, frames: number}>,
 *   onlyInB: Array<{start: number, end: number, frames: number}>,
 *   commonFrames: number,
 * }}
 *   `start` is inclusive and `end` exclusive, in frame indices into that copy.
 */
export function diffFrames(a, b, { minRunFrames = MIN_RUN_FRAMES } = {}) {
  if (!a?.length || !b?.length) {
    return { comparable: false, identical: false, onlyInA: [], onlyInB: [], commonFrames: 0 };
  }
  if (a.length === b.length && a.every((hash, index) => hash === b[index])) {
    // The common case by far, and worth answering without any work: two fetches of a
    // show that bakes its adverts in are byte-for-byte the same file.
    return { comparable: true, identical: true, onlyInA: [], onlyInB: [], commonFrames: a.length };
  }

  const matches = commonSubsequence(a, b);
  // Two files that share almost nothing are not two stitches of one episode. Reporting
  // the difference would produce a cut list covering most of the programme.
  if (matches.length < Math.min(a.length, b.length) * MIN_COMMON_FRACTION) {
    return { comparable: false, identical: false, onlyInA: [], onlyInB: [], commonFrames: matches.length };
  }

  const onlyInA = gapsBetween(matches.map((pair) => pair[0]), a.length, minRunFrames);
  const onlyInB = gapsBetween(matches.map((pair) => pair[1]), b.length, minRunFrames);

  return { comparable: true, identical: false, onlyInA, onlyInB, commonFrames: matches.length };
}

/** The runs of indices not present in a sorted list of matched indices. */
function gapsBetween(matched, total, minRunFrames) {
  const gaps = [];
  let expected = 0;
  for (const index of matched) {
    if (index > expected) gaps.push({ start: expected, end: index });
    expected = index + 1;
  }
  if (expected < total) gaps.push({ start: expected, end: total });

  return gaps
    .map((gap) => ({ ...gap, frames: gap.end - gap.start }))
    .filter((gap) => gap.frames >= minRunFrames);
}

/**
 * Turns frame-index runs into millisecond ranges.
 *
 * Kept separate from the diff so the diff stays a pure sequence operation with no
 * opinion about time — and so the same runs can be reported in whichever unit the
 * caller needs.
 */
export function runsToRanges(runs, frames) {
  const starts = new Float64Array(frames.length + 1);
  for (let i = 0; i < frames.length; i += 1) {
    starts[i + 1] = starts[i] + (frames[i].samplesPerFrame / frames[i].sampleRate) * 1000;
  }
  return runs.map((run) => ({
    // Frames first, because frames are what a cut is made of. The milliseconds are
    // for showing a person; rounding one to the other and back would move a cut by
    // most of a frame, and a caller that only had the milliseconds would have to
    // convert them back — which is how a range ends up a frame away from the audio it
    // was measured against.
    startFrame: Math.min(run.start, frames.length),
    endFrame: Math.min(run.end, frames.length),
    startMs: Math.round(starts[Math.min(run.start, frames.length)]),
    endMs: Math.round(starts[Math.min(run.end, frames.length)]),
    frames: run.frames,
    durationMs: Math.round(
      starts[Math.min(run.end, frames.length)] - starts[Math.min(run.start, frames.length)],
    ),
  }));
}
