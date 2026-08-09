import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SCAN_TRIGGER } from '../../src/constants.js';
import { createTestServer, ADMIN_PASSWORD } from '../helpers/http.js';

let server;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(async () => {
  await server.cleanup();
});

async function seedShow(slug = 'late-night', fixture = 'sample.m4a', as = fixture) {
  await server.addAudio(slug, fixture, as);
  await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
  return server.shows.getBySlug(slug);
}

describe('health endpoint (spec §12.3)', () => {
  it('answers unauthenticated with a version and permissive CORS', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    // The dashboard tests reachability from the browser, so this must be readable
    // cross-origin.
    assert.equal(response.headers['access-control-allow-origin'], '*');
    const body = response.json();
    assert.equal(body.status, 'ok');
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
  });

  it('stays HTTP 200 while degraded so the container is not restarted out of reach', async () => {
    server.health.set('shows_readable', { level: 'error', message: 'simulated permission failure' });
    const response = await server.app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'degraded');
  });
});

describe('authentication (spec §12.1)', () => {
  it('rejects the API without a session', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/api/shows' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'unauthenticated');
  });

  it('redirects pages to the sign-in screen', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    assert.equal(response.statusCode, 303);
    assert.match(response.headers.location, /^\/login/);
  });

  it('signs in and then serves the API', async () => {
    const login = await server.login();
    assert.equal(login.statusCode, 200);
    assert.ok(server.cookie, 'a session cookie should have been issued');

    const shows = await server.get('/api/shows');
    assert.equal(shows.statusCode, 200);
  });

  it('sets a hardened session cookie', async () => {
    const login = await server.login();
    const raw = login.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? raw[0] : raw;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const bad = await server.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'admin', password: 'wrong' },
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const unknownUser = await server.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'nobody', password: 'wrong' },
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(bad.statusCode, 401);
    assert.equal(unknownUser.statusCode, 401);
    assert.equal(bad.json().error.message, unknownUser.json().error.message);
  });

  it('backs off after repeated failures, and a spoofed forwarded IP does not reset it', async () => {
    for (let i = 0; i < 4; i += 1) {
      await server.app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'admin', password: 'wrong' },
        headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': `10.0.0.${i}` },
      });
    }
    // A fresh forged X-Forwarded-For must not buy a clean slate: the account-level
    // backoff is keyed to the account, not to a client-supplied header.
    const spoofed = await server.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'admin', password: ADMIN_PASSWORD },
      headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.99' },
    });
    assert.equal(spoofed.statusCode, 401);
    assert.equal(spoofed.json().error.code, 'rate_limited');
    assert.ok(spoofed.headers['retry-after']);
  });

  it('blocks a cross-site POST even with a valid session', async () => {
    await server.login();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/rescan',
      headers: { cookie: server.cookie, 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'cross_site_blocked');
  });

  it('blocks a POST whose Origin does not match the host', async () => {
    await server.login();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/rescan',
      headers: { cookie: server.cookie, origin: 'https://evil.example.com', host: 'podcast.example.com' },
    });
    assert.equal(response.statusCode, 403);
  });
});

describe('setup gating (first-run takeover risk)', () => {
  it('refuses to set a password without a session', async () => {
    const bare = await createTestServer({ completeSetup: false });
    try {
      const response = await bare.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { password: 'attacker-chosen-password', finish: true },
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      // There is no unauthenticated path to claim the instance: bootstrap always
      // creates a credential before the server listens.
      assert.equal(response.statusCode, 401);
    } finally {
      await bare.cleanup();
    }
  });

  it('refuses to re-run once setup is complete', async () => {
    await server.login();
    const response = await server.post('/api/setup', { password: 'another-password-1', finish: true });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'setup_complete');
  });

  it('will not finish the wizard without a valid public base URL', async () => {
    const bare = await createTestServer({ completeSetup: false, env: { PUBLIC_BASE_URL: '' } });
    try {
      await bare.login();
      const response = await bare.post('/api/setup', { finish: true, publicBaseUrl: 'not-a-url' });
      assert.equal(response.statusCode, 422);
      assert.ok(response.json().error.fields.publicBaseUrl);
      assert.equal(bare.settings.setupComplete(), false);
    } finally {
      await bare.cleanup();
    }
  });
});

describe('feed serving (spec §8)', () => {
  it('serves the feed to anyone holding the token, with no session', async () => {
    const show = await seedShow();
    const response = await server.app.inject({
      method: 'GET',
      url: `/feeds/${show.slug}/${show.feed_token}.xml`,
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /application\/rss\+xml/);
    assert.ok(response.body.includes('<rss version="2.0"'));
    assert.ok(response.body.includes('audio/x-m4a'));
  });

  it('returns 404 — not 403 — for a wrong token, so slugs are not enumerable', async () => {
    const show = await seedShow();
    const wrongToken = await server.app.inject({
      method: 'GET',
      url: `/feeds/${show.slug}/aaaaaaaaaaaaaaaaaaaaaa.xml`,
    });
    const noSuchShow = await server.app.inject({
      method: 'GET',
      url: '/feeds/does-not-exist/aaaaaaaaaaaaaaaaaaaaaa.xml',
    });
    assert.equal(wrongToken.statusCode, 404);
    assert.equal(noSuchShow.statusCode, 404);
    assert.deepEqual(wrongToken.json(), noSuchShow.json(), 'the two cases must be indistinguishable');
  });

  it('honours If-None-Match', async () => {
    const show = await seedShow();
    const first = await server.app.inject({ method: 'GET', url: `/feeds/${show.slug}/${show.feed_token}.xml` });
    const etag = first.headers.etag;
    assert.ok(etag);
    const second = await server.app.inject({
      method: 'GET',
      url: `/feeds/${show.slug}/${show.feed_token}.xml`,
      headers: { 'if-none-match': etag },
    });
    assert.equal(second.statusCode, 304);
  });

  it('answers 503 with an explanation when no public base URL is set', async () => {
    const bare = await createTestServer({ env: { PUBLIC_BASE_URL: '' } });
    try {
      await bare.addAudio('unset', 'sample.mp3');
      await bare.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
      const show = bare.shows.getBySlug('unset');
      const response = await bare.app.inject({
        method: 'GET',
        url: `/feeds/${show.slug}/${show.feed_token}.xml`,
      });
      assert.equal(response.statusCode, 503);
      assert.match(response.body, /public base URL/i);
    } finally {
      await bare.cleanup();
    }
  });
});

describe('media serving (spec §8.4)', () => {
  it('serves audio with the MIME type from the shared map', async () => {
    const show = await seedShow('media-show', 'sample.m4a');
    const episode = server.episodes.listByShow(show.id)[0];
    const response = await server.app.inject({
      method: 'GET',
      url: `/media/${show.slug}/${show.feed_token}/${episode.id}/${encodeURIComponent(episode.filename)}`,
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /audio\/x-m4a/);
    assert.equal(response.headers['accept-ranges'], 'bytes');
  });

  it('honours a Range request with 206 and the right slice', async () => {
    const show = await seedShow('range-show', 'sample.mp3');
    const episode = server.episodes.listByShow(show.id)[0];
    const url = `/media/${show.slug}/${show.feed_token}/${episode.id}/${encodeURIComponent(episode.filename)}`;

    const response = await server.app.inject({
      method: 'GET',
      url,
      headers: { range: 'bytes=0-99' },
    });
    assert.equal(response.statusCode, 206, 'seeking in a podcast app depends on this');
    assert.equal(response.headers['content-range'], `bytes 0-99/${episode.file_size_bytes}`);
    assert.equal(response.rawPayload.length, 100);
  });

  it('serves a media URL containing spaces, emoji and curly quotes verbatim', async () => {
    const nasty = "ep 42 🎙️ – it's ‘live’.m4a";
    await server.addAudio('nasty-names', 'sample.m4a', nasty);
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const show = server.shows.getBySlug('nasty-names');
    const built = server.feeds.build(show.id);
    const url = built.xml.match(/<enclosure url="([^"]+)"/)[1];

    // Take the URL exactly as the feed published it — that is what a podcast app does.
    const path = url.replace('https://podcast.example.com', '');
    const response = await server.app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /audio\/x-m4a/);
  });

  it('serves an episode whose filename is longer than a route parameter default', async () => {
    // Fastify rejects path parameters over 100 characters with a 414 before the
    // handler runs. Real episode titles pass that easily, and the symptom in a
    // podcast app is "requested URL too long" with nothing in SelfPod's own logs —
    // it took a screenshot from a phone to find it.
    const longName =
      '2026-08-03-Bulletin météo : forte dépression sur Ceuta, retour à la normale annoncé depuis Madrid.m4a';
    assert.ok(longName.length > 100, 'the fixture must actually exceed the default limit');

    await server.addAudio('long-names', 'sample.m4a', longName);
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const show = server.shows.getBySlug('long-names');
    const built = server.feeds.build(show.id);
    const url = built.xml.match(/<enclosure url="([^"]+)"/)[1].replace(/&amp;/g, '&');
    const path = url.replace('https://podcast.example.com', '');

    const response = await server.app.inject({ method: 'GET', url: path });
    assert.equal(response.statusCode, 200, 'a long filename must not produce a 414');
    assert.match(response.headers['content-type'], /audio\/x-m4a/);

    const ranged = await server.app.inject({ method: 'GET', url: path, headers: { range: 'bytes=0-49' } });
    assert.equal(ranged.statusCode, 206, 'seeking must work for these too');
  });

  it('resolves by episode id and ignores a mismatched filename in the URL', async () => {
    const show = await seedShow('routing-show', 'sample.mp3');
    const episode = server.episodes.listByShow(show.id)[0];
    const response = await server.app.inject({
      method: 'GET',
      url: `/media/${show.slug}/${show.feed_token}/${episode.id}/whatever-name.mp3`,
    });
    assert.equal(response.statusCode, 200);
  });

  it('rejects an episode id belonging to another show', async () => {
    const a = await seedShow('show-a', 'sample.mp3');
    await server.addAudio('show-b', 'sample.m4a');
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const b = server.shows.getBySlug('show-b');
    const episodeOfB = server.episodes.listByShow(b.id)[0];

    const response = await server.app.inject({
      method: 'GET',
      url: `/media/${a.slug}/${a.feed_token}/${episodeOfB.id}/${episodeOfB.filename}`,
    });
    assert.equal(response.statusCode, 404);
  });

  it('does not cache audio at a CDN, so a rotated token cannot be served from the edge', async () => {
    const show = await seedShow('cache-show', 'sample.mp3');
    const episode = server.episodes.listByShow(show.id)[0];
    const response = await server.app.inject({
      method: 'GET',
      url: `/media/${show.slug}/${show.feed_token}/${episode.id}/${episode.filename}`,
    });
    assert.match(response.headers['cache-control'], /private/);
  });
});

describe('cover art serving (spec §10.3)', () => {
  it('serves a cover.png through the stable cover.jpg URL', async () => {
    const sharp = (await import('sharp')).default;
    await server.addAudio('cover-show', 'sample.mp3');
    const buffer = await sharp({
      create: { width: 1500, height: 1500, channels: 3, background: '#2A6F97' },
    })
      .png()
      .toBuffer();
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(server.config.showsDir, 'cover-show', 'cover.png'), buffer);
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    const show = server.shows.getBySlug('cover-show');
    const response = await server.app.inject({
      method: 'GET',
      url: `/media/${show.slug}/${show.feed_token}/cover.jpg`,
    });
    assert.equal(response.statusCode, 200);
    // The URL says .jpg but the real file is a PNG, and its true type is sent.
    assert.match(response.headers['content-type'], /image\/png/);
    assert.match(response.headers['cache-control'], /max-age=3600/, 'artwork changes, so caching is short');
    assert.ok(response.headers.etag);
  });

  it('answers 304 for a matching ETag', async () => {
    const sharp = (await import('sharp')).default;
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await server.addAudio('etag-show', 'sample.mp3');
    await writeFile(
      join(server.config.showsDir, 'etag-show', 'cover.jpg'),
      await sharp({ create: { width: 1500, height: 1500, channels: 3, background: '#C44536' } }).jpeg().toBuffer(),
    );
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const show = server.shows.getBySlug('etag-show');
    const url = `/media/${show.slug}/${show.feed_token}/cover.jpg`;

    const first = await server.app.inject({ method: 'GET', url });
    const second = await server.app.inject({ method: 'GET', url, headers: { 'if-none-match': first.headers.etag } });
    assert.equal(second.statusCode, 304);
  });
});

describe('token redaction in logs', () => {
  it('masks the token in feed and media URLs', async () => {
    const { redactUrl } = await import('../../src/plugins/log-redaction.js');
    assert.equal(redactUrl('/feeds/my-show/SECRETTOKEN123.xml'), '/feeds/my-show/***.xml');
    assert.equal(
      redactUrl('/media/my-show/SECRETTOKEN123/abc-def/ep.mp3'),
      '/media/my-show/***/abc-def/ep.mp3',
    );
    assert.equal(redactUrl('/media/my-show/SECRETTOKEN123/cover.jpg'), '/media/my-show/***/cover.jpg');
    assert.equal(redactUrl('/api/shows'), '/api/shows', 'ordinary URLs are untouched');
  });
});
