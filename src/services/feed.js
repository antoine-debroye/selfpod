import { create } from 'xmlbuilder2';

import { FEED_CACHE_TTL_MS, GENERATOR, SHOW_STATUS } from '../constants.js';
import { formatDurationFeed, toRFC2822 } from '../lib/dates.js';
import { EVENTS } from '../lib/events.js';
import { sha256Hex } from '../lib/tokens.js';
import { coverUrl, mediaUrl } from '../lib/urls.js';
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
  /** showId → { xml, etag, builtAt } */
  const cache = new Map();

  if (events) {
    events.on(EVENTS.SHOW_CHANGED, ({ showId }) => {
      if (showId) cache.delete(showId);
    });
    events.on(EVENTS.SHOWS_CHANGED, () => cache.clear());
    events.on(EVENTS.SETTINGS_CHANGED, ({ keys = [] }) => {
      // Every URL in every feed is built from the base URL, so a change there
      // invalidates the whole cache rather than one show.
      if (keys.includes(SETTING_KEYS.PUBLIC_BASE_URL)) cache.clear();
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

      const cached = cache.get(showId);
      if (cached && Date.now() - cached.builtAt < FEED_CACHE_TTL_MS && cached.baseUrl === base) {
        return cached;
      }

      const xml = buildXml({ show, items: episodes.listForFeed(showId), base, config });
      const entry = { xml, etag: `"${sha256Hex(xml).slice(0, 32)}"`, builtAt: Date.now(), baseUrl: base };
      cache.set(showId, entry);
      logger?.debug({ slug: show.slug, bytes: xml.length }, 'built feed xml');
      return entry;
    },

    invalidate(showId) {
      if (showId) cache.delete(showId);
      else cache.clear();
    },

    stop() {
      cache.clear();
    },

    /** Exposed for tests. */
    _cacheSize() {
      return cache.size;
    },
  };

  return api;
}

function buildXml({ show, items, base, config }) {
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
  channel.ele('title').txt(show.title).up();
  channel.ele('link').txt(base).up();
  channel.ele('description').txt(show.description ?? '').up();
  channel.ele('language').txt(show.language || 'en').up();
  // Directories reject an empty itunes:author, so it always carries something
  // meaningful; the show title is the last-resort fallback.
  const authorName = show.author_name?.trim() || show.title;
  channel.ele('itunes:author').txt(authorName).up();
  channel.ele('itunes:summary').txt(show.description ?? '').up();

  const owner = channel.ele('itunes:owner');
  owner.ele('itunes:name').txt(authorName).up();
  // An empty <itunes:email> is worse than none at all — it looks like a real
  // value to validators. Omit it until the user provides one.
  if (show.author_email?.trim()) {
    owner.ele('itunes:email').txt(show.author_email.trim()).up();
  }
  owner.up();

  const category = channel.ele('itunes:category', { text: show.itunes_category });
  if (show.itunes_subcategory) {
    category.ele('itunes:category', { text: show.itunes_subcategory }).up();
  }
  category.up();

  channel.ele('itunes:explicit').txt(show.explicit === 1 ? 'true' : 'false').up();
  channel.ele('itunes:type').txt('episodic').up();

  if (show.cover_filename) {
    const art = coverUrl(base, show.slug, show.feed_token, { cacheBust: show.cover_mtime ?? undefined });
    channel.ele('itunes:image', { href: art }).up();
    const image = channel.ele('image');
    image.ele('url').txt(art).up();
    image.ele('title').txt(show.title).up();
    image.ele('link').txt(base).up();
    image.up();
  }

  // The feed is private, so it is marked as not available for transfer, and the
  // show's own UUID is its permanent identifier across any future URL change.
  channel.ele('podcast:locked').txt('yes').up();
  channel.ele('podcast:guid').txt(show.id).up();

  channel.ele('generator').txt(GENERATOR).up();
  channel.ele('lastBuildDate').txt(toRFC2822(lastBuildDate(show, items))).up();
  channel.ele('atom:link', {
    href: `${base}/feeds/${encodeURIComponent(show.slug)}/${encodeURIComponent(show.feed_token)}.xml`,
    rel: 'self',
    type: 'application/rss+xml',
  }).up();

  for (const episode of items) {
    const item = channel.ele('item');
    item.ele('title').txt(episode.title).up();
    item.ele('description').txt(episode.description ?? '').up();
    if (episode.description) {
      item.ele('content:encoded').dat(episode.description).up();
    }

    // isPermaLink is always written explicitly: some clients default it to true
    // and then try to fetch the guid as a URL (§8.3 requirement 2).
    item.ele('guid', { isPermaLink: 'false' }).txt(episode.id).up();
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
    if (show.cover_filename) {
      item.ele('itunes:image', {
        href: coverUrl(base, show.slug, show.feed_token, { cacheBust: show.cover_mtime ?? undefined }),
      }).up();
    }

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

function lastBuildDate(show, items) {
  const newestEpisode = items[0]?.pub_date;
  const candidates = [show.updated_at, newestEpisode].filter(Boolean).map((v) => new Date(v).getTime());
  const newest = candidates.length ? Math.max(...candidates) : Date.now();
  return new Date(Math.min(newest, Date.now()));
}
