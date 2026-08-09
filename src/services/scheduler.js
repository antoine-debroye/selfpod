import { SCAN_TRIGGER } from '../constants.js';
import { EVENTS } from '../lib/events.js';
import { SETTING_KEYS } from './settings.js';

/**
 * In-container scheduler (spec §6.2, §8.1).
 *
 * This is the piece that replaces the host cron job the prototype needed. It runs
 * three jobs on the same tick:
 *  1. a full library rescan — the actual correctness guarantee on network shares;
 *  2. the missing-file grace sweep, which is what finally drops an episode whose
 *     file has been gone long enough (deliberately not the scanner's job, so a
 *     brief share outage can't drop episodes);
 *  3. expired-session cleanup.
 *
 * A recursive timeout is used rather than setInterval so a slow scan can't cause
 * ticks to pile up, and the interval is re-read every tick so a change in the UI
 * takes effect without a restart.
 */
export function createScheduler({ settings, events, logger, scanner, episodes, watcher, activity }) {
  let timer = null;
  let running = false;
  let stopped = true;
  let lastRunAt = null;
  let nextRunAt = null;
  let sessionCleanup = null;

  function scheduleNext() {
    if (stopped) return;
    const seconds = settings.rescanIntervalSeconds();
    nextRunAt = new Date(Date.now() + seconds * 1000).toISOString();
    timer = setTimeout(tick, seconds * 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    timer = null;
    if (stopped || running) return;
    running = true;
    try {
      const record = await scanner.scanAllNow(SCAN_TRIGGER.SCHEDULED);
      lastRunAt = new Date().toISOString();

      const changed = Boolean(
        record && ((record.added ?? 0) + (record.updated ?? 0) + (record.missing ?? 0)) > 0,
      );
      // Feeds the watcher's self-diagnosis: changes found here that the watcher
      // never reported mean file events aren't arriving on this mount.
      watcher?.reportScheduledScan({ changed });

      const swept = episodes.sweepMissing(settings.missingGraceSeconds());
      if (swept.length) {
        const id = activity.start({ showId: null, trigger: SCAN_TRIGGER.SCHEDULED, note: 'grace period sweep' });
        activity.finish(id, {
          removed: swept.length,
          note: `${swept.length} episode${swept.length === 1 ? '' : 's'} dropped from feeds after the missing-file grace period`,
          warnings: swept.map((row) => ({
            file: row.filename,
            message: `\`${row.filename}\` has been missing longer than the grace period, so it has been dropped from the feed. Put the file back and it will return with the same episode identity.`,
          })),
        });
      }

      sessionCleanup?.();
    } catch (err) {
      logger?.error({ err }, 'scheduled rescan failed');
    } finally {
      running = false;
      scheduleNext();
    }
  }

  // A change to the interval takes effect immediately rather than after the
  // current (possibly six-hour) wait.
  events?.on(EVENTS.SETTINGS_CHANGED, ({ keys = [] }) => {
    if (!keys.includes(SETTING_KEYS.RESCAN_INTERVAL_SECONDS)) return;
    if (stopped || running) return;
    if (timer) clearTimeout(timer);
    scheduleNext();
    logger?.info({ seconds: settings.rescanIntervalSeconds() }, 'rescan interval updated');
  });

  return {
    start({ onSessionCleanup } = {}) {
      if (!stopped) return;
      stopped = false;
      sessionCleanup = onSessionCleanup ?? null;
      scheduleNext();
      logger?.info(
        { seconds: settings.rescanIntervalSeconds() },
        'scheduler started (periodic rescan is the correctness guarantee on network shares)',
      );
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    /** Runs the tick immediately; used by tests and by "rescan all" from the UI. */
    async runNow() {
      if (timer) clearTimeout(timer);
      timer = null;
      await tick();
    },

    status() {
      return {
        running,
        intervalSeconds: settings.rescanIntervalSeconds(),
        lastRunAt,
        nextRunAt,
      };
    },
  };
}
