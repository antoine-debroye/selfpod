import { createHash } from 'node:crypto';

import { audioMimeType, remoteAudioExtension } from '../constants.js';
import { isPortableFilename } from './slug.js';

/**
 * Choosing the name a downloaded episode gets on the user's share (spec §18.3).
 *
 * Everything here is derived from values a stranger controls — the feed's title, its
 * enclosure URL, and the headers the origin sends — and the output is a path inside
 * the user's SMB share. So the rule is **generate, never adopt**: nothing the remote
 * supplies is used as a name, only as material to build one from, and the result is
 * asserted portable before it goes anywhere near the filesystem.
 *
 * Two things are deliberately not consulted:
 *
 *  - **`Content-Disposition`.** There is no case where honouring it helps. It is a
 *    filename chosen by the person we are defending against, and every use of it is a
 *    chance to get sanitisation wrong.
 *  - **The URL's own extension, except as a last resort.** The type of a file is what
 *    the server says it is, not what the path happens to end in; a `.mp3` suffix on a
 *    URL serving HTML is exactly how a paywall page ends up in a show folder.
 */

/** Windows/SMB device names, reserved with any extension. Mirrors slug.js's check;
 * kept here as the *repair*, where that one is the assertion. */
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Leaves room for a " (2)" suffix and a long extension under the 255-byte limit. */
const MAX_STEM_BYTES = 120;

/**
 * Trims to a byte budget without splitting a character.
 *
 * `slice` counts UTF-16 units, which is neither bytes nor characters: it cuts an emoji
 * in half and leaves a lone surrogate, and it lets a title in Greek or Japanese run to
 * three times the byte budget. Iterating code points is the only way to be right about
 * both. Acceptance step 2 exists because emoji in filenames were once broken; this is
 * the same requirement arriving from the other direction.
 */
function truncateBytes(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = '';
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > maxBytes) break;
    out += character;
    used += size;
  }
  return out;
}

/**
 * Turns a remote title into the middle of a filename.
 *
 * Note the order: path separators are replaced before anything else, so a title of
 * `../../etc/passwd` becomes text rather than a traversal that later steps then have
 * to notice.
 */
export function stemFromTitle(title) {
  const stem = String(title ?? '')
    .normalize('NFC')
    // Separators first, and turned into a visible dash rather than dropped, so
    // "AC/DC" reads as "AC-DC" instead of "ACDC".
    .replace(/[/\\]/g, '-')
    .replace(/[<>:"|?*]/g, '')
    // Whitespace first, so a tab or a newline inside a title becomes a space rather
    // than vanishing: stripping control characters ahead of this turned "a\tb" into
    // "ab" and silently welded two words together.
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    // A leading dot hides the file from the scanner; a leading dash is an argument
    // to any command line the file later reaches.
    .replace(/^[.\-\s]+/, '')
    .trim();

  return truncateBytes(stem, MAX_STEM_BYTES)
    // Truncation can leave a trailing space or dot that Windows will not accept.
    .replace(/[.\s]+$/, '')
    .trim();
}

/**
 * The extension, decided from what the server said rather than what the URL looked like.
 *
 * Order matters: the response's own `Content-Type` is the most trustworthy of three
 * untrustworthy things, because it is what the origin claims about the bytes it is
 * sending right now. The feed's `type` attribute is a claim made earlier about a file
 * that may since have changed. The URL path is not a claim at all.
 *
 * Returns null when nothing maps, and callers must treat that as "refuse before
 * downloading a byte" — the scanner would ignore the file anyway and then warn the
 * user about a file they never chose to put there.
 */
export function extensionFor({ contentType, enclosureType, url } = {}) {
  const fromResponse = remoteAudioExtension(contentType);
  if (fromResponse) return fromResponse;

  const fromFeed = remoteAudioExtension(enclosureType);
  if (fromFeed) return fromFeed;

  // Last resort, and only for extensions SelfPod already serves — this can never
  // widen SUPPORTED_EXTENSIONS, only pick from it.
  try {
    const pathname = new URL(String(url)).pathname;
    const dot = pathname.lastIndexOf('.');
    if (dot > 0) {
      const candidate = pathname.slice(dot).toLowerCase();
      if (audioMimeType(candidate) !== null) return candidate;
    }
  } catch {
    // Not a URL we can read; nothing to salvage.
  }

  return null;
}

/**
 * Builds the filename for one downloaded episode.
 *
 * @returns {{ filename: string, extension: string } | { filename: null, reason: string }}
 */
export function remoteEpisodeFilename({
  title,
  url,
  contentType,
  enclosureType,
  pubDate,
  guid,
} = {}) {
  const extension = extensionFor({ contentType, enclosureType, url });
  if (!extension) return { filename: null, reason: 'unsupported_type' };

  // `YYYY-MM-DD-` is the convention the scanner's own titleFromFilename already knows
  // how to strip, so an episode whose enrichment has not landed yet still shows a
  // sensible title rather than a date glued to a name.
  const iso = pubDate ? String(pubDate).slice(0, 10) : '';
  const prefix = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}-` : '';

  let stem = stemFromTitle(title);

  // A title that sanitises away to nothing — punctuation only, or a script we
  // stripped — still needs a stable, unique name. Derived from the GUID so the same
  // item always produces the same filename, which keeps re-downloads idempotent.
  if (!stem) {
    const seed = String(guid ?? url ?? title ?? '');
    stem = `remote-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
  }

  // Bounded by construction: the stem is capped at MAX_STEM_BYTES, the date prefix is
  // 11 bytes and the extension at most 5, so the whole name cannot approach the 255
  // byte filesystem limit. An earlier draft had a "drop the date if it overflows"
  // branch here; it was unreachable, and a safeguard that never runs is worse than
  // none because it implies a protection nobody has tested.
  let filename = `${prefix}${stem}${extension}`;

  // "CON", "NUL", "COM1" and friends are device names on Windows and SMB, and a write
  // to one silently goes nowhere. A dated episode escapes this by accident because the
  // prefix is in front; an undated one does not, and refusing an episode outright
  // because a publisher titled it "Aux" would be a worse answer than renaming it.
  if (DEVICE_NAME.test(filename)) filename = `_${filename}`;

  // Not a defensive nicety — an assertion about this function. Everything above is
  // supposed to guarantee a portable name, so reaching here means a case was missed,
  // and the right response is to refuse loudly rather than write something odd into
  // the user's folder and let them discover it.
  if (!isPortableFilename(filename)) {
    return { filename: null, reason: 'underivable_filename' };
  }

  return { filename, extension };
}
