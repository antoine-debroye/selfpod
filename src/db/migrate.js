import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Forward-only migrations tracked in `PRAGMA user_version`. Dependency-free on
 * purpose: a schema migration tool is one more thing that can fail at boot on a
 * NAS, and this app's schema changes will be rare and linear.
 */
/**
 * `upTo` stops after that many migrations. It exists for one test: seeding a database
 * in an older shape and proving the next migration carries its rows across.
 */
export function runMigrations(db, { logger, upTo = Infinity } = {}) {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const current = db.pragma('user_version', { simple: true });
  let applied = 0;

  for (const [index, file] of files.entries()) {
    const version = index + 1;
    if (version <= current) continue;
    if (version > upTo) break;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const migrate = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    });

    try {
      migrate();
    } catch (err) {
      throw new Error(`Database migration ${file} failed: ${err.message}`, { cause: err });
    }

    applied += 1;
    logger?.info({ migration: file, version }, 'applied database migration');
  }

  return { from: current, to: db.pragma('user_version', { simple: true }), applied };
}
