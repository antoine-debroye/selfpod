import bcrypt from 'bcryptjs';

import { nowIso } from '../lib/dates.js';
import { newAdminPassword, newSessionSecret } from '../lib/tokens.js';
import { SETTING_KEYS } from './settings.js';
import { VERSION } from '../version.js';

export const BCRYPT_ROUNDS = 12;

/**
 * First-run bootstrap. Runs strictly before the HTTP server starts listening,
 * which is what closes the instance-takeover window: there is never a moment
 * where the app is reachable and has no admin credential, so no unauthenticated
 * "set the password" path has to exist (spec §9, §11.1).
 *
 * Env vars seed values only when they are absent from the database. After first
 * run the database wins, so the setup wizard and settings page can change
 * anything without editing the container config.
 */
export async function bootstrap({ db, settings, config, logger }) {
  const isFirstRun = settings.getRaw(SETTING_KEYS.CREATED_AT) === null;
  const result = { isFirstRun, generatedPassword: null };

  const seed = db.transaction(() => {
    if (isFirstRun) settings.setRaw(SETTING_KEYS.CREATED_AT, nowIso());

    // Signing key for session cookies. Persisted so sessions survive both a
    // container restart and a move of /data to another machine.
    if (!settings.sessionSecret()) {
      settings.setRaw(
        SETTING_KEYS.SESSION_SECRET,
        config.sessionSecretSeed && config.sessionSecretSeed.length >= 32
          ? config.sessionSecretSeed
          : newSessionSecret(),
      );
    }

    settings.seedIfAbsent(SETTING_KEYS.ADMIN_USERNAME, config.adminUsername);
    if (config.publicBaseUrl) {
      settings.seedIfAbsent(SETTING_KEYS.PUBLIC_BASE_URL, config.publicBaseUrl);
    }
    settings.seedIfAbsent(SETTING_KEYS.DEFAULT_LANGUAGE, 'en');
    settings.seedIfAbsent(SETTING_KEYS.DEFAULT_CATEGORY, 'Technology');
    settings.seedIfAbsent(SETTING_KEYS.RESCAN_INTERVAL_SECONDS, config.rescanIntervalSeconds);
    settings.seedIfAbsent(SETTING_KEYS.MISSING_GRACE_SECONDS, config.missingGraceSeconds);
    settings.seedIfAbsent(SETTING_KEYS.WATCHER_ENABLED, '1');
    settings.seedIfAbsent(SETTING_KEYS.SESSION_TTL_HOURS, '12');
    settings.setRaw(SETTING_KEYS.INSTALLED_VERSION, VERSION);
  });
  seed();

  // Admin credential. A blank or default password is never accepted silently:
  // either the operator supplied one, or one is generated, printed once, and the
  // wizard forces a change at first login (spec §9).
  if (!settings.adminPasswordHash()) {
    let password = config.adminPassword;
    let generated = false;
    if (!password) {
      password = newAdminPassword();
      generated = true;
    }
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    settings.update(
      {
        [SETTING_KEYS.ADMIN_PASSWORD_HASH]: hash,
        [SETTING_KEYS.MUST_CHANGE_PASSWORD]: generated ? '1' : '0',
      },
      { skipExport: true },
    );
    if (generated) {
      result.generatedPassword = password;
      printCredentialsBanner({ username: settings.adminUsername(), password, logger });
    } else {
      logger?.info('admin password set from ADMIN_PASSWORD');
    }
  }

  await settings.exportToDisk();

  return result;
}

/**
 * Printed with console.error, not the logger: the operator must be able to find
 * this in `docker logs` regardless of LOG_LEVEL, and it is the only time this
 * password is ever shown.
 */
function printCredentialsBanner({ username, password, logger }) {
  const lines = [
    '',
    '  ┌────────────────────────────────────────────────────────────────┐',
    '  │  SelfPod — first run: an admin password has been generated     │',
    '  ├────────────────────────────────────────────────────────────────┤',
    `  │  username: ${username.padEnd(52)}│`,
    `  │  password: ${password.padEnd(52)}│`,
    '  │                                                                │',
    '  │  This is shown once. Sign in and the setup wizard will ask you │',
    '  │  to choose your own password.                                  │',
    '  └────────────────────────────────────────────────────────────────┘',
    '',
  ];
  // eslint-disable-next-line no-console
  console.error(lines.join('\n'));
  logger?.warn('generated a random admin password and printed it to the container logs');
}
