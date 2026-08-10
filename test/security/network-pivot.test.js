import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';
import { SETTING_KEYS } from '../../src/services/settings.js';

/**
 * Adversarial tests for outbound requests.
 *
 * SelfPod runs inside a container on a NAS that can see the rest of the home network,
 * so anything that makes it fetch a URL is a potential way to probe that network from
 * outside. There is exactly one such feature — the public-address reachability check —
 * and these tests hold it to three properties: it cannot be aimed by the request, it
 * cannot report what it found, and it cannot be used quickly.
 */
describe('SelfPod cannot be used to probe the network behind it', () => {
  let server;
  let sentinel;
  let sentinelHits;
  let sentinelUrl;

  before(async () => {
    server = await createTestServer();
    await server.login();

    // Stands in for a service on the LAN — a router page, a database admin panel —
    // that must never become readable through SelfPod.
    sentinelHits = [];
    sentinel = createServer((req, res) => {
      sentinelHits.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: 'ROUTER-SECRET-BANNER', secret: 'LAN-ONLY-DATA' }));
    });
    await new Promise((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
    sentinelUrl = `http://127.0.0.1:${sentinel.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => sentinel.close(resolve));
    await server.cleanup();
  });

  it('has no endpoint that fetches a URL supplied by the request', async () => {
    // Aiming it requires changing a setting first; the endpoint itself takes nothing.
    for (const payload of [
      { url: 'http://127.0.0.1:1/' },
      { target: 'http://169.254.169.254/latest/meta-data/' },
      { publicBaseUrl: 'http://192.168.0.1/' },
      { baseUrl: 'file:///etc/passwd' },
    ]) {
      const before = sentinelHits.length;
      const response = await server.request({
        method: 'POST',
        url: '/api/reachability',
        payload,
        headers: { 'content-type': 'application/json' },
      });
      assert.ok([200, 429].includes(response.statusCode), `unexpected ${response.statusCode}`);
      assert.equal(sentinelHits.length, before, 'a request body must not choose the target');
      const body = response.json();
      // Whatever it did, it went to the configured address, not the supplied one.
      assert.ok(!JSON.stringify(body).includes('169.254'), 'a supplied URL was used');
    }
  });

  it('refuses to store a base URL that is not http(s)', async () => {
    for (const hostile of [
      'file:///etc/passwd',
      'gopher://127.0.0.1:70/',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://192.168.0.1/',
    ]) {
      const response = await server.request({
        method: 'PATCH',
        url: '/api/settings',
        payload: { publicBaseUrl: hostile },
        headers: { 'content-type': 'application/json' },
      });
      assert.ok(response.statusCode >= 400, `"${hostile}" was accepted with ${response.statusCode}`);
      assert.notEqual(server.settings.publicBaseUrl(), hostile);
    }
  });

  it('never hands back what a service on the network answered', async () => {
    // The worst case: an admin session is stolen, the base URL is pointed at
    // something on the LAN, and the check is used to read it.
    server.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: sentinelUrl });
    const response = await server.request({ method: 'POST', url: '/api/reachability' });
    assert.equal(response.statusCode, 200);
    const raw = JSON.stringify(response.json());

    assert.ok(!raw.includes('LAN-ONLY-DATA'), 'the response body leaked out');
    assert.ok(!raw.includes('ROUTER-SECRET-BANNER'), 'a version banner leaked out');
    assert.equal(response.json().sameInstance, false, 'it is not this instance');
    assert.equal(response.json().version, null, 'no version from an unproven instance');
  });

  it('cannot be used to sweep the network quickly', async () => {
    server.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: sentinelUrl });
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const response = await server.request({ method: 'POST', url: '/api/reachability' });
      if (response.statusCode === 429) limited += 1;
    }
    assert.ok(limited > 0, 'an admin session could sweep addresses without limit');
  });

  it('requires an admin session and a same-origin request', async () => {
    const anonymous = await server.app.inject({
      method: 'POST',
      url: '/api/reachability',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(anonymous.statusCode, 401);

    // A malicious website must not be able to trigger it through the admin's browser.
    const crossSite = await server.app.inject({
      method: 'POST',
      url: '/api/reachability',
      headers: { cookie: server.cookie, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    });
    assert.ok(crossSite.statusCode >= 400, `cross-site POST returned ${crossSite.statusCode}`);
  });

  it('does not make any outbound request while serving public routes', async () => {
    server.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: sentinelUrl });
    await server.addAudio('probe', 'sample.m4a', 'one.m4a');
    await server.scanner.scanAllNow('manual');
    const show = server.shows.getBySlug('probe');
    const episode = server.episodes.listByShow(show.id)[0];

    const before = sentinelHits.length;
    await server.app.inject({ url: '/health' });
    await server.app.inject({ url: `/feeds/${show.slug}/${show.feed_token}.xml` });
    await server.app.inject({
      url: `/media/${show.slug}/${show.feed_token}/${episode.id}/one.m4a`,
    });
    await server.app.inject({ url: `/media/${show.slug}/${show.feed_token}/cover.jpg` });
    assert.equal(
      sentinelHits.length,
      before,
      'an unauthenticated request caused SelfPod to call out to the network',
    );
  });
});
