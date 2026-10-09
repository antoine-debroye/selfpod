import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scanFinishedEvents } from '../../src/web/routes/events.js';

/**
 * "Rescan all" on N shows used to be N card fetches: every show finishing its turn
 * in the sweep sent the event the card re-reads itself on. The sweep's end is now
 * one event the grid re-reads itself on, and a card only re-reads itself when its
 * show was scanned on its own.
 */
describe('what the live stream says when a scan finishes', () => {
  const names = (payload) => scanFinishedEvents(payload).map(([event]) => event);

  it('a show scanned on its own clears its strip, tells its page, and tells its card', () => {
    assert.deepEqual(names({ scope: 'show', showId: 7, slug: 'tape-club', scanId: 12 }), [
      'scan-progress-7',
      'scan-finished-7',
      'show-scanned-7',
    ]);
  });

  it('a show scanned as part of a sweep tells its page but not its card', () => {
    assert.deepEqual(names({ scope: 'show', showId: 7, slug: 'tape-club', scanId: 13, parentScanId: 12 }), [
      'scan-progress-7',
      'scan-finished-7',
    ]);
  });

  it('the sweep itself clears the library strip and tells the grid, once', () => {
    assert.deepEqual(names({ scope: 'all', scanId: 12, totals: {} }), ['scan-progress-all', 'scan-finished-all']);
  });

  it('a strip is cleared with an empty swap and a trigger carries a token', () => {
    const events = scanFinishedEvents({ scope: 'show', showId: 7, scanId: 1 });
    assert.deepEqual(events[0], ['scan-progress-7', '']);
    for (const [, data] of events.slice(1)) assert.equal(data, 'done');
  });

  it('a sweep of three shows is three page events and one grid event, never three card events', () => {
    const sweep = [
      { scope: 'show', showId: 1, scanId: 2, parentScanId: 1 },
      { scope: 'show', showId: 2, scanId: 3, parentScanId: 1 },
      { scope: 'show', showId: 3, scanId: 4, parentScanId: 1 },
      { scope: 'all', scanId: 1 },
    ].flatMap(names);
    assert.equal(sweep.filter((name) => name.startsWith('show-scanned-')).length, 0);
    assert.equal(sweep.filter((name) => name === 'scan-finished-all').length, 1);
    assert.equal(sweep.filter((name) => /^scan-finished-\d/.test(name)).length, 3);
  });
});
