import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_SUBSCRIBE_TARGET,
  SUBSCRIBE_TARGETS,
  buildSubscribeLinks,
} from '../../src/web/lib/subscribe-links.js';

const FEED = 'https://selfpod.example.com/feeds/late-night/vSajnf5MUzA6iDOiHWygwf.xml';

/**
 * These formats are load-bearing. A QR or link with the wrong shape opens the right
 * podcast app and then fails to subscribe, which is worse than offering nothing —
 * the user has no way to tell whether the feed or the link is at fault.
 */
describe('subscribe links', () => {
  const byId = Object.fromEntries(buildSubscribeLinks(FEED).map((l) => [l.id, l.url]));

  it('strips the scheme for the apps that expect it', () => {
    assert.equal(byId.apple, 'podcast://selfpod.example.com/feeds/late-night/vSajnf5MUzA6iDOiHWygwf.xml');
    assert.equal(byId.pocketcasts, 'pktc://subscribe/selfpod.example.com/feeds/late-night/vSajnf5MUzA6iDOiHWygwf.xml');
    assert.equal(byId.castro, 'castros://subscribe/selfpod.example.com/feeds/late-night/vSajnf5MUzA6iDOiHWygwf.xml');
    for (const id of ['apple', 'pocketcasts', 'castro']) {
      assert.ok(!byId[id].includes('https://'), `${id} must not carry the feed's own scheme`);
    }
  });

  it('keeps the full URL for Overcast, which is the exception', () => {
    assert.equal(byId.overcast, `overcast://x-callback-url/add?url=${encodeURIComponent(FEED)}`);
    assert.ok(byId.overcast.includes('https%3A%2F%2F'), 'Overcast needs the protocol, percent-encoded');
  });

  it('offers the plain URL too, for apps with an add-by-URL box', () => {
    assert.equal(byId.url, FEED);
  });

  it('produces a URL a phone can act on for every target', () => {
    for (const { id, url } of buildSubscribeLinks(FEED)) {
      assert.match(url, /^[a-z]+:\/\//, `${id} should be a resolvable URL`);
      assert.ok(!/\s/.test(url), `${id} must not contain whitespace`);
    }
  });

  it('handles a feed on a plain-HTTP LAN address', () => {
    const links = Object.fromEntries(
      buildSubscribeLinks('http://192.168.1.5:31080/feeds/x/tok.xml').map((l) => [l.id, l.url]),
    );
    assert.equal(links.apple, 'podcast://192.168.1.5:31080/feeds/x/tok.xml');
    assert.ok(links.overcast.includes(encodeURIComponent('http://')));
  });

  it('returns nothing when no feed URL exists yet', () => {
    assert.deepEqual(buildSubscribeLinks(null), []);
    assert.deepEqual(buildSubscribeLinks(''), []);
  });

  it('defaults to a target that exists', () => {
    assert.ok(SUBSCRIBE_TARGETS.some((t) => t.id === DEFAULT_SUBSCRIBE_TARGET));
  });
});
