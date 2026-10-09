import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWatcher } from '../../src/services/watcher.js';

/**
 * On a network share the watcher gives up on events and polls instead. Polling means
 * chokidar stats every watched file each interval, and the scheduler's rescan already
 * stats every file at the rescan interval — so the poll has to run at that same
 * interval, or an SMB mount pays for two full sweeps where one was promised.
 *
 * `watch` is swapped for a stand-in that records what chokidar is asked for: the
 * options are the behaviour here, and nothing short of a real SMB share and a stopwatch
 * would observe the stat traffic itself.
 */
function watcherWith({ rescanIntervalSeconds = 300 } = {}) {
  const calls = [];
  const logs = [];
  const health = new Map();
  const fakeWatcher = {
    on() {
      return fakeWatcher;
    },
    async close() {},
  };
  const watcher = createWatcher({
    config: { showsDir: '/tmp/selfpod-watcher-test/shows' },
    settings: { rescanIntervalSeconds: () => rescanIntervalSeconds, watcherEnabled: () => true },
    events: null,
    logger: { info: (...args) => logs.push(args), debug() {}, warn() {}, error() {} },
    scanner: { enqueueShow() {}, enqueueAll() {} },
    shows: { getBySlug: () => null },
    health: { set: (key, value) => health.set(key, value), clear: (key) => health.delete(key) },
    watch: (path, options) => {
      calls.push({ path, options });
      return fakeWatcher;
    },
  });
  return { watcher, calls, logs, health };
}

/** Two scheduled scans that found changes the watcher never saw is what turns polling on. */
async function degradeToPolling(watcher) {
  watcher.reportScheduledScan({ changed: true });
  watcher.reportScheduledScan({ changed: true });
  // start(true) is fired and not awaited; it needs a turn to close the old watcher.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('the polling watcher runs at the rescan interval', () => {
  it('asks chokidar for events, not polling, to begin with', async () => {
    const { watcher, calls } = watcherWith();
    await watcher.start();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.usePolling, false);
    assert.equal(calls[0].options.interval, undefined, 'no poll interval when there is no polling');
    assert.equal(watcher.status().pollIntervalSeconds, null);
    await watcher.stop();
  });

  it('polls every rescan interval once degraded, not every minute on top of it', async () => {
    const { watcher, calls, logs, health } = watcherWith({ rescanIntervalSeconds: 300 });
    await watcher.start();
    await degradeToPolling(watcher);

    assert.equal(calls.length, 2, 'the watcher was started again, in polling mode');
    const { options } = calls[1];
    assert.equal(options.usePolling, true);
    assert.equal(options.interval, 300_000, 'the poll interval is the rescan interval, not min(rescan, 60 s)');
    assert.equal(options.binaryInterval, 300_000, 'audio files are binary, so this is the interval that actually applies');

    const status = watcher.status();
    assert.equal(status.mode, 'polling');
    assert.equal(status.pollIntervalSeconds, 300, 'the status says how often the share is polled');

    const starts = logs.filter(([, message]) => /file watcher started/.test(message));
    assert.equal(starts.length, 2, 'once for events, once again for polling');
    assert.equal(starts[0][0].pollIntervalSeconds, null, 'the events-mode start names no interval');
    assert.equal(starts[1][0].pollIntervalSeconds, 300);
    assert.match(starts[1][1], /polling every 5 minutes \(the rescan interval\)/, 'the log line says so in words');

    assert.match(health.get('watcher').message, /every 5 minutes/, 'the notice and the poll now agree');
    await watcher.stop();
  });

  it('follows the rescan interval the operator chose, however long', async () => {
    const { watcher, calls } = watcherWith({ rescanIntervalSeconds: 3600 });
    await watcher.start();
    await degradeToPolling(watcher);
    assert.equal(calls[1].options.interval, 3_600_000, 'an hour means an hour; nothing caps it at a minute');
    assert.equal(watcher.status().pollIntervalSeconds, 3600);
    await watcher.stop();
    assert.equal(watcher.status().pollIntervalSeconds, null, 'cleared with the watcher');
  });
});
