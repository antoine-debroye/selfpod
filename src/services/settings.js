import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  DEFAULT_MISSING_GRACE_SECONDS,
  RESCAN_INTERVAL_MAX_SECONDS,
  RESCAN_INTERVAL_MIN_SECONDS,
} from '../constants.js';
import { EVENTS } from '../lib/events.js';
import { normaliseBaseUrl } from '../lib/urls.js';

/**
 * Typed accessors over the key/value `settings` table, plus a mirror of the
 * user-facing subset to `/data/config.json`.
 *
 * The JSON file is an export for portability, never read back at runtime — the
 * database stays authoritative (spec §7.1). A failed write is a warning, not an
 * error: losing the convenience copy must never break the running app.
 */

export const SETTING_KEYS = Object.freeze({
  PUBLIC_BASE_URL: 'public_base_url',
  DEFAULT_AUTHOR_NAME: 'default_author_name',
  DEFAULT_AUTHOR_EMAIL: 'default_author_email',
  DEFAULT_LANGUAGE: 'default_language',
  DEFAULT_CATEGORY: 'default_category',
  DEFAULT_SUBCATEGORY: 'default_subcategory',
  DEFAULT_EXPLICIT: 'default_explicit',
  RESCAN_INTERVAL_SECONDS: 'rescan_interval_seconds',
  MISSING_GRACE_SECONDS: 'missing_grace_seconds',
  WATCHER_ENABLED: 'watcher_enabled',
  SESSION_TTL_HOURS: 'session_ttl_hours',
  ADMIN_USERNAME: 'admin_username',
  ADMIN_PASSWORD_HASH: 'admin_password_hash',
  MUST_CHANGE_PASSWORD: 'must_change_password',
  SETUP_COMPLETE: 'setup_complete',
  SESSION_SECRET: 'session_secret',
  WATCHER_NOTICE_DISMISSED: 'watcher_notice_dismissed',
  INSTALLED_VERSION: 'installed_version',
  CREATED_AT: 'created_at',
});

/** Keys that must never leave the server (credentials and hashes). */
const SECRET_KEYS = new Set([SETTING_KEYS.SESSION_SECRET, SETTING_KEYS.ADMIN_PASSWORD_HASH]);

/** The subset exported to config.json — settings a user might want to keep in git. */
const EXPORTED_KEYS = [
  SETTING_KEYS.PUBLIC_BASE_URL,
  SETTING_KEYS.DEFAULT_AUTHOR_NAME,
  SETTING_KEYS.DEFAULT_AUTHOR_EMAIL,
  SETTING_KEYS.DEFAULT_LANGUAGE,
  SETTING_KEYS.DEFAULT_CATEGORY,
  SETTING_KEYS.DEFAULT_SUBCATEGORY,
  SETTING_KEYS.DEFAULT_EXPLICIT,
  SETTING_KEYS.RESCAN_INTERVAL_SECONDS,
  SETTING_KEYS.MISSING_GRACE_SECONDS,
  SETTING_KEYS.WATCHER_ENABLED,
  SETTING_KEYS.SESSION_TTL_HOURS,
];

export function createSettings({ db, config, events, logger }) {
  const selectOne = db.prepare('SELECT value FROM settings WHERE key = ?');
  const selectAll = db.prepare('SELECT key, value FROM settings');
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const insertIfAbsent = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const deleteKey = db.prepare('DELETE FROM settings WHERE key = ?');

  let exportTimer = null;

  function getRaw(key) {
    return selectOne.get(key)?.value ?? null;
  }

  function setRaw(key, value) {
    if (value === null || value === undefined) deleteKey.run(key);
    else upsert.run(key, String(value));
  }

  function getString(key, fallback = null) {
    const value = getRaw(key);
    return value === null ? fallback : value;
  }

  function getInt(key, fallback = null) {
    const value = getRaw(key);
    if (value === null) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function getBool(key, fallback = false) {
    const value = getRaw(key);
    if (value === null) return fallback;
    return value === '1' || value === 'true';
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  const api = {
    getRaw,
    setRaw,
    getString,
    getInt,
    getBool,

    all() {
      const out = {};
      for (const row of selectAll.all()) {
        if (!SECRET_KEYS.has(row.key)) out[row.key] = row.value;
      }
      return out;
    },

    /** Only used on first run, so an existing value is never clobbered by env. */
    seedIfAbsent(key, value) {
      if (value === null || value === undefined || value === '') return;
      insertIfAbsent.run(key, String(value));
    },

    /* ---- typed views used across the app ---- */

    publicBaseUrl() {
      return normaliseBaseUrl(getString(SETTING_KEYS.PUBLIC_BASE_URL, '') ?? '');
    },

    hasPublicBaseUrl() {
      return api.publicBaseUrl() !== null;
    },

    rescanIntervalSeconds() {
      return clamp(
        getInt(SETTING_KEYS.RESCAN_INTERVAL_SECONDS, config.rescanIntervalSeconds),
        RESCAN_INTERVAL_MIN_SECONDS,
        RESCAN_INTERVAL_MAX_SECONDS,
      );
    },

    missingGraceSeconds() {
      return clamp(
        getInt(SETTING_KEYS.MISSING_GRACE_SECONDS, config.missingGraceSeconds),
        60,
        30 * 24 * 60 * 60,
      );
    },

    watcherEnabled() {
      return getBool(SETTING_KEYS.WATCHER_ENABLED, true);
    },

    sessionTtlHours() {
      return clamp(getInt(SETTING_KEYS.SESSION_TTL_HOURS, 12), 1, 24 * 30);
    },

    defaults() {
      return {
        authorName: getString(SETTING_KEYS.DEFAULT_AUTHOR_NAME, '') ?? '',
        authorEmail: getString(SETTING_KEYS.DEFAULT_AUTHOR_EMAIL, '') ?? '',
        language: getString(SETTING_KEYS.DEFAULT_LANGUAGE, 'en') ?? 'en',
        category: getString(SETTING_KEYS.DEFAULT_CATEGORY, 'Technology') ?? 'Technology',
        subcategory: getString(SETTING_KEYS.DEFAULT_SUBCATEGORY, null),
        explicit: getBool(SETTING_KEYS.DEFAULT_EXPLICIT, false),
      };
    },

    adminUsername() {
      return getString(SETTING_KEYS.ADMIN_USERNAME, config.adminUsername) ?? 'admin';
    },

    adminPasswordHash() {
      return getRaw(SETTING_KEYS.ADMIN_PASSWORD_HASH);
    },

    mustChangePassword() {
      return getBool(SETTING_KEYS.MUST_CHANGE_PASSWORD, false);
    },

    setupComplete() {
      return getBool(SETTING_KEYS.SETUP_COMPLETE, false);
    },

    sessionSecret() {
      return getRaw(SETTING_KEYS.SESSION_SECRET);
    },

    watcherNoticeDismissed() {
      return getBool(SETTING_KEYS.WATCHER_NOTICE_DISMISSED, false);
    },

    /**
     * Applies a batch of changes in one transaction, then announces which keys
     * moved so listeners (feed cache, scheduler) can react precisely.
     */
    update(patch, { skipExport = false } = {}) {
      const keys = Object.keys(patch);
      if (keys.length === 0) return [];
      const write = db.transaction(() => {
        for (const [key, value] of Object.entries(patch)) {
          if (typeof value === 'boolean') setRaw(key, value ? '1' : '0');
          else setRaw(key, value);
        }
      });
      write();
      events?.emit(EVENTS.SETTINGS_CHANGED, { keys });
      if (!skipExport) api.scheduleExport();
      return keys;
    },

    /* ---- config.json mirror ---- */

    scheduleExport() {
      if (exportTimer) clearTimeout(exportTimer);
      exportTimer = setTimeout(() => {
        exportTimer = null;
        api.exportToDisk().catch(() => {});
      }, 800);
      if (typeof exportTimer.unref === 'function') exportTimer.unref();
    },

    async exportToDisk() {
      const payload = { _comment: 'Exported by SelfPod. The database is authoritative; editing this file has no effect.' };
      for (const key of EXPORTED_KEYS) {
        const value = getRaw(key);
        if (value !== null) payload[key] = value;
      }
      const target = config.configPath;
      const tmp = `${target}.tmp`;
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await rename(tmp, target);
        return true;
      } catch (err) {
        logger?.warn(
          { err, path: target },
          'could not write config.json export; settings are safe in the database',
        );
        return false;
      }
    },

    stop() {
      if (exportTimer) {
        clearTimeout(exportTimer);
        exportTimer = null;
      }
    },
  };

  return api;
}

export { DEFAULT_MISSING_GRACE_SECONDS };
