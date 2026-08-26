import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyAddress,
  ipv6ToBytes,
  normaliseSubscriptionUrl,
} from '../../src/lib/address-rules.js';

/**
 * The address table is driven on **raw addresses**, not URLs, and that is deliberate.
 *
 * A URL-driven table would have looked thorough and tested almost nothing of the hard
 * part: `new URL('http://[::ffff:192.168.1.1]/').hostname` is `"[::ffff:c0a8:101]"`,
 * and a classifier that returns "unparseable" for every bracketed literal passes such
 * a table from day one — and would keep passing it if the entire IPv4-mapped, 6to4,
 * NAT64 and Teredo unwrapping were deleted. Those forms are only ever reached through
 * an address a resolver returned, so that is the shape the table has to use.
 */

const REFUSED = [
  // --- IPv4, the ranges that are not public unicast --------------------------------
  ['0.0.0.0', 'unspecified', 'routes to localhost on Linux'],
  ['0.1.2.3', 'unspecified', 'all of 0/8, not just the all-zero address'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback', 'all of 127/8, not just 127.0.0.1'],
  ['10.0.0.1', 'private'],
  ['10.255.255.255', 'private'],
  ['172.16.0.1', 'private'],
  ['172.31.255.255', 'private', 'the top of the RFC1918 range'],
  ['192.168.0.1', 'private'],
  ['192.168.255.255', 'private'],
  ['100.64.0.1', 'cgnat', 'a NAS behind Starlink shares this with its ISP'],
  ['100.127.255.255', 'cgnat'],
  ['169.254.1.1', 'link_local'],
  ['169.254.169.254', 'link_local', 'the cloud metadata endpoint'],
  ['192.0.0.1', 'reserved'],
  ['192.0.2.1', 'reserved', 'TEST-NET-1'],
  ['198.51.100.1', 'reserved', 'TEST-NET-2'],
  ['203.0.113.1', 'reserved', 'TEST-NET-3'],
  ['192.88.99.1', 'reserved', '6to4 relay anycast'],
  ['198.18.0.1', 'reserved', 'benchmarking'],
  ['198.19.255.255', 'reserved'],
  ['192.31.196.1', 'reserved', 'AS112'],
  ['192.52.193.1', 'reserved', 'AS112'],
  ['192.175.48.1', 'reserved', 'AS112'],
  ['224.0.0.1', 'multicast'],
  ['239.255.255.255', 'multicast'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'reserved', 'broadcast'],

  // --- IPv6, refused by the 2000::/3 allow-list ------------------------------------
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['fd00::1', 'non_global', 'unique local'],
  ['fdff:ffff::1', 'non_global'],
  ['fc00::1', 'non_global'],
  ['fe80::1', 'non_global', 'link local'],
  ['febf::1', 'non_global'],
  ['fec0::1', 'non_global', 'deprecated site-local, missed by an enumerated deny-list'],
  ['ff02::1', 'non_global', 'multicast'],
  ['100::1', 'non_global', 'discard-only'],
  ['64:ff9b:1::1', 'non_global', 'local-use NAT64, missed by an enumerated deny-list'],
  ['0100::1', 'non_global'],
  ['1000::1', 'non_global', 'not yet assigned, and refused by default'],
  ['4000::1', 'non_global', 'outside 2000::/3'],
  ['2001:db8::1', 'reserved', 'documentation'],
  ['2001:20::1', 'reserved', 'ORCHIDv2'],
  ['3fff::1', 'reserved', 'documentation, RFC 9637'],

  // --- IPv4 hidden inside IPv6 -----------------------------------------------------
  ['::ffff:192.168.1.1', 'private', 'IPv4-mapped'],
  ['::ffff:c0a8:101', 'private', 'the same address as a WHATWG URL rewrites it'],
  ['::ffff:127.0.0.1', 'loopback'],
  ['::ffff:169.254.169.254', 'link_local'],
  ['::192.168.1.1', 'private', 'IPv4-compatible, deprecated but still parsed'],
  ['64:ff9b::c0a8:101', 'private', 'NAT64 well-known prefix'],
  ['64:ff9b::192.168.1.1', 'private'],
  ['2002:c0a8:0101::', 'private', '6to4 — sits inside 2000::/3, so the allow-list alone would pass it'],
  ['2002:7f00:0001::', 'loopback', '6to4 wrapping 127.0.0.1'],
  ['2001:0:0:0:0:0:3f57:fefe', 'private', 'Teredo, whose embedded address is bit-inverted'],

  // --- not addresses at all --------------------------------------------------------
  ['not-an-ip', 'unparseable'],
  ['', 'unparseable'],
  ['999.999.999.999', 'unparseable'],
  ['1.2.3', 'unparseable'],
  [null, 'unparseable'],
  [undefined, 'unparseable'],
];

const ALLOWED = [
  ['1.1.1.1', 'Cloudflare DNS'],
  ['8.8.8.8', 'Google DNS'],
  ['93.184.216.34', 'a plain public host'],
  ['172.15.255.255', 'just below the RFC1918 block — 172.x is not all private'],
  ['172.32.0.1', 'just above it'],
  ['100.63.255.255', 'just below CGNAT'],
  ['100.128.0.1', 'just above CGNAT'],
  ['126.255.255.255', 'just below loopback'],
  ['128.0.0.1', 'just above it'],
  ['223.255.255.255', 'just below multicast'],
  ['2606:4700:4700::1111', 'a real public IPv6 host'],
  ['2a00:1450:4009::200e', 'another'],
  ['2000::1', 'the very bottom of the global range'],
  ['3ffe::1', 'inside 2000::/3, and not inside the 3fff::/20 carve-out'],
  ['3fff:1000::1', 'just outside 3fff::/20, which is only 3fff:0000-3fff:0fff'],
  ['2400::1', 'APNIC space'],
];

describe('every address SelfPod connects to must be public unicast', () => {
  for (const [address, category, why] of REFUSED) {
    it(`refuses ${JSON.stringify(address)}${why ? ` — ${why}` : ''}`, () => {
      const verdict = classifyAddress(address);
      assert.equal(verdict.ok, false, `${address} was allowed`);
      assert.equal(verdict.category, category, `${address} was refused for the wrong reason`);
    });
  }

  for (const [address, why] of ALLOWED) {
    it(`allows ${address} — ${why}`, () => {
      // The positive half matters as much as the negative one. A classifier that
      // refused everything would pass every test above and break the feature.
      const verdict = classifyAddress(address);
      assert.equal(verdict.ok, true, `${address} was refused as ${verdict.category}`);
    });
  }
});

describe('bracketed and zoned forms reach the real rules', () => {
  it('accepts the bracketed form a URL hands over', () => {
    // If this returned "unparseable", every IPv6 rule would be dead code on the path
    // that matters, and the tests above would still be green.
    assert.deepEqual(classifyAddress('[::1]'), { ok: false, category: 'loopback' });
    assert.deepEqual(classifyAddress('[fd00::1]'), { ok: false, category: 'non_global' });
    assert.deepEqual(classifyAddress('[2606:4700:4700::1111]'), { ok: true });
  });

  it('refuses a zoned link-local address for being link-local, not for being odd', () => {
    assert.equal(classifyAddress('fe80::1%eth0').category, 'non_global');
  });
});

describe('ipv6ToBytes', () => {
  const cases = [
    ['::1', '00000000000000000000000000000001'],
    ['::', '00000000000000000000000000000000'],
    ['2001:db8::1', '20010db8000000000000000000000001'],
    ['::ffff:192.168.1.1', '00000000000000000000ffffc0a80101'],
    ['64:ff9b::c0a8:101', '0064ff9b0000000000000000c0a80101'],
    ['2606:4700:4700::1111', '26064700470000000000000000001111'],
    ['fe80:0:0:0:0:0:0:1', 'fe800000000000000000000000000001'],
  ];
  for (const [address, hex] of cases) {
    it(`expands ${address}`, () => {
      const bytes = ipv6ToBytes(address);
      assert.ok(bytes, `${address} did not expand`);
      assert.equal(bytes.length, 16);
      assert.equal(bytes.map((b) => b.toString(16).padStart(2, '0')).join(''), hex);
    });
  }

  it('returns null for what is not an IPv6 address', () => {
    for (const bad of ['1.2.3.4', 'nonsense', '', '1::2::3']) {
      assert.equal(ipv6ToBytes(bad), null, bad);
    }
  });
});

describe('normaliseSubscriptionUrl', () => {
  const refuse = (input, reason) => {
    const result = normaliseSubscriptionUrl(input);
    assert.equal(result.reason, reason, `${input} → ${JSON.stringify(result)}`);
  };

  it('accepts an ordinary feed URL', () => {
    const result = normaliseSubscriptionUrl('https://feeds.example.com/show.xml');
    assert.equal(result.hostname, 'feeds.example.com');
    assert.equal(result.url.href, 'https://feeds.example.com/show.xml');
  });

  it('refuses a scheme that is not http or https', () => {
    for (const scheme of [
      'file:///etc/passwd',
      'gopher://127.0.0.1:70/',
      'ftp://192.168.0.1/',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'dict://127.0.0.1:2628/',
      'ws://example.com/',
      'blob:https://example.com/x',
    ]) {
      refuse(scheme, 'bad_scheme');
    }
  });

  it('refuses a port that is not 80 or 443', () => {
    // RFC1918 blocking still leaves the whole internet reachable on any port, and a
    // router that forwards a public address back inside is an ordinary setup.
    refuse('http://feeds.example.com:9200/', 'blocked_port');
    refuse('https://feeds.example.com:8443/', 'blocked_port');
    refuse('http://feeds.example.com:443/', 'blocked_port');
    refuse('https://feeds.example.com:80/', 'blocked_port');
  });

  it('accepts the port that matches the scheme, written out or omitted', () => {
    assert.equal(normaliseSubscriptionUrl('https://feeds.example.com:443/x').hostname, 'feeds.example.com');
    assert.equal(normaliseSubscriptionUrl('http://feeds.example.com:80/x').hostname, 'feeds.example.com');
  });

  it('refuses credentials in the URL, password-only included', () => {
    refuse('http://evil.com@192.168.1.1/', 'credentials_in_url');
    // The one an `if (url.username)` check sails straight past.
    refuse('http://:token@192.168.1.1/', 'credentials_in_url');
    refuse('http://user:pass@feeds.example.com/', 'credentials_in_url');
    refuse('http://user%40evil:p%40ss@192.168.1.1/', 'credentials_in_url');
  });

  it('refuses names that never resolve to anything public', () => {
    for (const name of [
      'http://localhost/feed.xml',
      'http://LOCALHOST/feed.xml',
      'http://my-nas.local/feed.xml',
      'http://thing.internal/feed.xml',
      'http://x.home.arpa/feed.xml',
      'http://1.0.0.127.in-addr.arpa/feed.xml',
    ]) {
      refuse(name, 'blocked_address');
    }
  });

  it('is not fooled by a trailing dot', () => {
    // "localhost." resolves perfectly well, while an equality test against
    // "localhost" and an endsWith('.local') check both miss it.
    refuse('http://localhost./feed.xml', 'blocked_address');
    refuse('http://my-nas.local./feed.xml', 'blocked_address');
  });

  it('strips a trailing dot so one origin cannot be stored twice', () => {
    // Otherwise "example.com" and "example.com." are two rows under a UNIQUE
    // constraint on the feed URL, halving the effective poll interval against one
    // publisher and doubling the subscription count against its cap.
    assert.equal(normaliseSubscriptionUrl('https://feeds.example.com./x').hostname, 'feeds.example.com');
  });

  it('refuses every obfuscated spelling of a private address, at the field', () => {
    // Judged here rather than only at fetch time, so the operator is told "that is a
    // private address" against the box they are still looking at, instead of
    // "could not be reached" an hour later from a background poll.
    for (const spelling of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://127.1/']) {
      refuse(spelling, 'blocked_address');
    }
  });

  it('canonicalises those spellings to one address before judging them', () => {
    // The WHATWG parser does the decoding for free; this pins the behaviour so nobody
    // adds a hand-rolled octal/hex decoder later. Exercised through the allow-list,
    // which is the only way a private literal is ever accepted.
    const allowedHosts = new Set(['127.0.0.1']);
    for (const spelling of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://127.1/']) {
      const result = normaliseSubscriptionUrl(spelling, { allowedHosts });
      assert.equal(result.hostname, '127.0.0.1', spelling);
      assert.equal(classifyAddress(result.hostname).category, 'loopback');
    }
  });

  it('hands back an IPv6 literal without its brackets', () => {
    // So the caller can pass it straight to a resolver and to classifyAddress.
    assert.equal(normaliseSubscriptionUrl('http://[2606:4700:4700::1111]/').hostname, '2606:4700:4700::1111');
  });

  it('refuses a private IPv6 literal at the field too', () => {
    refuse('http://[::1]/', 'blocked_address');
    refuse('http://[fd00::1]/', 'blocked_address');
    // The form a WHATWG URL rewrites ::ffff:192.168.1.1 into.
    refuse('http://[::ffff:192.168.1.1]/', 'blocked_address');
  });

  it('exempts only the exact addresses named in the allow-list', () => {
    const allowedHosts = new Set(['127.0.0.1']);
    assert.equal(normaliseSubscriptionUrl('http://127.0.0.1/f', { allowedHosts }).hostname, '127.0.0.1');
    // Naming one address must not open its neighbours, its range, or anything else.
    assert.equal(normaliseSubscriptionUrl('http://127.0.0.2/f', { allowedHosts }).reason, 'blocked_address');
    assert.equal(normaliseSubscriptionUrl('http://10.0.0.1/f', { allowedHosts }).reason, 'blocked_address');
    assert.equal(normaliseSubscriptionUrl('http://[::1]/f', { allowedHosts }).reason, 'blocked_address');
  });

  it('refuses what is not a URL at all', () => {
    for (const bad of ['not a url', '', '   ', null, undefined, 42, {}]) {
      refuse(bad, 'bad_url');
    }
  });

  it('refuses an absurdly long URL or hostname', () => {
    refuse(`https://example.com/${'a'.repeat(3000)}`, 'bad_url');
    refuse(`https://${'a'.repeat(300)}.com/`, 'bad_url');
  });

  it('lowercases the hostname so one origin has one spelling', () => {
    assert.equal(normaliseSubscriptionUrl('https://FEEDS.Example.COM/x').hostname, 'feeds.example.com');
  });

  it('punycodes an internationalised name rather than returning Unicode', () => {
    // Homographs are a display problem, not an SSRF one — the address it resolves to
    // is what matters. But the stored and displayed form must be the ASCII one.
    const result = normaliseSubscriptionUrl('https://аpple.com/feed.xml');
    assert.match(result.hostname, /^[a-z0-9.-]+$/, `not ASCII: ${result.hostname}`);
    assert.match(result.hostname, /^xn--/);
  });
});
