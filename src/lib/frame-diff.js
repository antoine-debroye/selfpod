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
 * A ceiling on the diff's search depth.
 *
 * The algorithm below is O(N·D) where D is the number of differing frames. For two
 * copies of one episode D is small — the adverts — and it is fast. For two *different*
 * episodes D approaches N and the work approaches N², which for 137,000 frames is not
 * something to discover in production. Past this, give up and say so: "these two files
 * are not the same episode" is a true and useful answer.
 */
const MAX_EDIT_DISTANCE = 4000;

/**
 * Myers' diff, returning the common subsequence as matched index pairs.
 *
 * Returns null when the two sequences differ by more than the cap, which the caller
 * must treat as "not comparable" rather than as "everything differs".
 */
function commonSubsequence(a, b) {
  const n = a.length;
  const m = b.length;
  const max = Math.min(MAX_EDIT_DISTANCE, n + m);
  // v[k] is the furthest x reached on diagonal k. Offset so k can be negative.
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return null;
}

/** Walks the recorded states backwards to recover which indices matched. */
function backtrack(trace, a, b, d, offset) {
  const matches = [];
  let x = a.length;
  let y = b.length;

  for (let step = d; step > 0; step -= 1) {
    const v = trace[step];
    const k = x - y;
    const previousK =
      k === -step || (k !== step && v[k - 1 + offset] < v[k + 1 + offset]) ? k + 1 : k - 1;
    const previousX = v[previousK + offset];
    const previousY = previousX - previousK;

    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    matches.push([x, y]);
  }
  matches.reverse();
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
  if (!matches) {
    return { comparable: false, identical: false, onlyInA: [], onlyInB: [], commonFrames: 0 };
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
