import { copyFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Moves a finished upload or download into its final place.
 *
 * A rename is preferred because it is atomic: the file either isn't there or is
 * there complete, so a scan can never pick up a half-written episode. But a rename
 * only works within one filesystem, and mounting the media separately from the
 * app's own data is a completely ordinary deployment — on a NAS it is the norm,
 * because the audio lives on an existing share while the database gets its own
 * dataset. In that layout the rename fails with EXDEV.
 *
 * So: rename when possible, and otherwise copy to a temporary name beside the
 * destination and rename *that* into place, which keeps the atomicity guarantee
 * where it actually matters — no reader ever sees a partial file at the final path.
 */
export async function moveIntoPlace(source, destination) {
  try {
    await rename(source, destination);
    return { method: 'rename' };
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }

  const staging = stagingPathFor(destination);
  try {
    await copyFile(source, staging);
    await rename(staging, destination);
  } catch (err) {
    await unlink(staging).catch(() => {});
    throw err;
  }
  await unlink(source).catch(() => {});
  return { method: 'copy' };
}

/**
 * Where the EXDEV copy is staged: beside the destination, but **dot-prefixed**.
 *
 * This used to be `${destination}.selfpod-incoming`, which is a visible name inside
 * the user's own show folder. Both the scanner and the watcher skip dot-prefixed
 * entries and nothing else; `.selfpod-incoming` is in neither ignore list. A scan
 * landing mid-copy therefore reported "`episode.mp3.selfpod-incoming` was ignored
 * because SelfPod doesn't serve that file type" into the activity log — a warning
 * about SelfPod's own temporary file, blamed on the user.
 *
 * It never bit in practice because uploads are fast and land on the same filesystem.
 * Subscription downloads are neither: an 80 MB fetch over a slow line, copied across
 * a mount boundary, leaves this file sitting there for a long time and orphans it on
 * any crash. Dot-prefixing makes it invisible to both, and gives the staging sweep a
 * single prefix to collect.
 */
export function stagingPathFor(destination) {
  return join(dirname(destination), `.${basename(destination)}.selfpod-incoming`);
}
