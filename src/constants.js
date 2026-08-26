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
  /**
   * A scan caused by a feed subscription downloading episodes.
   *
   * Adding a value here widens `activity`'s validation set automatically, because it
   * derives from Object.values(SCAN_TRIGGER) — but it does **not** widen the filter
   * dropdown in web/routes/pages.js, which is hand-written. Both must be edited or
   * these rows are recorded and then unfilterable.
   */
  SUBSCRIPTION: 'subscription',
});

/**
 * Human wording for each scan trigger, for the activity-log filter.
 *
 * Here rather than in the web layer so it cannot fall behind SCAN_TRIGGER. It used to
 * live as a hand-written array in web/routes/pages.js while activity.js derived its
 * validation set from Object.values(SCAN_TRIGGER) — so a new trigger was accepted and
 * stored immediately but had no way to be filtered for, and its arrival also flipped
 * any bookmarked "everything ticked" URL from "no filter" into "exclude the new one".
 *
 * Keys must cover SCAN_TRIGGER exactly; a unit test asserts it.
 */
export const SCAN_TRIGGER_LABELS = Object.freeze({
  watcher: 'File change',
  scheduled: 'Scheduled',
  manual: 'Rescan button',
  startup: 'Startup',
  upload: 'Upload',
  subscription: 'Subscription',
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

/* -------------------------------------------------------------------------- */
/* Feed subscriptions (spec §18)                                              */
/* -------------------------------------------------------------------------- */

/**
 * What SelfPod decided about one item in a remote feed.
 *
 * The refusals are the point. "Why is that episode not in my feed?" is unanswerable
 * if only the accepted items are recorded, and unanswerable is the failure class this
 * app exists to remove (spec §13).
 *
 * The three rejection reasons are deliberately separate rather than one `rejected`,
 * because they cost different amounts to revisit:
 *  - REJECTED_DECLARED was decided from the feed's own metadata, so re-checking it
 *    when the user loosens a rule is free;
 *  - REJECTED_MEASURED was decided after the file was downloaded and its real
 *    duration read, so re-checking it costs the whole download again;
 *  - REJECTED_BLOCKED was refused by the address guard and is **never** retried —
 *    a hostile feed listing 25 enclosures on the LAN would otherwise be a probe
 *    that re-fires on every poll for ever.
 */
export const ITEM_DECISION = Object.freeze({
  PENDING: 'pending',
  MATCHED: 'matched',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  REJECTED_DECLARED: 'rejected_declared',
  REJECTED_MEASURED: 'rejected_measured',
  REJECTED_BLOCKED: 'rejected_blocked',
  SKIPPED_BACKFILL: 'skipped_backfill',
  DUPLICATE: 'duplicate',
  /** The user deleted the episode. Terminal: never downloaded again. */
  DELETED_BY_USER: 'deleted_by_user',
  FAILED: 'failed',
});

/** Decisions that no poll may ever revisit, whatever the user changes. */
export const TERMINAL_DECISIONS = Object.freeze([
  ITEM_DECISION.DOWNLOADED,
  ITEM_DECISION.REJECTED_BLOCKED,
  ITEM_DECISION.DUPLICATE,
  ITEM_DECISION.DELETED_BY_USER,
]);

/** Where a remote item's dedup key came from, so a fragile one stays visible. */
export const GUID_SOURCES = Object.freeze(['guid', 'enclosure', 'synthesised']);

/** How often a remote feed is polled. Floor is 15 minutes: this is someone else's server. */
export const REMOTE_POLL_MIN_SECONDS = 15 * 60;
export const REMOTE_POLL_MAX_SECONDS = 24 * 60 * 60;
export const DEFAULT_REMOTE_POLL_SECONDS = 60 * 60;

/** Ceilings that bound one poll, so a hostile or broken feed cannot run away with the app. */
export const REMOTE_MAX_SUBSCRIPTIONS = 20;
export const REMOTE_MAX_REDIRECTS = 3;
export const REMOTE_MAX_ITEMS_PER_POLL = 25;
export const REMOTE_BACKFILL_MAX = 100;
export const DEFAULT_BACKFILL_COUNT = 5;

/**
 * The feed document cap.
 *
 * This was 5 MB, chosen from the assumption that "real podcast feeds are tens to
 * hundreds of kilobytes". That assumption was wrong, and measuring real feeds is what
 * caught it: long-running daily shows keep their whole back catalogue in one document.
 *
 *   This American Life     0.05 MB      15 items
 *   BBC Global News        1.05 MB     279 items
 *   Planet Money           2.04 MB     355 items
 *   The Vergecast          5.75 MB   1,061 items
 *   The Daily             19.03 MB   2,959 items
 *
 * A 5 MB cap refuses the last two outright. 25 MB clears the largest of them with room
 * to grow, and the cost is bounded: the parser is a SAX state machine that keeps only
 * the extracted fields, never a document tree, so The Daily parses in 92 ms for 15 MB
 * of retained heap — less than the input itself. `accept-encoding: identity` means the
 * wire cap is also the memory cap, so there is no compressed-bomb gap behind it.
 */
export const REMOTE_FEED_MAX_BYTES = 25 * 1024 * 1024;

/** Show artwork fetched from a remote channel. Generous for cover art, tiny next to audio. */
export const REMOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Ceiling on the pixels sharp will decode from a remote image.
 *
 * sharp's own default is around 268 megapixels, which is far too permissive when the
 * input is chosen by a stranger: a 200 KB PNG declaring 30000×30000 allocates roughly
 * 2.7 GB and takes the container with it. 40 MP is still four times Apple's largest
 * accepted artwork.
 */
export const REMOTE_IMAGE_MAX_PIXELS = 40 * 1000 * 1000;

/**
 * Four timers, not one, because they catch four different failures.
 *
 * A single total budget would kill a legitimate two-hour episode on a slow line. A
 * single idle timer lets an attacker hold the socket for ever at one byte every 59
 * seconds — and since outbound concurrency is 1 globally, that one socket would block
 * every other subscription. The throughput floor is what actually closes that.
 */
export const REMOTE_HEADERS_TIMEOUT_MS = 10_000;
export const REMOTE_CONNECT_TIMEOUT_MS = 5_000;
export const REMOTE_STALL_TIMEOUT_MS = 60_000;
export const REMOTE_TOTAL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const REMOTE_MIN_BYTES_PER_SECOND = 8 * 1024;

/** Content types a podcast feed is allowed to arrive as. Narrows; never authorises. */
export const REMOTE_FEED_CONTENT_TYPES = Object.freeze([
  'application/rss+xml',
  'application/atom+xml',
  'application/xml',
  'text/xml',
  'application/rdf+xml',
  // Real podcast hosts serve feeds as both of these. Tolerated here and then
  // disproved by sniffing the bytes, which is the only check that is worth anything:
  // the header comes from the same untrusted party as the body.
  'text/html',
  'application/octet-stream',
]);

/**
 * Remote content type → the extension SelfPod stores the file under.
 *
 * This is the reverse direction of AUDIO_MIME_TYPES and cannot be derived from it:
 * origins send `audio/mp4`, `audio/x-m4a` and `audio/mpeg` for files that table only
 * indexes the other way round, and several send types with no extension at all. Kept
 * here rather than in the downloader for the reason at the top of this file — a second
 * copy of an extension table is what once served `.m4a` with the wrong type.
 *
 * Never index this directly with a remote-supplied string: use remoteAudioExtension().
 */
export const REMOTE_AUDIO_TYPE_EXTENSIONS = Object.freeze({
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/x-mpeg': '.mp3',
  'audio/mpeg3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/aacp': '.aac',
  'audio/ogg': '.ogg',
  'application/ogg': '.ogg',
  'audio/vorbis': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/vnd.wave': '.wav',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
});

/**
 * Reduces a Content-Type header to its essence: lowercase type/subtype, no parameters.
 *
 * Returns null for anything ambiguous. A comma means Node joined two Content-Type
 * headers, which is malformed enough that guessing would be worse than refusing.
 */
export function contentTypeEssence(header) {
  if (typeof header !== 'string') return null;
  if (header.includes(',')) return null;
  const essence = header.split(';')[0].trim().toLowerCase();
  return essence || null;
}

/**
 * Content type → extension, for a value a stranger chose.
 *
 * Object.hasOwn rather than a bare lookup: `REMOTE_AUDIO_TYPE_EXTENSIONS['constructor']`
 * is a function, and the result of this call becomes a filename on the user's share.
 * Returns null for anything not in the table, which callers must treat as "refuse
 * before downloading a byte".
 */
export function remoteAudioExtension(contentType) {
  const essence = contentTypeEssence(contentType);
  if (!essence) return null;
  if (!Object.hasOwn(REMOTE_AUDIO_TYPE_EXTENSIONS, essence)) return null;
  const extension = REMOTE_AUDIO_TYPE_EXTENSIONS[essence];
  // Belt and braces: the extension we hand back must be one the rest of the app
  // already knows how to serve, so this table can never widen SUPPORTED_EXTENSIONS.
  return SUPPORTED_EXTENSIONS.includes(extension) ? extension : null;
}
