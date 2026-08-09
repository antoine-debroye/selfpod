/**
 * The only place in the codebase where feed / media / cover URLs are assembled.
 *
 * Every path segment is percent-encoded individually (spec §8.3 requirement 1).
 * String-concatenating a raw filename into a URL is what once produced feeds
 * that podcast clients rejected outright, for filenames containing spaces,
 * emoji, curly quotes or accented characters.
 */

/**
 * Encodes one path segment. `encodeURIComponent` escapes `/` too, which is
 * correct here: a filename can never legitimately contain a path separator, so
 * anything that looks like one is either an encoding artefact or an attempt at
 * traversal, and must not survive into the URL as structure.
 */
export function encodePathSegment(segment) {
  return encodeURIComponent(String(segment));
}

/** Strips a trailing slash and validates the shape required by spec §9. */
export function normaliseBaseUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.search || parsed.hash) return null;
  // Keep any base path the user's reverse proxy adds, minus the trailing slash.
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

function join(baseUrl, ...segments) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return `${base}/${segments.map(encodePathSegment).join('/')}`;
}

/** `{base}/feeds/{slug}/{token}.xml` — note the `.xml` is part of the last segment. */
export function feedUrl(baseUrl, slug, token) {
  return `${join(baseUrl, 'feeds', slug)}/${encodePathSegment(token)}.xml`;
}

/** `{base}/media/{slug}/{token}/{episodeId}/{filename}` (spec §8.4). */
export function mediaUrl(baseUrl, slug, token, episodeId, filename) {
  return join(baseUrl, 'media', slug, token, episodeId, filename);
}

/**
 * `{base}/media/{slug}/{token}/cover.jpg` — a stable handle. The server serves
 * whatever cover file it actually detected (which may be a .png) with that
 * file's real content type, so `cover.png` on disk works without the URL
 * changing (spec §10.3).
 */
export function coverUrl(baseUrl, slug, token, { cacheBust } = {}) {
  const url = join(baseUrl, 'media', slug, token, 'cover.jpg');
  return cacheBust ? `${url}?v=${encodeURIComponent(cacheBust)}` : url;
}

export function healthUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/health`;
}
