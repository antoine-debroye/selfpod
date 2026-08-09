#!/usr/bin/env node
/**
 * Resets the admin password.
 *
 * SelfPod prints its generated password exactly once, to the container logs. That
 * is the right default — it means a fresh instance is never left on a known
 * password — but it leaves no way back in if the log has scrolled away, and there
 * is deliberately no "forgot password" email flow in an app with no mail
 * configuration and one account. This is that way back: it requires access to the
 * container (or to the data directory), which is the same level of access needed to
 * read the original log line.
 *
 *   docker exec <container> node scripts/reset-password.js
 *
 * A new password is generated rather than accepted as an argument, so it cannot end
 * up in a shell history or a process list. The next sign-in is forced to change it.
 */
import bcrypt from 'bcryptjs';

import { loadConfig } from '../src/config.js';
import { openDatabase, closeDatabase } from '../src/db/index.js';
import { newAdminPassword } from '../src/lib/tokens.js';
import { BCRYPT_ROUNDS } from '../src/services/bootstrap.js';

const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

async function main() {
  const config = loadConfig();
  let db;
  try {
    ({ db } = openDatabase(config.databasePath, { logger: quiet }));
  } catch (err) {
    console.error(
      `Could not open SelfPod's database at ${config.databasePath}: ${err.message}\n` +
        'Run this inside the SelfPod container, or set DATA_DIR to the data directory.',
    );
    process.exit(1);
  }

  const password = newAdminPassword();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const username = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_username')?.value ?? 'admin';

  const apply = db.transaction(() => {
    upsert.run('admin_password_hash', hash);
    // Force a change at next sign-in, so this generated value is temporary.
    upsert.run('must_change_password', '1');
    // Any existing session is invalidated: whoever knew the old password should not
    // stay signed in after a reset.
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM login_attempts').run();
  });
  apply();

  closeDatabase(db, { logger: quiet });

  const line = '─'.repeat(56);
  console.log(
    [
      '',
      line,
      '  SelfPod admin password has been reset.',
      line,
      `  username: ${username}`,
      `  password: ${password}`,
      '',
      '  Shown once. Signing in will ask you to choose your own.',
      '  Everyone who was signed in has been signed out.',
      line,
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error(`Password reset failed: ${err.message}`);
  process.exit(1);
});
