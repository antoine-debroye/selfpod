import bcrypt from 'bcryptjs';

import { RESCAN_INTERVAL_MAX_SECONDS, RESCAN_INTERVAL_MIN_SECONDS } from '../../constants.js';
import { unprocessable } from '../../lib/errors.js';
import { normaliseBaseUrl } from '../../lib/urls.js';
import { SETTING_KEYS } from '../../services/settings.js';
import { MIN_PASSWORD_LENGTH } from './setup.js';

export default async function settingsRoutes(fastify, { config, settings, watcher, scheduler, shows }) {
  fastify.addHook('onRequest', fastify.requireAdminApi);

  fastify.get('/settings', async () => ({
    settings: {
      publicBaseUrl: settings.publicBaseUrl(),
      defaultAuthorName: settings.defaults().authorName,
      defaultAuthorEmail: settings.defaults().authorEmail,
      defaultLanguage: settings.defaults().language,
      defaultCategory: settings.defaults().category,
      defaultSubcategory: settings.defaults().subcategory,
      defaultExplicit: settings.defaults().explicit,
      rescanIntervalSeconds: settings.rescanIntervalSeconds(),
      missingGraceSeconds: settings.missingGraceSeconds(),
      watcherEnabled: settings.watcherEnabled(),
      sessionTtlHours: settings.sessionTtlHours(),
      adminUsername: settings.adminUsername(),
      setupComplete: settings.setupComplete(),
    },
    runtime: {
      timeZone: config.timeZone,
      dataDir: config.dataDir,
      showsDir: config.showsDir,
      puid: config.runtimeUid ?? config.puid,
      pgid: config.runtimeGid ?? config.pgid,
      maxUploadSizeMb: config.maxUploadSizeMb,
      watcher: watcher?.status() ?? null,
      scheduler: scheduler?.status() ?? null,
    },
  }));

  fastify.patch('/settings', async (request) => {
    const body = request.body ?? {};
    const patch = {};
    const fields = {};

    if (body.publicBaseUrl !== undefined) {
      const normalised = normaliseBaseUrl(String(body.publicBaseUrl));
      if (!normalised) {
        fields.publicBaseUrl =
          'Include the scheme and host, for example https://podcast.example.com (no trailing slash).';
      } else {
        patch[SETTING_KEYS.PUBLIC_BASE_URL] = normalised;
      }
    }

    if (body.defaultAuthorName !== undefined) {
      patch[SETTING_KEYS.DEFAULT_AUTHOR_NAME] = String(body.defaultAuthorName).trim().slice(0, 200);
    }
    if (body.defaultAuthorEmail !== undefined) {
      const email = String(body.defaultAuthorEmail).trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        fields.defaultAuthorEmail = "That doesn't look like an email address.";
      } else {
        patch[SETTING_KEYS.DEFAULT_AUTHOR_EMAIL] = email.slice(0, 200);
      }
    }
    if (body.defaultLanguage !== undefined) {
      const language = String(body.defaultLanguage).trim().toLowerCase();
      if (language && !/^[a-z]{2}(-[a-z]{2})?$/.test(language)) {
        fields.defaultLanguage = 'Use a language code like "en" or "en-gb".';
      } else {
        patch[SETTING_KEYS.DEFAULT_LANGUAGE] = language || 'en';
      }
    }

    if (body.rescanIntervalSeconds !== undefined) {
      const seconds = parseSeconds(body.rescanIntervalSeconds);
      if (seconds === null) {
        fields.rescanIntervalSeconds = 'Enter a number of seconds.';
      } else if (seconds < RESCAN_INTERVAL_MIN_SECONDS || seconds > RESCAN_INTERVAL_MAX_SECONDS) {
        fields.rescanIntervalSeconds = 'Choose between 1 minute and 6 hours.';
      } else {
        patch[SETTING_KEYS.RESCAN_INTERVAL_SECONDS] = String(seconds);
      }
    }

    if (body.missingGraceSeconds !== undefined) {
      const seconds = parseSeconds(body.missingGraceSeconds);
      if (seconds === null || seconds < 60 || seconds > 30 * 24 * 60 * 60) {
        fields.missingGraceSeconds = 'Choose between 1 minute and 30 days.';
      } else {
        patch[SETTING_KEYS.MISSING_GRACE_SECONDS] = String(seconds);
      }
    }

    if (body.watcherEnabled !== undefined) {
      patch[SETTING_KEYS.WATCHER_ENABLED] = isTrue(body.watcherEnabled) ? '1' : '0';
    }

    if (body.sessionTtlHours !== undefined) {
      const hours = Number.parseInt(String(body.sessionTtlHours), 10);
      if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
        fields.sessionTtlHours = 'Choose between 1 hour and 30 days.';
      } else {
        patch[SETTING_KEYS.SESSION_TTL_HOURS] = String(hours);
      }
    }


    if (Object.keys(fields).length) {
      throw unprocessable('Some of those values need fixing.', 'validation_failed', fields);
    }

    const changed = Object.keys(patch).length ? settings.update(patch) : [];

    // Restarting the watcher applies an enable/disable or interval change without
    // needing a container restart.
    if (
      changed.includes(SETTING_KEYS.WATCHER_ENABLED) ||
      changed.includes(SETTING_KEYS.RESCAN_INTERVAL_SECONDS)
    ) {
      await watcher?.restart();
    }

    if (
      changed.includes(SETTING_KEYS.DEFAULT_AUTHOR_NAME) ||
      changed.includes(SETTING_KEYS.DEFAULT_AUTHOR_EMAIL)
    ) {
      shows.applyDefaultsToBlankShows();
    }

    return { ok: true, changed };
  });

  fastify.post('/settings/password', async (request) => {
    const { currentPassword, password, passwordConfirm } = request.body ?? {};
    const fields = {};

    const hash = settings.adminPasswordHash();
    const currentOk = await bcrypt.compare(String(currentPassword ?? ''), hash ?? '');
    if (!currentOk) fields.currentPassword = 'That is not your current password.';

    if (String(password ?? '').length < MIN_PASSWORD_LENGTH) {
      fields.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (passwordConfirm !== undefined && password !== passwordConfirm) {
      fields.passwordConfirm = "Those two passwords don't match.";
    }

    if (Object.keys(fields).length) {
      throw unprocessable('Some of those values need fixing.', 'validation_failed', fields);
    }

    await fastify.setAdminPassword(password);
    return { ok: true };
  });
}

/** Accepts raw seconds or a "5m" / "2h" shorthand from the inline editor. */
function parseSeconds(value) {
  const raw = String(value).trim().toLowerCase();
  const match = raw.match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount)) return null;
  const unit = match[2] ?? 's';
  if (unit.startsWith('m')) return amount * 60;
  if (unit.startsWith('h')) return amount * 3600;
  return amount;
}

function isTrue(value) {
  return value === true || value === 'true' || value === '1' || value === 'on' || value === 'yes';
}
