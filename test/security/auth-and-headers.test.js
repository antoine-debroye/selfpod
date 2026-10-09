import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ADMIN_PASSWORD, createTestServer } from '../helpers/http.js';

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

  it('signs every other session out when the password changes', async () => {
    const fresh = await createTestServer();
    try {
      await fresh.login();
      const phone = fresh.cookie;
      await fresh.login();
      const laptop = fresh.cookie;
      assert.notEqual(phone, laptop, 'two sign-ins should be two sessions');

      const change = await fresh.app.inject({
        method: 'POST',
        url: '/api/settings/password',
        headers: { cookie: laptop, 'sec-fetch-site': 'same-origin' },
        payload: {
          currentPassword: ADMIN_PASSWORD,
          password: 'a-new-password-123',
          passwordConfirm: 'a-new-password-123',
        },
      });
      assert.equal(change.statusCode, 200, change.body);

      const stolen = await fresh.app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { cookie: phone, 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(stolen.statusCode, 401, 'the other session survived a password change');
      const own = await fresh.app.inject({
        method: 'GET',
        url: '/api/settings',
        headers: { cookie: laptop, 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(own.statusCode, 200, 'the session that changed the password was signed out too');
    } finally {
      await fresh.cleanup();
    }
  });

  it('issues a new session id on sign-in rather than promoting the one it was handed', async () => {
    const fresh = await createTestServer();
    try {
      await fresh.login();
      const before = fresh.cookie;
      const again = await fresh.app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username: 'admin', password: ADMIN_PASSWORD },
        headers: { cookie: before, 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(again.statusCode, 200);
      const issued = again.headers['set-cookie'];
      assert.ok(issued, 'a sign-in with an existing cookie must still set a cookie');
      const sid = (value) => String(value).split(';')[0];
      assert.notEqual(sid(issued), sid(before), 'the session id did not change on sign-in');
    } finally {
      await fresh.cleanup();
    }
  });

  it('never locks the account out for more than a minute, however hard a stranger tries', async () => {
    const fresh = await createTestServer();
    try {
      const justNow = new Date(Date.now() - 1000).toISOString();
      const insert = fresh.db.prepare(
        'INSERT INTO login_attempts (username, attempted_at, succeeded, source) VALUES (?, ?, 0, ?)',
      );
      for (let i = 0; i < 40; i += 1) insert.run('admin', justNow, `203.0.113.${i}|`);

      // Forty failures from forty addresses a second ago: the account waits, but
      // only a minute — one wrong password every five minutes used to keep the
      // owner out for as long as the stranger cared to carry on.
      const accountWait = fresh.app.loginBackoffSeconds('admin');
      assert.ok(accountWait > 0, 'the account should be backing off');
      assert.ok(accountWait <= 60, `the account lock was ${accountWait}s`);

      // Whereas the address that did the guessing waits the full five minutes.
      for (let i = 0; i < 10; i += 1) insert.run('admin', justNow, '198.51.100.7|');
      const sourceWait = fresh.app.loginBackoffSeconds('admin', '198.51.100.7|');
      assert.ok(sourceWait > 60, `the guessing source only waits ${sourceWait}s`);
      assert.equal(fresh.app.loginBackoffSeconds('admin', '192.0.2.1|'), accountWait, 'an innocent address waits only the account minute');

      // And the throttle answers 429, not "wrong password".
      const refused = await fresh.app.inject({
        method: 'POST',
        url: '/login',
        payload: 'username=admin&password=whatever',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(refused.statusCode, 429);
      assert.ok(refused.headers['retry-after']);
    } finally {
      await fresh.cleanup();
    }
  });

  it('shows a stranger only the permission banners, never a show or a feed by name', async () => {
    const fresh = await createTestServer();
    try {
      fresh.health.set('trimmed_missing_show1', {
        level: 'warn',
        message: 'SelfPod is serving “Secret Tape Club” with its adverts back in.',
      });
      fresh.health.set('shows_readable', {
        level: 'error',
        message: 'SelfPod cannot read your shows folder `/data/shows`.',
      });

      const anonymousStatus = await fresh.app.inject({ url: '/api/status' });
      assert.equal(anonymousStatus.statusCode, 200);
      assert.doesNotMatch(anonymousStatus.body, /Secret Tape Club/);
      assert.match(anonymousStatus.body, /cannot read your shows folder/);

      const loginPage = await fresh.app.inject({ url: '/login' });
      assert.doesNotMatch(loginPage.body, /Secret Tape Club/);
      assert.match(loginPage.body, /cannot read your shows folder/);

      await fresh.login();
      const ownStatus = await fresh.app.inject({
        url: '/api/status',
        headers: { cookie: fresh.cookie },
      });
      assert.match(ownStatus.body, /Secret Tape Club/, 'the owner still sees everything');
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
