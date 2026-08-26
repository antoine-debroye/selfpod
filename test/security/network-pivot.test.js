import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';
import { SETTING_KEYS } from '../../src/services/settings.js';

/**
 * Adversarial tests for outbound requests.
 *
 * SelfPod runs in a container on a NAS that can see the rest of the home network, so
 * anything that makes it fetch a URL is a potential way to probe that network from
 * outside. There used to be exactly one such feature — the public-address reachability
 * check — and this file held it to three properties: it could not be aimed by the
 * request, it could not report what it found, and it could not be used quickly.
 *
 * Feed subscriptions changed that, and the first of those properties could not survive:
 * the whole feature is a URL somebody supplies. It is replaced here by four narrower
 * ones rather than quietly dropped, and the file is longer than it was because the
 * surface is bigger, not because the bar moved:
 *
 *   1. Only an authenticated admin, same-origin, can supply a URL at all.
 *   2. It is refused unless http/https on port 80/443, with no credentials, and every
 *      address it resolves to is public unicast.
 *   3. The whole check runs again at every redirect hop and every poll — never once,
 *      at subscribe time, and then trusted for ever.
 *   4. No unauthenticated code path causes any outbound request whatsoever.
 *
 * The fourth is the load-bearing one: it is what keeps a publicly-exposed SelfPod from
 * being a probe for anyone who has not got the password.
 *
 * **Every negative assertion here is paired with a positive one.** "The sentinel was
 * not hit" and "the secret did not leak" are both satisfied by code that never ran —
 * a typo'd URL, a flag defaulting off, an unrelated 500 — so each test also proves the
 * thing it is testing actually happened.
 *
 * ## What this file does and does not pin down
 *
 * These are *composition* tests: they assert the outcome an attacker would observe —
 * refused, nothing fetched, nothing leaked — through the real HTTP routes with no
 * injected doubles. They deliberately cannot tell *which* layer produced a refusal,
 * and that was measured rather than assumed: deleting the scheme allow-list, the
 * literal-address check, or the per-hop re-validation leaves every test in this file
 * green, because another layer still refuses the request.
 *
 * That is defence in depth working, not a gap — but it does mean this file alone is
 * not enough, and reading it as if it were is the mistake to avoid. The mechanisms are
 * pinned one level down, where a single guard can be isolated:
 *
 *   test/unit/address-rules.test.js   the ~60-case address table, and the URL rules
 *   test/unit/guarded-fetch.test.js   pinning, per-hop checks, caps, timers, TLS
 *   test/integration/subscriptions*   the poller and the API, end to end
 *
 * Each of those four deletions does turn the full suite red. Keep it that way.
 */
describe('SelfPod cannot be used to probe the network behind it', () => {
  let server;
  let sentinel;
  let sentinelHits;
  let sentinelUrl;
  let respond;

  before(async () => {
    // Stands in for a service on the LAN — a router page, a database admin panel —
    // that must never become readable through SelfPod.
    sentinelHits = [];
    sentinel = createServer((req, res) => {
      sentinelHits.push(req.url);
      if (respond) return respond(req, res);
      res.writeHead(200, { 'content-type': 'application/json', server: 'LANbox/1.2' });
      return res.end(
        JSON.stringify({ status: 'ok', version: 'ROUTER-SECRET-BANNER', secret: 'LAN-ONLY-DATA' }),
      );
    });
    await new Promise((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
    sentinelUrl = `http://127.0.0.1:${sentinel.address().port}`;

    server = await createTestServer();
    await server.login();
    server.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '1' });
  });

  after(async () => {
    await new Promise((resolve) => sentinel.close(resolve));
    await server.cleanup();
  });

  beforeEach(() => {
    respond = null;
    sentinelHits.length = 0;
  });

  const json = { 'content-type': 'application/json' };

  function preview(feedUrl) {
    return server.request({
      method: 'POST',
      url: '/api/subscriptions/preview',
      payload: { feedUrl },
      headers: json,
    });
  }

  /* ------------------------------------------------------------------ property 4 */

  it('makes no outbound request while serving any public route', async () => {
    // Unchanged from before subscriptions existed, and now more valuable rather than
    // less: a poller exists, and none of it may be reachable without a password.
    server.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: sentinelUrl });
    await server.addAudio('probe', 'sample.m4a', 'one.m4a');
    await server.scanner.scanAllNow('manual');
    const show = server.shows.getBySlug('probe');
    const episode = server.episodes.listByShow(show.id)[0];

    const before = sentinelHits.length;
    await server.app.inject({ url: '/health' });
    await server.app.inject({ url: `/feeds/${show.slug}/${show.feed_token}.xml` });
    await server.app.inject({ url: `/media/${show.slug}/${show.feed_token}/${episode.id}/one.m4a` });
    await server.app.inject({ url: `/media/${show.slug}/${show.feed_token}/cover.jpg` });

    assert.equal(
      sentinelHits.length,
      before,
      'an unauthenticated request caused SelfPod to call out to the network',
    );
    // Positive control: those routes really did serve something, so "no outbound
    // request" is not "no request at all".
    const feed = await server.app.inject({ url: `/feeds/${show.slug}/${show.feed_token}.xml` });
    assert.equal(feed.statusCode, 200);
  });

  it('makes no outbound request while a subscription is due and nobody is signed in', async () => {
    // The specific worry a background poller introduces: work that happens without a
    // human, on a schedule, must still be unreachable from outside.
    const show = server.shows.getBySlug('probe') ?? server.shows.list()[0];
    server.db
      .prepare(
        `INSERT OR REPLACE INTO feed_subscriptions
           (id, show_id, feed_url, enabled, next_poll_at, created_at, updated_at)
         VALUES ('due-probe', ?, ?, 1, NULL, '2020-01-01', '2020-01-01')`,
      )
      .run(show.id, `${sentinelUrl}/feed.xml`);

    const before = sentinelHits.length;
    await server.app.inject({ url: '/health' });
    await server.app.inject({ url: '/' });
    await server.app.inject({ method: 'POST', url: '/api/subscriptions/preview' });

    assert.equal(sentinelHits.length, before, 'an unauthenticated request triggered a poll');
    server.db.prepare("DELETE FROM feed_subscriptions WHERE id = 'due-probe'").run();
  });

  it('makes no outbound request at all while the feature is switched off', async () => {
    server.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '0' });
    try {
      const response = await preview(`${sentinelUrl}/feed.xml`);
      assert.equal(response.statusCode, 400);
      assert.equal(sentinelHits.length, 0, 'a disabled feature must be silent on the network');
      await server.remoteFeeds.pollDue();
      assert.equal(sentinelHits.length, 0);
    } finally {
      server.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '1' });
    }
  });

  /* ------------------------------------------------------------------ property 1 */

  it('refuses to be aimed by anyone who is not signed in', async () => {
    for (const [method, url] of [
      ['POST', '/api/subscriptions/preview'],
      ['GET', '/api/subscriptions/anything'],
    ]) {
      const response = await server.app.inject({
        method,
        url,
        headers: { 'sec-fetch-site': 'same-origin', ...json },
        payload: method === 'POST' ? { feedUrl: `${sentinelUrl}/feed.xml` } : undefined,
      });
      assert.equal(response.statusCode, 401, `${method} ${url} answered ${response.statusCode}`);
    }
    assert.equal(sentinelHits.length, 0);
  });

  it('refuses to be aimed by a website through the admin\'s own browser', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/subscriptions/preview',
      headers: {
        cookie: server.cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
        ...json,
      },
      payload: { feedUrl: `${sentinelUrl}/feed.xml` },
    });
    assert.ok(response.statusCode >= 400, `cross-site POST returned ${response.statusCode}`);
    assert.equal(sentinelHits.length, 0);
  });

  /* ------------------------------------------------------------------ property 2 */

  it('refuses a private or local address when it is typed in', async () => {
    for (const feedUrl of [
      'http://127.0.0.1/feed.xml',
      'http://10.0.0.1/feed.xml',
      'http://192.168.1.1/feed.xml',
      'http://172.16.0.1/feed.xml',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/feed.xml',
      'http://[::1]/feed.xml',
      'http://[fd00::1]/feed.xml',
      'http://[::ffff:192.168.1.1]/feed.xml',
      'http://localhost/feed.xml',
      'http://localhost./feed.xml',
      'http://2130706433/feed.xml',
      'http://0x7f000001/feed.xml',
      'http://my-nas.local/feed.xml',
    ]) {
      const response = await preview(feedUrl);
      assert.ok(response.statusCode >= 400, `${feedUrl} was accepted with ${response.statusCode}`);
      assert.ok(
        !JSON.stringify(response.json()).includes('LAN-ONLY-DATA'),
        `${feedUrl} returned LAN content`,
      );
    }
    assert.equal(sentinelHits.length, 0, 'not one of those may have been fetched');
  });

  it('refuses a scheme it does not speak', async () => {
    for (const feedUrl of [
      'file:///etc/passwd',
      'gopher://127.0.0.1:70/',
      'ftp://192.168.0.1/',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'dict://127.0.0.1:2628/',
      'ws://example.com/',
    ]) {
      const response = await preview(feedUrl);
      assert.ok(response.statusCode >= 400, `${feedUrl} was accepted`);
    }
    assert.equal(sentinelHits.length, 0);
  });

  it('refuses a port that is not 80 or 443', async () => {
    // Blocking private address space still leaves the whole public internet reachable
    // on any port, and a router that forwards a public address back inside is an
    // ordinary home setup.
    const response = await preview('http://feeds.example.com:9200/feed.xml');
    assert.ok(response.statusCode >= 400);
    assert.equal(sentinelHits.length, 0);
  });

  it('refuses credentials in the URL, including a password with no username', async () => {
    for (const feedUrl of [
      'http://evil.com@192.168.1.1/feed.xml',
      'http://:token@192.168.1.1/feed.xml',
      'http://user:pass@feeds.example.com/feed.xml',
    ]) {
      const response = await preview(feedUrl);
      assert.ok(response.statusCode >= 400, `${feedUrl} was accepted`);
    }
  });

  /* ------------------------------------------------------------------ property 3 */

  it('re-checks the address at poll time, not only when the feed was saved', async () => {
    // The single most likely real bug in this feature: validate the URL when it is
    // saved, then trust the row for ever while a background timer keeps using it.
    const show = server.shows.getBySlug('probe') ?? server.shows.list()[0];
    server.db.prepare('DELETE FROM feed_subscriptions').run();
    server.db
      .prepare(
        `INSERT INTO feed_subscriptions (id, show_id, feed_url, enabled, created_at, updated_at)
         VALUES ('sneaked', ?, 'http://192.168.1.50/feed.xml', 1, '2020-01-01', '2020-01-01')`,
      )
      .run(show.id);

    const result = await server.remoteFeeds.pollNow('sneaked');

    assert.equal(result.status, 'blocked', 'a row that bypassed the form must still be refused');
    assert.match(server.subscriptions.get('sneaked').last_error, /private or local network/);
    server.db.prepare('DELETE FROM feed_subscriptions').run();
  });

  /* ------------------------------------------------------------------ property 2' */

  it('never hands back what a service on the network answered', async () => {
    // The worst case: an admin session is stolen and used to read the LAN. The
    // address guard is the first control; this is what stands behind it, because a
    // public host that proxies inwards defeats address rules entirely.
    server.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: sentinelUrl });
    const response = await server.request({ method: 'POST', url: '/api/reachability' });
    assert.equal(response.statusCode, 200);
    const raw = JSON.stringify(response.json());

    assert.ok(!raw.includes('LAN-ONLY-DATA'), 'the response body leaked out');
    assert.ok(!raw.includes('ROUTER-SECRET-BANNER'), 'a version banner leaked out');
    assert.ok(!raw.includes('LANbox'), 'a response header leaked out');
    assert.equal(response.json().sameInstance, false, 'it is not this instance');
    assert.equal(response.json().version, null, 'no version from an unproven instance');
    // Positive control: it really did reach the sentinel.
    assert.ok(sentinelHits.length > 0);
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
        headers: json,
      });
      assert.ok(response.statusCode >= 400, `"${hostile}" was accepted with ${response.statusCode}`);
      assert.notEqual(server.settings.publicBaseUrl(), hostile);
    }
  });

  /* ------------------------------------------------------------------ property 3' */

  it('cannot be used to sweep the network quickly', async () => {
    server.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: sentinelUrl });
    let limited = 0;
    for (let i = 0; i < 12; i += 1) {
      const response = await server.request({ method: 'POST', url: '/api/reachability' });
      if (response.statusCode === 429) limited += 1;
    }
    assert.ok(limited > 0, 'an admin session could sweep addresses without limit');
  });

  it('rate limits the subscription preview too', async () => {
    let limited = 0;
    for (let i = 0; i < 10; i += 1) {
      const response = await preview('https://feeds.example.com/feed.xml');
      if (response.statusCode === 429) limited += 1;
    }
    assert.ok(limited > 0, 'preview could be used to sweep addresses without limit');
  });

  it('requires an admin session and a same-origin request for the reachability check', async () => {
    const anonymous = await server.app.inject({
      method: 'POST',
      url: '/api/reachability',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(anonymous.statusCode, 401);

    const crossSite = await server.app.inject({
      method: 'POST',
      url: '/api/reachability',
      headers: { cookie: server.cookie, 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
    });
    assert.ok(crossSite.statusCode >= 400, `cross-site POST returned ${crossSite.statusCode}`);
  });
});

/**
 * A subscription's feed URL is a credential.
 *
 * Private and premium podcast feeds identify the listener with a token in the path or
 * the query string. A URL like that in `docker logs` or in an exported config file is
 * a working subscription link for anyone who can read them — which is the same rule a
 * show's own feed token already has, arriving from the other direction.
 */
describe('a feed URL is treated as the credential it is', () => {
  let server;

  before(async () => {
    server = await createTestServer();
    await server.login();
  });

  after(async () => {
    await server.cleanup();
  });

  it('is never written to the exported config file', async () => {
    await server.addAudio('exported', 'sample.m4a', 'one.m4a');
    await server.scanner.scanAllNow('manual');
    const show = server.shows.getBySlug('exported');
    server.subscriptions.create(show.id, {
      feedUrl: 'https://feeds.example.com/private/SECRET-LISTENER-TOKEN/rss',
    });

    await server.settings.exportToDisk();
    const exported = await import('node:fs/promises').then((fs) =>
      fs.readFile(server.config.configPath, 'utf8').catch(() => ''),
    );

    assert.ok(exported.length > 0, 'the export really was written');
    assert.ok(!exported.includes('SECRET-LISTENER-TOKEN'), 'a feed URL reached config.json');
  });

  it('is reduced to scheme and host before it reaches a log line', async () => {
    const { redactFeedUrl } = await import('../../src/plugins/log-redaction.js');
    const redacted = redactFeedUrl('https://feeds.example.com/private/SECRET-LISTENER-TOKEN/rss');

    assert.ok(!redacted.includes('SECRET-LISTENER-TOKEN'));
    // The host is deliberately kept: it is what an operator needs in order to act on
    // a log line, and it is what makes a sweep visible in the first place.
    assert.match(redacted, /feeds\.example\.com/);
  });
});

/**
 * Redirects, tested where they can actually be reached.
 *
 * These need their own instance, with 127.0.0.1 named in ALLOW_PRIVATE_FEED_HOSTS, so
 * the *first* hop is permitted and what gets refused is the redirect itself. An
 * earlier version of this test ran on the default instance and passed without ever
 * reaching the sentinel — the initial address was refused, the redirect logic never
 * ran, and the test would have stayed green with per-hop checking deleted entirely.
 * Hence the positive control in every case below.
 */
describe('a redirect is re-checked, never followed on trust', () => {
  let server;
  let sentinel;
  let hits;
  let location;
  let origin;

  before(async () => {
    hits = [];
    sentinel = createServer((req, res) => {
      hits.push(req.url);
      res.writeHead(302, { location });
      res.end('SECRET-REDIRECT-BODY');
    });
    await new Promise((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${sentinel.address().port}`;

    server = await createTestServer({ env: { ALLOW_PRIVATE_FEED_HOSTS: '127.0.0.1' } });
    await server.login();
    server.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '1' });
  });

  after(async () => {
    await new Promise((resolve) => sentinel.close(resolve));
    await server.cleanup();
  });

  async function previewThrough(target) {
    location = target;
    hits.length = 0;
    const response = await server.request({
      method: 'POST',
      url: '/api/subscriptions/preview',
      payload: { feedUrl: `${origin}/feed.xml` },
      headers: { 'content-type': 'application/json' },
    });
    return response;
  }

  it('refuses a redirect into private address space', async () => {
    const response = await previewThrough('http://192.168.1.1/secret.xml');

    assert.ok(hits.length > 0, 'the first hop must actually have happened');
    assert.ok(response.statusCode >= 400, `the redirect was followed (${response.statusCode})`);
    const raw = JSON.stringify(response.json());
    assert.ok(!raw.includes('192.168.1.1'), 'the redirect target leaked');
    assert.ok(!raw.includes('SECRET-REDIRECT-BODY'), 'the redirect body was read and returned');
  });

  it('refuses a redirect to a scheme it does not speak', async () => {
    const response = await previewThrough('file:///etc/passwd');

    assert.ok(hits.length > 0, 'the first hop must actually have happened');
    assert.ok(response.statusCode >= 400);
    assert.ok(!JSON.stringify(response.json()).includes('root:'), 'a local file was read');
  });

  it('refuses a redirect to a non-standard port', async () => {
    const response = await previewThrough('http://feeds.example.com:9200/feed.xml');

    assert.ok(hits.length > 0);
    assert.ok(response.statusCode >= 400);
  });

  it('stops after the cap rather than following a chain', async () => {
    const response = await previewThrough(`${origin}/again`);

    assert.ok(hits.length > 1, 'it followed at least one hop');
    assert.ok(hits.length <= 5, `it followed ${hits.length} hops without stopping`);
    assert.ok(response.statusCode >= 400);
  });
});
