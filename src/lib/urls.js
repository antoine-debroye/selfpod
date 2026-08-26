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

/**
 * `{base}/media/{slug}/{token}/{episodeId}/{filename}` (spec §8.4).
 *
 * `cacheBust` is the content version of the bytes this URL currently serves, and it
 * is what makes replacing an episode's audio — cutting adverts out of it — safe. The
 * hazard is not a stale copy, which podcast apps tolerate: it is that this route
 * serves byte ranges, so a client holding the first half of one file and asking for
 * the rest would be handed the second half of a different one and would stitch the
 * two together without any error to notice. A version in the URL means the second
 * request is simply a different resource. `coverUrl` has done this since §10.3.
 */
export function mediaUrl(baseUrl, slug, token, episodeId, filename, { cacheBust } = {}) {
  const url = join(baseUrl, 'media', slug, token, episodeId, filename);
  return cacheBust ? `${url}?v=${encodeURIComponent(cacheBust)}` : url;
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

/**
 * `{base}/media/{slug}/{token}/{episodeId}/cover.jpg` — this episode's own artwork.
 *
 * One segment deeper than the show cover and, like it, always ending in `cover.jpg`
 * whatever the stored file really is; the server sends the real content type. The
 * cache-buster is the artwork's content hash, so replacing the image gives it a URL
 * no app has already cached, and re-extracting the identical image does not.
 */
export function episodeArtUrl(baseUrl, slug, token, episodeId, { cacheBust } = {}) {
  const url = join(baseUrl, 'media', slug, token, episodeId, 'cover.jpg');
  return cacheBust ? `${url}?v=${encodeURIComponent(cacheBust)}` : url;
}

export function healthUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/health`;
}
