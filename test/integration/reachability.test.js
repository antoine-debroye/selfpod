import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';

/**
 * The public-address test.
 *
 * The behaviour that matters is the verdict being *honest*: the browser cannot tell
 * "your address is broken" from "your browser refused the call", and reporting the
 * second as the first sent the operator to check DNS for an address that worked. The
 * server-side half is what makes the distinction possible, and the nonce is what stops
 * some other server on that hostname passing as this one.
 */
describe('public address reachability', () => {
  let server;

  before(async () => {
    server = await createTestServer();
    await server.login();
  });

  after(async () => {
    await server.cleanup();
  });

  describe('the /health instance proof', () => {
    it('answers a nonce with a proof only this install can compute', async () => {
      const response = await server.app.inject({ url: '/health?ping=abc123DEF' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.ping, 'abc123DEF');
      assert.equal(body.status, 'ok');
      assert.match(body.pong, /^[0-9a-f]{64}$/, 'the proof is an HMAC, not the nonce echoed back');
      assert.notEqual(body.pong, 'abc123DEF');
    });

    it('produces a different proof on a different install', async () => {
      // The whole point: two SelfPods answering the same nonce must not be
      // interchangeable, or "is that my container?" is unanswerable.
      const other = await createTestServer();
      try {
        const mine = (await server.app.inject({ url: '/health?ping=samenonce' })).json();
        const theirs = (await other.app.inject({ url: '/health?ping=samenonce' })).json();
        assert.equal(mine.ping, theirs.ping);
        assert.notEqual(mine.pong, theirs.pong, 'two installs must not sign alike');
      } finally {
        await other.cleanup();
      }
    });

    it('signs nothing that is not a plain short token', async () => {
      for (const ping of ['<script>', 'a b', 'x'.repeat(65), '../../etc', 'a;b', '"quoted"']) {
        const response = await server.app.inject({
          url: `/health?ping=${encodeURIComponent(ping)}`,
        });
        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.ping, undefined, `must not reflect ${JSON.stringify(ping)}`);
        assert.equal(body.pong, undefined, `must not sign ${JSON.stringify(ping)}`);
      }
    });

    it('is absent when nothing was asked', async () => {
      const body = (await server.app.inject({ url: '/health' })).json();
      assert.equal(body.ping, undefined);
      assert.equal(body.pong, undefined);
    });
  });

  describe('the server-side check', () => {
    it('requires the admin session', async () => {
      const anonymous = await server.app.inject({
        method: 'POST',
        url: '/api/reachability',
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(anonymous.statusCode, 401);
    });

    it('reports a base URL that resolves to nothing, naming the real cause', async () => {
      // The test harness is configured with podcast.example.com, which does not
      // resolve — the useful case, since that is what a typo produces.
      const response = await server.request({ method: 'POST', url: '/api/reachability' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.checked, true);
      assert.equal(body.reachable, false);
      assert.equal(body.sameInstance, false);
      assert.ok(body.message.length > 0, 'a failure must come with a sentence');
      // Never the generic "fetch failed" that Node hands back.
      assert.ok(!/fetch failed/i.test(body.message), `unhelpful message: ${body.message}`);
      assert.match(body.message, /podcast\.example\.com/);
    });

    it('recognises its own instance through a real public URL', async () => {
      // Point the public base URL at this very server, over a real socket, which is
      // the only way to exercise DNS, the HTTP client and the nonce together.
      await server.app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = server.app.server.address();
      const { SETTING_KEYS } = await import('../../src/services/settings.js');
      server.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: `http://127.0.0.1:${port}` });

      const response = await server.request({ method: 'POST', url: '/api/reachability' });
      const body = response.json();
      assert.equal(body.reachable, true);
      assert.equal(body.status, 200);
      assert.equal(body.sameInstance, true, 'the echoed nonce must identify this instance');
      assert.match(body.message, /reaches this SelfPod/);
      assert.ok(typeof body.elapsedMs === 'number');
    });

    it('does not mistake another server on that address for itself', async () => {
      // A second SelfPod: answers /health perfectly, but cannot echo this one's
      // nonce. Without that check it would pass, and the operator would never learn
      // that their public address serves a different container.
      const other = await createTestServer();
      try {
        await other.app.listen({ port: 0, host: '127.0.0.1' });
        const { port } = other.app.server.address();
        const { SETTING_KEYS } = await import('../../src/services/settings.js');
        server.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: `http://127.0.0.1:${port}` });

        const body = (await server.request({ method: 'POST', url: '/api/reachability' })).json();
        assert.equal(body.reachable, true, 'it does answer');
        assert.equal(body.sameInstance, false, 'but it is not this instance');
        assert.match(body.message, /not this SelfPod/);
      } finally {
        await other.cleanup();
      }
    });

    it('says so plainly when no public address is set at all', async () => {
      const bare = await createTestServer({ env: { PUBLIC_BASE_URL: '' } });
      try {
        await bare.login();
        const body = (await bare.request({ method: 'POST', url: '/api/reachability' })).json();
        assert.equal(body.checked, false);
        assert.equal(body.reason, 'no_public_base_url');
        assert.match(body.message, /nothing to test/);
      } finally {
        await bare.cleanup();
      }
    });
  });
});
