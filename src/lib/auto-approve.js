import { CUE_STRONG } from '../constants.js';

/**
 * Whether automatic mode may cut a segment without being asked (spec §19.5).
 *
 * Kept apart from the search that finds segments, because the two answer different
 * questions and change for different reasons. Finding repeated audio is signal
 * processing; deciding whether to remove it unasked is a judgement about what a show is
 * made of, and it is the judgement that keeps a theme tune in a listener's feed.
 *
 * Nothing here claims to know what an advert is. Every rule is a reason *not* to act
 * unattended — a shape more likely to be part of the programme than an interruption of
 * it. Everything is catalogued and offered either way; this gates only the case where
 * nobody is asked.
 */

/**
 * Whether a segment may be cut without anyone looking at it first.
 *
 * Separate from finding it, and deliberately so: everything found is offered for
 * review whatever this says. This only gates *unattended* cutting, and it exists
 * because the obvious threshold — "appears in at least three episodes" — cuts the
 * theme tune on episode three. That is not a corner case; it is the guaranteed first
 * behaviour of automatic mode on any show with a theme.
 */
/**
 * The longest a difference between two downloads may be and still be cut unasked.
 *
 * Generous — a two-and-a-half minute break exists — but finite, because the content
 * of a diff segment is chosen by whoever serves the audio.
 */
const DIFF_MAX_SECONDS = 150;

/**
 * Whether every occurrence hugs the start or the end of its episode — the shape of a
 * theme tune and of credits. Shared by the corpus and transcript branches, and in both
 * it yields to the words: "Welcome to the show, I'm X" opens every episode at 0:00, and
 * so does "This episode is brought to you by…", and only the second is an advert.
 */
function positionGuard(segment, episodeDurations) {
  const durations = episodeDurations ?? {};
  const positions = segment.occurrences.map((occurrence) => {
    const total = durations[occurrence.episodeId];
    if (!total) return null;
    return { fromStartMs: occurrence.startMs ?? null, fromEndMs: total - (occurrence.endMs ?? 0) };
  });
  const known = positions.filter(Boolean);
  if (known.length && known.every((position) => position.fromStartMs !== null && position.fromStartMs < 5000)) {
    return 'always_at_the_start';
  }
  if (known.length && known.every((position) => position.fromEndMs < 15000)) {
    return 'always_at_the_end';
  }
  return null;
}

export function safeToApproveAutomatically(
  segment,
  { episodeDurations, minEpisodes = 3, source = 'corpus' } = {},
) {
  /*
   * A segment found by diffing two downloads of one episode is safe by construction:
   * a theme tune is in both copies, so it can never be what differs between them. The
   * position guards below are therefore not applied to it — an advert stitched at the
   * very start is still an advert, and refusing it because a theme tune also lives
   * there would give up the one signal that can tell them apart.
   *
   * The *length* guard still applies, and for a reason the position guards do not
   * share: what differs between two downloads is decided by whoever serves them. Ten
   * minutes of difference is not an advert — it is the publisher having replaced the
   * programme, or a comparison that has gone wrong — and cutting it unattended would
   * take ten minutes of audio out of an episode nobody looked at. The Myers diff's
   * own edit-distance bound happens to cap this near a hundred seconds today, which is
   * exactly why the rule is written down here instead: that bound is a performance
   * limit and will be tuned by someone who is not thinking about this.
   */
  if (source === 'diff') {
    const diffSeconds = segment.durationMs ? segment.durationMs / 1000 : null;
    if (diffSeconds !== null && diffSeconds > DIFF_MAX_SECONDS) {
      return { safe: false, reason: 'too_long_to_be_an_advert' };
    }
    return { safe: true, reason: null };
  }

  /*
   * Found by the words. Repetition is still the evidence — a stretch heard once is
   * offered and never cut, whatever it says — but the wording is the tie-breaker the
   * acoustic branch never had: two readings of the same sponsor script on two days is
   * the campaign the owner described, and sponsor wording at the very start of an
   * episode is a pre-roll, not a theme tune.
   */
  if (source === 'transcript') {
    const seconds = segment.durationMs ? segment.durationMs / 1000 : null;
    if (seconds !== null && seconds < 6) return { safe: false, reason: 'too_short_to_be_an_advert' };
    if (seconds !== null && seconds > 150) return { safe: false, reason: 'too_long_to_be_an_advert' };
    if (segment.episodeCount < 2) return { safe: false, reason: 'only_heard_once' };
    const strong = (segment.cueScore ?? 0) >= CUE_STRONG;
    if (segment.episodeCount < minEpisodes && !strong) return { safe: false, reason: 'seen_too_few_times' };
    if (!strong) {
      const position = positionGuard(segment, episodeDurations);
      if (position) return { safe: false, reason: position };
    }
    return { safe: true, reason: null };
  }

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

  // The intro/outro signature — unless the words attached to this audio say sponsor,
  // which is how a pre-roll first found by ear and held here is let go once it has
  // been heard.
  if ((segment.cueScore ?? 0) < CUE_STRONG) {
    const position = positionGuard(segment, episodeDurations);
    if (position) return { safe: false, reason: position };
  }

  return { safe: true, reason: null };
}

