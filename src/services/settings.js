import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  DEFAULT_MISSING_GRACE_SECONDS,
  PREVIOUS_BASE_URL_WINDOW_DAYS,
  REMOTE_POLL_MAX_SECONDS,
  REMOTE_POLL_MIN_SECONDS,
  RESCAN_INTERVAL_MAX_SECONDS,
  RESCAN_INTERVAL_MIN_SECONDS,
} from '../constants.js';
import { nowIso } from '../lib/dates.js';
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
  /**
   * The address the feeds were served on before the last change, and when that
   * change happened. Written by `update()` rather than by any route — see there.
   */
  PREVIOUS_PUBLIC_BASE_URL: 'previous_public_base_url',
  PREVIOUS_PUBLIC_BASE_URL_SET_AT: 'previous_public_base_url_set_at',
  DEFAULT_AUTHOR_NAME: 'default_author_name',
  DEFAULT_AUTHOR_EMAIL: 'default_author_email',
  DEFAULT_LANGUAGE: 'default_language',
  DEFAULT_CATEGORY: 'default_category',
  DEFAULT_SUBCATEGORY: 'default_subcategory',
  DEFAULT_EXPLICIT: 'default_explicit',
  RESCAN_INTERVAL_SECONDS: 'rescan_interval_seconds',
  MISSING_GRACE_SECONDS: 'missing_grace_seconds',
  WATCHER_ENABLED: 'watcher_enabled',
  /**
   * Feed subscriptions (spec §18). Default off — see config.js for why that matters
   * more than it looks: with this off, SelfPod's outbound behaviour is byte-for-byte
   * what it was before the feature existed.
   */
  SUBSCRIPTIONS_ENABLED: 'subscriptions_enabled',
  REMOTE_POLL_INTERVAL_SECONDS: 'remote_poll_interval_seconds',
  REMOTE_MAX_DOWNLOAD_MB: 'remote_max_download_mb',
  SESSION_TTL_HOURS: 'session_ttl_hours',
  ADMIN_USERNAME: 'admin_username',
  ADMIN_PASSWORD_HASH: 'admin_password_hash',
  MUST_CHANGE_PASSWORD: 'must_change_password',
  SETUP_COMPLETE: 'setup_complete',
  SESSION_SECRET: 'session_secret',
  INSTALLED_VERSION: 'installed_version',
  CREATED_AT: 'created_at',
});

/** Keys that must never leave the server (credentials and hashes). */
const SECRET_KEYS = new Set([SETTING_KEYS.SESSION_SECRET, SETTING_KEYS.ADMIN_PASSWORD_HASH]);

/**
 * The subset exported to config.json — settings a user might want to keep in git.
 *
 * The previous-base-URL pair is deliberately absent: it is transient state about a
 * move that is currently in progress, not configuration. Restoring it from a file
 * months later would start forwarding subscribers all over again.
 */
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
  SETTING_KEYS.SUBSCRIPTIONS_ENABLED,
  SETTING_KEYS.REMOTE_POLL_INTERVAL_SECONDS,
  SETTING_KEYS.REMOTE_MAX_DOWNLOAD_MB,
];

/**
 * Subscriptions themselves are deliberately **not** exportable, here or in show.json.
 *
 * A subscription's feed URL is a credential in its own right: private and premium
 * feeds carry a per-listener token in the path or the query string. That is the same
 * reason shows.feed_token is left out of every export, and the reason redactFeedUrl
 * exists for the log. The three keys above are ordinary configuration — how often to
 * poll, how large a file to accept, and whether the feature is on at all.
 */

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

  /**
   * The pair of keys that record a base-URL change, or nothing when this patch is
   * not one.
   *
   * Only a change away from an existing, different address counts. The first time an
   * address is set there is nobody on an old one to forward, and re-saving the same
   * value is not a move. Both sides are compared normalised, so a trailing slash is
   * not mistaken for a change of address.
   */
  function baseUrlMove(patch) {
    if (!Object.hasOwn(patch, SETTING_KEYS.PUBLIC_BASE_URL)) return null;
    const before = normaliseBaseUrl(getRaw(SETTING_KEYS.PUBLIC_BASE_URL) ?? '');
    const after = normaliseBaseUrl(String(patch[SETTING_KEYS.PUBLIC_BASE_URL] ?? ''));
    if (!before || !after || before === after) return null;
    return {
      [SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL]: before,
      [SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL_SET_AT]: nowIso(),
    };
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

    /**
     * The address SelfPod was reachable on before the last base-URL change, or null.
     *
     * Null once the forwarding window has passed, so the feed and the settings page
     * cannot disagree about whether a move is still being announced: both ask this
     * one question rather than each reading the raw key and doing their own sums.
     *
     * A missing or unreadable timestamp also reads as null. The window is the whole
     * point of the pair, and a value with no way to tell whether it has expired would
     * otherwise forward subscribers for ever.
     */
    previousPublicBaseUrl() {
      const previous = normaliseBaseUrl(getString(SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL, '') ?? '');
      if (!previous) return null;

      const setAt = Date.parse(getString(SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL_SET_AT, '') ?? '');
      if (!Number.isFinite(setAt)) return null;
      const age = Date.now() - setAt;
      if (age > PREVIOUS_BASE_URL_WINDOW_DAYS * 24 * 60 * 60 * 1000) return null;

      return previous;
    },

    /** "The move is done" — stops the feeds announcing it before the window ends. */
    forgetPreviousBaseUrl() {
      return api.update({
        [SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL]: null,
        [SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL_SET_AT]: null,
      });
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

    subscriptionsEnabled() {
      // Falls back to the env seed, like every other setting here — not to a hardcoded
      // false. Defaulting to false regardless meant SUBSCRIPTIONS_ENABLED=1 in the
      // compose file did nothing at all: the container said the feature was on, the
      // UI said it was off, and there was nothing to explain the difference.
      return getBool(SETTING_KEYS.SUBSCRIPTIONS_ENABLED, config.subscriptionsEnabled === true);
    },

    remotePollIntervalSeconds() {
      return clamp(
        getInt(SETTING_KEYS.REMOTE_POLL_INTERVAL_SECONDS, config.remotePollIntervalSeconds),
        REMOTE_POLL_MIN_SECONDS,
        REMOTE_POLL_MAX_SECONDS,
      );
    },

    remoteMaxDownloadBytes() {
      const mb = clamp(
        getInt(SETTING_KEYS.REMOTE_MAX_DOWNLOAD_MB, config.maxDownloadSizeMb),
        1,
        65536,
      );
      return mb * 1024 * 1024;
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


    /**
     * Applies a batch of changes in one transaction, then announces which keys
     * moved so listeners (feed cache, scheduler) can react precisely.
     */
    update(patch, { skipExport = false } = {}) {
      if (Object.keys(patch).length === 0) return [];
      const keys = [];
      const write = db.transaction(() => {
        // A base-URL move is recorded here, in the one function every caller goes
        // through, rather than in a route: the setup wizard and the settings page
        // both change the public address, so recording it in either one leaves the
        // other silently failing to forward anybody. The old value also has to be
        // read before the patch overwrites it, which is why this sits inside the
        // transaction that writes both.
        for (const [key, value] of Object.entries({ ...baseUrlMove(patch), ...patch })) {
          if (typeof value === 'boolean') setRaw(key, value ? '1' : '0');
          else setRaw(key, value);
          keys.push(key);
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
