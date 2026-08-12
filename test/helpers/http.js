import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { closeDatabase, openDatabase } from '../../src/db/index.js';
import { createEventBus } from '../../src/lib/events.js';
import { createActivity } from '../../src/services/activity.js';
import { bootstrap } from '../../src/services/bootstrap.js';
import { createCovers } from '../../src/services/covers.js';
import { createEpisodeArt } from '../../src/services/episode-art.js';
import { createEpisodes } from '../../src/services/episodes.js';
import { createFeeds } from '../../src/services/feed.js';
import { createHealth } from '../../src/services/health.js';
import { createMetadata } from '../../src/services/metadata.js';
import { createPresenters } from '../../src/services/presenters.js';
import { createScanner } from '../../src/services/scanner.js';
import { createSettings } from '../../src/services/settings.js';
import { createReadiness } from '../../src/services/readiness.js';
import { createStats } from '../../src/services/stats.js';

import { createShows } from '../../src/services/shows.js';
import { createTimeline } from '../../src/services/timeline.js';
import { copyFile } from 'node:fs/promises';
import { FIXTURE_DIR, silentLogger } from './harness.js';
import { SETTING_KEYS } from '../../src/services/settings.js';

export const ADMIN_PASSWORD = 'test-password-1234';

/**
 * Builds the real Fastify app against a throwaway data directory, so HTTP tests
 * exercise the same plugin graph, routes and templates the container runs.
 */
export async function createTestServer({ env = {}, completeSetup = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'selfpod-http-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: 'https://podcast.example.com',
    ADMIN_PASSWORD,
    TZ: 'UTC',
    LOG_LEVEL: 'silent',
    ...env,
  });

  await mkdir(config.showsDir, { recursive: true });
  await mkdir(config.tempDir, { recursive: true });
  await mkdir(config.episodeArtDir, { recursive: true });

  const { db } = openDatabase(config.databasePath, { logger: silentLogger });
  const events = createEventBus();
  const settings = createSettings({ db, config, events, logger: silentLogger });
  const health = createHealth({ config, events, logger: silentLogger });

  await bootstrap({ db, settings, config, logger: silentLogger });
  if (completeSetup) settings.update({ [SETTING_KEYS.SETUP_COMPLETE]: '1' });

  const activity = createActivity({ db, config, logger: silentLogger });
  const covers = createCovers({ config, logger: silentLogger });
  const episodeArt = createEpisodeArt({ config, covers, logger: silentLogger });
  const metadata = createMetadata({ logger: silentLogger });
  const shows = createShows({ db, config, events, logger: silentLogger, settings, episodeArt });
  const episodes = createEpisodes({ db, config, events, shows, logger: silentLogger, episodeArt });
  const feeds = createFeeds({ config, settings, events, shows, episodes, logger: silentLogger });
  const scanner = createScanner({
    db, config, settings, events, logger: silentLogger,
    shows, episodes, covers, episodeArt, metadata, activity, health,
  });

  const stats = createStats({ db, logger: silentLogger });
  const readiness = createReadiness({ covers });
  const timeline = createTimeline({ db, logger: silentLogger });
  const presenters = createPresenters({ settings, shows, episodes, covers, activity, stats, readiness });

  const services = {
    config, logger: silentLogger, db, events, settings, health, activity, covers, episodeArt, metadata,
    shows, episodes, feeds, scanner, stats, timeline, readiness, ...presenters,
    watcher: { status: () => ({ mode: 'events', enabled: true, degraded: false, lastEventAt: null }), restart: async () => {} },
    scheduler: { status: () => ({ running: false, intervalSeconds: 300, lastRunAt: null, nextRunAt: null }) },
  };

  const app = await buildApp(services);
  await app.ready();

  let cookie = null;

  const api = {
    app,
    services,
    config,
    ...services,
    dataDir,

    /** Signs in and remembers the session cookie for later calls. */
    async login(password = ADMIN_PASSWORD, username = 'admin') {
      const response = await app.inject({
        method: 'POST',
        url: '/api/login',
        payload: { username, password },
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      const setCookie = response.headers['set-cookie'];
      if (setCookie) {
        const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        cookie = raw.split(';')[0];
      }
      return response;
    },

    get cookie() {
      return cookie;
    },

    /** Authenticated request helper: attaches the session cookie and same-origin headers. */
    async request({ method = 'GET', url, payload, headers = {}, authed = true }) {
      const merged = { 'sec-fetch-site': 'same-origin', ...headers };
      if (authed && cookie) merged.cookie = cookie;
      return app.inject({ method, url, payload, headers: merged });
    },

    async get(url, headers) {
      return api.request({ method: 'GET', url, headers });
    },

    async post(url, payload, headers) {
      return api.request({ method: 'POST', url, payload, headers });
    },

    async addAudio(slug, fixture, as = fixture) {
      const dir = join(config.showsDir, slug);
      await mkdir(dir, { recursive: true });
      await copyFile(join(FIXTURE_DIR, fixture), join(dir, as));
      return join(dir, as);
    },

    async makeShowFolder(slug) {
      const dir = join(config.showsDir, slug);
      await mkdir(dir, { recursive: true });
      return dir;
    },

    async cleanup() {
      await app.close();
      shows.stop?.();
      settings.stop?.();
      feeds.stop?.();
      closeDatabase(db, { logger: silentLogger });
      await rm(dataDir, { recursive: true, force: true });
    },
  };

  return api;
}
