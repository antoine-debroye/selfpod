/**
 * Reading one downloaded file for signs that adverts were stitched into it (spec §19.10).
 *
 * This decides one thing only: whether it is worth downloading an episode a *second*
 * time, later, to see whether what comes back differs. That question deserves a
 * careful answer, because a second download is not free in a way that matters beyond
 * bandwidth:
 *
 *   - it is a second IAB-countable download, so it inflates the publisher's figures
 *     for an episode you took once;
 *   - a podcast host stitches per listener and caches the result, so most second
 *     fetches return byte-identical audio and learn nothing at all.
 *
 * So the bar is a positive signal in this file, not "it might be worth a look". With
 * no signal SelfPod fetches once and relies on repetition across episodes, which finds
 * a baked-in sponsor read perfectly well and costs the publisher nothing extra.
 *
 * None of these signals proves anything on its own, which is why they are returned as
 * reasons rather than as a score. They are all consequences of the same thing: an
 * advert encoded separately and joined on, rather than mixed into the programme before
 * it was encoded.
 */

/**
 * @param {ReturnType<import('./mp3-frames.js').frameProfile>} profile
 * @returns {{ likely: boolean, reasons: string[], detail: string|null }}
 */
export function describeStitchSignals(profile) {
  if (!profile || !profile.frameCount) return { likely: false, reasons: [], detail: null };

  const reasons = [];
  const details = [];

  /*
   * A change of sample rate or channel mode part-way through a file.
   *
   * One recording encoded in one pass cannot do this — the encoder is given a format
   * and keeps it. Two pieces of audio joined after encoding can, and joint-stereo
   * meeting plain stereo is the classic version, because ad networks and podcast
   * producers make different defaults choices in their encoders.
   *
   * Bitrate changes are deliberately not counted here; `frameProfile` has already
   * dropped them for variable-bitrate files, where they mean nothing.
   */
  if (profile.discontinuities?.length) {
    const [first] = profile.discontinuities;
    reasons.push('format_changes_mid_file');
    details.push(
      `the audio changes ${first.changes.join(' and ')} ${
        profile.discontinuities.length > 1 ? `${profile.discontinuities.length} times, first ` : ''
      }at ${Math.round(first.atMs / 1000)}s`,
    );
  }

  /*
   * The file's own header disagrees with how many frames it contains.
   *
   * The Xing header is written when the file is encoded. Add frames afterwards and it
   * is wrong unless whoever added them rewrote it — and a stitcher working on a
   * streaming response has no chance to, because rewriting means seeking back to the
   * start of a file it has already begun sending.
   *
   * Absence proves nothing: plenty of encoders write no Xing header, and plenty of
   * stitchers do fix it up. Only a header that is present and wrong counts.
   */
  if (profile.frameCountMismatch) {
    const { declared, actual } = profile.frameCountMismatch;
    reasons.push('frame_count_disagrees_with_header');
    details.push(`its header says ${declared} frames and it has ${actual}`);
  }

  /*
   * Bytes between frames that are not frames.
   *
   * A clean encode has none: every frame begins where the last one ended. A resync is
   * the decoder finding rubbish and hunting for the next sync word, which is what a
   * join looks like when the two pieces were not aligned. One or two can happen for
   * dull reasons, so this only counts as corroboration.
   */
  if (profile.resyncs > 2) {
    reasons.push('gaps_between_frames');
    details.push(`${profile.resyncs} places where the audio does not join cleanly`);
  }

  return {
    // A resync count on its own is too weak to spend a download on.
    likely: reasons.some((reason) => reason !== 'gaps_between_frames'),
    reasons,
    detail: details.length ? capitalise(`${details.join(', and ')}.`) : null,
  };
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
