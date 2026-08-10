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
 * **The bigger trap, learned the hard way.** Some of these schemes do not hand the
 * app a feed to fetch — they hand it a feed to *look up in that vendor's public
 * directory*. Every SelfPod feed is private and unlisted, so it is in no directory,
 * and the app answers "unable to find podcast, please contact the podcast author"
 * while the very same URL pasted into its search box subscribes immediately. Pocket
 * Casts works this way and documents pasting the URL as the route for private feeds.
 * A link that opens the right app and then refuses is worse than no link, so those
 * apps get the instruction that works instead of a QR that cannot.
 *
 * Formats verified against nathangathright/podcast-platform-links (August 2026);
 * Pocket Casts' directory behaviour against its own support documentation.
 */

/** How a private, unlisted feed actually gets into each app. */
export const ADD_METHOD = Object.freeze({
  /** The URL scheme hands the app the feed itself, so a QR works. */
  LINK: 'link',
  /** The scheme resolves through a public directory, so only pasting the URL works. */
  PASTE: 'paste',
});

/** Strips the leading `https://` or `http://`, which most apps expect. */
function withoutScheme(feedUrl) {
  return String(feedUrl).replace(/^https?:\/\//, '');
}

export const SUBSCRIBE_TARGETS = Object.freeze([
  {
    id: 'apple',
    label: 'Apple Podcasts',
    // Also handled by several other iOS clients that register the same scheme.
    method: ADD_METHOD.LINK,
    build: (feedUrl) => `podcast://${withoutScheme(feedUrl)}`,
  },
  {
    id: 'pocketcasts',
    label: 'Pocket Casts',
    // `pktc://subscribe/` is a directory lookup, not a fetch. Confirmed against a
    // real private feed: the app opens and reports "unable to find podcast", while
    // the same URL pasted into its search box subscribes at once.
    method: ADD_METHOD.PASTE,
    where: 'the search box on the Discover tab',
    build: (feedUrl) => String(feedUrl),
  },
  {
    id: 'overcast',
    // The odd one out: it wants the full URL, protocol included.
    label: 'Overcast',
    method: ADD_METHOD.LINK,
    build: (feedUrl) => `overcast://x-callback-url/add?url=${encodeURIComponent(feedUrl)}`,
  },
  {
    id: 'castro',
    label: 'Castro',
    method: ADD_METHOD.LINK,
    build: (feedUrl) => `castros://subscribe/${withoutScheme(feedUrl)}`,
  },
  {
    id: 'url',
    label: 'Any other app',
    // The universal fallback, and the only route that depends on nothing but the
    // app being able to fetch a URL.
    method: ADD_METHOD.PASTE,
    where: 'its “add by URL” or search box',
    build: (feedUrl) => String(feedUrl),
  },
]);

/**
 * Apple Podcasts first: it takes the feed by link, and it is the app most people
 * scanning a QR from a phone already have.
 */
export const DEFAULT_SUBSCRIBE_TARGET = 'apple';

export function buildSubscribeLinks(feedUrl) {
  if (!feedUrl) return [];
  return SUBSCRIBE_TARGETS.map((target) => ({
    id: target.id,
    label: target.label,
    url: target.build(feedUrl),
    method: target.method,
    where: target.where ?? null,
  }));
}
