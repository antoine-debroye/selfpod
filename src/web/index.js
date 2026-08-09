import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import fp from 'fastify-plugin';

import { VERSION } from '../version.js';
import { createViewHelpers } from './lib/view-helpers.js';
import eventRoutes from './routes/events.js';
import fragmentRoutes from './routes/fragments.js';
import pageRoutes from './routes/pages.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Cache-busting token for CSS and JS.
 *
 * The app version alone is not enough: assets are served with a long immutable
 * max-age, so during development — where the version never moves — a browser
 * would keep an edited stylesheet cached forever. Folding the files' modification
 * times in means the URL changes exactly when the content does.
 */
function assetVersion() {
  const files = ['css/app.css', 'js/app.js'];
  let stamp = 0;
  for (const file of files) {
    try {
      stamp = Math.max(stamp, statSync(join(here, 'public', file)).mtimeMs);
    } catch {
      /* a missing asset is caught by the tests, not worth failing boot over */
    }
  }
  return `${VERSION}-${Math.round(stamp).toString(36)}`;
}

/**
 * The server-rendered admin UI.
 *
 * Layouts are applied per render call rather than globally, because htmx fragment
 * responses must come back bare — a global layout would wrap every fragment in a
 * full HTML document.
 */
async function webPlugin(fastify, services) {
  const { config } = services;
  const helpers = createViewHelpers({ config });

  await fastify.register(fastifyView, {
    engine: { eta: new Eta({ views: join(here, 'views') }) },
    root: join(here, 'views'),
    viewExt: 'eta',
    defaultContext: { version: VERSION, assetVersion: assetVersion(), helpers },
    production: process.env.NODE_ENV === 'production',
  });

  // Fonts, CSS and JS. Long-lived immutable caching is safe in a release because
  // every asset URL carries the app version as a query string — but that same
  // caching makes edits invisible during development, where the version does not
  // move, so it is only applied when NODE_ENV says this is production.
  const isProduction = process.env.NODE_ENV === 'production';
  await fastify.register(fastifyStatic, {
    root: join(here, 'public'),
    prefix: '/assets/',
    decorateReply: false,
    maxAge: isProduction ? '365d' : 0,
    immutable: isProduction,
  });

  fastify.decorate('viewHelpers', helpers);

  await fastify.register(pageRoutes, services);
  await fastify.register(fragmentRoutes, services);
  await fastify.register(eventRoutes, services);
}

export default fp(webPlugin, { name: 'selfpod-web', dependencies: ['selfpod-auth'] });
