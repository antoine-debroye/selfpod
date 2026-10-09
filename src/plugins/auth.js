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

/**
 * Two backoffs, because they protect against different people.
 *
 * The account-level one holds *everyone* back after failures from anywhere, so it
 * is what stops a slow guess spread across many addresses — and also what lets a
 * stranger who holds the public URL keep the owner out: one wrong password every
 * few minutes used to reset a five-minute lock for ever. It is therefore capped at
 * a minute, which is still one guess a minute for a patient attacker.
 *
 * The per-source one is allowed to grow to five minutes, because it only ever
 * holds back the address that earned it. Behind Cloudflare the source is the
 * edge-set client address; on a LAN it is the socket; behind another proxy that
 * sets neither header every visitor shares one source, which is no worse than the
 * old account-level lock.
 */
const ACCOUNT_BACKOFF_STEPS = [0, 0, 1, 3, 10, 30, 60];
const SOURCE_BACKOFF_STEPS = [0, 0, 1, 3, 10, 30, 60, 120, 300];
const MAX_ACCOUNT_LOCK_SECONDS = ACCOUNT_BACKOFF_STEPS[ACCOUNT_BACKOFF_STEPS.length - 1];

async function authPlugin(fastify, { db, settings, config, logger }) {
  const recordAttempt = db.prepare(
    'INSERT INTO login_attempts (username, attempted_at, succeeded, source) VALUES (?, ?, ?, ?)',
  );
  const recentFailures = db.prepare(
    `SELECT COUNT(*) AS n, MAX(attempted_at) AS last FROM login_attempts
      WHERE username = ? AND succeeded = 0 AND attempted_at > ?`,
  );
  const recentFailuresFromSource = db.prepare(
    `SELECT COUNT(*) AS n, MAX(attempted_at) AS last FROM login_attempts
      WHERE username = ? AND source = ? AND succeeded = 0 AND attempted_at > ?`,
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

  /** Seconds still to wait after the failures in `row`, on the given ladder. */
  function waitFor(steps, row) {
    const failures = row?.n ?? 0;
    if (!failures || !row.last) return 0;
    const step = steps[Math.min(failures, steps.length - 1)];
    if (!step) return 0;
    const elapsed = (Date.now() - new Date(row.last).getTime()) / 1000;
    return Math.max(0, Math.ceil(step - elapsed));
  }

  /**
   * Seconds this caller must wait before another attempt, 0 when clear: the longer
   * of the account's own wait and the wait this source has earned for itself.
   */
  fastify.decorate('loginBackoffSeconds', (username, source = null) => {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const account = waitFor(ACCOUNT_BACKOFF_STEPS, recentFailures.get(username, since));
    const bySource = source
      ? waitFor(SOURCE_BACKOFF_STEPS, recentFailuresFromSource.get(username, source, since))
      : 0;
    return Math.max(account, bySource);
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

    const backoff = fastify.loginBackoffSeconds(expectedUser, source);
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

  /**
   * Sets the password and signs every *other* session out.
   *
   * Someone changing their password because they suspect a session was stolen
   * expects the thief to be gone; until now the thief stayed signed in for up to
   * thirty days. `keepSessionId` is the session doing the changing — the setup
   * wizard and the Settings modal pass their own — and `null` means sign out
   * everyone, which is what the reset script wants.
   */
  fastify.decorate('setAdminPassword', async (password, { keepSessionId = null } = {}) => {
    const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    settings.update(
      { [SETTING_KEYS.ADMIN_PASSWORD_HASH]: hash, [SETTING_KEYS.MUST_CHANGE_PASSWORD]: '0' },
      { skipExport: true },
    );
    const endedSessions = fastify.sessionStore?.deleteOthers(keepSessionId) ?? 0;
    if (endedSessions) logger?.info({ endedSessions }, 'password changed; other sessions signed out');
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
    // Every current browser sends Sec-Fetch-Site, and `same-origin` is a stronger
    // statement than anything Origin can tell us — so trust it and stop.
    if (fetchSite === 'same-origin' || fetchSite === 'none') return;

    const origin = request.headers.origin;
    if (!origin) return;

    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw forbidden('That request had an unreadable Origin header and was blocked.', 'bad_origin');
    }

    // Which hostnames count as "us" is not obvious behind a proxy: nginx's default
    // `proxy_set_header Host $proxy_host` rewrites Host to the container's name, so
    // comparing Origin against Host alone would reject every form submission —
    // including the sign-in form, locking the admin out entirely. The configured
    // public base URL is the authoritative answer, with the forwarded and real Host
    // headers accepted as well.
    const allowed = new Set();
    const publicBase = settings.publicBaseUrl();
    if (publicBase) {
      try {
        allowed.add(new URL(publicBase).host);
      } catch {
        /* a malformed stored value simply contributes nothing */
      }
    }
    // A chain of proxies appends, so this header can be a comma-separated list.
    const forwardedHost = request.headers['x-forwarded-host'];
    if (forwardedHost) allowed.add(String(forwardedHost).split(',')[0].trim());
    if (request.headers.host) allowed.add(request.headers.host);

    if (!allowed.has(originHost)) {
      request.log.warn(
        { originHost, allowed: [...allowed] },
        'blocked a request whose Origin does not match this instance',
      );
      throw forbidden(
        `That request came from ${originHost}, which is not this SelfPod instance, so it was blocked. If you reach SelfPod on that address, set it as the public base URL in Settings.`,
        'cross_origin_blocked',
      );
    }
  });

  void config;
}

function formatSeconds(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export { MAX_ACCOUNT_LOCK_SECONDS, WINDOW_MS };
export default fp(authPlugin, { name: 'selfpod-auth', dependencies: ['selfpod-session'] });
