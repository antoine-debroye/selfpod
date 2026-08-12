import { createHash, randomUUID } from 'node:crypto';
import { rmSync, unlinkSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';

import { DIRECTORY_IMAGE_FORMATS } from '../constants.js';

/**
 * Per-episode artwork storage (the cache behind the `art_*` columns on `episodes`).
 *
 * **Where the bytes live, and the two places they deliberately do not.**
 *
 * They live in `/data/.art/{show_id}/{episode_id}.{jpg|png}`.
 *
 * Not in the show folder. That folder is the user's own file share — usually an SMB
 * share they browse from a laptop — and SelfPod does not create files there that the
 * user did not ask for (spec §13, lesson 5; the same principle that stops covers.js
 * deleting a user's originals). An owner who drops in twelve mp3s should still find
 * twelve mp3s.
 *
 * Not as a database BLOB either. A 300-episode library at 200–600 KB an image is
 * upwards of 100 MB living inside the single file the app opens at boot, checkpoints
 * on shutdown, and that the user is told they can copy to migrate — on a NAS, where
 * that file is already the slowest thing SelfPod touches. Artwork is served as files
 * by a static handler that can sendfile them; a BLOB would have to be read through
 * SQLite into memory on every request.
 *
 * This whole directory is a **cache**. Every one of the seven `art_*` columns exists
 * so that a lost `/data/.art` can be rebuilt from the audio file or the sidecar image
 * on the next scan, and the scanner checks for exactly that.
 */
export function createEpisodeArt({ config, covers, logger }) {
  const api = {
    dirFor(showId) {
      return join(config.episodeArtDir, String(showId));
    },

    pathFor(showId, filename) {
      return join(api.dirFor(showId), filename);
    },

    /**
     * Writes one episode's artwork and reports what was stored.
     *
     * JPEG and PNG go through **byte for byte**. The owner tagged their file with a
     * particular image and re-encoding it would quietly cost them quality for no
     * benefit — Apple accepts both formats as they are. Anything else (WebP, GIF,
     * BMP) is converted to JPEG, because a WebP that renders perfectly in the admin
     * UI is a rejection at a podcast directory.
     *
     * Throws on unreadable input; the scanner turns that into a warning naming the
     * file, because one bad image must never abort a scan.
     */
    async store({ showId, episodeId, buffer, sourceFormat = null }) {
      const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const probe = await sharp(data).metadata();

      // What the bytes are, never what the tag claimed they were: an APIC frame
      // announcing `image/png` around JPEG data is a common tagger bug, and trusting
      // the declaration would serve the image under the wrong content type.
      if (sourceFormat && probe.format && !String(sourceFormat).includes(probe.format)) {
        logger?.debug(
          { showId, episodeId, declared: sourceFormat, actual: probe.format },
          'embedded artwork declares one format and contains another; trusting the bytes',
        );
      }

      const passthrough = DIRECTORY_IMAGE_FORMATS.includes(probe.format);
      let bytes = data;
      let extension = probe.format === 'png' ? '.png' : '.jpg';
      let width = probe.width ?? null;
      let height = probe.height ?? null;

      if (!passthrough) {
        bytes = await sharp(data)
          .rotate() // honour EXIF orientation before the metadata is dropped
          .jpeg({ quality: 90, mozjpeg: true })
          .toBuffer();
        extension = '.jpg';
        const after = await sharp(bytes).metadata();
        width = after.width ?? width;
        height = after.height ?? height;
      }

      const filename = `${episodeId}${extension}`;
      const dir = api.dirFor(showId);
      await mkdir(dir, { recursive: true });

      // Written to a temporary name and renamed into place, so a request that
      // arrives mid-write reads either the old image or the new one and never a
      // half-written file. Same reason covers.js does it.
      const target = join(dir, filename);
      const tmp = join(dir, `.art-${randomUUID()}.tmp`);
      try {
        await writeFile(tmp, bytes);
        await rename(tmp, target);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }

      // A JPEG replacing a PNG (or the reverse) would otherwise leave the old file
      // behind for ever, and `art_filename` only ever names one of them.
      const stale = join(dir, `${episodeId}${extension === '.png' ? '.jpg' : '.png'}`);
      await unlink(stale).catch(() => {});

      return {
        filename,
        width,
        height,
        etag: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
        // Undersized or non-square artwork is stored and served with a warning, never
        // refused — refusing it would leave the episode silently on the show cover,
        // which is the invisible failure this app exists to remove. Same rule, same
        // wording source, as a show cover.
        warning: covers.describeDimensions({ width, height }, { label: 'Episode artwork' }),
      };
    },

    /**
     * Drops one episode's cached artwork.
     *
     * Synchronous on purpose. Its callers are the synchronous repository methods on
     * `episodes`, and one of them — `forgetAllForShow` — is immediately followed by a
     * rescan that writes new files into this very directory. A promise left running
     * there could delete the artwork the scan had just re-extracted.
     */
    forget(showId, episodeId) {
      if (!showId || !episodeId) return;
      for (const extension of ['.jpg', '.png']) {
        try {
          unlinkSync(api.pathFor(showId, `${episodeId}${extension}`));
        } catch (err) {
          if (err?.code !== 'ENOENT') {
            logger?.debug({ err, showId, episodeId }, 'could not remove cached episode artwork');
          }
        }
      }
    },

    /** Drops every cached image for a show. Synchronous, for the reason above. */
    forgetShow(showId) {
      if (!showId) return;
      try {
        rmSync(api.dirFor(showId), { recursive: true, force: true });
      } catch (err) {
        logger?.debug({ err, showId }, 'could not remove a show’s cached episode artwork');
      }
    },
  };

  return api;
}
