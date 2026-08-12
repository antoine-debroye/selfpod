/**
 * Conditional-request and content-negotiation header parsing. Pure string work:
 * no Fastify, no I/O, so the awkward cases below can be pinned down by unit tests
 * instead of by staring at a podcast app's traffic.
 *
 * Everything here fails open — a header we cannot make sense of means "serve the
 * full response", never an error. A listener whose app cannot fetch the feed is a
 * far worse outcome than one who re-downloads a few kilobytes of XML.
 */

/**
 * One whole entity-tag: an optional weak marker followed by a quoted opaque-tag.
 * Matched with a regex rather than `split(',')` on purpose — see `etagMatches`.
 */
const ENTITY_TAG = /(?:W\/)?"[^"]*"/g;

/** Weak comparison ignores the `W/` marker; only the opaque-tag has to agree. */
function stripWeakMarker(tag) {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

/**
 * Does an `If-None-Match` header cover the ETag we issued?
 *
 * RFC 9110 §13.1.2 requires the *weak* comparison here, and that is not pedantry.
 * The README recommends putting SelfPod behind a Cloudflare Tunnel, and Cloudflare
 * re-emits strong ETags as weak ones: it hands the client back `W/"a1b2c3"` for the
 * `"a1b2c3"` we sent. A plain `ifNoneMatch === etag` comparison therefore never
 * matches, every poll from every subscribed app becomes a full feed download, and
 * nothing anywhere logs an error — the feed simply stops being cacheable and the
 * NAS quietly serves the same XML for ever.
 *
 * The list is scanned with a regex because a comma is a legal character inside an
 * opaque-tag: `"a1b2,c3"` is one tag, and `split(',')` cuts it into two fragments
 * that can never match anything again. Same silent failure, harder to spot.
 */
export function etagMatches(header, etag) {
  if (typeof header !== 'string') return false;
  if (typeof etag !== 'string' || !etag.trim()) return false;

  // `*` means "any current representation", which any tag we hold satisfies.
  if (header.trim() === '*') return true;

  // Bare unquoted tokens are not entity-tags, so a caller passing an unquoted
  // `etag` matches nothing: the candidates below always carry their quotes.
  const target = stripWeakMarker(etag.trim());
  for (const [candidate] of header.matchAll(ENTITY_TAG)) {
    if (stripWeakMarker(candidate) === target) return true;
  }
  return false;
}

/**
 * Is the client's dated copy still current, per `If-Modified-Since`?
 *
 * The stored instant is floored to whole seconds first. An HTTP-date has one-second
 * resolution, so a `Last-Modified` built from a timestamp carrying milliseconds is
 * rounded down on the way out — and the `If-Modified-Since` the client echoes back
 * is then always *earlier* than the instant we compare it against. Without the
 * floor the copy looks stale on every single request and the client re-downloads
 * for ever, which is exactly the bug conditional requests exist to prevent.
 */
export function notModifiedSince(header, lastModified) {
  if (typeof header !== 'string' || !(lastModified instanceof Date)) return false;

  const since = Date.parse(header);
  if (Number.isNaN(since)) return false; // Unreadable date: treat the copy as stale.

  const stored = lastModified.getTime();
  if (Number.isNaN(stored)) return false; // `new Date('nonsense')`.

  const flooredToSeconds = Math.floor(stored / 1000) * 1000;
  return flooredToSeconds <= since;
}

/** Splits `br;q=0.5` into a lowercased coding name and its q-weight (default 1). */
function parseCoding(part) {
  const [rawName, ...params] = part.split(';');
  const name = rawName.trim().toLowerCase();
  if (!name) return null;
  let weight = 1;
  for (const param of params) {
    const match = /^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/i.exec(param);
    if (!match) continue;
    const parsed = Number.parseFloat(match[1]);
    if (!Number.isNaN(parsed)) weight = parsed;
  }
  return { name, weight };
}

/**
 * The best content-coding this client accepts, or null meaning "send it as-is".
 *
 * Server preference wins: we walk `available` in our own order and take the first
 * coding the client will accept, rather than obeying the client's q-weights. The
 * ordering is ours because we know which encoding is cheapest for the NAS to serve.
 *
 * Nothing here ever throws and nothing ever signals a 406. RFC 9110 permits
 * refusing a request that accepts no available coding, but this is a podcast feed:
 * an app that cannot read it at all is a much worse outcome than one that reads a
 * bigger, uncompressed copy. When in doubt we return null and send plain bytes.
 */
export function preferredEncoding(header, available = ['br', 'gzip']) {
  if (typeof header !== 'string' || !header.trim()) return null;

  const weights = new Map();
  let wildcard = null; // The `*` weight, standing in for anything not named.
  for (const part of header.split(',')) {
    const coding = parseCoding(part);
    if (!coding) continue;
    if (coding.name === '*') wildcard = coding.weight;
    else weights.set(coding.name, coding.weight);
  }

  for (const candidate of available) {
    if (typeof candidate !== 'string') continue;
    const name = candidate.trim().toLowerCase();
    // An explicit `q=0` is a refusal and must not fall through to the wildcard.
    const weight = weights.has(name) ? weights.get(name) : wildcard;
    if (weight !== null && weight > 0) return candidate;
  }
  return null;
}
