import { SHOW_STATUS } from '../../constants.js';
import { VERSION } from '../../version.js';

/**
 * Instance status. This is what powers the persistent degraded-state banner, so
 * it must answer even when the app is unhealthy — the values come from the
 * in-memory health registry rather than from a query that might itself fail.
 */
export default async function statusRoutes(fastify, { settings, health, watcher, scheduler, shows, activity, config }) {
  fastify.get('/status', async (request) => {
    const authenticated = fastify.isAuthenticated(request);
    const issues = health.list();

    const base = {
      version: VERSION,
      status: health.hasErrors() ? 'degraded' : 'ok',
      setupComplete: settings.setupComplete(),
      hasPublicBaseUrl: settings.hasPublicBaseUrl(),
      authenticated,
      // The banner has to be visible to whoever can reach the app, otherwise a
      // permission problem is undiagnosable without SSH (spec §13.1).
      issues: issues.map((issue) => ({
        key: issue.key,
        level: issue.level,
        message: issue.message,
        since: issue.since,
      })),
    };

    if (!authenticated) return base;

    const lastGlobalScan = activity.latestGlobal();
    return {
      ...base,
      // Only shared with an authenticated admin: telling an anonymous visitor that
      // the instance is still on its generated password is an invitation.
      mustChangePassword: settings.mustChangePassword(),
      publicBaseUrl: settings.publicBaseUrl(),
      timeZone: config.timeZone,
      puid: config.runtimeUid ?? config.puid,
      pgid: config.runtimeGid ?? config.pgid,
      dataDir: config.dataDir,
      showsDir: config.showsDir,
      maxUploadSizeMb: config.maxUploadSizeMb,
      watcher: watcher?.status() ?? { mode: 'off', enabled: false, degraded: false, lastEventAt: null },
      scheduler: scheduler?.status() ?? null,
      watcherNoticeDismissed: settings.watcherNoticeDismissed(),
      shows: {
        total: shows.list().length,
        paused: shows.list().filter((s) => s.status === SHOW_STATUS.FOLDER_MISSING).length,
      },
      lastScan: lastGlobalScan
        ? {
            id: lastGlobalScan.id,
            finishedAt: lastGlobalScan.finishedAt,
            trigger: lastGlobalScan.trigger,
            added: lastGlobalScan.added,
            errors: lastGlobalScan.errors.length,
          }
        : null,
    };
  });

  /** Apple's category taxonomy, so the picker is never free text (spec §11.3). */
  fastify.get('/categories', { preHandler: fastify.requireAdminApi }, async () => shows.categories());
}
