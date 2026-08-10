import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { EVENTS } from '../lib/events.js';
import { describeFsError } from '../lib/errors.js';

/**
 * In-memory registry of degraded states.
 *
 * Deliberately independent of the database: the web UI's persistent banner must
 * render even when the app is degraded, including when the database itself could
 * not be opened. Spec §13.1 step 4 requires the UI to stay reachable so a
 * permission problem can be diagnosed without SSH — the whole point being that
 * every failure in the hand-rolled version was invisible until a podcast app
 * broke.
 */
export function createHealth({ config, events, logger }) {
  /** key → { level, message, detail?, since } */
  const issues = new Map();

  const api = {
    /**
     * `level` is `error`, `warn` or `info`.
     *
     * `info` exists for a state that is worth reporting but is not a fault — running
     * on a network share where live file events are never delivered, for instance.
     * That condition is permanent and expected, and a banner on every page for it
     * trains people to scroll past banners, which costs exactly when something is
     * actually wrong. Informational states stay out of `banners()` and appear in
     * Settings and `/api/status` instead.
     */
    set(key, { level = 'error', message, detail = null } = {}) {
      const existing = issues.get(key);
      if (existing && existing.message === message && existing.level === level) return;
      issues.set(key, { key, level, message, detail, since: new Date().toISOString() });
      logger?.[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ issue: key, detail }, message);
      events?.emit(EVENTS.HEALTH_CHANGED, { key, state: 'set' });
    },

    clear(key) {
      if (!issues.delete(key)) return;
      events?.emit(EVENTS.HEALTH_CHANGED, { key, state: 'cleared' });
    },

    get(key) {
      return issues.get(key) ?? null;
    },

    list() {
      return [...issues.values()];
    },

    /**
     * The subset that earns a banner across the top of every page: things that are
     * wrong, not things that are merely true. Informational states are deliberately
     * excluded — see `set()`.
     */
    banners() {
      return [...issues.values()].filter((issue) => issue.level === 'error' || issue.level === 'warn');
    },

    hasErrors() {
      return [...issues.values()].some((issue) => issue.level === 'error');
    },

    isDegraded() {
      return issues.size > 0;
    },

    /**
     * Verifies the app can actually read the shows directory and write inside
     * /data, as the UID it is really running as. A failure does not stop the
     * app: it records a specific, actionable message and lets the UI show it.
     */
    async runDataSelfTest() {
      const uid = config.runtimeUid ?? config.puid;
      const gid = config.runtimeGid ?? config.pgid;

      // 1. /data must be writable — the database and uploads live there.
      try {
        await mkdir(config.dataDir, { recursive: true });
        const probe = join(config.dataDir, '.selfpod-write-test');
        await writeFile(probe, 'ok', 'utf8');
        await unlink(probe);
        api.clear('data_writable');
      } catch (err) {
        api.set('data_writable', {
          level: 'error',
          message: `SelfPod cannot write to \`${config.dataDir}\`. ${describeFsError(err, {
            path: config.dataDir,
            uid,
            gid,
          })}`,
          detail: { path: config.dataDir, uid, gid, code: err.code ?? null },
        });
      }

      // 2. /data/shows must be readable — without it there are no shows at all.
      try {
        await mkdir(config.showsDir, { recursive: true });
        await readdir(config.showsDir);
        api.clear('shows_readable');
      } catch (err) {
        api.set('shows_readable', {
          level: 'error',
          message: `SelfPod cannot read your shows folder \`${config.showsDir}\`. ${describeFsError(
            err,
            { path: config.showsDir, uid, gid },
          )}`,
          detail: { path: config.showsDir, uid, gid, code: err.code ?? null },
        });
      }

      // 3. The upload staging directory must exist on the same filesystem as the
      //    shows so completed uploads can be moved into place atomically.
      try {
        await mkdir(config.tempDir, { recursive: true });
        api.clear('temp_writable');
      } catch (err) {
        api.set('temp_writable', {
          level: 'warn',
          message: `SelfPod cannot create its upload staging folder \`${config.tempDir}\`. Browser uploads will fail; dropping files straight into a show folder still works. ${describeFsError(
            err,
            { path: config.tempDir, uid, gid },
          )}`,
          detail: { path: config.tempDir, uid, gid, code: err.code ?? null },
        });
      }

      return api.list();
    },

    /** Payload for GET /health (spec §12.3) and the dashboard's reachability test. */
    summary({ version }) {
      return {
        status: api.hasErrors() ? 'degraded' : 'ok',
        version,
      };
    },
  };

  if (config.entrypointSelfTestFailed) {
    api.set('entrypoint_selftest', {
      level: 'warn',
      message: `The container's startup check could not read and write \`${config.dataDir}\` as UID ${config.puid}, GID ${config.pgid}. Set PUID/PGID to match the owner of your files, or grant that user access to the dataset — SelfPod never changes permissions on your files itself.`,
      detail: { path: config.dataDir, uid: config.puid, gid: config.pgid },
    });
  }

  return api;
}
