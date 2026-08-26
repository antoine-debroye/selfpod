import { join } from 'node:path';

import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

import { AppError } from './lib/errors.js';
import authPlugin from './plugins/auth.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import { loggerRedactPaths, loggerSerializers } from './plugins/log-redaction.js';
import securityHeadersPlugin from './plugins/security-headers.js';
import sessionPlugin from './plugins/session.js';
import apiRoutes from './routes/api/index.js';
import publicRoutes from './routes/public.js';
import webPlugin from './web/index.js';

/**
 * Builds the Fastify instance. Deliberately does not call `listen`, so tests can
 * drive the real app with `inject` and the entrypoint stays in charge of the
 * process lifecycle.
 */
export async function buildApp(services) {
  const { config, logger } = services;

  const fastify = Fastify({
    loggerInstance: logger,
    // The app always runs behind the user's own reverse proxy or tunnel, so
    // X-Forwarded-Proto has to be honoured for Secure cookies and correct URLs.
    // Note this makes `request.ip` client-influenced — see plugins/auth.js for why
    // rate limiting deliberately does not use it.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024, // form posts only; uploads stream via multipart

    // Episode filenames are route parameters, and Fastify rejects any parameter
    // over 100 characters with a 414 before the handler ever runs. Real episode
    // titles blow through that easily — "2026-08-03-Bulletin météo : forte
    // dépression sur Ceuta, retour à la normale annoncé depuis Madrid.m4a" is 106 —
    // and the failure surfaces in a podcast app as "requested URL too long", with
    // nothing in SelfPod's own logs to explain it. 512 comfortably exceeds the
    // 255-byte filename ceiling of every filesystem this runs on.
    maxParamLength: 512,
  });

  await fastify.register(errorHandlerPlugin);
  // Registered before any route so the headers apply to every response, including
  // errors produced by the handlers below.
  await fastify.register(securityHeadersPlugin, { settings: services.settings, config });
  await fastify.register(fastifyFormbody);
  await fastify.register(fastifyMultipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 20,
      fieldSize: 1024 * 1024,
    },
  });

  // `serve: false` registers only the sendFile decorator; media is served through
  // authorised handlers, never as an open static root. sendFile brings correct
  // HTTP Range handling with it (spec §8.4).
  await fastify.register(fastifyStatic, {
    root: config.showsDir,
    serve: false,
    decorateReply: true,
  });

  await fastify.register(sessionPlugin, {
    db: services.db,
    settings: services.settings,
    logger,
  });
  await fastify.register(authPlugin, {
    db: services.db,
    settings: services.settings,
    config,
    logger,
  });

  /**
   * Rate limiting, opt-in per route.
   *
   * `@fastify/rate-limit` has been a declared dependency for some time and was never
   * actually registered; the only limiter in the app was a twelve-line array inside
   * the reachability route. Registering it is overdue — but **`global: false` is not
   * a preference, it is the whole design**, and turning it on would break the app in
   * two ways that are both worse than having no limiter at all:
   *
   *  1. `/media/...` serves Range requests. A podcast app scrubbing through an
   *     episode issues a burst of 206s, and a 429 in the middle of that is a broken
   *     episode with no explanation anywhere.
   *  2. `loginSourceKey` is `socket.remoteAddress | cf-connecting-ip`. Behind nginx,
   *     Traefik or Tailscale — anything that is not Cloudflare — the socket address
   *     is the proxy's, so **every listener in the world shares one bucket**. That
   *     key is right for login precisely because it is paired with an account-level
   *     backoff; as a general key for public traffic it is a self-inflicted outage
   *     on the app's main job.
   *
   * So: no route is limited unless it opts in with `config.rateLimit`, and the ones
   * that do are all admin-only actions where a shared bucket is the intent.
   *
   * `keyGenerator` reads `fastify.loginSourceKey` lazily, inside the call. Referring
   * to it eagerly here would throw at boot, because authPlugin decorates it and has
   * only just been registered above — a detail worth stating, since moving this
   * registration a few lines either way would look harmless.
   */
  await fastify.register(fastifyRateLimit, {
    global: false,
    keyGenerator: (request) => fastify.loginSourceKey(request),
    // Advertising the remaining budget tells an attacker exactly how hard they can
    // push; Retry-After is the only one that helps an honest client.
    addHeaders: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
      'retry-after': true,
    },
    // Must return an **Error**, not a payload object. The plugin's own default body
    // is {statusCode, error, message}, while the app's contract is {error:{message,
    // code}} — but returning a plain object of that shape produces a 500, because
    // Fastify has nothing to take a status from. Returning an AppError instead lets
    // the app's error handler do the shaping it already does for every other route,
    // so there is one error shape in the app rather than two.
    errorResponseBuilder: (request, context) =>
      new AppError(
        `That has run several times in the last little while. Wait ${Math.ceil(context.ttl / 1000)} seconds and try again.`,
        { code: 'rate_limited', status: 429 },
      ),
  });

  await fastify.register(publicRoutes, services);
  await fastify.register(apiRoutes, { prefix: '/api', ...services });
  await fastify.register(webPlugin, services);

  fastify.decorate('services', services);
  return fastify;
}

export function loggerOptions(config) {
  return {
    level: config.logLevel === 'silent' ? 'silent' : config.logLevel,
    serializers: loggerSerializers,
    redact: loggerRedactPaths,
    ...(config.prettyLogs
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  };
}

export const staticAssetsRoot = (here) => join(here, 'web', 'public');
