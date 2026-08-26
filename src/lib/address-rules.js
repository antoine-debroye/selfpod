import { isIP, isIPv4, isIPv6 } from 'node:net';

/**
 * What SelfPod is allowed to talk to (spec §18.4).
 *
 * SelfPod runs in a container on a NAS that can see the rest of the home network, and
 * it is frequently exposed to the internet through a tunnel. Before this feature it
 * made exactly one outbound request, to an address the operator had typed in and could
 * see on their own dashboard. A subscription is different in kind: it is a URL chosen
 * by whoever can reach the admin UI, fetched by a background timer, for ever, with no
 * human watching. So the rule is narrow and absolute — **every address SelfPod connects
 * to must be public unicast** — and this module is the only place that decides it.
 *
 * Pure by design: no DNS, no sockets, no clock. Everything here is a decision about a
 * string or a set of bytes, which is what makes the ~60 cases in the tests worth
 * having. The resolving and the connecting live in guarded-fetch.js, which asks this
 * module and is not allowed to have an opinion of its own.
 *
 * ## What this cannot do
 *
 * Two holes are real and unclosable here, and pretending otherwise would be worse than
 * naming them:
 *
 *  - **A public host that proxies into a private one.** `https://someproxy.example/
 *    ?url=http://192.168.1.1/` resolves public, connects public, and returns the LAN's
 *    reply. No address rule can see that. It is why the projection handed back to the
 *    admin is a bounded set of named fields rather than anything derived from the
 *    response body — that projection is the control for this case, not this file.
 *  - **SelfPod's own public address.** Behind a tunnel it resolves to a public address
 *    like any other, so nothing here rejects it. guarded-fetch.js checks for that
 *    separately, with a signed probe header.
 */

/** RFC 1035 caps a name at 253 characters; beyond that it is not a hostname. */
const MAX_HOSTNAME_LENGTH = 253;
const MAX_URL_LENGTH = 2048;

/**
 * Names that never resolve to anything public.
 *
 * Defence in depth rather than the control — `classifyAddress` catches these anyway
 * once they resolve. The value of refusing them by name is that `.local` goes to mDNS,
 * where resolver behaviour is genuinely hard to reason about and varies by platform.
 */
const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.arpa'];

/**
 * IPv4 ranges that are not public unicast, as [first octet mask] predicates.
 *
 * A deny-list is correct for IPv4 — the public space is the default and the exceptions
 * are enumerable and stable. (IPv6 gets the opposite treatment; see below.)
 */
function classifyIPv4(bytes) {
  const [a, b] = bytes;

  // 0.0.0.0/8 — "this network". 0.0.0.0 routes to localhost on Linux, which is the
  // whole reason it is here rather than being dismissed as unroutable.
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback'; // all of 127/8, not just 127.0.0.1
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // .16–.31 only, not all of 172.x
  if (a === 192 && b === 168) return 'private';
  // Carrier-grade NAT. A NAS behind Starlink or a mobile connection shares this range
  // with its ISP, so it is as reachable-but-not-yours as RFC1918.
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  // Link-local, which subsumes the 169.254.169.254 cloud metadata endpoint.
  if (a === 169 && b === 254) return 'link_local';
  if (a === 192 && b === 0 && bytes[2] === 0) return 'reserved'; // IETF protocol assignments
  if (a === 192 && b === 0 && bytes[2] === 2) return 'reserved'; // TEST-NET-1
  if (a === 198 && b === 51 && bytes[2] === 100) return 'reserved'; // TEST-NET-2
  if (a === 203 && b === 0 && bytes[2] === 113) return 'reserved'; // TEST-NET-3
  if (a === 192 && b === 88 && bytes[2] === 99) return 'reserved'; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // benchmarking
  // AS112 direct delegation.
  if (a === 192 && b === 31 && bytes[2] === 196) return 'reserved';
  if (a === 192 && b === 52 && bytes[2] === 193) return 'reserved';
  if (a === 192 && b === 175 && bytes[2] === 48) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved'; // subsumes 255.255.255.255

  return null;
}

/** Expands any legal IPv6 text form to exactly 16 bytes, or null. */
export function ipv6ToBytes(address) {
  if (!isIPv6(address)) return null;

  let text = address;
  let embedded = null;

  // A trailing dotted quad, as in ::ffff:192.168.1.1 or ::192.168.1.1.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const quad = dotted[1].split('.').map(Number);
    if (quad.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    embedded = quad;
    text = text.slice(0, dotted.index + 1);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }

  const [head, tail, ...rest] = text.split('::');
  if (rest.length) return null; // more than one "::" is not a valid address

  const parse = (part) =>
    part && part.length ? part.split(':').filter((group) => group.length) : [];

  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);

  const groups = [];
  const embeddedGroups = embedded ? 2 : 0;
  if (tail === undefined) {
    groups.push(...left);
  } else {
    const missing = 8 - embeddedGroups - left.length - right.length;
    if (missing < 0) return null;
    groups.push(...left, ...Array.from({ length: missing }, () => '0'), ...right);
  }
  if (groups.length + embeddedGroups !== 8) return null;

  const bytes = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  if (embedded) bytes.push(...embedded);

  return bytes.length === 16 ? bytes : null;
}

function bytesEqual(bytes, from, values) {
  return values.every((value, index) => bytes[from + index] === value);
}

function allZero(bytes, from, to) {
  for (let i = from; i <= to; i += 1) if (bytes[i] !== 0) return false;
  return true;
}

/**
 * Finds an IPv4 address hiding inside an IPv6 one.
 *
 * Five forms embed IPv4, and each is a way to name a private address in a shape that a
 * naive IPv6 check waves through. `::ffff:192.168.1.1` is the obvious one; a WHATWG URL
 * even rewrites it to `[::ffff:c0a8:101]`, so a string search for "::ffff:" followed by
 * a dotted quad misses it entirely and the bytes have to be inspected instead. 6to4 and
 * Teredo matter because both sit *inside* the global 2000::/3 range and would otherwise
 * be allowed by the rule below.
 */
function embeddedIPv4(bytes) {
  // IPv4-mapped ::ffff:0:0/96
  if (allZero(bytes, 0, 9) && bytesEqual(bytes, 10, [0xff, 0xff])) return bytes.slice(12, 16);

  // NAT64 well-known prefix 64:ff9b::/96
  if (bytesEqual(bytes, 0, [0x00, 0x64, 0xff, 0x9b]) && allZero(bytes, 4, 11)) {
    return bytes.slice(12, 16);
  }

  // 6to4 2002::/16 — the embedded address is the *relay's*, at bytes 2..5.
  if (bytesEqual(bytes, 0, [0x20, 0x02])) return bytes.slice(2, 6);

  // Teredo 2001:0::/32 — the client address is at bytes 12..15, bitwise inverted.
  if (bytesEqual(bytes, 0, [0x20, 0x01, 0x00, 0x00])) {
    return bytes.slice(12, 16).map((byte) => byte ^ 0xff);
  }

  // IPv4-compatible ::a.b.c.d (deprecated, still parsed by everything). Excludes
  // :: and ::1, which are their own thing and handled below.
  if (allZero(bytes, 0, 11) && !allZero(bytes, 12, 15) && !bytesEqual(bytes, 12, [0, 0, 0, 1])) {
    return bytes.slice(12, 16);
  }

  return null;
}

/**
 * IPv6 gets an allow-list, where IPv4 gets a deny-list.
 *
 * "Public unicast" in IPv6 is exactly 2000::/3, so testing for membership is both
 * simpler and permanently correct. An earlier draft enumerated the ranges to refuse
 * and had already missed fec0::/10 (deprecated site-local, still honoured by some
 * stacks), 64:ff9b:1::/48, 2001:20::/28 and 3fff::/20 — and would have gone on missing
 * whatever IANA allocates next. Three lines here cannot fall behind.
 */
function classifyIPv6(bytes) {
  const inner = embeddedIPv4(bytes);
  if (inner) {
    const verdict = classifyIPv4(inner);
    return verdict ?? 'embedded_ipv4';
  }

  if (allZero(bytes, 0, 15)) return 'unspecified'; // ::
  if (allZero(bytes, 0, 14) && bytes[15] === 1) return 'loopback'; // ::1

  // Everything outside 2000::/3: unique-local fc00::/7, link-local fe80::/10,
  // multicast ff00::/8, site-local fec0::/10, 100::/64 discard-only, and every
  // range not yet assigned.
  if ((bytes[0] & 0xe0) !== 0x20) return 'non_global';

  // Carve-outs inside 2000::/3 that are global-shaped but not usable addresses.
  if (bytesEqual(bytes, 0, [0x20, 0x01, 0x0d, 0xb8])) return 'reserved'; // 2001:db8::/32 docs
  if (bytesEqual(bytes, 0, [0x20, 0x01]) && (bytes[2] === 0x00 && (bytes[3] & 0xf0) === 0x20)) {
    return 'reserved'; // 2001:20::/28 ORCHIDv2
  }
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0x00) {
    return 'reserved'; // 3fff::/20 documentation
  }

  return null;
}

/**
 * Decides whether one literal address may be connected to.
 *
 * @returns {{ ok: true } | { ok: false, category: string }}
 */
export function classifyAddress(address) {
  const value = String(address ?? '').trim();
  // Accept the bracketed form so callers reading straight from a URL do not each have
  // to remember to strip them — forgetting is silent, and silently fails *open* in the
  // sense that every IPv6 rule below would be skipped as unparseable.
  const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  // A zone index (fe80::1%eth0) is only ever link-local, but strip it so the parse
  // succeeds and the real rule refuses it rather than "unparseable".
  const withoutZone = bare.includes('%') ? bare.slice(0, bare.indexOf('%')) : bare;

  if (isIPv4(withoutZone)) {
    const bytes = withoutZone.split('.').map(Number);
    const category = classifyIPv4(bytes);
    return category ? { ok: false, category } : { ok: true };
  }

  if (isIPv6(withoutZone)) {
    const bytes = ipv6ToBytes(withoutZone);
    if (!bytes) return { ok: false, category: 'unparseable' };
    const category = classifyIPv6(bytes);
    return category ? { ok: false, category } : { ok: true };
  }

  // Not an address at all. Fail closed: this function is only ever asked about
  // something that is supposed to be one.
  return { ok: false, category: 'unparseable' };
}

/**
 * Validates and canonicalises a subscription URL before anything is resolved.
 *
 * `allowedHosts` is the ALLOW_PRIVATE_FEED_HOSTS list, and exempts only the literal
 * addresses named in it — never a range, never a hostname. `allowedPorts` widens
 * **only** the port rule, and only to ports named explicitly.
 * Every other rule — scheme, credentials, hostname suffixes, length — stays live, and
 * the address rules are not touched at all. It exists because a test server binds to
 * an ephemeral port and because an operator with a feed on their own LAN may genuinely
 * serve it on one; it is deliberately not a switch that turns the guard off, so there
 * is no path by which relaxing it relaxes anything else.
 *
 * @returns {{ url: URL, hostname: string } | { reason: string }}
 *   `hostname` is the bare form — brackets stripped, trailing dot removed — which is
 *   what a resolver and `classifyAddress` both want.
 */
export function normaliseSubscriptionUrl(input, { allowedPorts = null, allowedHosts = null } = {}) {
  if (typeof input !== 'string') return { reason: 'bad_url' };
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return { reason: 'bad_url' };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { reason: 'bad_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { reason: 'bad_scheme' };

  // Both, not just the username: `http://:token@192.168.1.1/` has an empty username
  // and a password, and the obvious `if (url.username)` check sails straight past it.
  if (url.username || url.password) return { reason: 'credentials_in_url' };

  // Restricting to 80 and 443 is not decoration. Refusing private address space still
  // leaves the entire public internet reachable on any port, and a home router that
  // forwards a public address back inside is an ordinary setup. No podcast host serves
  // a feed on 9200, and Elasticsearch does.
  if (!url.hostname) return { reason: 'bad_url' };

  let hostname = url.hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  // A single trailing dot is the root-anchored form of a name. The OS resolves
  // "localhost." perfectly well, while `endsWith('.local')` and an equality test
  // against "localhost" both miss it — and it doubles as a way to store the same
  // origin twice under a UNIQUE(feed_url) constraint, halving the effective poll
  // interval against one publisher.
  if (hostname.endsWith('.') && hostname.length > 1) hostname = hostname.slice(0, -1);

  if (!hostname || hostname.length > MAX_HOSTNAME_LENGTH) return { reason: 'bad_url' };

  const exempted = allowedHosts instanceof Set && allowedHosts.has(hostname.toLowerCase());

  if (isIP(hostname) === 0) {
    if (hostname === 'localhost') return { reason: 'blocked_address' };
    if (PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
      return { reason: 'blocked_address' };
    }
    // Write the cleaned name back, or the canonicalisation never reaches what callers
    // actually store. `url.href` still carries the trailing dot otherwise, so
    // "example.com" and "example.com." remain two distinct rows under a UNIQUE
    // constraint on the feed URL — which is the precise thing stripping it was for.
    if (url.hostname !== hostname) url.hostname = hostname;
  } else {
    // A literal address can be judged right now, with no resolver involved. Doing it
    // here as well as at fetch time is not redundancy for its own sake: it turns
    // "SelfPod could not reach that address" an hour later into "that address is on a
    // private network" against the field the operator is still looking at.
    const verdict = classifyAddress(hostname);
    if (!verdict.ok && !exempted) return { reason: 'blocked_address' };
  }

  // Checked last, so `exempted` is known. Restricting to 80 and 443 is not
  // decoration: refusing private address space still leaves the entire public
  // internet reachable on any port, and a home router that forwards a public address
  // back inside is an ordinary setup. No podcast host serves a feed on 9200;
  // Elasticsearch does.
  //
  // An address the operator named in ALLOW_PRIVATE_FEED_HOSTS is exempt from this
  // too, and that is deliberate rather than incidental: someone who has said "I trust
  // this specific machine" almost always means its own port as well — a feed served
  // from a NAS app on :8096 is the ordinary case — and making them name the port
  // separately would be a second knob describing the same decision.
  const expectedPort = url.protocol === 'https:' ? '443' : '80';
  const portAllowed =
    url.port === '' ||
    url.port === expectedPort ||
    exempted ||
    (allowedPorts instanceof Set && allowedPorts.has(url.port));
  if (!portAllowed) return { reason: 'blocked_port' };

  return { url, hostname };
}
