import { join } from 'node:path';

import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

import authPlugin from './plugins/auth.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import { loggerRedactPaths, loggerSerializers } from './plugins/log-redaction.js';
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
  });

  await fastify.register(errorHandlerPlugin);
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
