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

/** The only image formats Apple Podcasts accepts. WebP is a valid cover file here and a rejection there. */
export const DIRECTORY_IMAGE_FORMATS = Object.freeze(['jpeg', 'png']);

/**
 * Sidecar artwork extensions for an episode, checked case-insensitively in this
 * order against the audio file's own stem — `ep-one.mp3` → `ep-one.jpg`.
 *
 * These are already in the scanner's `knownNonAudio` list, so an image sitting
 * beside an episode has never produced a "SelfPod doesn't serve that file type"
 * warning and still doesn't.
 */
export const EPISODE_ART_SIDECAR_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Ceiling on embedded artwork SelfPod will pull out of an audio file.
 *
 * Artwork is read into memory to be hashed and written, and a tagger that embedded
 * a 60 MB uncompressed TIFF would otherwise have every scan buffer it. Past this the
 * picture is dropped with a warning naming the file, rather than silently — the owner
 * needs to know why that episode fell back to the show cover.
 */
export const EMBEDDED_ART_MAX_BYTES = 12 * 1024 * 1024;

export const GENERATOR = 'SelfPod';

/**
 * What a podcast app should make of an episode.
 *
 * Apple treats a missing value as `full`, which is why the feed always states one:
 * otherwise the ordinary case is implicit and only the rare ones are visible.
 */
export const EPISODE_TYPES = Object.freeze(['full', 'trailer', 'bonus']);

/** Whether a show is meant to be heard newest-first or from the beginning. */
export const SHOW_TYPES = Object.freeze(['episodic', 'serial']);

/**
 * Whether podcast directories may list a show.
 *
 * `allowed` emits nothing, which is what every feed has always done. `blocked` emits
 * `<itunes:block>`, which also refuses a deliberate submission — so it is opted into,
 * never defaulted, and the readiness panel says so when it is on.
 */
export const DIRECTORY_LISTINGS = Object.freeze(['allowed', 'blocked']);

export const EPISODE_STATUS = Object.freeze({
  ACTIVE: 'active',
  /** File not on disk right now; still in the feed during its grace period. */
  MISSING: 'missing',
  /**
   * Gone for longer than the grace period, so dropped from the feed — but the row
   * is kept, and the scanner re-adopts it with the same GUID if the file comes
   * back. Deliberately distinct from `removed`: conflating the two meant a file
   * that returned after a long outage came back as a brand-new episode, losing
   * every subscriber's played state.
   */
  EXPIRED: 'expired',
  /** Removed from the feed by the user. Never resurrected automatically. */
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

/**
 * How long a feed keeps naming its new address after the public base URL changes.
 *
 * `<itunes:new-feed-url>` is the only thing that moves a subscriber whose app is still
 * polling the old address, and it only works for as long as SelfPod keeps saying it.
 * Apple's guidance is a fortnight at minimum; 60 days covers apps that poll rarely
 * without turning a completed move into a permanent element nobody remembers switching on.
 */
export const PREVIOUS_BASE_URL_WINDOW_DAYS = 60;

export const DIRECTORY_NAMES = Object.freeze({
  SHOWS: 'shows',
  TEMP: '.tmp',
  /**
   * Cached per-episode artwork, as `/data/.art/{show_id}/{episode_id}.{jpg|png}`.
   *
   * Dot-prefixed and outside `shows/` on purpose: a show folder is the user's own
   * file share, and SelfPod does not create files there that the user did not ask
   * for (spec §13, lesson 5). Everything under here is derived, and every art_*
   * column on `episodes` exists so it can be rebuilt.
   */
  EPISODE_ART: '.art',
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
