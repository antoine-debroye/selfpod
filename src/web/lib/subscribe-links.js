/**
 * "Subscribe in an app" links for a feed URL.
 *
 * A QR code containing an `https://` feed URL is close to useless for actually
 * subscribing: a phone camera hands it to the browser, which renders the RSS as
 * raw XML and offers no way through to a podcast app. Every major client instead
 * registers a URL scheme that means "subscribe to this feed", and those are what a
 * QR code should carry.
 *
 * The awkward part is that they disagree about the feed URL's own scheme: most want
 * it stripped, Overcast wants it intact. Getting that wrong produces a link that
 * opens the right app and then fails, which is worse than no link at all.
 *
 * Formats verified against nathangathright/podcast-platform-links (August 2026).
 */

/** Strips the leading `https://` or `http://`, which most apps expect. */
function withoutScheme(feedUrl) {
  return String(feedUrl).replace(/^https?:\/\//, '');
}

export const SUBSCRIBE_TARGETS = Object.freeze([
  {
    id: 'apple',
    label: 'Apple Podcasts',
    // Also handled by several other iOS clients that register the same scheme.
    build: (feedUrl) => `podcast://${withoutScheme(feedUrl)}`,
  },
  {
    id: 'pocketcasts',
    label: 'Pocket Casts',
    build: (feedUrl) => `pktc://subscribe/${withoutScheme(feedUrl)}`,
  },
  {
    id: 'overcast',
    // The odd one out: it wants the full URL, protocol included.
    label: 'Overcast',
    build: (feedUrl) => `overcast://x-callback-url/add?url=${encodeURIComponent(feedUrl)}`,
  },
  {
    id: 'castro',
    label: 'Castro',
    build: (feedUrl) => `castros://subscribe/${withoutScheme(feedUrl)}`,
  },
  {
    id: 'url',
    label: 'Plain URL',
    // For any other app: paste it into "add by URL". Scanning this shows the raw
    // feed in a browser, which is why it is not the default.
    build: (feedUrl) => String(feedUrl),
  },
]);

export const DEFAULT_SUBSCRIBE_TARGET = 'apple';

export function buildSubscribeLinks(feedUrl) {
  if (!feedUrl) return [];
  return SUBSCRIBE_TARGETS.map((target) => ({
    id: target.id,
    label: target.label,
    url: target.build(feedUrl),
  }));
}
