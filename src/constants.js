/**
 * Shared constants. Nothing in here may be duplicated elsewhere in the codebase.
 *
 * AUDIO_MIME_TYPES in particular is the single source of truth for extension →
 * MIME mapping: the scanner, the feed builder, the media route and the upload
 * validator all import it. A second copy of this table is what once caused
 * `.m4a` files to be served with the wrong type (spec §6.1).
 */

export const AUDIO_MIME_TYPES = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/x-m4a',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
});

export const SUPPORTED_EXTENSIONS = Object.freeze(Object.keys(AUDIO_MIME_TYPES));

/** Human-readable list for UI copy and error messages ("mp3, m4a, aac, …"). */
export const SUPPORTED_EXTENSIONS_LABEL = SUPPORTED_EXTENSIONS.map((e) => e.slice(1)).join(', ');

/**
 * Cover art filenames, checked case-insensitively in this exact order —
 * first match wins (spec §10.1).
 */
export const COVER_FILENAMES = Object.freeze([
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'cover.webp',
  'folder.jpg',
  'artwork.jpg',
]);

export const IMAGE_MIME_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
});

/** Cover uploads are normalised to this filename so disk and UI stay in sync. */
export const CANONICAL_COVER_FILENAME = 'cover.jpg';

/** Apple Podcasts artwork requirements, used for the (non-blocking) warning. */
export const ARTWORK_MIN_PX = 1400;
export const ARTWORK_MAX_PX = 3000;

export const GENERATOR = 'SelfPod';

export const EPISODE_STATUS = Object.freeze({
  ACTIVE: 'active',
  MISSING: 'missing',
  REMOVED: 'removed',
});

export const SHOW_STATUS = Object.freeze({
  ACTIVE: 'active',
  FOLDER_MISSING: 'folder_missing',
});

export const SCAN_TRIGGER = Object.freeze({
  WATCHER: 'watcher',
  SCHEDULED: 'scheduled',
  MANUAL: 'manual',
  STARTUP: 'startup',
  UPLOAD: 'upload',
});

/** Bounds for the fallback rescan interval, per spec §6.2: 1 minute – 6 hours. */
export const RESCAN_INTERVAL_MIN_SECONDS = 60;
export const RESCAN_INTERVAL_MAX_SECONDS = 6 * 60 * 60;

/** Default grace period before a vanished file is dropped from the feed (§6.3). */
export const DEFAULT_MISSING_GRACE_SECONDS = 24 * 60 * 60;

/** Feed XML is cached this long as a backstop; scanner events invalidate it sooner. */
export const FEED_CACHE_TTL_MS = 60_000;

export const DIRECTORY_NAMES = Object.freeze({
  SHOWS: 'shows',
  TEMP: '.tmp',
});

export const FILE_NAMES = Object.freeze({
  DATABASE: 'db.sqlite',
  CONFIG: 'config.json',
  SHOW_CONFIG: 'show.json',
});

export const LANGUAGES = Object.freeze([
  { code: 'en', label: 'English (en)' },
  { code: 'en-gb', label: 'English — UK (en-gb)' },
  { code: 'en-us', label: 'English — US (en-us)' },
  { code: 'fr', label: 'French (fr)' },
  { code: 'nl', label: 'Dutch (nl)' },
  { code: 'de', label: 'German (de)' },
  { code: 'es', label: 'Spanish (es)' },
  { code: 'it', label: 'Italian (it)' },
  { code: 'pt', label: 'Portuguese (pt)' },
  { code: 'sv', label: 'Swedish (sv)' },
  { code: 'da', label: 'Danish (da)' },
  { code: 'no', label: 'Norwegian (no)' },
  { code: 'fi', label: 'Finnish (fi)' },
  { code: 'pl', label: 'Polish (pl)' },
  { code: 'cs', label: 'Czech (cs)' },
  { code: 'ru', label: 'Russian (ru)' },
  { code: 'ja', label: 'Japanese (ja)' },
  { code: 'zh', label: 'Chinese (zh)' },
  { code: 'ko', label: 'Korean (ko)' },
]);

/**
 * Extension → MIME lookup. Returns null for anything not in the supported table,
 * which callers must treat as "not an episode candidate".
 */
export function audioMimeType(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return AUDIO_MIME_TYPES[filename.slice(dot).toLowerCase()] ?? null;
}

export function isSupportedAudioFile(filename) {
  return audioMimeType(filename) !== null;
}

export function imageMimeType(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return IMAGE_MIME_TYPES[filename.slice(dot).toLowerCase()] ?? null;
}
