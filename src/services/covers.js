import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  IMAGE_MAX_INPUT_PIXELS,
  ARTWORK_MAX_PX,
  ARTWORK_MIN_PX,
  CANONICAL_COVER_FILENAME,
  COVER_FILENAMES,
  imageMimeType,
} from '../constants.js';
import { badRequest } from '../lib/errors.js';
import { loadSharp } from '../lib/lazy-sharp.js';
import { describeImageError } from './episode-art.js';

/** Every decode refuses at the header past the pixel ceiling — see the constant. */
const SHARP_LIMITS = Object.freeze({ limitInputPixels: IMAGE_MAX_INPUT_PIXELS });
const isPixelLimitError = (err) => Boolean(describeImageError(err));

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
        const sharp = await loadSharp();
        const [meta, stats] = await Promise.all([sharp(filePath, SHARP_LIMITS).metadata(), stat(filePath)]);
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

    /**
     * `label` names the artwork the sentence is about. Per-episode artwork asks
     * exactly the same question of exactly the same numbers, so it borrows this
     * rather than growing a second copy of Apple's range — one place to change
     * when they change it.
     */
    describeDimensions({ width, height }, { label = 'Cover art' } = {}) {
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
        message: `${label} is ${width}×${height}px (${problems.join(
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
      // Outside the try: a broken image library must not be reported as a bad image.
      const sharp = await loadSharp();
      try {
        await sharp(sourcePath, SHARP_LIMITS)
          .rotate() // honour EXIF orientation before discarding metadata
          .jpeg({ quality: 90, mozjpeg: true })
          .toFile(tmp);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        if (isPixelLimitError(err)) {
          throw badRequest(
            `That image is too large to be used as cover art: it has more than ${Math.round(IMAGE_MAX_INPUT_PIXELS / 1_000_000)} million pixels. Podcast directories want a square between 1400 and 3000 pixels, so shrink it and try again.`,
            'image_too_large',
          );
        }
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

      const sharp = await loadSharp();
      try {
        const background = await dominantEdgeColour(sharp, source);
        await sharp(source, SHARP_LIMITS)
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

    /**
     * A small copy of a cover for the dashboard card, made once and kept on disk.
     *
     * The full cover is 1400 px or more — several hundred kilobytes, a few megabytes
     * for a PNG — and the card shows it at 250 px, so a dashboard of twelve shows
     * over a tunnel was downloading tens of megabytes of artwork to paint twelve
     * thumbnails. The copy is named by the cover's content hash, so a changed cover
     * gets a new one and the old one is removed; `scope` (the show id) is what makes
     * the old one findable. Returns the path, or null when it cannot be made — the
     * route then serves the full cover, so a cover that sharp cannot read is still
     * a cover rather than a broken image.
     */
    async thumbnail(filePath, { width = THUMBNAIL_WIDTH, etag = null, scope = 'cover' } = {}) {
      const tag = etag ?? (await api.etag(filePath));
      if (!tag) return null;
      const key = tag.replace(/[^0-9a-f]/gi, '').slice(0, 32);
      const safeScope = String(scope).replace(/[^\w-]/g, '_');
      const dir = config.coverThumbDir;
      const target = join(dir, `${safeScope}-${width}-${key}.jpg`);
      try {
        await stat(target);
        return target;
      } catch {
        /* not made yet */
      }
      const tmp = join(dir, `.${safeScope}-${width}-${randomUUID()}.tmp`);
      try {
        const sharp = await loadSharp();
        await mkdir(dir, { recursive: true });
        await sharp(filePath, SHARP_LIMITS)
          .rotate()
          .resize(width, width, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82, mozjpeg: true })
          .toFile(tmp);
        await rename(tmp, target);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        logger?.debug({ err, filePath }, 'could not make a cover thumbnail; the full cover is served instead');
        return null;
      }
      // The copies of this show's earlier covers, which nothing will ask for again.
      try {
        const stale = (await readdir(dir)).filter(
          (name) => name.startsWith(`${safeScope}-${width}-`) && name.endsWith('.jpg') && name !== basename(target),
        );
        await Promise.all(stale.map((name) => unlink(join(dir, name)).catch(() => {})));
      } catch {
        /* a listing that fails leaves a stale file behind, which costs disk and nothing else */
      }
      return target;
    },
  };

  return api;
}

/** The dashboard card is 250 px wide; 400 px covers a 1.5× screen without being the full file. */
export const THUMBNAIL_WIDTH = 400;

/**
 * Samples the image's own edges for a padding colour, so a 16:9 cover padded to
 * square blends instead of gaining black bars.
 */
async function dominantEdgeColour(sharp, filePath) {
  try {
    const { dominant } = await sharp(filePath, SHARP_LIMITS).stats();
    if (dominant) return { r: dominant.r, g: dominant.g, b: dominant.b, alpha: 1 };
  } catch {
    /* fall through to a neutral paper tone */
  }
  return { r: 246, g: 242, b: 235, alpha: 1 };
}
