import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import sharp from 'sharp';

import {
  ARTWORK_MAX_PX,
  ARTWORK_MIN_PX,
  CANONICAL_COVER_FILENAME,
  COVER_FILENAMES,
  imageMimeType,
} from '../constants.js';
import { badRequest } from '../lib/errors.js';

/**
 * Cover art detection, validation and normalisation (spec §10).
 *
 * Detection accepts a list of filenames rather than one hardcoded name: the
 * prototype looked only for `cover.jpg`, so a user's `cover.png` was silently
 * ignored and their show simply had no artwork, with no error anywhere.
 */
export function createCovers({ config, logger }) {
  /** path → { etag, size, mtimeMs } so ETags aren't recomputed on every request. */
  const etagCache = new Map();

  const api = {
    /** First match from COVER_FILENAMES wins, compared case-insensitively. */
    async detect(showDir) {
      let entries;
      try {
        entries = await readdir(showDir, { withFileTypes: true });
      } catch {
        return null;
      }
      const byLower = new Map();
      for (const entry of entries) {
        if (entry.isFile()) byLower.set(entry.name.toLowerCase(), entry.name);
      }
      for (const candidate of COVER_FILENAMES) {
        const actual = byLower.get(candidate);
        if (actual) return actual;
      }
      return null;
    },

    /**
     * Reads real dimensions and format. Never blocks anything: artwork outside
     * Apple's documented range still produces a working feed, it just earns a
     * specific warning naming the actual size (spec §10.2).
     */
    async inspect(filePath) {
      try {
        const [meta, stats] = await Promise.all([sharp(filePath).metadata(), stat(filePath)]);
        const width = meta.width ?? null;
        const height = meta.height ?? null;
        return {
          width,
          height,
          format: meta.format ?? null,
          bytes: stats.size,
          mtime: stats.mtime.toISOString(),
          warning: api.describeDimensions({ width, height }),
        };
      } catch (err) {
        logger?.debug({ err, filePath }, 'could not inspect cover image');
        return { width: null, height: null, format: null, bytes: null, mtime: null, warning: null, error: err };
      }
    },

    describeDimensions({ width, height }) {
      if (!width || !height) return null;
      const isSquare = width === height;
      const inRange =
        width >= ARTWORK_MIN_PX &&
        width <= ARTWORK_MAX_PX &&
        height >= ARTWORK_MIN_PX &&
        height <= ARTWORK_MAX_PX;
      if (isSquare && inRange) return null;

      const problems = [];
      if (!isSquare) problems.push('not square');
      if (width < ARTWORK_MIN_PX || height < ARTWORK_MIN_PX) problems.push('smaller than 1400px');
      else if (width > ARTWORK_MAX_PX || height > ARTWORK_MAX_PX) problems.push('larger than 3000px');

      return {
        width,
        height,
        problems,
        message: `Cover art is ${width}×${height}px (${problems.join(
          ' and ',
        )}). Podcast directories typically require square artwork between ${ARTWORK_MIN_PX}–${ARTWORK_MAX_PX}px. The feed still works; artwork may look wrong where subscribers view it full size.`,
      };
    },

    /**
     * Writes an uploaded image as cover.jpg, converting whatever came in. Both
     * filesystem-dropped and UI-uploaded covers therefore end up as the same
     * canonical file (spec §10.1).
     */
    async saveUpload(showDir, sourcePath) {
      const target = join(showDir, CANONICAL_COVER_FILENAME);
      const tmp = join(showDir, `.cover-upload-${randomUUID()}.tmp`);
      try {
        await sharp(sourcePath)
          .rotate() // honour EXIF orientation before discarding metadata
          .jpeg({ quality: 90, mozjpeg: true })
          .toFile(tmp);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw badRequest(
          "That file could not be read as an image. Cover art needs to be a JPEG, PNG or WebP.",
          'invalid_image',
        );
      }
      await rename(tmp, target);
      await api.removeOtherCovers(showDir, CANONICAL_COVER_FILENAME);
      api.invalidate(target);
      return CANONICAL_COVER_FILENAME;
    },

    /**
     * The optional one-click fix from spec §10.2: pad the existing artwork to a
     * square 1400×1400 without cropping, using an edge-sampled background so the
     * padding doesn't read as a hard border.
     */
    async normalise(showDir, filename, { size = ARTWORK_MIN_PX } = {}) {
      const source = join(showDir, filename);
      const target = join(showDir, CANONICAL_COVER_FILENAME);
      const tmp = join(showDir, `.cover-normalise-${randomUUID()}.tmp`);

      const before = await api.inspect(source);
      if (before.error) {
        throw badRequest('That cover image could not be read, so it cannot be resized.', 'invalid_image');
      }

      try {
        const background = await dominantEdgeColour(source);
        await sharp(source)
          .rotate()
          .resize(size, size, { fit: 'contain', background, withoutEnlargement: false })
          .flatten({ background })
          .jpeg({ quality: 92, mozjpeg: true })
          .toFile(tmp);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw badRequest(`That cover image could not be resized: ${err.message}`, 'resize_failed');
      }

      await rename(tmp, target);
      if (filename !== CANONICAL_COVER_FILENAME) {
        await api.removeOtherCovers(showDir, CANONICAL_COVER_FILENAME);
      }
      api.invalidate(target);
      return { filename: CANONICAL_COVER_FILENAME, before, after: await api.inspect(target) };
    },

    /**
     * Clears only the files that would *shadow* the new cover — i.e. those earlier
     * than it in the detection order.
     *
     * It deliberately does not delete every recognised cover name. `folder.jpg` and
     * `artwork.jpg` are the conventions Jellyfin, Plex and Kodi use, and a user's
     * high-resolution `cover.png` is their original: destroying those to install a
     * re-encoded JPEG would be deleting the user's files without asking.
     */
    async removeOtherCovers(showDir, keep) {
      const keepIndex = COVER_FILENAMES.indexOf(keep.toLowerCase());
      if (keepIndex <= 0) return [];

      let entries;
      try {
        entries = await readdir(showDir, { withFileTypes: true });
      } catch {
        return [];
      }

      const shadowing = new Set(COVER_FILENAMES.slice(0, keepIndex));
      const removed = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const lower = entry.name.toLowerCase();
        if (!shadowing.has(lower)) continue;
        try {
          await unlink(join(showDir, entry.name));
          removed.push(entry.name);
        } catch (err) {
          logger?.debug({ err, file: entry.name }, 'could not remove a shadowing cover file');
        }
      }
      return removed;
    },

    mimeTypeFor(filename) {
      return imageMimeType(filename) ?? 'application/octet-stream';
    },

    /**
     * Content ETag, memoised on (size, mtime). Spec §10.3 deliberately uses a
     * short max-age because covers change; the ETag is what stops well-behaved
     * caches re-downloading unchanged artwork anyway.
     */
    async etag(filePath) {
      let stats;
      try {
        stats = await stat(filePath);
      } catch {
        return null;
      }
      const cached = etagCache.get(filePath);
      if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
        return cached.etag;
      }
      const hash = createHash('sha1');
      await pipeline(createReadStream(filePath), hash);
      const etag = `"${hash.digest('hex').slice(0, 32)}"`;
      etagCache.set(filePath, { etag, size: stats.size, mtimeMs: stats.mtimeMs });
      if (etagCache.size > 500) {
        const oldest = etagCache.keys().next().value;
        etagCache.delete(oldest);
      }
      return etag;
    },

    invalidate(filePath) {
      etagCache.delete(filePath);
    },
  };

  return api;
}

/**
 * Samples the image's own edges for a padding colour, so a 16:9 cover padded to
 * square blends instead of gaining black bars.
 */
async function dominantEdgeColour(filePath) {
  try {
    const { dominant } = await sharp(filePath).stats();
    if (dominant) return { r: dominant.r, g: dominant.g, b: dominant.b, alpha: 1 };
  } catch {
    /* fall through to a neutral paper tone */
  }
  return { r: 246, g: 242, b: 235, alpha: 1 };
}
