import activityRoutes from './activity.js';
import adSegmentRoutes from './ad-segments.js';
import authRoutes from './auth.js';
import episodeRoutes from './episodes.js';
import reachabilityRoutes from './reachability.js';
import settingsRoutes from './settings.js';
import setupRoutes from './setup.js';
import showRoutes from './shows.js';
import statsRoutes from './stats.js';
import statusRoutes from './status.js';
import subscriptionRoutes from './subscriptions.js';

/**
 * The JSON API (spec §14). Every route below requires the admin session except
 * the two auth endpoints and the status endpoint the UI polls to render its
 * degraded-state banner.
 */
export default async function apiRoutes(fastify, options) {
  // The `prefix` that mounted this plugin arrives in `options`. Passing it
  // straight through to the children would apply it a second time and put every
  // route at /api/api/…, so it is stripped here.
  const { prefix, ...services } = options;
  void prefix;

  await fastify.register(authRoutes, services);
  await fastify.register(statusRoutes, services);
  await fastify.register(setupRoutes, services);
  await fastify.register(showRoutes, services);
  await fastify.register(episodeRoutes, services);
  await fastify.register(activityRoutes, services);
  await fastify.register(statsRoutes, services);
  await fastify.register(reachabilityRoutes, services);
  await fastify.register(subscriptionRoutes, services);
  await fastify.register(adSegmentRoutes, services);
  await fastify.register(settingsRoutes, services);
}
