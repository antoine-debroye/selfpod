import { evaluateItem } from './feed-filter.js';

/**
 * The only thing a route may hand back about a remote feed (spec §18.5).
 *
 * The reachability check returns nothing at all from what it fetched, and that
 * absolute rule cannot survive here — the whole point of a preview is to show the user
 * the episodes they are about to filter. So it is replaced by a narrower one: the reply
 * is built field by field from a closed list, each one type-checked and length-clamped,
 * and nothing else from the response can reach it by any route.
 *
 * This matters more than it looks, because there is one hole the address rules cannot
 * close. A public host that proxies inwards — `https://someproxy.example/?url=
 * http://192.168.1.1/` — resolves public, connects public, and returns the LAN's reply.
 * No address check can see that. This projection is the control for it: the LAN service
 * would have to be emitting valid RSS, and even then only these fields, at these
 * lengths, would come back. Not theatre, and not sufficient on its own either.
 *
 * Deliberately absent, and each for its own reason:
 *
 *  - the raw body, or any slice of it;
 *  - **any** response header — `Server`, `WWW-Authenticate`, `Set-Cookie`;
 *  - **the redirect chain**, including its length. A chain is a read primitive:
 *    `feed.evil → 302 → http://192.168.1.50:8006/` reveals whether Proxmox is on .50
 *    purely by whether the hop succeeded;
 *  - resolved IP addresses;
 *  - upstream error bodies or error codes.
 */

const MAX_PREVIEW_ITEMS = 50;

/** Hosts are shown to the operator, so they must be plain ASCII, not lookalikes. */
const SAFE_HOST = /^[a-z0-9.-]{1,253}$/;

function clampText(value, limit) {
  const text = String(value ?? '').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * The enclosure's host, or null.
 *
 * Kept because it is genuinely useful — "this show's audio is on a CDN you don't
 * recognise" is worth knowing — but asserted ASCII first. A host reaches the admin UI
 * as text, and an internationalised name renders as its Unicode form unless something
 * insists otherwise: right-to-left override characters and homograph domains both
 * become a display problem at that point. One regex removes the whole class, and
 * `URL` has already punycoded the name by the time it gets here.
 */
function hostOf(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return SAFE_HOST.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * Builds the preview: what the feed says it is, and what each item's fate would be.
 *
 * The verdicts are the useful half. Showing which episodes match is worth something;
 * showing *why* the others do not is what turns a filter from a guess into a setting
 * someone can adjust with confidence, before a single byte is downloaded.
 */
export function projectFeed(feed, rules = {}) {
  const items = [];
  for (const item of feed.items.slice(0, MAX_PREVIEW_ITEMS)) {
    const verdict = evaluateItem(item, rules);
    items.push({
      guid: clampText(item.guid, 200),
      guidSource: item.guidSource,
      title: clampText(item.title, 300),
      // Re-serialised from a parsed Date, never echoed as the remote wrote it.
      publishedAt: item.pubDate ?? null,
      durationSeconds:
        Number.isFinite(item.declaredDurationSeconds) && item.declaredDurationSeconds >= 0
          ? Math.min(86400, Math.round(item.declaredDurationSeconds))
          : null,
      enclosure: item.enclosureUrl
        ? {
            // Host only. The full URL of a private feed's audio carries the listener
            // token that identifies the operator to the publisher.
            host: hostOf(item.enclosureUrl),
            contentType: item.enclosureType ?? null,
            sizeBytes:
              Number.isFinite(item.enclosureLengthBytes) && item.enclosureLengthBytes > 0
                ? item.enclosureLengthBytes
                : null,
          }
        : null,
      keep: verdict.keep,
      reason: verdict.reason,
      detail: verdict.detail,
      needsDownloadToDecide: verdict.durationCheck === 'deferred',
    });
  }

  return {
    feed: {
      title: clampText(feed.title, 200),
      // Already reduced to plain text at parse time; clamped again here so this
      // function's contract holds whatever it is handed.
      description: clampText(feed.description, 2000),
      language: /^[a-z]{2}(-[a-z]{2})?$/i.test(feed.language ?? '') ? feed.language : null,
      author: clampText(feed.author, 200),
      // An href only, and never fetched at preview time — rendering a remote <img>
      // would let a feed track when the admin is looking. Blocked by the CSP anyway
      // (img-src 'self' data:), and that is deliberately left in place.
      imageUrl: feed.imageUrl && /^https?:\/\//i.test(feed.imageUrl) ? clampText(feed.imageUrl, 2000) : null,
      episodeCount: Math.min(500, feed.items.length),
    },
    items,
    matchCount: items.filter((item) => item.keep).length,
    truncated: feed.items.length > MAX_PREVIEW_ITEMS,
  };
}
