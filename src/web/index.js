import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyCompress from '@fastify/compress';
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

  fastify.decorate('viewHelpers', helpers);

  /*
   * The pages, fragments and assets, in a context of their own so that compression
   * applies to them and to nothing else.
   *
   * This plugin is not encapsulated (it has to share the auth and view decorators),
   * so compression registered here directly would reach every route in the app —
   * including `/media/*`, which serves already-compressed audio with byte ranges and
   * where a content-coding would spend CPU to break seeking, and `/feeds/*`, which
   * compresses itself once and caches the result. Inside this child it can only ever
   * see HTML, CSS, JS and the SSE stream — and the stream is excluded by type.
   */
  await fastify.register(async (web) => {
    await web.register(fastifyCompress, compressOptions());

    // Fonts, CSS and JS. Long-lived immutable caching is safe in a release because
    // every asset URL carries the app version as a query string — but that same
    // caching makes edits invisible during development, where the version does not
    // move, so it is only applied when NODE_ENV says this is production.
    const isProduction = process.env.NODE_ENV === 'production';
    await web.register(fastifyStatic, {
      root: join(here, 'public'),
      prefix: '/assets/',
      decorateReply: false,
      maxAge: isProduction ? '365d' : 0,
      immutable: isProduction,
    });

    await web.register(pageRoutes, services);
    await web.register(fragmentRoutes, services);
    await web.register(eventRoutes, services);
  });
}

/**
 * How HTML, CSS, JS and JSON are compressed — shared with the API plugin.
 *
 * Only text types, named explicitly: the plugin's own default list includes
 * `application/octet-stream`, which is what an unknown download is served as, and
 * nothing binary should ever be re-compressed here. `text/event-stream` is left out
 * so the live-update stream is written through as it happens rather than buffered
 * in a compressor. Request bodies are never decompressed: an admin form is small, and
 * inflating whatever a client chose to send is a bomb nobody asked to defuse.
 */
export function compressOptions() {
  return {
    global: true,
    globalDecompression: false,
    encodings: ['br', 'gzip'],
    threshold: 1024,
    customTypes: /^text\/(?!event-stream)|(?:\+|\/)json(?:;|$)|(?:\+|\/)xml(?:;|$)|javascript(?:;|$)/u,
  };
}

export default fp(webPlugin, { name: 'selfpod-web', dependencies: ['selfpod-auth'] });
