import { AD_TRIM_MODES, PUBLISH_HOLDS, TRIM_STATUS } from '../constants.js';

/**
 * Whether an episode is ready to go out yet (spec §19.7).
 *
 * A pure function with every input named, because this is the rule most likely to be
 * argued about later and the arguments are easier to have against something you can
 * read in one screen.
 *
 * ## Why hold at all
 *
 * The alternative is to publish an episode as it arrives and swap the audio underneath
 * it once the adverts are found. That is worse than it sounds. The media route serves
 * byte ranges, so a client that fetched the first half of the untrimmed file and asks
 * for the rest gets the second half of a shorter one and stitches together an episode
 * that never existed, silently. Versioning the URL fixes that for a *later* re-cut,
 * but it cannot help the first one: apps that already downloaded the episode simply
 * keep the copy with the adverts in, which is the whole thing you asked SelfPod to
 * avoid. Holding for the few minutes it takes to decide costs a few minutes.
 *
 * ## Why the two modes hold differently
 *
 * In `review`, an undecided segment holds the episode: you asked to be the one who
 * decides, and publishing before you have would make the decision meaningless.
 *
 * In `auto`, only a corpus too small to detect anything holds it. A segment the safety
 * guard declined to approve unattended — a theme tune's signature, something under
 * fifteen seconds — is surfaced for you to look at, but it must not stop the feed.
 * "Automatic" that stops publishing until you log in is not automatic, and the failure
 * would be invisible: episodes simply stop arriving.
 */
export function resolvePublishHold({
  mode,
  corpusSize,
  minEpisodes,
  undecidedSegments = 0,
  trimStatus = null,
  canBeTrimmed = true,
}) {
  if (mode !== 'review' && mode !== 'auto') return null;

  /*
   * An episode SelfPod cannot read is never going to be trimmed, so holding it is
   * waiting for something that cannot happen. Only MP3 frames can be walked and
   * rejoined today; an AAC or Opus episode publishes as it always has.
   *
   * Getting this wrong is quiet and total: turning the feature on for a show of .m4a
   * files would empty its feed, permanently, while the page said "waiting for more
   * episodes to compare" — a sentence that is not merely unhelpful but false, because
   * more episodes would not have helped.
   */
  if (!canBeTrimmed) return null;

  // Nothing can be detected in a show SelfPod has barely seen, and publishing now
  // would mean re-cutting the first few episodes once it can. The UI shows this as a
  // count — "waiting for 2 more episodes" — because an unexplained wait is the one
  // thing worse than the wait.
  if (corpusSize < Math.max(2, minEpisodes)) return PUBLISH_HOLDS.AWAITING_CORPUS;

  if (mode === 'review' && undecidedSegments > 0) return PUBLISH_HOLDS.AWAITING_REVIEW;

  // The cut itself is a matter of seconds, but an episode published between a decision
  // and the copy that carries it out would go out with the adverts still in.
  if (trimStatus === TRIM_STATUS.PENDING || trimStatus === TRIM_STATUS.TRIMMING) {
    return PUBLISH_HOLDS.TRIMMING;
  }

  return null;
}

/**
 * The hold a brand-new episode starts with, applied as the scanner inserts it.
 *
 * At insert rather than in a pass afterwards: the scanner invalidates the feed cache
 * when it finishes a folder, so an episode inserted without a hold and held a moment
 * later would still have had one window in which the feed could be built with it in.
 * A window that small will never be reproduced and will be reported as "sometimes an
 * episode goes out untrimmed".
 */
export function initialPublishHold(show) {
  if (!show || !AD_TRIM_MODES.includes(show.ad_trim_mode)) return null;
  if (show.ad_trim_mode === 'off') return null;
  return PUBLISH_HOLDS.AWAITING_CORPUS;
}
