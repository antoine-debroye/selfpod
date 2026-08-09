import { copyFile, rename, unlink } from 'node:fs/promises';

/**
 * Moves a finished upload into its final place.
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

  const staging = `${destination}.selfpod-incoming`;
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
