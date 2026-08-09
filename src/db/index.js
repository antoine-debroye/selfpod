import Database from 'better-sqlite3';

import { runMigrations } from './migrate.js';

/**
 * Opens the SQLite database and applies migrations.
 *
 * WAL is the right journal mode on a local filesystem, but `/data` sometimes
 * ends up on an NFS or SMB mount despite the documentation saying not to, and
 * WAL's shared-memory locking is unreliable there. So the mode is *verified*
 * after being requested: if the database refuses to enter WAL, the app falls
 * back to a journal mode that works over network locks and reports a warning
 * rather than running with a silently broken assumption.
 */
export function openDatabase(path, { logger, readonly = false } = {}) {
  const db = new Database(path, { readonly });

  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  let journalMode = 'unknown';
  let journalWarning = null;
  try {
    journalMode = String(db.pragma('journal_mode = WAL', { simple: true })).toLowerCase();
  } catch (err) {
    journalWarning = err.message;
  }

  if (journalMode !== 'wal') {
    try {
      journalMode = String(db.pragma('journal_mode = TRUNCATE', { simple: true })).toLowerCase();
    } catch (err) {
      journalWarning = err.message;
    }
    logger?.warn(
      { journalMode, error: journalWarning },
      'SQLite could not use WAL journalling; this usually means /data is on a network filesystem (NFS/SMB). SelfPod will keep working, but /data should be a local path on the Docker host.',
    );
  }

  db.pragma('synchronous = NORMAL');

  const migration = runMigrations(db, { logger });

  return {
    db,
    journalMode,
    journalIsWal: journalMode === 'wal',
    migration,
  };
}

/**
 * Clean shutdown. The WAL checkpoint matters for migration: a truncated WAL
 * means copying `/data` to another machine cannot leave the database in a state
 * that needs recovery.
 */
export function closeDatabase(db, { logger } = {}) {
  if (!db || !db.open) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    logger?.debug({ err }, 'wal checkpoint on shutdown failed (harmless)');
  }
  try {
    db.close();
  } catch (err) {
    logger?.warn({ err }, 'error closing database');
  }
}
