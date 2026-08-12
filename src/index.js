import { mkdir } from 'node:fs/promises';

import Fastify from 'fastify';
import pino from 'pino';

import { buildApp, loggerOptions } from './app.js';
import { loadConfig } from './config.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { describeFsError } from './lib/errors.js';
import { createEventBus } from './lib/events.js';
import { createActivity } from './services/activity.js';
import { bootstrap } from './services/bootstrap.js';
import { createCovers } from './services/covers.js';
import { createEpisodeArt } from './services/episode-art.js';
import { createEpisodes } from './services/episodes.js';
import { createFeeds } from './services/feed.js';
import { createHealth } from './services/health.js';
import { createMetadata } from './services/metadata.js';
import { createPresenters } from './services/presenters.js';
import { createScanner } from './services/scanner.js';
import { createScheduler } from './services/scheduler.js';
import { createSettings } from './services/settings.js';
import { createReadiness } from './services/readiness.js';
import { createStats } from './services/stats.js';

import { createShows } from './services/shows.js';
import { createTimeline } from './services/timeline.js';
import { createWatcher } from './services/watcher.js';
import { SCAN_TRIGGER } from './constants.js';
import { VERSION } from './version.js';

const config = loadConfig();
const logger = pino(loggerOptions(config));

for (const warning of config.warnings) logger.warn(warning);

let shutdown = async () => {};

/**
 * Last line of defence.
 *
 * Node exits the process on an unhandled rejection, which for a container means a
 * restart loop — and the operator sees a service that keeps dying with no
 * explanation. A background job that fails should degrade the app, not kill it, so
 * these are logged loudly and the process keeps serving. A genuinely fatal state
 * still surfaces through the health endpoint and the UI banner.
 */
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason : new Error(String(reason)) },
    'a background task failed without being handled; SelfPod is still running, but please report this',
  );
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'an unexpected error escaped; SelfPod is still running, but please report this');
});

async function main() {
  logger.info(
    { version: VERSION, dataDir: config.dataDir, uid: config.runtimeUid, gid: config.runtimeGid },
    'starting SelfPod',
  );

  // /data must exist before anything else can be attempted.
  try {
    await mkdir(config.showsDir, { recursive: true });
    await mkdir(config.tempDir, { recursive: true });
    await mkdir(config.episodeArtDir, { recursive: true });
  } catch (err) {
    logger.error({ err }, 'could not prepare the data directory');
  }

  let opened;
  try {
    opened = openDatabase(config.databasePath, { logger });
  } catch (err) {
    // The database is the one thing the app genuinely cannot run without. Rather
    // than exiting — which would leave the operator with only container logs to
    // work from — serve a minimal app that explains the problem in a browser
    // (spec §13.1 step 4).
    await startDegradedServer(err);
    return;
  }

  const { db, journalIsWal, journalMode } = opened;
  const events = createEventBus({ logger });
  const settings = createSettings({ db, config, events, logger });
  const health = createHealth({ config, events, logger });

  if (!journalIsWal) {
    health.set('sqlite_journal', {
      level: 'warn',
      message: `SelfPod could not use SQLite's recommended journal mode on \`${config.dataDir}\` (it fell back to "${journalMode}"). This almost always means /data is an NFS or SMB mount. SelfPod will work, but /data should be a local path on the Docker host — keep your media there and share it out, rather than mounting a share in.`,
    });
  }

  await bootstrap({ db, settings, config, logger });
  await health.runDataSelfTest();

  const activity = createActivity({ db, config, logger });
  const covers = createCovers({ config, logger });
  const episodeArt = createEpisodeArt({ config, covers, logger });
  const metadata = createMetadata({ logger });
  const shows = createShows({ db, config, events, logger, settings, episodeArt });
  const episodes = createEpisodes({ db, config, events, shows, logger, episodeArt });
  const feeds = createFeeds({ config, settings, events, shows, episodes, logger });
  const scanner = createScanner({
    db, config, settings, events, logger,
    shows, episodes, covers, episodeArt, metadata, activity, health,
  });
  const stats = createStats({ db, logger });
  const readiness = createReadiness({ covers });
  const timeline = createTimeline({ db, logger });
  const watcher = createWatcher({ config, settings, events, logger, scanner, shows, health });
  const scheduler = createScheduler({
    settings, events, logger, scanner, episodes, watcher, activity, stats,
  });

  const presenters = createPresenters({ settings, shows, episodes, covers, activity, stats, readiness });

  const services = {
    config, logger, db, events, settings, health, activity, covers, episodeArt, metadata,
    shows, episodes, feeds, scanner, watcher, scheduler, stats, timeline, readiness,
    ...presenters,
  };

  const app = await buildApp(services);

  shutdown = createShutdown({ app, db, watcher, scheduler, settings, shows, feeds, logger });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  logger.info({ port: config.port, host: config.host }, 'SelfPod is listening');

  if (!settings.hasPublicBaseUrl()) {
    logger.warn(
      'no public base URL is set yet, so feeds cannot be built. Sign in and complete setup, or set PUBLIC_BASE_URL.',
    );
  }

  // The library is scanned once at startup, then kept in sync by the watcher and
  // the periodic rescan. Deliberately not awaited: a large library must not delay
  // the UI becoming reachable.
  scanner.enqueueAll(SCAN_TRIGGER.STARTUP);
  await watcher.start();
  scheduler.start({ onSessionCleanup: () => app.cleanupSessions() });
}

function createShutdown({ app, db, watcher, scheduler, settings, shows, feeds, logger }) {
  let running = false;
  return async (signal) => {
    if (running) return;
    running = true;
    logger.info({ signal }, 'shutting down');
    try {
      scheduler.stop();
      settings.stop();
      shows.stop();
      feeds.stop();
      await watcher.stop();
      await app.close();
      // Checkpointing the WAL means a copy of /data taken after shutdown needs no
      // recovery — which is what makes "move the volume" a safe migration story.
      closeDatabase(db, { logger });
      logger.info('goodbye');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
}

/**
 * Last-resort server for when the database cannot be opened at all. It answers
 * /health (so the container stays "healthy" and reachable) and serves one page
 * naming the exact path and UID that failed.
 */
async function startDegradedServer(cause) {
  const detail = describeFsError(cause, {
    path: config.databasePath,
    uid: config.runtimeUid ?? config.puid,
    gid: config.runtimeGid ?? config.pgid,
  });

  logger.error({ err: cause }, `SelfPod cannot open its database. ${detail}`);

  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  app.get('/health', async (request, reply) => {
    reply.header('access-control-allow-origin', '*').header('cache-control', 'no-store');
    return { status: 'degraded', version: VERSION, reason: 'database_unavailable' };
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(503).type('text/html; charset=utf-8').send(degradedPage(detail));
  });

  app.get('/', async (request, reply) => {
    reply.status(503).type('text/html; charset=utf-8').send(degradedPage(detail));
  });

  await app.listen({ host: config.host, port: config.port });
  logger.error(
    { port: config.port },
    'SelfPod started in a degraded state: the web UI explains the problem, but nothing else will work until it is fixed',
  );

  shutdown = async () => {
    await app.close();
    process.exit(1);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function degradedPage(detail) {
  const escape = (value) =>
    String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SelfPod — cannot start</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#F6F2EB;color:#1B1D22;margin:0;padding:48px 20px;line-height:1.55}
  main{max-width:620px;margin:0 auto;background:#FBF8F2;border:1px solid #E4DDCB;border-radius:16px;padding:32px 34px;
       box-shadow:0 2px 4px rgba(40,32,18,.06),0 18px 40px -16px rgba(40,32,18,.18)}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:-.015em}
  .tag{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#C44536;font-weight:600}
  p{margin:14px 0}
  code{font-family:ui-monospace,monospace;font-size:13px;background:#EFE9DF;border:1px solid #E4DDCB;border-radius:5px;padding:1px 5px}
  .fix{background:#F3D6D0;border:1px solid #ECC9C3;border-radius:11px;padding:14px 16px;margin-top:20px;font-size:14px}
  ul{margin:8px 0 0;padding-left:20px}
</style></head>
<body><main>
  <div class="tag">SelfPod cannot start</div>
  <h1>SelfPod can't reach its database</h1>
  <p>${escape(detail)}</p>
  <div class="fix">
    <strong>How to fix it</strong>
    <ul>
      <li>Set <code>PUID</code> and <code>PGID</code> to the user and group that own your data folder
          — currently <code>${escape(config.puid)}:${escape(config.pgid)}</code>.</li>
      <li>Or grant that user read and write access to <code>${escape(config.dataDir)}</code> on the host.</li>
      <li>Check that <code>${escape(config.dataDir)}</code> is a local path on the Docker host, not an
          NFS or SMB mount.</li>
    </ul>
  </div>
  <p style="margin-top:20px;font-size:13px;color:#6B6A63">SelfPod never changes permissions on your files
     itself, so nothing has been modified. Fix the access above and restart the container.</p>
</main></body></html>`;
}

main().catch((err) => {
  logger.fatal({ err }, 'SelfPod failed to start');
  process.exit(1);
});
