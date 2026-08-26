import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';

/**
 * `@fastify/rate-limit` is registered with `global: false`, and these tests are why.
 *
 * Registering it globally is the obvious thing to do and would break the app's main
 * job. Every request in this suite shares one rate-limit key — `light-my-request`
 * gives them all the same `socket.remoteAddress` and no Cloudflare header — which is
 * exactly the situation a real deployment behind nginx, Traefik or Tailscale is in,
 * where the socket address is the proxy's and every listener in the world collapses
 * into a single bucket.
 *
 * So a burst here standing in for "one podcast app scrubbing through an episode" is a
 * faithful test, not a contrived one.
 */
describe('rate limiting is opt-in, never global', () => {
  let server;
  let show;
  let episode;

  before(async () => {
    server = await createTestServer();
    await server.login();
    await server.addAudio('tape-club', 'sample.mp3', 'one.mp3');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('tape-club');
    [episode] = server.episodes.listByShow(show.id);
  });

  after(async () => {
    await server.cleanup();
  });

  it('does not limit media, so scrubbing an episode cannot be cut off', async () => {
    // A player seeking through an episode issues a burst of Range requests. A 429 in
    // the middle of that is a broken episode, with nothing in SelfPod's logs to say
    // why — and it would look like a corrupt file, not a server refusing.
    const statuses = [];
    for (let i = 0; i < 40; i += 1) {
      const response = await server.app.inject({
        method: 'GET',
        url: `/media/${show.slug}/${show.feed_token}/${episode.id}/one.mp3`,
        headers: { range: `bytes=${i * 100}-${i * 100 + 99}` },
      });
      statuses.push(response.statusCode);
    }

    assert.ok(
      statuses.every((status) => status === 206 || status === 200),
      `a burst of range requests was rate limited: ${[...new Set(statuses)].join(', ')}`,
    );
  });

  it('does not limit the feed, so a polling app is never turned away', async () => {
    const statuses = [];
    for (let i = 0; i < 40; i += 1) {
      const response = await server.app.inject({ url: `/feeds/${show.slug}/${show.feed_token}.xml` });
      statuses.push(response.statusCode);
    }
    assert.ok(
      statuses.every((status) => status === 200 || status === 304),
      `feed polling was rate limited: ${[...new Set(statuses)].join(', ')}`,
    );
  });

  it('does not limit ordinary admin pages', async () => {
    // /ui/events reconnects every three seconds when a proxy severs it, which would
    // burn a shared bucket and then 429 the rest of the admin UI.
    const statuses = [];
    for (let i = 0; i < 40; i += 1) {
      const response = await server.get('/', { authed: true });
      statuses.push(response.statusCode);
    }
    assert.ok(
      statuses.every((status) => status < 400),
      `the dashboard was rate limited: ${[...new Set(statuses)].join(', ')}`,
    );
  });

  it('still limits a route that opts in', async () => {
    // The positive control. Without this, every assertion above would also pass if
    // the plugin had simply not been registered at all, and the tests would be
    // asserting the absence of a feature rather than the shape of one.
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await server.request({ method: 'POST', url: '/api/reachability' });
      statuses.push(response.statusCode);
    }
    assert.ok(statuses.includes(429), 'an opted-in route must still be limited');
  });

  it('reports a refusal in the app\'s own error shape', async () => {
    let limited = null;
    for (let i = 0; i < 12 && !limited; i += 1) {
      const response = await server.request({ method: 'POST', url: '/api/reachability' });
      if (response.statusCode === 429) limited = response;
    }
    assert.ok(limited, 'expected to be rate limited');

    const body = limited.json();
    // The API contract is {error: {message, code}}. The plugin's default body is a
    // different shape, and the UI's error handling degrades silently on it.
    assert.ok(body.error, `wrong error shape: ${JSON.stringify(body)}`);
    assert.ok(typeof body.error.message === 'string' && body.error.message.length > 10);
    assert.ok(!('statusCode' in body), 'the plugin default shape leaked through');
    assert.ok(limited.headers['retry-after'], 'an honest client needs to know when to come back');
    // Advertising the remaining budget tells an attacker how hard they may push.
    assert.equal(limited.headers['x-ratelimit-remaining'], undefined);
  });

  it('does not let an anonymous flood spend the admin\'s budget', async () => {
    // The limiter runs as a preHandler *after* authentication, not as the onRequest
    // hook that route-level `config.rateLimit` would give it. Declared the obvious
    // way round, someone who never signed in could exhaust the operator's own budget
    // and would be told "too many requests" instead of "sign in" — a denial of
    // service on the feature, mounted for free.
    const fresh = await createTestServer();
    try {
      for (let i = 0; i < 30; i += 1) {
        const anonymous = await fresh.app.inject({
          method: 'POST',
          url: '/api/reachability',
          headers: { 'sec-fetch-site': 'same-origin' },
        });
        assert.equal(
          anonymous.statusCode,
          401,
          `request ${i} was answered ${anonymous.statusCode}, so anonymous traffic is consuming budget`,
        );
      }

      // And the admin's budget is untouched: the first authenticated call still works.
      await fresh.login();
      const first = await fresh.request({ method: 'POST', url: '/api/reachability' });
      assert.notEqual(first.statusCode, 429, 'the admin was locked out by anonymous traffic');
    } finally {
      await fresh.cleanup();
    }
  });
});
