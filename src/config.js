import { isAbsolute, join, resolve } from 'node:path';

import {
  DEFAULT_MISSING_GRACE_SECONDS,
  DIRECTORY_NAMES,
  FILE_NAMES,
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

    /** Set by the entrypoint when its own /data read+write test failed. */
    entrypointSelfTestFailed: env.SELFPOD_DATA_SELFTEST === 'failed',

    warnings,
  };

  config.maxUploadBytes = config.maxUploadSizeMb * 1024 * 1024;

  if (!isAbsolute(config.dataDir)) {
    throw new Error(`DATA_DIR must be an absolute path (got "${config.dataDir}").`);
  }

  return Object.freeze(config);
}
