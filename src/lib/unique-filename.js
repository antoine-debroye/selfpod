import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Picks a name that is not already taken in `dir`: "name (2).mp3", "name (3).mp3".
 *
 * Lifted out of the upload route so the downloader uses the same rule. Two copies of
 * "never overwrite" is one copy too many — the whole point is that no path into a show
 * folder can ever destroy a file that is already there, and a second implementation is
 * a second chance to get that wrong.
 *
 * It is inherently racy: the file could appear between the stat and the write. That is
 * acceptable here because both callers write to a staging path first and then rename
 * into place, so the worst case is two files with the same content under different
 * names — which the scanner already detects and reports, rather than data loss.
 */
export async function uniqueTarget(dir, filename) {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let candidate = filename;
  let counter = 2;
  for (;;) {
    try {
      await stat(join(dir, candidate));
    } catch {
      return candidate;
    }
    candidate = `${stem} (${counter})${ext}`;
    counter += 1;
    // A folder with 500 same-named files is a bug somewhere else, and spinning here
    // for ever would hide it. Fall back to something certainly unique and move on.
    if (counter > 500) return `${stem}-${Date.now()}${ext}`;
  }
}
