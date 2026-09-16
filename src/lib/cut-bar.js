/**
 * The arithmetic behind the bar drawn for each episode: where each stretch sits, as
 * a percentage of the episode, computed here rather than in a template or in the
 * browser so the page is right with JavaScript off and a test can check the numbers.
 */

/** Narrower than this and a three-second cut in a two-hour episode cannot be seen or tapped. */
export const MIN_MARK_WIDTH = 0.6;

const round = (value) => Math.round(value * 100) / 100;

/**
 * `left` and `width` in percent for each stretch.
 *
 * Clamped so nothing is drawn past either end of the bar: a cut whose recorded end is
 * a breath beyond the measured duration (edges are biased outwards) still ends at 100%.
 *
 * @param {Array<{startMs: number, endMs: number}>} stretches
 * @param {number} durationMs
 * @returns {Array<object>} the stretches, each with `left` and `width` added
 */
export function barMarks(stretches, durationMs) {
  const total = Number(durationMs) > 0
    ? Number(durationMs)
    : Math.max(1, ...stretches.map((stretch) => Number(stretch.endMs) || 0));
  return stretches.map((stretch) => {
    const start = Math.max(0, Math.min(total, Number(stretch.startMs) || 0));
    const end = Math.max(start, Math.min(total, Number(stretch.endMs) || 0));
    let left = (start / total) * 100;
    let width = Math.max(MIN_MARK_WIDTH, ((end - start) / total) * 100);
    if (left + width > 100) left = Math.max(0, 100 - width);
    width = Math.min(width, 100);
    return { ...stretch, left: round(left), width: round(width) };
  });
}

/** The inline style a mark carries: the only style attribute the bar needs. */
export function markStyle(mark) {
  return `left:${mark.left}%;width:${mark.width}%`;
}

/**
 * Whether a per-episode restore covers a stored cut.
 *
 * By time, not by row: rows are folded together and re-found under new signatures as
 * a show grows, and the edges of a cut move by a breath when the words are read again.
 * Most of the cut lying inside the restored stretch is the same stretch. Shared by the
 * trimmer's cut list and the page, so the page never shows as restored what is cut.
 */
export const SAME_THING_OVERLAP = 0.7;

export function restoreCovers(restore, occurrence) {
  const length = occurrence.end_ms - occurrence.start_ms;
  if (length <= 0) return false;
  const overlap = Math.min(occurrence.end_ms, restore.end_ms) - Math.max(occurrence.start_ms, restore.start_ms);
  return overlap >= SAME_THING_OVERLAP * length;
}

/** "m:ss" from a text box, or a number of seconds; null when it is neither. */
export function parseClock(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => /^\d+(\.\d+)?$/.test(part))) return null;
  const numbers = parts.map(Number);
  const seconds = numbers.length === 3
    ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    : numbers[0] * 60 + numbers[1];
  return Math.round(seconds * 1000);
}
