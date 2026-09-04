import { isIP } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';

import {
  DEFAULT_MISSING_GRACE_SECONDS,
  DEFAULT_REMOTE_POLL_SECONDS,
  DIRECTORY_NAMES,
  FILE_NAMES,
  REMOTE_POLL_MAX_SECONDS,
  REMOTE_POLL_MIN_SECONDS,
  RESCAN_INTERVAL_MAX_SECONDS,
  RESCAN_INTERVAL_MIN_SECONDS,
} from './constants.js';
import { normaliseBaseUrl } from './lib/urls.js';

/**
 * Environment configuration (spec §9).
 *
 * Env vars are *seeds*, not the runtime source of truth: on first run they
 * populate the settings table, and after that the database wins so the setup
 * wizard and settings page can change them without editing the container.
 *
 * The one deliberate adjudication: spec §9 marks `PUBLIC_BASE_URL` required,
 * but §11.1's setup wizard offers it as an editable, env-prefilled field. Boot
 * therefore succeeds without it — the wizard refuses to finish until one is set,
 * and until then feed/media routes answer 503 with an explanatory message rather
 * than emitting URLs built from a guess.
 */

function readInt(raw, fallback, { min, max, name } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: fallback, warning: null };
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed)) {
    return {
      value: fallback,
      warning: `${name} is not a number ("${raw}"); using ${fallback} instead.`,
    };
  }
  if (min !== undefined && parsed < min) {
    return { value: min, warning: `${name} was ${parsed}, below the minimum of ${min}; using ${min}.` };
  }
  if (max !== undefined && parsed > max) {
    return { value: max, warning: `${name} was ${parsed}, above the maximum of ${max}; using ${max}.` };
  }
  return { value: parsed, warning: null };
}

/**
 * Parses ALLOW_PRIVATE_FEED_HOSTS: a comma-separated list of literal IP addresses
 * that are exempt from the "public addresses only" rule for outbound feed fetches.
 *
 * Deliberately a **list**, not a boolean. As an on/off switch it would disable the
 * single most important control in the whole feature — and because the test suite
 * needs loopback to reach its fixture server, every integration test would then run
 * with the guard switched off, exercising the scheme rules, the port rules, the
 * address pin, the redirect re-check and the self-reference check only in their
 * neutered form. Naming one address keeps all of those live and exempts exactly the
 * thing that was meant to be exempted.
 *
 * It is also the better shape in production: an operator with one real feed on their
 * LAN allows that host, rather than opening the whole private address space.
 *
 * Hostnames are refused on purpose. The exemption is checked against the address a
 * name resolved to, so accepting a name here would be a promise this cannot keep.
 */
function readAllowedPrivateHosts(raw, { name }) {
  const warnings = [];
  const allowed = new Set();
  for (const entry of String(raw ?? '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    // Bracketed IPv6 is what a URL yields, so accept it here rather than making
    // every caller remember to strip them.
    const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    if (isIP(bare) === 0) {
      warnings.push(
        `${name} entry "${value}" is not an IP address and was ignored. List literal addresses like 127.0.0.1 or ::1; hostnames cannot be allowed here because the exemption is checked against the address a name resolves to.`,
      );
      continue;
    }
    allowed.add(bare.toLowerCase());
  }
  return { value: Object.freeze(allowed), warnings };
}

const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

export function loadConfig(env = process.env) {
  const warnings = [];
  const collect = ({ value, warning }) => {
    if (warning) warnings.push(warning);
    return value;
  };

  const dataDir = resolve(
    env.DATA_DIR && String(env.DATA_DIR).trim() ? String(env.DATA_DIR).trim() : '/data',
  );

  const rawBaseUrl = env.PUBLIC_BASE_URL?.trim();
  const publicBaseUrl = rawBaseUrl ? normaliseBaseUrl(rawBaseUrl) : null;
  if (rawBaseUrl && !publicBaseUrl) {
    warnings.push(
      `PUBLIC_BASE_URL ("${rawBaseUrl}") is not a valid URL. It needs a scheme and host, for example https://podcast.example.com — ignoring it; set it in Settings instead.`,
    );
  }

  const logLevelRaw = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  const logLevel = LOG_LEVELS.has(logLevelRaw) ? logLevelRaw : 'info';
  if (!LOG_LEVELS.has(logLevelRaw)) {
    warnings.push(`LOG_LEVEL "${env.LOG_LEVEL}" is not recognised; using "info".`);
  }

  const timeZone = env.TZ?.trim() || 'UTC';
  let timeZoneValid = true;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
  } catch {
    timeZoneValid = false;
    warnings.push(`TZ "${timeZone}" is not a recognised time zone; falling back to UTC.`);
  }

  const config = {
    dataDir,
    showsDir: join(dataDir, DIRECTORY_NAMES.SHOWS),
    tempDir: join(dataDir, DIRECTORY_NAMES.TEMP),
    episodeArtDir: join(dataDir, DIRECTORY_NAMES.EPISODE_ART),
    fingerprintDir: join(dataDir, DIRECTORY_NAMES.FINGERPRINTS),
    trimmedDir: join(dataDir, DIRECTORY_NAMES.TRIMMED),
    transcriptDir: join(dataDir, DIRECTORY_NAMES.TRANSCRIPTS),
    databasePath: join(dataDir, FILE_NAMES.DATABASE),
    configPath: join(dataDir, FILE_NAMES.CONFIG),

    host: env.HOST?.trim() || '0.0.0.0',
    port: collect(readInt(env.PORT, 8080, { min: 1, max: 65535, name: 'PORT' })),

    publicBaseUrl,

    // Read only so error messages and the UI banner can name the UID the app is
    // actually running as. The entrypoint owns applying these; the app never
    // changes ownership or permissions on user files (spec §13, lesson 5).
    puid: collect(readInt(env.PUID, 1000, { min: 0, name: 'PUID' })),
    pgid: collect(readInt(env.PGID, 1000, { min: 0, name: 'PGID' })),
    runtimeUid: typeof process.getuid === 'function' ? process.getuid() : null,
    runtimeGid: typeof process.getgid === 'function' ? process.getgid() : null,

    timeZone: timeZoneValid ? timeZone : 'UTC',

    rescanIntervalSeconds: collect(
      readInt(env.RESCAN_INTERVAL_SECONDS, 300, {
        min: RESCAN_INTERVAL_MIN_SECONDS,
        max: RESCAN_INTERVAL_MAX_SECONDS,
        name: 'RESCAN_INTERVAL_SECONDS',
      }),
    ),
    missingGraceSeconds: collect(
      readInt(env.MISSING_GRACE_SECONDS, DEFAULT_MISSING_GRACE_SECONDS, {
        min: 60,
        max: 30 * 24 * 60 * 60,
        name: 'MISSING_GRACE_SECONDS',
      }),
    ),

    /**
     * Opt-in HSTS. Off by default because SelfPod is normally reachable on a plain
     * HTTP LAN address as well as through an HTTPS tunnel, and a browser that has
     * seen HSTS for a hostname will refuse plain HTTP to it for months — excellent
     * when chosen, a lockout when it arrives by surprise.
     */
    hstsEnabled: env.ENABLE_HSTS === '1' || env.ENABLE_HSTS === 'true',

    adminUsername: env.ADMIN_USERNAME?.trim() || 'admin',
    adminPassword: env.ADMIN_PASSWORD?.length ? env.ADMIN_PASSWORD : null,
    sessionSecretSeed: env.SESSION_SECRET?.length ? env.SESSION_SECRET : null,

    logLevel,
    prettyLogs: env.PRETTY_LOGS === '1' || env.NODE_ENV === 'development',

    maxUploadSizeMb: collect(
      readInt(env.MAX_UPLOAD_SIZE_MB, 1024, { min: 1, max: 65536, name: 'MAX_UPLOAD_SIZE_MB' }),
    ),

    /**
     * Seeds for feed subscriptions (spec §18). Like every other value here these only
     * populate the settings table on first run; after that the database wins.
     *
     * Off by default, and that is not politeness. With subscriptions off SelfPod makes
     * exactly the outbound requests it made before the feature existed — one, the
     * reachability self-check — so upgrading cannot quietly change the security posture
     * of an install that never asked for this. Turning it on is an explicit, logged,
     * admin-only grant of network reach.
     */
    subscriptionsEnabled: env.SUBSCRIPTIONS_ENABLED === '1' || env.SUBSCRIPTIONS_ENABLED === 'true',
    remotePollIntervalSeconds: collect(
      readInt(env.REMOTE_POLL_INTERVAL_SECONDS, DEFAULT_REMOTE_POLL_SECONDS, {
        min: REMOTE_POLL_MIN_SECONDS,
        max: REMOTE_POLL_MAX_SECONDS,
        name: 'REMOTE_POLL_INTERVAL_SECONDS',
      }),
    ),

    /**
     * The speech recogniser (spec §19.6). The image ships whisper.cpp under
     * /app/whisper and picks the binary for the CPU at boot; these exist so an operator
     * can point at a different build or a larger model mounted under /data. Unset on a
     * dev machine means "none", which the transcriber reports rather than assumes.
     */
    whisperBinary: env.WHISPER_CLI?.trim() || null,
    whisperModel: env.WHISPER_MODEL?.trim() || null,
    whisperThreads: collect(readInt(env.WHISPER_THREADS, 2, { min: 1, max: 16, name: 'WHISPER_THREADS' })),

    /** Set by the entrypoint when its own /data read+write test failed. */
    entrypointSelfTestFailed: env.SELFPOD_DATA_SELFTEST === 'failed',

    warnings,
  };

  config.maxUploadBytes = config.maxUploadSizeMb * 1024 * 1024;

  // Defaults to the upload cap so an operator who has already decided "episodes on this
  // instance are at most N MB" does not have to decide it twice.
  config.maxDownloadSizeMb = collect(
    readInt(env.MAX_DOWNLOAD_SIZE_MB, config.maxUploadSizeMb, {
      min: 1,
      max: 65536,
      name: 'MAX_DOWNLOAD_SIZE_MB',
    }),
  );
  config.maxDownloadBytes = config.maxDownloadSizeMb * 1024 * 1024;

  /**
   * Env-only, with no settings row and no control in the UI — the same treatment
   * ENABLE_HSTS gets, and for the same reason: this weakens a security guarantee, so
   * changing it should require touching the container rather than clicking something a
   * stolen admin session could also click. /data/config.json is export-only (settings.js
   * never reads it back), so there is no path by which a file can turn this on either.
   */
  const privateHosts = readAllowedPrivateHosts(env.ALLOW_PRIVATE_FEED_HOSTS, {
    name: 'ALLOW_PRIVATE_FEED_HOSTS',
  });
  warnings.push(...privateHosts.warnings);
  config.allowedPrivateFeedHosts = privateHosts.value;

  if (!isAbsolute(config.dataDir)) {
    throw new Error(`DATA_DIR must be an absolute path (got "${config.dataDir}").`);
  }

  return Object.freeze(config);
}
