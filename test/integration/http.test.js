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

/**
 * Conditional and compressed feed delivery.
 *
 * A podcast app polls the same feed for ever and the feed rarely changes, so almost
 * every request should be answered with "you already have it". Two things used to stop
 * that happening, both silent: the ETag was compared as an exact string, so anything
 * that rewrote the validator in transit — Cloudflare, which the README recommends,
 * re-emits strong tags as weak — turned every poll into a full download; and the 304
 * was returned before the request was recorded, so the app doing everything right was
 * invisible on the show page.
 *
 * Neither failure produces an error anywhere. That is why they are worth pinning down.
 */
describe('conditional feed requests', () => {
  const feedUrlFor = (show) => `/feeds/${show.slug}/${show.feed_token}.xml`;

  async function fetchFeed(show, headers = {}) {
    return server.app.inject({ method: 'GET', url: feedUrlFor(show), headers });
  }

  it('answers 304 to the exact ETag it just issued', async () => {
    const show = await seedShow();
    const first = await fetchFeed(show);
    assert.equal(first.statusCode, 200, 'the first fetch returns the feed');

    const second = await fetchFeed(show, { 'if-none-match': first.headers.etag });
    assert.equal(second.statusCode, 304, 'the second is told nothing has changed');
    assert.equal(second.body, '', 'and carries no body');
  });

  it('answers 304 to the weak form of its own ETag', async () => {
    const show = await seedShow();
    const first = await fetchFeed(show);
    const weak = `W/${first.headers.etag}`;

    const second = await fetchFeed(show, { 'if-none-match': weak });
    assert.equal(
      second.statusCode,
      304,
      'a proxy that rewrites the tag as weak must not defeat revalidation entirely',
    );
  });

  it('answers 304 to a list containing its ETag among others', async () => {
    const show = await seedShow();
    const first = await fetchFeed(show);

    const second = await fetchFeed(show, {
      'if-none-match': `"something-else", ${first.headers.etag}, W/"another"`,
    });
    assert.equal(second.statusCode, 304, 'If-None-Match is a list, not a single value');
  });

  it('echoes both validators on the 304, not only on the 200', async () => {
    const show = await seedShow();
    const first = await fetchFeed(show);
    const second = await fetchFeed(show, { 'if-none-match': first.headers.etag });

    assert.equal(second.headers.etag, first.headers.etag, 'the ETag comes back');
    assert.ok(second.headers['last-modified'], 'and so does the date');
    assert.equal(
      second.headers['last-modified'],
      first.headers['last-modified'],
      'unchanged, because the feed is unchanged',
    );
  });

  it('sends a Last-Modified with whole-second precision', async () => {
    const show = await seedShow();
    const response = await fetchFeed(show);
    const header = response.headers['last-modified'];
    assert.ok(header, 'the header is present');
    assert.equal(
      new Date(header).getTime() % 1000,
      0,
      'an HTTP-date carries no milliseconds, so one that does can never be echoed back exactly',
    );
  });

  it('answers 304 to If-Modified-Since when no ETag is offered', async () => {
    const show = await seedShow();
    const first = await fetchFeed(show);

    const second = await fetchFeed(show, { 'if-modified-since': first.headers['last-modified'] });
    assert.equal(second.statusCode, 304, 'some apps validate by date alone');
  });

  it('ignores If-Modified-Since when an If-None-Match is present and does not match', async () => {
    const show = await seedShow();
    const first = await fetchFeed(show);

    const second = await fetchFeed(show, {
      'if-none-match': '"not-the-current-one"',
      'if-modified-since': first.headers['last-modified'],
    });
    assert.equal(
      second.statusCode,
      200,
      'the ETag is a statement about the bytes and outranks a guess about them',
    );
  });

  it('sends Vary: accept-encoding on both the 200 and the 304', async () => {
    const show = await seedShow();
    const first = await fetchFeed(show);
    assert.match(first.headers.vary ?? '', /accept-encoding/i, 'on the full response');

    const second = await fetchFeed(show, { 'if-none-match': first.headers.etag });
    assert.match(second.headers.vary ?? '', /accept-encoding/i, 'and on the revalidation');
  });

  it('compresses the feed when asked, and the body is still the feed', async () => {
    const { gunzipSync } = await import('node:zlib');
    const show = await seedShow();

    const plain = await fetchFeed(show);
    assert.equal(plain.headers['content-encoding'], undefined, 'nothing is forced on a client');

    const zipped = await fetchFeed(show, { 'accept-encoding': 'gzip' });
    assert.equal(zipped.headers['content-encoding'], 'gzip', 'gzip is used when offered');
    assert.equal(
      gunzipSync(zipped.rawPayload).toString('utf8'),
      plain.body,
      'and decompresses to exactly the feed that would have been sent',
    );
    assert.ok(zipped.rawPayload.length < Buffer.byteLength(plain.body), 'it is actually smaller');
  });

  it('leaves episode audio uncompressed and its ranges intact', async () => {
    const show = await seedShow();
    const episode = server.episodes.listByShow(show.id)[0];
    const url = `/media/${show.slug}/${show.feed_token}/${episode.id}/${encodeURIComponent(episode.filename)}`;

    const response = await server.app.inject({
      method: 'GET',
      url,
      headers: { 'accept-encoding': 'gzip, br', range: 'bytes=0-1023' },
    });
    assert.equal(response.statusCode, 206, 'a range request is still answered with a range');
    assert.equal(
      response.headers['content-encoding'],
      undefined,
      'compressing already-compressed audio would spend CPU to break seeking',
    );
    assert.ok(response.headers['content-range'], 'and the range is described');
  });
});

/**
 * Cover art gets the same two fixes, because two routes answering the same question
 * differently is where the next bug hides.
 */
describe('conditional cover requests', () => {
  it('answers 304 to the weak form of the cover ETag', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const sharp = (await import('sharp')).default;

    await server.addAudio('arty', 'sample.m4a');
    await writeFile(
      join(server.config.showsDir, 'arty', 'cover.jpg'),
      await sharp({ create: { width: 1500, height: 1500, channels: 3, background: '#3E2D4A' } })
        .jpeg()
        .toBuffer(),
    );
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const show = server.shows.getBySlug('arty');

    const url = `/media/${show.slug}/${show.feed_token}/cover.jpg`;
    const first = await server.app.inject({ method: 'GET', url });
    assert.equal(first.statusCode, 200, 'the cover is served, so there is something to revalidate');
    assert.ok(first.headers.etag, 'and it carries an ETag');

    const second = await server.app.inject({
      method: 'GET',
      url,
      headers: { 'if-none-match': `W/${first.headers.etag}` },
    });
    assert.equal(second.statusCode, 304, 'a rewritten validator still revalidates');
    assert.equal(second.headers.etag, first.headers.etag, 'and the tag comes back');
  });
});

/**
 * The category defaults were readable and seeded, but had no write path at all: every
 * new show got Technology and there was nothing anywhere that could change it.
 */
describe('instance category defaults (PATCH /api/settings)', () => {
  beforeEach(async () => {
    await server.login();
  });

  async function patch(payload) {
    return server.request({ method: 'PATCH', url: '/api/settings', payload });
  }

  it('writes a category and subcategory that Apple recognises', async () => {
    const response = await patch({ defaultCategory: 'Arts', defaultSubcategory: 'Books' });
    assert.equal(response.statusCode, 200);

    const defaults = server.settings.defaults();
    assert.equal(defaults.category, 'Arts');
    assert.equal(defaults.subcategory, 'Books');

    const read = (await server.get('/api/settings')).json().settings;
    assert.equal(read.defaultCategory, 'Arts');
    assert.equal(read.defaultSubcategory, 'Books');
  });

  it('refuses a category or subcategory a directory would reject', async () => {
    const bogus = await patch({ defaultCategory: 'Woodwork' });
    assert.equal(bogus.statusCode, 422);
    assert.ok(bogus.json().error.fields.defaultCategory);

    const mismatched = await patch({ defaultCategory: 'Arts', defaultSubcategory: 'Rugby' });
    assert.equal(mismatched.statusCode, 422);
    assert.ok(mismatched.json().error.fields.defaultSubcategory);

    assert.equal(server.settings.defaults().category, 'Technology', 'nothing was written');
  });

  it('drops a subcategory the new category has no place for', async () => {
    await patch({ defaultCategory: 'Arts', defaultSubcategory: 'Books' });
    await patch({ defaultCategory: 'Sports' });

    assert.equal(
      server.settings.defaults().subcategory,
      null,
      'Books under Sports would be rejected in the very next feed it reached',
    );
  });

  it('writes the explicit default too, and a new show is created with all three', async () => {
    await patch({ defaultCategory: 'Arts', defaultSubcategory: 'Books', defaultExplicit: true });
    assert.equal(server.settings.defaults().explicit, true);

    await server.makeShowFolder('inherits-defaults');
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    const show = server.shows.getBySlug('inherits-defaults');
    assert.equal(show.itunes_category, 'Arts');
    assert.equal(show.itunes_subcategory, 'Books');
    assert.equal(show.explicit, 1);
  });
});

/**
 * Per-episode artwork, served one segment deeper than the show cover and from a
 * cache SelfPod owns rather than from the user's file share.
 */
describe('per-episode artwork (GET /media/:slug/:token/:episodeId/cover.jpg)', () => {
  async function seedArtwork(slug = 'arty-eps') {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const sharp = (await import('sharp')).default;
    const { mp3WithEmbeddedArtwork } = await import('../helpers/harness.js');

    await server.makeShowFolder(slug);
    await writeFile(
      join(server.config.showsDir, slug, 'ep-one.mp3'),
      await mp3WithEmbeddedArtwork(
        await sharp({ create: { width: 1500, height: 1500, channels: 3, background: '#204020' } })
          .jpeg()
          .toBuffer(),
      ),
    );
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    const show = server.shows.getBySlug(slug);
    const [episode] = server.episodes.listByShow(show.id);
    return {
      show,
      episode,
      url: `/media/${show.slug}/${show.feed_token}/${episode.id}/cover.jpg`,
    };
  }

  it('serves the image with a content ETag taken straight from the art_etag column', async () => {
    const { episode, url } = await seedArtwork();

    const response = await server.app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.equal(response.headers['cache-control'], 'public, max-age=3600');
    assert.equal(response.headers.etag, `"${episode.art_etag}"`, 'no per-request hashing');
    assert.ok(response.rawPayload.length > 0);
  });

  it('answers 304 to both the strong and the weak form of that ETag', async () => {
    const { url } = await seedArtwork();
    const first = await server.app.inject({ method: 'GET', url });

    const strong = await server.app.inject({
      method: 'GET',
      url,
      headers: { 'if-none-match': first.headers.etag },
    });
    assert.equal(strong.statusCode, 304);
    assert.equal(strong.headers.etag, first.headers.etag, 'a 304 still carries its validator');

    // Cloudflare re-emits strong ETags as weak ones, so without the weak comparison
    // every poll from behind the recommended tunnel would refetch the image.
    const weak = await server.app.inject({
      method: 'GET',
      url,
      headers: { 'if-none-match': `W/${first.headers.etag}` },
    });
    assert.equal(weak.statusCode, 304);
  });

  it('wins over the audio route for the literal cover.jpg segment', async () => {
    const { show, episode } = await seedArtwork();

    // Both routes match this shape — `cover.jpg` sits exactly where the audio
    // route's `:filename` is — and a static segment must beat a parametric one.
    // Asserted rather than assumed: if precedence ever flipped, this URL would
    // quietly start serving the mp3 under an image content type.
    const artwork = await server.app.inject({
      method: 'GET',
      url: `/media/${show.slug}/${show.feed_token}/${episode.id}/cover.jpg`,
    });
    assert.equal(artwork.statusCode, 200);
    assert.equal(artwork.headers['content-type'], 'image/jpeg');

    const audio = await server.app.inject({
      method: 'GET',
      url: `/media/${show.slug}/${show.feed_token}/${episode.id}/${episode.filename}`,
    });
    assert.equal(audio.statusCode, 200);
    assert.equal(audio.headers['content-type'], 'audio/mpeg', 'the audio route still answers');
  });

  it('404s on a wrong token, exactly as every other media route does', async () => {
    const { show, episode } = await seedArtwork();
    const response = await server.app.inject({
      method: 'GET',
      url: `/media/${show.slug}/not-the-token/${episode.id}/cover.jpg`,
    });
    assert.equal(response.statusCode, 404);
  });

  it('404s for an episode belonging to another show', async () => {
    const { episode } = await seedArtwork('arty-eps');
    const other = await seedArtwork('arty-other');
    const response = await server.app.inject({
      method: 'GET',
      url: `/media/${other.show.slug}/${other.show.feed_token}/${episode.id}/cover.jpg`,
    });
    assert.equal(response.statusCode, 404, 'the episode must belong to the show in the URL');
  });

  it('404s for an episode that has no artwork of its own', async () => {
    await server.addAudio('plain', 'sample.m4a');
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const show = server.shows.getBySlug('plain');
    const [episode] = server.episodes.listByShow(show.id);

    assert.equal(episode.art_filename, null);
    const response = await server.app.inject({
      method: 'GET',
      url: `/media/${show.slug}/${show.feed_token}/${episode.id}/cover.jpg`,
    });
    assert.equal(response.statusCode, 404);
  });

  it('404s rather than traversing when art_filename has been tampered with', async () => {
    const { show, episode, url } = await seedArtwork();
    assert.equal((await server.app.inject({ method: 'GET', url })).statusCode, 200);

    // A restored or hand-edited database is exactly the input the containment check
    // exists for: this column is never validated on the way in.
    for (const tampered of ['../../db.sqlite', '/etc/passwd', '..%2F..%2Fdb.sqlite']) {
      server.db
        .prepare('UPDATE episodes SET art_filename = ? WHERE id = ?')
        .run(tampered, episode.id);
      const response = await server.app.inject({
        method: 'GET',
        url: `/media/${show.slug}/${show.feed_token}/${episode.id}/cover.jpg`,
      });
      assert.equal(response.statusCode, 404, `\`${tampered}\` must not resolve to anything`);
    }
  });

  it('404s when the cached file has been deleted from under the row', async () => {
    const { rm } = await import('node:fs/promises');
    const { url } = await seedArtwork();
    assert.equal((await server.app.inject({ method: 'GET', url })).statusCode, 200);

    await rm(server.config.episodeArtDir, { recursive: true, force: true });
    const response = await server.app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 404, 'a row pointing at nothing is a 404, not a 500');
  });
});
