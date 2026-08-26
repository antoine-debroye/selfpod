import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { createScanner } from '../../src/services/scanner.js';
import { createSettings } from '../../src/services/settings.js';
import { createReadiness } from '../../src/services/readiness.js';
import { createStats } from '../../src/services/stats.js';
import { createRemoteFeeds } from '../../src/services/remote-feeds.js';
import { createAdPipeline } from '../../src/services/ad-pipeline.js';
import { createTrimmer } from '../../src/services/trimmer.js';
import { createAdDetect } from '../../src/services/ad-detect.js';
import { createSubscriptions } from '../../src/services/subscriptions.js';

import { createShows } from '../../src/services/shows.js';
import { createTimeline } from '../../src/services/timeline.js';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'audio');

export const silentLogger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return silentLogger; },
};

/** ID3v2 tag sizes are seven bits per byte, so a 0xFF cannot appear inside one. */
function syncsafe(value) {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

/**
 * The bytes of `sample.mp3` with an ID3v2.3 APIC frame in front of them.
 *
 * Written by hand rather than pulled in as a tagging dependency: an APIC frame is
 * a length, a MIME string and the image, and building it here means the fixtures
 * stay the seven small files they are. `picture` is deliberately unvalidated so a
 * test can hand over 13 MB of nonsense to exercise the size cap.
 */
export async function mp3WithEmbeddedArtwork(picture, { mime = 'image/jpeg' } = {}) {
  const body = Buffer.concat([
    Buffer.from([0x00]), // text encoding: ISO-8859-1
    Buffer.from(mime, 'latin1'),
    Buffer.from([0x00]),
    Buffer.from([0x03]), // picture type: front cover
    Buffer.from([0x00]), // empty description
    Buffer.isBuffer(picture) ? picture : Buffer.from(picture),
  ]);
  const frameSize = Buffer.alloc(4);
  frameSize.writeUInt32BE(body.length, 0); // v2.3 frame sizes are plain big-endian
  const frame = Buffer.concat([Buffer.from('APIC', 'latin1'), frameSize, Buffer.from([0, 0]), body]);
  const header = Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([0x03, 0x00, 0x00]),
    syncsafe(frame.length),
  ]);
  return Buffer.concat([header, frame, await readFile(join(FIXTURE_DIR, 'sample.mp3'))]);
}

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
  await mkdir(config.episodeArtDir, { recursive: true });
  await mkdir(config.fingerprintDir, { recursive: true });
  await mkdir(config.trimmedDir, { recursive: true });

  const { db } = openDatabase(config.databasePath, { logger: silentLogger });
  const events = createEventBus();
  const settings = createSettings({ db, config, events, logger: silentLogger });
  const health = createHealth({ config, events, logger: silentLogger });

  if (!skipBootstrap) {
    await bootstrap({ db, settings, config, logger: silentLogger });
  }

  const activity = createActivity({ db, config, logger: silentLogger });
  const covers = createCovers({ config, logger: silentLogger });
  const episodeArt = createEpisodeArt({ config, covers, logger: silentLogger });
  const metadata = createMetadata({ logger: silentLogger });
  const shows = createShows({ db, config, events, logger: silentLogger, settings, episodeArt });
  const episodes = createEpisodes({ db, config, events, shows, logger: silentLogger, episodeArt });
  const feeds = createFeeds({ config, settings, events, shows, episodes, logger: silentLogger });
  const stats = createStats({ db, logger: silentLogger });
  const readiness = createReadiness({ covers });
  const timeline = createTimeline({ db, logger: silentLogger });
  const scanner = createScanner({
    db, config, settings, events, logger: silentLogger,
    shows, episodes, covers, episodeArt, metadata, activity, health,
  });

  const subscriptions = createSubscriptions({ db, config, events, logger: silentLogger });
  const adDetect = createAdDetect({ db, config, events, logger: silentLogger, shows, episodes });
  const trimmer = createTrimmer({
    db, config, events, logger: silentLogger, health, shows, episodes, adDetect, metadata,
  });
  const adPipeline = createAdPipeline({
    db, events, logger: silentLogger, shows, episodes, adDetect, trimmer,
  });
  const remoteFeeds = createRemoteFeeds({
    config, settings, subscriptions, shows, episodes, scanner,
    metadata, activity, health, events, logger: silentLogger,
  });

  return {
    config, db, events, settings, health, activity, covers, episodeArt, metadata,
    shows, episodes, feeds, scanner, stats, timeline, readiness, subscriptions, remoteFeeds, adDetect, trimmer, adPipeline,
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
      remoteFeeds.stop?.();
      shows.stop?.();
      settings.stop?.();
      feeds.stop?.();
      closeDatabase(db, { logger: silentLogger });
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
