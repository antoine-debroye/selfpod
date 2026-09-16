import { HOP, bitErrorRate } from './acoustic-fingerprint.js';
import { TARGET_RATE } from './decode-audio.js';
import { findRepeatedAudio } from './repeated-audio.js';

/**
 * Cutting a pre-roll by the sound of the jingle that follows it (spec §19.6).
 *
 * A boundary the owner teaches today is matched in a whisper transcript, and a
 * recognizer writes the same station ident differently on different days — "Vous
 * pouvez vous écouter RMC" one day, "Vous pouvez vous écouter..." the next, cut off
 * mid-word. Measured on a real show's four episodes: the same four-second ident
 * scored 0.000–0.071 bit-error against itself and never below 0.438 against anything
 * else in the same episode — a chasm next to the words' one-in-four token budget for
 * error. So where a jingle exists, the sound decides; the words stay a fallback for
 * an episode nothing here can fingerprint.
 *
 * Built entirely on `repeated-audio.js` — no new matching algorithm. What is new is
 * *where* it is asked to look (the opening of every episode, not the whole file) and
 * *how small a repeat it is allowed to report* (two seconds, not five) — because the
 * ident this exists for was measured to share only 2.8–3.2 seconds of `bitErrorRate
 * &lt;= MATCH_BER` before an advert or the show's own cold open diverges, and the
 * whole-episode search's five-second floor drops that silently.
 */

/** One sub-fingerprint's span: 64 samples at the 5512 Hz every fingerprint is taken at. */
export const SUB_MS = (HOP / TARGET_RATE) * 1000;

/**
 * How wrong a match to a stored clip may be.
 *
 * The same value `repeated-audio.js` uses for the same reason, chosen independently
 * here from a clip's own numbers rather than imported, because the two searches read
 * different things: that one matches whole seeded windows across a corpus; this
 * matches one fixed clip against one episode at a time. Measured: 0.000–0.071 for the
 * genuine match, never below 0.438 anywhere else in the same episode.
 */
export const ANCHOR_MATCH_BER = 0.25;

/**
 * A pre-roll shorter than this is a lead-in, not an advert — the same threshold the
 * taught-boundary marker already uses (`MIN_MARKER_CUT_MS` in `ad-detect.js`), kept
 * as its own constant here because the two are read by different code and a shared
 * import would suggest a dependency between them that does not exist.
 */
export const MIN_ANCHOR_CUT_MS = 2000;

/** How far into every episode a jingle is looked for, when proposing one. */
export const DEFAULT_PROPOSAL_HEAD_MS = 120_000;

/**
 * The shortest repeat worth proposing as a jingle.
 *
 * `repeated-audio.js`'s own default is five seconds, chosen for the acoustic corpus
 * search generally — a sting or a join is not worth offering. A station ident can be
 * shorter than that: the one this file exists for shares 2.8–3.2 seconds of matching
 * audio across four real episodes, measured, and a five-second floor would drop it
 * silently while every other rule here still worked.
 */
export const MIN_PROPOSAL_SECONDS = 2;

/**
 * How far a clip is inset from the edges `repeated-audio.js` reports for a candidate
 * region, on each side.
 *
 * The reported edges are already corrected for the width of the comparison window
 * (`EDGE_MARGIN`, in `repeated-audio.js`), and that correction is itself an estimate —
 * "roughly half a window's span," in that file's own words. Measured against the real
 * ident: taking the clip from the raw reported region gave a match of 0.12–0.17
 * against a floor of 0.44–0.46 elsewhere — already safe, but not as safe as it can be
 * for nothing. Insetting 400 ms from each edge before taking the clip tightened that
 * to 0.000–0.071 against the same floor, which is the number a search run once and
 * relied on for as long as the show exists should have.
 */
export const CLIP_GUARD_MS = 400;

/** The longest a stored clip is kept. Long enough to be unmistakable, no longer. */
export const MAX_CLIP_MS = 3000;

/** The shortest a clip may end up after insetting. Below this there is nothing left to match on. */
export const MIN_CLIP_MS = 1200;

/** How far into an episode a stored clip is searched for, once one exists. */
export const DEFAULT_SEARCH_MS = 300_000;

/**
 * Audio common to the opening of every episode passed in, at a varying offset.
 *
 * A thin wrapper over `findRepeatedAudio`, restricted to the opening minutes and with
 * a lower floor on how short a repeat counts (see `MIN_PROPOSAL_SECONDS`). Two rules
 * beyond what that function already does, both measured against a real show that
 * carries a changing pre-roll advert in front of a fixed station ident:
 *
 *  1. **Present in every episode searched.** A pre-roll shared by only some of them —
 *     the same advert running two days running — is not the boundary; it drops out
 *     of `findRepeatedAudio`'s own result the moment `episodeCount` falls short, and
 *     this insists on the strict case: every episode, not merely `minEpisodes`.
 *  2. **Not at the very start of every episode.** Audio that opens every episode at
 *     0:00 is a theme tune, and the position guard in `auto-approve.js` already
 *     refuses to auto-approve one for the same reason. A jingle behind a pre-roll
 *     sits somewhere past 0:00 in at least one episode; a jingle with no pre-roll in
 *     front of it that day sits at 0:00 in that one and nowhere else has to.
 *  3. **The offset actually varies.** Audio that sits at the *same* position in every
 *     episode, whatever that position is, is a fixed part of the show's edit — a
 *     sting between the cold open and the theme, say — not a boundary behind
 *     something that changes day to day. A jingle behind a pre-roll of varying
 *     length cannot help but land at a different offset in each episode; if it does
 *     not, this is not that.
 *
 * All three rules are conservative in the same direction: a show whose last dozen
 * episodes all happen to share one pre-roll, all happen to have no pre-roll at all, or
 * all happen to carry a fixed mid-show element that also repeats, gets no proposal
 * rather than a wrong one. The owner can still point at the jingle by hand.
 *
 * Results are ranked by how much the offset varies — the varying offset is the
 * evidence that this is a boundary sitting behind something that changes, not a
 * fixed part of the show — then by the shortest duration, since a shorter repeat is a
 * cleaner clip.
 *
 * @param {Array<{id: string, fingerprint: Uint32Array}>} episodes
 * @returns {Array<{signature: string, durationMs: number, episodeCount: number,
 *   occurrenceCount: number, occurrences: Array<{episodeId: string, startMs: number, endMs: number}>,
 *   spreadMs: number}>}
 */
export function findHeadAnchors(episodes, { headMs = DEFAULT_PROPOSAL_HEAD_MS, minSeconds = MIN_PROPOSAL_SECONDS } = {}) {
  const headSubs = Math.round(headMs / SUB_MS);
  const sliced = episodes
    .filter((episode) => episode.fingerprint?.length)
    .map((episode) => ({
      id: episode.id,
      fingerprint: episode.fingerprint.subarray(0, Math.min(headSubs, episode.fingerprint.length)),
    }));
  if (sliced.length < 2) return [];

  // Every episode, not merely a threshold — see rule 1 above. findRepeatedAudio's own
  // occurrenceCount never exceeds episodeCount (one occurrence is recruited per
  // episode at most), so the `=== sliced.length` filter below is the strict form of
  // this, kept explicit rather than trusted to the library's current behaviour.
  const found = findRepeatedAudio(sliced, { minEpisodes: sliced.length, minSeconds });

  return found
    .filter((segment) => segment.episodeCount === sliced.length)
    .map((segment) => {
      const starts = segment.occurrences.map((occurrence) => occurrence.startMs);
      return { ...segment, spreadMs: Math.max(...starts) - Math.min(...starts), maxStartMs: Math.max(...starts) };
    })
    // Rule 2: not at 0:00 in every episode. Rule 3: the offset actually moves.
    .filter((segment) => segment.maxStartMs >= MIN_ANCHOR_CUT_MS && segment.spreadMs > 0)
    .sort((a, b) => b.spreadMs - a.spreadMs || a.durationMs - b.durationMs);
}

/**
 * The clip to remember from a candidate region, and how far its own start sits after
 * the region's true left edge.
 *
 * The exemplar is the candidate's *longest* occurrence, not its earliest-starting
 * one. An occurrence whose region sits right at an episode's own edge — offset 0,
 * typically, the shape of a jingle with no pre-roll in front of it that day — is the
 * one `findRepeatedAudio` clamps against that edge (its own `EDGE_MARGIN` correction
 * would otherwise go negative), which shortens exactly that occurrence and no other.
 * Picking the earliest start therefore reliably picks the *shortest* material to
 * build a clip from — measured on a real pair of fixtures, 1.8s against an unclamped
 * 2.2s elsewhere in the same candidate — which is the opposite of what a clean clip
 * needs. The longest occurrence is never the one an edge has cut short.
 * The clip itself is inset by `CLIP_GUARD_MS`
 * from both of the region's reported edges and capped at `MAX_CLIP_MS`; `leadMs` is
 * computed from where the inset landed rather than assumed to equal the guard, so a
 * region too short to take the full guard from is still handled correctly rather
 * than silently mis-measured.
 *
 * `leadMs` only ever needs to be known once, at the moment the clip is taken — never
 * recomputed against a *different* episode later. The candidate region's own left
 * edge is already the boundary `findRepeatedAudio` grew against *every* partner at
 * once (see that file's `allAgree`), so it cannot have been dragged backwards into
 * audio only some of the partners share — a pre-roll two episodes happen to have in
 * common cannot masquerade as part of the ident, because the episodes with no
 * pre-roll in the same candidate set do not agree with it there. There is nothing to
 * solve for after that: `leadMs` is arithmetic on the inset, not a second search.
 *
 * Returns null when there is nothing to take a clip from — no fingerprint for the
 * exemplar, or a region too short to survive the inset — so the caller can decline
 * the whole candidate rather than store a clip too thin to mean anything.
 *
 * @param {{occurrences: Array<{episodeId: string, startMs: number, endMs: number}>}} candidate
 * @param {Map<string, {hashes: Uint32Array}>} fingerprintsById
 */
export function anchorClipFrom(
  candidate,
  fingerprintsById,
  { guardMs = CLIP_GUARD_MS, maxClipMs = MAX_CLIP_MS, minClipMs = MIN_CLIP_MS } = {},
) {
  const exemplar = candidate.occurrences.reduce((best, occurrence) =>
    occurrence.endMs - occurrence.startMs > best.endMs - best.startMs ? occurrence : best,
  );
  const fingerprint = fingerprintsById.get(exemplar.episodeId);
  if (!fingerprint?.hashes?.length) return null;

  const guardSubs = Math.round(guardMs / SUB_MS);
  const regionStartSub = Math.round(exemplar.startMs / SUB_MS);
  const regionEndSub = Math.round(exemplar.endMs / SUB_MS);

  let from = regionStartSub + guardSubs;
  let to = regionEndSub - guardSubs;
  const maxClipSubs = Math.round(maxClipMs / SUB_MS);
  if (to - from > maxClipSubs) to = from + maxClipSubs;
  if (to - from <= 0 || (to - from) * SUB_MS < minClipMs) return null;

  return {
    hashes: fingerprint.hashes.slice(from, to),
    leadMs: Math.round((from - regionStartSub) * SUB_MS),
    // The whole matched region, not just the clip taken from inside it — almost
    // always longer, since the clip is inset from both of this region's edges.
    matchSpanMs: Math.round((regionEndSub - regionStartSub) * SUB_MS),
    exemplarEpisodeId: exemplar.episodeId,
    exemplarStartMs: Math.round(from * SUB_MS),
    exemplarEndMs: Math.round(to * SUB_MS),
  };
}

/**
 * Where a stored clip occurs in one episode's fingerprint, or null.
 *
 * Exhaustive over the search window rather than seeded, unlike `findRepeatedAudio`:
 * there is exactly one clip and one episode to compare, so there is no corpus to
 * index and no seed to miss. Cost is the search window times the clip length in
 * popcounts — a few million for a five-minute window and a three-second clip, a few
 * milliseconds on a desktop — once per episode per pass, on the chain that already
 * spends minutes an episode on whisper.
 *
 * Returns the **first** position under `maxBer`, refined forward to its local
 * minimum, not the best position in the whole search window. A genuine match is a
 * plateau a few dozen milliseconds wide — the width of the analysis window the clip
 * was built from — and everything outside it measured at least 0.438 in every real
 * episode checked; a jingle played again later in the same episode must never be
 * allowed to win over the first, earlier one, which is the one a pre-roll sits in
 * front of.
 *
 * @param {Uint32Array} clip
 * @param {Uint32Array} hashes the episode's own fingerprint
 * @returns {{atMs: number, ber: number} | null}
 */
export function locateAnchor(clip, hashes, { searchMs = DEFAULT_SEARCH_MS, maxBer = ANCHOR_MATCH_BER } = {}) {
  if (!clip?.length || !hashes?.length) return null;
  const searchSubs = Math.min(hashes.length - clip.length, Math.round(searchMs / SUB_MS));
  if (searchSubs < 0) return null;

  let bestAt = -1;
  let bestBer = 1;
  for (let i = 0; i <= searchSubs; i += 1) {
    const ber = bitErrorRate(clip, hashes, 0, i, clip.length);
    if (bestAt < 0) {
      if (ber <= maxBer) {
        bestAt = i;
        bestBer = ber;
      }
      continue;
    }
    if (ber <= bestBer) {
      bestBer = ber;
      bestAt = i;
      continue;
    }
    break;
  }
  if (bestAt < 0) return null;
  return { atMs: Math.round(bestAt * SUB_MS), ber: bestBer };
}
