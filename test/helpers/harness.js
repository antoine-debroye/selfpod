import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../src/config.js';
import { closeDatabase, openDatabase } from '../../src/db/index.js';
import { createEventBus } from '../../src/lib/events.js';
import { createActivity } from '../../src/services/activity.js';
import { bootstrap } from '../../src/services/bootstrap.js';
import { createCovers } from '../../src/services/covers.js';
import { createEpisodes } from '../../src/services/episodes.js';
import { createFeeds } from '../../src/services/feed.js';
import { createHealth } from '../../src/services/health.js';
import { createMetadata } from '../../src/services/metadata.js';
import { createScanner } from '../../src/services/scanner.js';
import { createSettings } from '../../src/services/settings.js';
import { createShows } from '../../src/services/shows.js';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'audio');

export const silentLogger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger; },
};

/**
 * Spins up the real service graph against a throwaway /data directory. Tests
 * exercise the same wiring the app uses rather than mocks, so a behaviour that
 * passes here is a behaviour the running app has.
 */
export async function createTestInstance({ env = {}, skipBootstrap = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'selfpod-test-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: 'https://podcast.example.com',
    ADMIN_PASSWORD: 'test-password-123',
    TZ: 'UTC',
    ...env,
  });

  await mkdir(config.showsDir, { recursive: true });
  await mkdir(config.tempDir, { recursive: true });

  const { db } = openDatabase(config.databasePath, { logger: silentLogger });
  const events = createEventBus();
  const settings = createSettings({ db, config, events, logger: silentLogger });
  const health = createHealth({ config, events, logger: silentLogger });

  if (!skipBootstrap) {
    await bootstrap({ db, settings, config, logger: silentLogger });
  }

  const activity = createActivity({ db, config, logger: silentLogger });
  const covers = createCovers({ config, logger: silentLogger });
  const metadata = createMetadata({ logger: silentLogger });
  const shows = createShows({ db, config, events, logger: silentLogger, settings });
  const episodes = createEpisodes({ db, config, events, shows, logger: silentLogger });
  const feeds = createFeeds({ config, settings, events, shows, episodes, logger: silentLogger });
  const scanner = createScanner({
    db, config, settings, events, logger: silentLogger,
    shows, episodes, covers, metadata, activity, health,
  });

  return {
    config, db, events, settings, health, activity, covers, metadata,
    shows, episodes, feeds, scanner,
    dataDir,

    /** Copies a fixture into a show folder, optionally under a different name. */
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
      shows.stop?.();
      settings.stop?.();
      feeds.stop?.();
      closeDatabase(db, { logger: silentLogger });
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
