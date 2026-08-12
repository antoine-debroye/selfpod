import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

import { create } from 'xmlbuilder2';

import { FEED_CACHE_TTL_MS, GENERATOR, SHOW_STATUS } from '../constants.js';
import { formatDurationFeed, toRFC2822 } from '../lib/dates.js';
import { EVENTS } from '../lib/events.js';
import { sha256Hex } from '../lib/tokens.js';
import { coverUrl, episodeArtUrl, feedUrl, mediaUrl } from '../lib/urls.js';
import { SETTING_KEYS } from './settings.js';

/**
 * RSS generation (spec §8).
 *
 * Feeds are built on demand from the database, never written to disk on a timer.
 * That single decision removes the whole "why isn't my update showing up" class of
 * problem the prototype had, where a feed was only ever as fresh as the last cron
 * run and nothing surfaced when that had last happened.
 *
 * A short in-memory cache keeps a busy podcast app from rebuilding XML on every
 * poll, but it is invalidated by scanner and edit *events* — not just by its TTL —
 * so a change is visible immediately (§8.1).
 */
export function createFeeds({ config, settings, events, shows, episodes, logger }) {
  /** showId → { xml, etag, lastModified, encoded, builtAt, baseUrl, previousBase } */
  const cache = new Map();

  /**
   * showId → { etag, at } — the newest Last-Modified ever served for this show.
   *
   * `lastBuildDate` is derived from the episodes *currently* in the feed, so it moves
   * backwards whenever the feed loses its newest item: an episode removed, expired past
   * its grace period, or given a publish date in the future. A client that validates by
   * date alone would read a date it has already seen as "still fresh" and never fetch
   * the shorter feed. So the header only ever moves forwards — and where the content
   * changed but the derived date did not advance, now is the honest answer.
   *
   * This is a watermark, not a cache: invalidation must not clear it, or the guarantee
   * is lost on the very edit that needed it.
   */
  const servedAt = new Map();

  if (events) {
    events.on(EVENTS.SHOW_CHANGED, ({ showId }) => {
      if (showId) cache.delete(showId);
    });
    events.on(EVENTS.SHOWS_CHANGED, () => cache.clear());
    events.on(EVENTS.SETTINGS_CHANGED, ({ keys = [] }) => {
      // Every URL in every feed is built from the base URL, so a change there
      // invalidates the whole cache rather than one show. The forwarding pair is
      // listed for the same reason: it decides whether itunes:new-feed-url is in
      // the document, and without it "the move is done" would go on being
      // contradicted by a cached feed for up to a minute.
      if (
        keys.includes(SETTING_KEYS.PUBLIC_BASE_URL) ||
        keys.includes(SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL) ||
        keys.includes(SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL_SET_AT)
      ) {
        cache.clear();
      }
    });
  }

  const api = {
    /** Returns null when the show has no feed to serve (folder gone). */
    build(showId, { baseUrl } = {}) {
      const show = shows.get(showId);
      if (!show) return null;
      if (show.status === SHOW_STATUS.FOLDER_MISSING) return null;

      const base = baseUrl ?? settings.publicBaseUrl();
      if (!base) return null;

      // Part of the cache key, not just of the document: this value also stops being
      // set on its own, sixty days after the move, with no event to announce it. Read
      // it on every build and compare it, and that expiry lands on the next request
      // instead of waiting out the TTL.
      const previousBase = settings.previousPublicBaseUrl();

      const cached = cache.get(showId);
      if (
        cached &&
        Date.now() - cached.builtAt < FEED_CACHE_TTL_MS &&
        cached.baseUrl === base &&
        cached.previousBase === previousBase
      ) {
        return cached;
      }

      const items = episodes.listForFeed(showId);
      const xml = buildXml({ show, items, base, previousBase, config });
      const etag = `"${sha256Hex(xml).slice(0, 32)}"`;

      // Same bytes as last time: keep the date we already told clients, so a
      // revalidation cannot be answered with a value they have never seen.
      const previous = servedAt.get(showId);
      const derived = lastBuildDate(show, items).getTime();
      const at =
        previous && previous.etag === etag
          ? previous.at
          : previous && derived <= previous.at
            ? Date.now()
            : derived;
      // Whole seconds: an HTTP-date carries no finer resolution, and a header the
      // client cannot echo back exactly is a validator that never validates.
      const lastModified = new Date(Math.floor(at / 1000) * 1000);
      servedAt.set(showId, { etag, at: lastModified.getTime() });

      const entry = {
        xml,
        etag,
        lastModified,
        encoded: encodeBodies(xml),
        builtAt: Date.now(),
        baseUrl: base,
        previousBase,
      };
      cache.set(showId, entry);
      logger?.debug({ slug: show.slug, bytes: xml.length }, 'built feed xml');
      return entry;
    },

    invalidate(showId) {
      // `servedAt` is deliberately untouched: it is the promise that a Last-Modified
      // never goes backwards, and an edit is exactly when that promise is needed.
      if (showId) cache.delete(showId);
      else cache.clear();
    },

    stop() {
      cache.clear();
      servedAt.clear();
    },

    /** Exposed for tests. */
    _cacheSize() {
      return cache.size;
    },
  };

  return api;
}

/**
 * Strips characters that XML 1.0 forbids outright.
 *
 * Control characters cannot appear in an XML document even as numeric references,
 * so a single one — arriving from an ID3 tag, a filename, or the API — would make
 * the *entire* feed unparseable for every subscriber, with nothing to see but a
 * podcast app that stopped updating. Lone surrogates are removed for the same
 * reason: they cannot be encoded as valid UTF-8.
 */
function xmlSafe(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
    .replace(/\uFFFE|\uFFFF/g, '');
}

function buildXml({ show, items, base, previousBase, config }) {
  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('rss', {
    version: '2.0',
    'xmlns:itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd',
    'xmlns:podcast': 'https://podcastindex.org/namespace/1.0',
    'xmlns:content': 'http://purl.org/rss/1.0/modules/content/',
    'xmlns:atom': 'http://www.w3.org/2005/Atom',
  });

  const channel = doc.ele('channel');

  // All text goes through the XML builder's escaping: titles come from filenames
  // and user input, so none of it can be assumed XML-safe (§8.3 requirement 5).
  channel.ele('title').txt(xmlSafe(show.title)).up();
  channel.ele('link').txt(base).up();
  channel.ele('description').txt(xmlSafe(show.description)).up();
  channel.ele('language').txt(xmlSafe(show.language) || 'en').up();
  // Directories reject an empty itunes:author, so it always carries something
  // meaningful; the show title is the last-resort fallback.
  const authorName = xmlSafe(show.author_name?.trim() || show.title);
  channel.ele('itunes:author').txt(authorName).up();
  channel.ele('itunes:summary').txt(xmlSafe(show.description)).up();

  const owner = channel.ele('itunes:owner');
  owner.ele('itunes:name').txt(authorName).up();
  // An empty <itunes:email> is worse than none at all — it looks like a real
  // value to validators. Omit it until the user provides one.
  if (show.author_email?.trim()) {
    owner.ele('itunes:email').txt(xmlSafe(show.author_email.trim())).up();
  }
  owner.up();

  const category = channel.ele('itunes:category', { text: xmlSafe(show.itunes_category) });
  if (show.itunes_subcategory) {
    category.ele('itunes:category', { text: xmlSafe(show.itunes_subcategory) }).up();
  }
  category.up();

  channel.ele('itunes:explicit').txt(show.explicit === 1 ? 'true' : 'false').up();
  // An allow-list rather than the raw column: a CHECK constraint guards what gets
  // written, not what a restored or hand-edited database puts in front of the builder.
  channel.ele('itunes:type').txt(show.itunes_type === 'serial' ? 'serial' : 'episodic').up();

  // A feed whose URL leaks should not also become a search result. This is the only
  // element that asks the directories to keep it out of their index, and it is emitted
  // only when the owner has asked for it — because the same element also refuses a
  // deliberate submission, and a silent block stopping an intended action would be its
  // own invisible failure.
  //
  // Only ever "Yes". <itunes:block>No</itunes:block> is a no-op that reads like a
  // decision, so the absence of the element is what "allowed" looks like. The capital Y
  // matches Apple's documentation; podcast:locked below is lowercase because the
  // Podcasting 2.0 spec writes it that way. Those are two namespaces, not an
  // inconsistency — this note exists so nobody "fixes" one to match the other.
  if (show.directory_listing === 'blocked') {
    channel.ele('itunes:block').txt('Yes').up();
  }

  if (show.cover_filename) {
    const art = coverUrl(base, show.slug, show.feed_token, { cacheBust: show.cover_mtime ?? undefined });
    channel.ele('itunes:image', { href: art }).up();
    const image = channel.ele('image');
    image.ele('url').txt(art).up();
    image.ele('title').txt(xmlSafe(show.title)).up();
    image.ele('link').txt(base).up();
    image.up();
  }

  // The feed is private, so it is marked as not available for transfer, and the
  // show's own UUID is its permanent identifier across any future URL change.
  //
  // The `owner` attribute carries the address that may authorise moving the show to
  // another host, and the Podcasting 2.0 spec marks it required. With no owner email
  // the element is still emitted without it: dropping the element entirely would
  // silently make the show transferable, the exact inversion of the intent, and
  // owner="" reads as a real value to a validator — the same argument as itunes:email.
  const lockOwner = show.author_email?.trim();
  channel
    .ele('podcast:locked', lockOwner ? { owner: xmlSafe(lockOwner) } : {})
    .txt('yes')
    .up();
  channel.ele('podcast:guid').txt(xmlSafe(show.id)).up();

  channel.ele('generator').txt(GENERATOR).up();
  channel.ele('lastBuildDate').txt(toRFC2822(lastBuildDate(show, items))).up();
  // Built by the one function that assembles feed URLs, rather than by hand here: two
  // places composing the same URL is how they come to disagree about encoding.
  channel.ele('atom:link', {
    href: feedUrl(base, show.slug, show.feed_token),
    rel: 'self',
    type: 'application/rss+xml',
  }).up();

  // Where the show now lives, after the public address changed. Changing it rewrites
  // every URL a subscriber holds, and this element is the only thing that tells their
  // app about it.
  //
  // One document serves both readers, which is what keeps the feed cache single-keyed.
  // An app still polling the old address is moved to the address named here. An app
  // already on the new address reads a value equal to the URL it just fetched, and
  // does nothing — so there is no need to build a second variant per requested host,
  // and no way for the two to drift apart.
  if (previousBase) {
    channel.ele('itunes:new-feed-url').txt(feedUrl(base, show.slug, show.feed_token)).up();
  }

  for (const episode of items) {
    const item = channel.ele('item');
    item.ele('title').txt(xmlSafe(episode.title)).up();
    item.ele('description').txt(xmlSafe(episode.description)).up();
    if (episode.description) {
      item.ele('content:encoded').dat(xmlSafe(episode.description).replace(/]]>/g, ']]&gt;')).up();
    }

    // isPermaLink is always written explicitly: some clients default it to true
    // and then try to fetch the guid as a URL (§8.3 requirement 2).
    item.ele('guid', { isPermaLink: 'false' }).txt(xmlSafe(episode.id)).up();
    item.ele('pubDate').txt(toRFC2822(episode.pub_date)).up();

    // Omitted entirely when unknown — never zero, never an empty tag (§8.3 req 3).
    if (episode.duration_seconds !== null && episode.duration_seconds !== undefined) {
      item.ele('itunes:duration').txt(formatDurationFeed(episode.duration_seconds)).up();
    }

    const explicit =
      episode.explicit === null || episode.explicit === undefined
        ? show.explicit === 1
        : episode.explicit === 1;
    item.ele('itunes:explicit').txt(explicit ? 'true' : 'false').up();

    if (Number.isInteger(episode.season)) item.ele('itunes:season').txt(String(episode.season)).up();
    if (Number.isInteger(episode.episode_number)) {
      item.ele('itunes:episode').txt(String(episode.episode_number)).up();
    }
    // Always written. Apple treats a missing value as "full", so leaving it out would
    // make the ordinary case implicit and the two rarer ones the only visible ones —
    // saying it every time means the feed states what the owner actually chose. The
    // allow-list is for the same reason as itunes:type above.
    item
      .ele('itunes:episodeType')
      .txt(
        episode.episode_type === 'trailer' || episode.episode_type === 'bonus'
          ? episode.episode_type
          : 'full',
      )
      .up();
    // The episode's own artwork, else the show's, else neither. An app renders the
    // show cover for an item that carries no image of its own, so falling back here
    // rather than omitting the element changes nothing a listener sees — but it does
    // mean the item states what it actually has, and one episode with its own art
    // does not make the rest look deliberately blank.
    //
    // The buster is the artwork's content hash, not a timestamp: replacing an image
    // gives it a URL nothing has cached, and re-extracting the same image does not.
    const itemArt = episode.art_filename
      ? episodeArtUrl(base, show.slug, show.feed_token, episode.id, {
          cacheBust: episode.art_etag ?? undefined,
        })
      : show.cover_filename
        ? coverUrl(base, show.slug, show.feed_token, { cacheBust: show.cover_mtime ?? undefined })
        : null;
    if (itemArt) item.ele('itunes:image', { href: itemArt }).up();

    item.ele('enclosure', {
      url: mediaUrl(base, show.slug, show.feed_token, episode.id, episode.filename),
      length: String(episode.file_size_bytes ?? 0),
      type: episode.mime_type,
    }).up();

    item.up();
  }

  void config;
  return doc.end({ prettyPrint: true });
}

/**
 * Pre-compressed copies of the feed, made once per build rather than once per poll.
 *
 * A subscriber's app polls every few minutes for ever; the feed changes when the owner
 * drops a file into a folder. Compressing the cached representation rather than the
 * response puts the cost on the rare event instead of the constant one — about a
 * millisecond per build for a large feed, which then goes out at a twentieth of its size
 * on a home connection.
 *
 * This is also the only place in SelfPod that compresses anything, and that is
 * deliberate: episode audio is already compressed and is served with byte ranges, so a
 * content-coding there would spend CPU to break seeking. Keeping the negotiation in the
 * feed handler means it physically cannot reach that route.
 *
 * A coding is kept only if it actually came out smaller — on a feed with no episodes the
 * framing can exceed the document.
 */
function encodeBodies(xml) {
  const raw = Buffer.from(xml, 'utf8');
  const gzip = gzipSync(raw, { level: 6 });
  const brotli = brotliCompressSync(raw, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  return {
    gzip: gzip.length < raw.length ? gzip : null,
    br: brotli.length < raw.length ? brotli : null,
  };
}

/**
 * When the feed's content last changed.
 *
 * Derived from the episodes and the show's own metadata timestamp — deliberately
 * not from anything a scan touches for bookkeeping, so a feed that has not changed
 * keeps reporting the same build date and the same ETag. Podcast apps poll often;
 * a value that moved every few minutes meant every poll re-downloaded everything.
 */
function lastBuildDate(show, items) {
  const stamps = [show.updated_at];
  for (const episode of items) {
    stamps.push(episode.pub_date, episode.updated_at);
  }
  const times = stamps.filter(Boolean).map((v) => new Date(v).getTime()).filter((t) => !Number.isNaN(t));
  const newest = times.length ? Math.max(...times) : Date.now();
  return new Date(Math.min(newest, Date.now()));
}
