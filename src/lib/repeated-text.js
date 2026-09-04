import { createHash } from 'node:crypto';

/**
 * Finding the words a show repeats, and finding known words again (spec §19.6).
 *
 * The text counterpart of repeated-audio.js, and shaped like it on purpose: seed on an
 * exact match of a few tokens, grow outwards while the two sides keep agreeing, recruit
 * every other episode before fixing the edges. The difference is what "agree" means. A
 * recogniser mishears a word here and there, and a host reading a sponsor script drops
 * or adds one, so the growth tolerates a substitution, an insertion or a deletion as
 * long as the next two tokens line up again — and gives up when three of those land
 * within a dozen tokens, which is the sound of two different sentences that happen to
 * share a phrase.
 *
 * Everything works on normalised tokens (text-normalise.js) that still carry the
 * timing of the word they came from, so a match found in words becomes a span in
 * milliseconds without a second lookup.
 */

/** Tokens in a seed. Four words in the same order is rare by chance in a few hours of talk. */
const SHINGLE = 4;

/**
 * A seed that occurs more often than this across the corpus is not a lead, it is the
 * language: "et puis il y a", "and then you know". The same idea as the key cap in the
 * acoustic search, which drops room tone for the same reason.
 */
export const MAX_KEY_OCCURRENCES = 64;

/** The shortest run worth calling a repeat. */
export const MIN_TOKENS = 10;
/** Errors allowed per token over the whole run. */
export const MAX_ERROR = 0.15;
/**
 * Errors in the trailing window that stop growth. A backstop against growing through
 * unrelated talk on chance resynchronisations; the real judge of a match is the error
 * rate over its whole length, so this is set loose enough that a cluster of
 * mishearings inside one genuine read — which is how recognisers fail — gets through.
 */
const MAX_RECENT_ERRORS = 5;
const RECENT_WINDOW = 16;

/** In milliseconds: shorter is a stinger or a catchphrase; longer is a shared programme. */
export const MIN_MS = 6000;
export const MAX_MS = 150000;

/** How alike a later transcription has to be to count as the same words. */
export const MIN_SIMILARITY = 0.75;

function inRange(tokens, i) {
  return i >= 0 && i < tokens.length;
}

function sameWindow(tokens, i, j) {
  return tokens[i].window === tokens[j].window;
}

/** Do the `count` tokens after p and q match exactly, in direction `dir`? */
function matchesAhead(a, p, b, q, dir, count) {
  for (let k = 1; k <= count; k += 1) {
    const i = p + k * dir;
    const j = q + k * dir;
    if (!inRange(a, i) || !inRange(b, j)) return false;
    if (!sameWindow(a, i, p) || !sameWindow(b, j, q)) return false;
    if (a[i].t !== b[j].t) return false;
  }
  return true;
}

/**
 * Where to pick the match up again after a disagreement at (np, nq).
 *
 * Cheapest first: a substitution, then one extra token on either side, then two.
 * Whatever is skipped, the two sides have to agree on the token they meet at *and* the
 * one after it, or it is not a resynchronisation but a coincidence. The cost is the
 * larger of the two skips: "a dos" for "ado" is one error, not three.
 */
const RESYNC_STEPS = [
  [1, 1],
  [0, 1],
  [1, 0],
  [0, 2],
  [2, 0],
  [1, 2],
  [2, 1],
  [2, 2],
];

function resync(a, np, b, nq, dir) {
  for (const [da, db] of RESYNC_STEPS) {
    const pp = np + da * dir;
    const qq = nq + db * dir;
    if (!inRange(a, pp) || !inRange(b, qq)) continue;
    if (!sameWindow(a, pp, np) || !sameWindow(b, qq, nq)) continue;
    if (a[pp].t !== b[qq].t) continue;
    if (!matchesAhead(a, pp, b, qq, dir, 1)) continue;
    return { p: pp, q: qq, cost: Math.max(da, db, 1) };
  }
  return null;
}

/**
 * Grows a match from an exact seed at (i, j) in direction `dir`.
 *
 * Returns the last positions on each side that matched exactly, and how many errors
 * were tolerated on the way. Growth stops when the two sides cannot be brought back
 * together within a couple of tokens, or when too many errors land close together.
 */
function extend(a, i, b, j, dir) {
  let p = i;
  let q = j;
  let errors = 0;
  const recent = [];

  for (;;) {
    const np = p + dir;
    const nq = q + dir;
    if (!inRange(a, np) || !inRange(b, nq)) break;
    if (!sameWindow(a, np, p) || !sameWindow(b, nq, q)) break;

    if (a[np].t === b[nq].t) {
      p = np;
      q = nq;
      recent.push(0);
    } else {
      const step = resync(a, np, b, nq, dir);
      if (!step) break;
      p = step.p;
      q = step.q;
      errors += step.cost;
      recent.push(step.cost);
    }
    while (recent.length > RECENT_WINDOW) recent.shift();
    if (recent.reduce((sum, e) => sum + e, 0) >= MAX_RECENT_ERRORS) break;
  }
  return { p, q, errors };
}

/** The full match around a seed: spans on both sides, inclusive, and the errors inside. */
function matchAround(a, i, b, j) {
  const forward = extend(a, i, b, j, 1);
  const backward = extend(a, i, b, j, -1);
  return {
    aStart: backward.p,
    aEnd: forward.p,
    bStart: backward.q,
    bEnd: forward.q,
    errors: forward.errors + backward.errors,
  };
}

function shingleKey(tokens, i) {
  let key = tokens[i].t;
  for (let k = 1; k < SHINGLE; k += 1) key += ' ' + tokens[i + k].t;
  return key;
}

function buildIndex(episodes) {
  const counts = new Map();
  for (const episode of episodes) {
    const tokens = episode.tokens;
    for (let i = 0; i + SHINGLE <= tokens.length; i += 1) {
      if (!sameWindow(tokens, i, i + SHINGLE - 1)) continue;
      const key = shingleKey(tokens, i);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const index = new Map();
  for (let e = 0; e < episodes.length; e += 1) {
    const tokens = episodes[e].tokens;
    for (let i = 0; i + SHINGLE <= tokens.length; i += 1) {
      if (!sameWindow(tokens, i, i + SHINGLE - 1)) continue;
      const key = shingleKey(tokens, i);
      if (counts.get(key) > MAX_KEY_OCCURRENCES) continue;
      let list = index.get(key);
      if (!list) index.set(key, (list = []));
      list.push({ e, i });
    }
  }
  return index;
}

function spanMs(tokens, start, end) {
  return { startMs: tokens[start].startMs, endMs: tokens[end].endMs };
}

function canonicalText(tokens, start, end) {
  const parts = [];
  for (let k = start; k <= end; k += 1) parts.push(tokens[k].t);
  return parts.join(' ');
}

export function signatureOf(text) {
  return `tx:${createHash('sha256').update(text).digest('hex').slice(0, 24)}`;
}

/**
 * Finds runs of words shared by two or more episodes.
 *
 * @param {Array<{id: string, tokens: Array<{t: string, startMs: number, endMs: number, p?: number, word?: number, window?: number}>}>} episodes
 * @param {{minTokens?: number, maxError?: number, minMs?: number, maxMs?: number, claimed?: Map<string, Array<[number, number]>>}} [options]
 *   `claimed` maps an episode id to inclusive token ranges that are already spoken for
 * @returns {Array<{signature: string, canonicalText: string, durationMs: number, episodeCount: number, occurrenceCount: number, exemplar: {episodeId: string, start: number, end: number}, occurrences: Array<{episodeId: string, start: number, end: number, startMs: number, endMs: number, similarity: number}>}>}
 */
export function findRepeatedText(
  episodes,
  { minTokens = MIN_TOKENS, maxError = MAX_ERROR, minMs = MIN_MS, maxMs = MAX_MS, claimed: initial = null } = {},
) {
  if (episodes.length < 2) return [];
  const index = buildIndex(episodes);
  // Ground already spoken for — a boundary the owner taught, a read already known —
  // is not searched again, so the same words are never offered twice under two names.
  const claimed = episodes.map((episode) => {
    const own = new Uint8Array(episode.tokens.length);
    for (const [start, end] of initial?.get(episode.id) ?? []) {
      for (let k = Math.max(0, start); k <= Math.min(end, own.length - 1); k += 1) own[k] = 1;
    }
    return own;
  });
  const found = [];

  const claim = (e, start, end) => {
    for (let k = start; k <= end; k += 1) claimed[e][k] = 1;
  };
  const isClaimed = (e, start, end) => {
    for (let k = start; k <= end; k += 1) if (claimed[e][k]) return true;
    return false;
  };

  for (let e = 0; e < episodes.length; e += 1) {
    const a = episodes[e].tokens;
    for (let i = 0; i + SHINGLE <= a.length; i += 1) {
      if (claimed[e][i]) continue;
      if (!sameWindow(a, i, i + SHINGLE - 1)) continue;
      const hits = index.get(shingleKey(a, i));
      if (!hits || hits.length < 2) continue;
      if (process.env.RT_DEBUG) console.error("seed", e, i, shingleKey(a, i), JSON.stringify(hits));
      if (process.env.RT_DEBUG) console.error("seed", e, i, shingleKey(a, i), JSON.stringify(hits));

      // One partner per other episode, and only unclaimed ground.
      const partners = new Map();
      for (const hit of hits) {
        if (hit.e === e || partners.has(hit.e)) continue;
        if (claimed[hit.e][hit.i]) continue;
        partners.set(hit.e, hit.i);
      }
      if (!partners.size) continue;

      // Grow against the first partner to learn the extent; that becomes the canonical
      // span, and every other partner is aligned to it.
      const [firstE, firstJ] = partners.entries().next().value;
      const b = episodes[firstE].tokens;
      const match = matchAround(a, i, b, firstJ);
      const length = match.aEnd - match.aStart + 1;
      if (length < minTokens) continue;
      if (match.errors / length > maxError) continue;
      const timing = spanMs(a, match.aStart, match.aEnd);
      const durationMs = timing.endMs - timing.startMs;
      if (durationMs < minMs || durationMs > maxMs) continue;
      if (isClaimed(e, match.aStart, match.aEnd)) continue;
      if (isClaimed(firstE, match.bStart, match.bEnd)) continue;

      const occurrences = [
        { episodeId: episodes[e].id, start: match.aStart, end: match.aEnd, ...timing, similarity: 1 },
        {
          episodeId: episodes[firstE].id,
          start: match.bStart,
          end: match.bEnd,
          ...spanMs(b, match.bStart, match.bEnd),
          similarity: 1 - match.errors / length,
        },
      ];

      for (const [otherE, otherJ] of partners) {
        if (otherE === firstE) continue;
        const c = episodes[otherE].tokens;
        const other = matchAround(a, i, c, otherJ);
        // Has to carry most of the canonical span, or it is a different thing that
        // shares a phrase with this one.
        const overlapStart = Math.max(other.aStart, match.aStart);
        const overlapEnd = Math.min(other.aEnd, match.aEnd);
        const covered = (overlapEnd - overlapStart + 1) / length;
        if (covered < 0.8) continue;
        if (isClaimed(otherE, other.bStart, other.bEnd)) continue;
        occurrences.push({
          episodeId: episodes[otherE].id,
          start: other.bStart,
          end: other.bEnd,
          ...spanMs(c, other.bStart, other.bEnd),
          similarity: Math.max(0, 1 - other.errors / length),
        });
      }

      for (const occurrence of occurrences) {
        const index = episodes.findIndex((episode) => episode.id === occurrence.episodeId);
        claim(index, occurrence.start, occurrence.end);
      }

      const text = canonicalText(a, match.aStart, match.aEnd);
      found.push({
        signature: signatureOf(text),
        canonicalText: text,
        durationMs,
        episodeCount: new Set(occurrences.map((occurrence) => occurrence.episodeId)).size,
        occurrenceCount: occurrences.length,
        exemplar: { episodeId: episodes[e].id, start: match.aStart, end: match.aEnd },
        occurrences,
      });
    }
  }
  return found;
}

/**
 * How alike two token sequences are, 0..1, by edit distance.
 *
 * Banded, because the two are expected to be nearly the same length and nearly the
 * same content: anything that needs more than `band` insertions is simply "different".
 */
export function tokenSimilarity(a, b, { band = 8 } = {}) {
  const as = a.map((token) => (typeof token === 'string' ? token : token.t));
  const bs = b.map((token) => (typeof token === 'string' ? token : token.t));
  const n = as.length;
  const m = bs.length;
  if (!n && !m) return 1;
  if (Math.abs(n - m) > band) return 0;
  let previous = new Array(m + 1);
  let current = new Array(m + 1);
  for (let j = 0; j <= m; j += 1) previous[j] = j;
  for (let i = 1; i <= n; i += 1) {
    current[0] = i;
    const lo = Math.max(1, i - band);
    const hi = Math.min(m, i + band);
    for (let j = 1; j < lo; j += 1) current[j] = Infinity;
    for (let j = lo; j <= hi; j += 1) {
      const cost = as[i - 1] === bs[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = hi + 1; j <= m; j += 1) current[j] = Infinity;
    [previous, current] = [current, previous];
  }
  const distance = previous[m];
  if (!Number.isFinite(distance)) return 0;
  return 1 - distance / Math.max(n, m);
}

/**
 * Finds a known phrase inside a transcript, allowing for the recogniser's errors.
 *
 * Semi-global alignment: the phrase has to be consumed whole, the transcript may start
 * and end anywhere. Returns the earliest occurrence within tolerance — the right answer
 * for a marker ("the programme starts when it first says this") and for a remembered
 * read alike — or null.
 *
 * @param {Array<{t: string, startMs: number, endMs: number}>} tokens
 * @param {string[]|Array<{t: string}>} phrase
 * @param {{minSimilarity?: number, maxErrors?: number}} [options]
 * @returns {{start: number, end: number, startMs: number, endMs: number, errors: number, similarity: number}|null}
 */
export function locatePhrase(tokens, phrase, { minSimilarity = MIN_SIMILARITY, maxErrors = null } = {}) {
  const ps = phrase.map((token) => (typeof token === 'string' ? token : token.t));
  const m = ps.length;
  const n = tokens.length;
  if (!m || !n) return null;
  // A phrase of three words or more gets at least one error, because a doubled or
  // dropped word is the recogniser's favourite mistake and "vous écoutez rmc" has
  // three words to lose. One or two words have to be exact, or "rmc" would match
  // anything.
  const allowed = maxErrors ?? Math.max(m >= 3 ? 1 : 0, Math.floor(m * (1 - minSimilarity)));

  // dp[j] = best cost of matching phrase[0..j) ending at the current text position;
  // from[j] = where that match started. Row 0 is free everywhere.
  let previous = new Array(m + 1).fill(Infinity);
  let previousFrom = new Array(m + 1).fill(0);
  previous[0] = 0;
  let best = null;

  // Column 0 (no text consumed): only the empty prefix matches.
  for (let j = 1; j <= m; j += 1) {
    previous[j] = j;
    previousFrom[j] = 0;
  }

  for (let i = 1; i <= n; i += 1) {
    const current = new Array(m + 1);
    const currentFrom = new Array(m + 1);
    current[0] = 0;
    currentFrom[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = tokens[i - 1].t === ps[j - 1] ? 0 : 1;
      const diagonal = previous[j - 1] + cost;
      const deletion = previous[j] + 1; // extra transcript token
      const insertion = current[j - 1] + 1; // phrase token missing from the transcript
      if (diagonal <= deletion && diagonal <= insertion) {
        current[j] = diagonal;
        currentFrom[j] = previousFrom[j - 1];
      } else if (deletion <= insertion) {
        current[j] = deletion;
        currentFrom[j] = previousFrom[j];
      } else {
        current[j] = insertion;
        currentFrom[j] = currentFrom[j - 1];
      }
    }
    if (current[m] <= allowed) {
      const start = currentFrom[m];
      const end = i - 1;
      const candidate = { start, end, errors: current[m] };
      // Earliest start wins; among the same start, fewer errors, then the shorter end.
      if (
        !best ||
        candidate.start < best.start ||
        (candidate.start === best.start && candidate.errors < best.errors)
      ) {
        best = candidate;
      } else if (best && candidate.start > best.start) {
        break;
      }
    }
    previous = current;
    previousFrom = currentFrom;
  }
  if (!best) return null;
  return {
    ...best,
    startMs: tokens[best.start].startMs,
    endMs: tokens[best.end].endMs,
    similarity: 1 - best.errors / m,
  };
}
