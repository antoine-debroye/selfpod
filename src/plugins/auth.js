import bcrypt from 'bcryptjs';
import fp from 'fastify-plugin';

import { nowIso } from '../lib/dates.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { BCRYPT_ROUNDS } from '../services/bootstrap.js';
import { SETTING_KEYS } from '../services/settings.js';

/**
 * Authentication, brute-force protection and CSRF defence for the single admin
 * account (spec §12.1).
 *
 * Two subtleties that a naive implementation gets wrong behind a tunnel:
 *
 * 1. `request.ip` cannot be trusted for rate limiting. With `trustProxy` enabled
 *    it is the left-most X-Forwarded-For entry, which the *client* supplies —
 *    and Cloudflare appends to that header rather than replacing it. An attacker
 *    rotating a fake XFF would get a fresh bucket per request. But keying on the
 *    raw socket address alone is also wrong: through a tunnel every visitor
 *    shares cloudflared's address, so one attacker could lock out the real admin.
 *    So the key combines the socket address with the edge-set CF-Connecting-IP,
 *    and an account-level backoff runs regardless of source — for a one-account
 *    app, that is the control that actually matters.
 *
 * 2. SameSite=Lax alone is thin: homelab users typically host many apps under one
 *    registrable domain, and a compromised sibling subdomain is *same-site*. So
 *    mutating requests also verify Origin/Sec-Fetch-Site.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 5;

/** Backoff after consecutive failures, in seconds, regardless of source address. */
const BACKOFF_STEPS = [0, 0, 1, 3, 10, 30, 60, 120, 300];

async function authPlugin(fastify, { db, settings, config, logger }) {
  const recordAttempt = db.prepare(
    'INSERT INTO login_attempts (username, attempted_at, succeeded, source) VALUES (?, ?, ?, ?)',
  );
  const recentFailures = db.prepare(
    `SELECT COUNT(*) AS n, MAX(attempted_at) AS last FROM login_attempts
      WHERE username = ? AND succeeded = 0 AND attempted_at > ?`,
  );
  const clearAttempts = db.prepare('DELETE FROM login_attempts WHERE username = ?');
  const trimAttempts = db.prepare('DELETE FROM login_attempts WHERE attempted_at < ?');

  /**
   * The rate-limit key. Not spoofable through Cloudflare (CF-Connecting-IP is set
   * at the edge), and honest on a LAN (where the socket address is the client).
   */
  function sourceKey(request) {
    const socket = request.socket?.remoteAddress ?? 'unknown';
    const edge = request.headers['cf-connecting-ip'];
    const trueClient = request.headers['true-client-ip'];
    return `${socket}|${edge ?? trueClient ?? ''}`;
  }

  fastify.decorate('loginSourceKey', sourceKey);

  /** Seconds the account must wait before another attempt, 0 when clear. */
  fastify.decorate('loginBackoffSeconds', (username) => {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const row = recentFailures.get(username, since);
    const failures = row?.n ?? 0;
    if (!failures || !row.last) return 0;
    const step = BACKOFF_STEPS[Math.min(failures, BACKOFF_STEPS.length - 1)];
    if (!step) return 0;
    const elapsed = (Date.now() - new Date(row.last).getTime()) / 1000;
    return Math.max(0, Math.ceil(step - elapsed));
  });

  fastify.decorate('recentFailureCount', (username) => {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    return recentFailures.get(username, since)?.n ?? 0;
  });

  /**
   * Verifies credentials. Always runs a bcrypt comparison, even for an unknown
   * username, so response timing doesn't reveal whether the account exists.
   */
  fastify.decorate('verifyCredentials', async (username, password, request) => {
    const expectedUser = settings.adminUsername();
    const hash = settings.adminPasswordHash();
    const source = request ? sourceKey(request) : null;

    const backoff = fastify.loginBackoffSeconds(expectedUser);
    if (backoff > 0) {
      return {
        ok: false,
        retryAfter: backoff,
        message: `Too many failed sign-in attempts. Try again in ${formatSeconds(backoff)}.`,
      };
    }

    const usernameMatches = typeof username === 'string' && username.trim() === expectedUser;
    const passwordMatches = await bcrypt.compare(
      String(password ?? ''),
      hash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv',
    );

    if (!usernameMatches || !passwordMatches) {
      recordAttempt.run(expectedUser, nowIso(), 0, source);
      trimAttempts.run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      logger?.warn({ source, username }, 'failed admin sign-in');
      return { ok: false, message: 'That username and password combination is not correct.' };
    }

    recordAttempt.run(expectedUser, nowIso(), 1, source);
    clearAttempts.run(expectedUser);
    return { ok: true, username: expectedUser };
  });

  fastify.decorate('setAdminPassword', async (password) => {
    const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    settings.update(
      { [SETTING_KEYS.ADMIN_PASSWORD_HASH]: hash, [SETTING_KEYS.MUST_CHANGE_PASSWORD]: '0' },
      { skipExport: true },
    );
    return true;
  });

  fastify.decorate('isAuthenticated', (request) => Boolean(request.session?.get?.('admin')));

  /** preHandler for the JSON API: rejects with the standard error shape. */
  fastify.decorate('requireAdminApi', async (request) => {
    if (!fastify.isAuthenticated(request)) {
      throw unauthorized('Please sign in to continue.', 'unauthenticated');
    }
  });

  /** preHandler for pages: redirects to the sign-in page instead of erroring. */
  fastify.decorate('requireAdminPage', async (request, reply) => {
    if (fastify.isAuthenticated(request)) return;
    const target = request.method === 'GET' ? request.url : '/';
    if (request.headers['hx-request']) {
      reply.header('HX-Redirect', `/login?next=${encodeURIComponent(target)}`);
      return reply.status(401).send();
    }
    return reply.redirect(`/login?next=${encodeURIComponent(target)}`, 303);
  });

  /**
   * Same-origin check for every state-changing request. Cheap, needs no token
   * plumbing, and closes the same-site-sibling hole SameSite=Lax leaves open.
   */
  fastify.addHook('onRequest', async (request) => {
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      throw forbidden(
        'That request came from another site and was blocked. Reload this page and try again.',
        'cross_site_blocked',
      );
    }

    const origin = request.headers.origin;
    if (origin) {
      const host = request.headers['x-forwarded-host'] ?? request.headers.host;
      let originHost = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (!originHost || (host && originHost !== host)) {
        throw forbidden(
          'That request came from another site and was blocked. Reload this page and try again.',
          'cross_origin_blocked',
        );
      }
    }
  });

  void config;
}

function formatSeconds(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export { MAX_ATTEMPTS_PER_WINDOW, WINDOW_MS };
export default fp(authPlugin, { name: 'selfpod-auth', dependencies: ['selfpod-session'] });
