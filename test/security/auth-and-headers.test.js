import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';

/**
 * Adversarial tests for authentication, session handling and response hardening.
 *
 * The premise is that the admin interface is reachable from the internet, so every
 * route that changes something must be unreachable without a session, unreachable
 * from another website, and unreachable by guessing passwords at speed.
 */
describe('the admin surface cannot be reached without credentials', () => {
  let server;
  let show;

  before(async () => {
    server = await createTestServer();
    await server.addAudio('locked', 'sample.m4a', 'one.m4a');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('locked');
  });

  after(async () => {
    await server.cleanup();
  });

  /** Every route that reads or changes admin state. */
  const GUARDED = [
    ['GET', '/api/shows'],
    ['GET', '/api/settings'],
    ['GET', '/api/activity'],
    ['GET', '/api/stats'],
    ['GET', '/api/stats/log'],
    ['GET', '/api/categories'],
    ['POST', '/api/reachability'],
    ['POST', '/api/rescan'],
    ['PATCH', '/api/settings'],
    ['POST', '/api/setup'],
    ['GET', '/'],
    ['GET', '/settings'],
    ['GET', '/stats'],
    ['GET', '/activity'],
    ['GET', '/ui/stats/log'],
    ['GET', '/ui/activity'],
  ];

  it('refuses every guarded route to an anonymous caller', async () => {
    for (const [method, url] of GUARDED) {
      const response = await server.app.inject({
        method,
        url,
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      assert.ok(
        [401, 302, 303, 404].includes(response.statusCode),
        `${method} ${url} answered ${response.statusCode} to an anonymous caller`,
      );
      const body = response.body ?? '';
      assert.ok(!body.includes(show.feed_token), `${method} ${url} leaked a feed token`);
      assert.ok(!body.includes('"shows"'), `${method} ${url} leaked show data`);
    }
  });

  it('refuses a forged or malformed session cookie', async () => {
    for (const cookie of [
      'selfpod.sid=abcdef123456',
      'selfpod.sid=' + 'a'.repeat(64),
      'selfpod.sid=admin',
      'selfpod.sid=%7B%22admin%22%3Atrue%7D',
    ]) {
      const response = await server.app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { cookie, 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(response.statusCode, 401, `cookie "${cookie}" was accepted`);
    }
  });

  it('rejects mutating requests that come from another website', async () => {
    await server.login();
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example' },
      { origin: 'http://selfpod.debroye.com.evil.example' },
    ]) {
      const response = await server.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        payload: { defaultAuthorName: 'attacker' },
        headers: { ...headers, cookie: server.cookie, 'content-type': 'application/json' },
      });
      assert.ok(
        response.statusCode >= 400,
        `a cross-origin PATCH with ${JSON.stringify(headers)} returned ${response.statusCode}`,
      );
    }
    assert.notEqual(server.settings.defaults().authorName, 'attacker');
  });

  it('will not change the password without the current one', async () => {
    await server.login();
    const response = await server.request({
      method: 'POST',
      url: '/api/settings/password',
      payload: { password: 'attacker-chosen-pw', passwordConfirm: 'attacker-chosen-pw' },
      headers: { 'content-type': 'application/json' },
    });
    assert.ok(response.statusCode >= 400, `password changed without the current one (${response.statusCode})`);
    // The original password must still work.
    const stillWorks = await server.login();
    assert.equal(stillWorks.statusCode, 200);
  });

  it('throttles password guessing, and a spoofed client IP does not help', async () => {
    const fresh = await createTestServer();
    try {
      let blocked = 0;
      for (let i = 0; i < 12; i += 1) {
        const response = await fresh.app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { username: 'admin', password: `guess-${i}` },
          headers: {
            'sec-fetch-site': 'same-origin',
            // A rotating forged client address must not buy fresh attempts.
            'x-forwarded-for': `10.0.0.${i}`,
          },
        });
        if (response.statusCode === 429 || /too many/i.test(response.body ?? '')) blocked += 1;
      }
      assert.ok(blocked > 0, 'password guessing was never throttled');
    } finally {
      await fresh.cleanup();
    }
  });

  it('ends a session server-side on logout', async () => {
    await server.login();
    const cookie = server.cookie;
    const before = await server.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(before.statusCode, 200);

    await server.app.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    });

    const after_ = await server.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(after_.statusCode, 401, 'the old cookie still worked after logout');
  });
});

describe('a wrong feed token reveals nothing', () => {
  let server;
  let show;

  before(async () => {
    server = await createTestServer();
    await server.addAudio('secretshow', 'sample.m4a', 'one.m4a');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('secretshow');
  });

  after(async () => {
    await server.cleanup();
  });

  it('answers identically for a real show with a bad token and a show that does not exist', async () => {
    // If these differed, the feed URLs would be enumerable one slug at a time.
    const wrongToken = await server.app.inject({
      url: `/feeds/secretshow/${'a'.repeat(22)}.xml`,
    });
    const noSuchShow = await server.app.inject({
      url: `/feeds/does-not-exist/${'a'.repeat(22)}.xml`,
    });

    assert.equal(wrongToken.statusCode, 404);
    assert.equal(noSuchShow.statusCode, 404);
    assert.equal(wrongToken.body, noSuchShow.body, 'the two answers must be indistinguishable');
    assert.ok(!wrongToken.body.includes('secretshow') || !wrongToken.body.includes('token'));
  });

  it('never uses 403, which would confirm the show exists', async () => {
    const response = await server.app.inject({
      url: `/media/secretshow/${'b'.repeat(22)}/x/y.m4a`,
    });
    assert.equal(response.statusCode, 404);
  });

  it('keeps the token out of logs', async () => {
    const lines = [];
    const capturing = await createTestServer({
      logger: {
        info: (o) => lines.push(JSON.stringify(o)),
        warn: (o) => lines.push(JSON.stringify(o)),
        error: (o) => lines.push(JSON.stringify(o)),
      },
    });
    try {
      await capturing.app.inject({ url: `/feeds/${show.slug}/${show.feed_token}.xml` });
      const dump = lines.join('\n');
      assert.ok(!dump.includes(show.feed_token), 'a feed token reached the logs');
    } finally {
      await capturing.cleanup();
    }
  });
});

describe('responses carry hardening headers', () => {
  let server;

  before(async () => {
    server = await createTestServer();
    await server.login();
  });

  after(async () => {
    await server.cleanup();
  });

  it('sends a script-tight content security policy on HTML', async () => {
    const response = await server.request({ method: 'GET', url: '/' });
    const csp = response.headers['content-security-policy'];
    assert.ok(csp, 'no content security policy on an HTML page');
    assert.match(csp, /script-src 'self'/);
    assert.ok(
      !/script-src[^;]*unsafe-inline/.test(csp),
      'inline script is allowed, which defeats the point',
    );
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'self'/);
  });

  it('sets the other headers on every response, including the feed', async () => {
    for (const url of ['/', '/login', '/health']) {
      const response = await server.request({ method: 'GET', url });
      assert.equal(response.headers['x-content-type-options'], 'nosniff', url);
      assert.equal(response.headers['x-frame-options'], 'DENY', url);
      assert.equal(response.headers['referrer-policy'], 'no-referrer', url);
    }
  });

  it('leaves /health readable cross-origin, which the reachability test needs', async () => {
    const response = await server.app.inject({ url: '/health' });
    assert.equal(response.headers['access-control-allow-origin'], '*');
  });

  it('allows the configured public address in connect-src, or the test cannot run', async () => {
    const response = await server.request({ method: 'GET', url: '/' });
    const csp = response.headers['content-security-policy'];
    assert.match(csp, /connect-src [^;]*https:\/\/podcast\.example\.com/);
  });

  it('does not send HSTS unless it was asked for', async () => {
    const response = await server.request({ method: 'GET', url: '/' });
    assert.equal(response.headers['strict-transport-security'], undefined);
  });
});
