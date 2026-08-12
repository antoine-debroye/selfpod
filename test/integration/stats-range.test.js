import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';
import { bucketEdges, resolveRange } from '../../src/lib/time-range.js';

/**
 * The statistics period.
 *
 * Every figure on the stats page used to be all-time, which cannot answer the only
 * question anyone actually asks of it: is this week better than last? These tests lock
 * down the two ways that answer goes wrong quietly — a request landing in the wrong
 * day because the buckets were cut in UTC rather than the operator's zone, and a
 * comparison against a period that does not abut the one on screen.
 *
 * The half-open boundary is the other silent failure: if both `to` and the next `from`
 * claimed the same instant, a request stamped exactly on midnight would be counted
 * twice and every total would be one out with nothing to show for it.
 */
describe('statistics over a period', () => {
  let server;
  let show;
  let episode;

  before(async () => {
    server = await createTestServer({ env: { TZ: 'Europe/London' } });
    await server.addAudio('metrics', 'sample.m4a', 'first-episode.m4a');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('metrics');
    episode = server.episodes.listByShow(show.id)[0];
    await server.login();
  });

  after(async () => {
    await server.cleanup();
  });

  function clearLog() {
    server.db.prepare('DELETE FROM media_access').run();
  }

  /** Writes one row directly, so a test can place a request at an exact instant. */
  function logAt(requestedAt, { kind = 'download', statusCode = 200, bytes = 1000, client = 'Overcast' } = {}) {
    server.db
      .prepare(
        `INSERT INTO media_access
           (episode_id, show_id, requested_at, kind, status_code, bytes_sent, total_bytes, client)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(episode.id, show.id, requestedAt, kind, statusCode, bytes, bytes, client);
  }

  describe('the bounds', () => {
    it('counts a request stamped exactly on the start of the period', () => {
      clearLog();
      const range = resolveRange('7d', { timeZone: 'Europe/London' });
      logAt(range.from);
      assert.equal(
        server.stats.count({ from: range.from, to: range.to }),
        1,
        'the first instant of the period belongs to it',
      );
    });

    it('excludes a request stamped exactly on the end of the period', () => {
      clearLog();
      const range = resolveRange('7d', { timeZone: 'Europe/London' });
      logAt(range.to);
      assert.equal(
        server.stats.count({ from: range.from, to: range.to }),
        0,
        'the end is exclusive, so the boundary instant belongs to the next period only',
      );
    });

    it('puts a request just after local midnight in that local day, not the one before', () => {
      clearLog();
      // 00:30 on a British Summer Time morning is 23:30 the previous day in UTC. Cut the
      // days in UTC and this request lands in yesterday's column.
      const range = resolveRange('7d', { timeZone: 'Europe/London', now: new Date('2026-07-15T12:00:00Z') });
      const buckets = bucketEdges({ from: range.from, to: range.to, timeZone: 'Europe/London' });
      logAt('2026-07-14T23:30:00.000Z');

      const rows = server.stats.daily({ buckets });
      const busy = rows.filter((row) => row.downloads > 0);
      assert.equal(busy.length, 1, 'exactly one bucket holds the request');
      assert.ok(
        busy[0].key.endsWith('-15'),
        `the request belongs to 15 July locally, got bucket ${busy[0].key}`,
      );
    });
  });

  describe('the chart', () => {
    it('returns a zero for a quiet day rather than leaving it out', () => {
      clearLog();
      const range = resolveRange('7d', { timeZone: 'Europe/London' });
      const buckets = bucketEdges({ from: range.from, to: range.to, timeZone: 'Europe/London' });
      logAt(range.from);

      const rows = server.stats.daily({ buckets });
      assert.equal(rows.length, buckets.length, 'every bucket comes back');
      assert.equal(
        rows.filter((row) => row.downloads === 0).length,
        buckets.length - 1,
        'the quiet days are present as zeros, not missing',
      );
    });

    it('counts downloads and streams apart', () => {
      clearLog();
      const range = resolveRange('7d', { timeZone: 'Europe/London' });
      const buckets = bucketEdges({ from: range.from, to: range.to, timeZone: 'Europe/London' });
      logAt(range.from, { kind: 'download' });
      logAt(range.from, { kind: 'stream' });
      logAt(range.from, { kind: 'feed' });

      const total = server.stats.daily({ buckets }).reduce(
        (sum, row) => ({ downloads: sum.downloads + row.downloads, streams: sum.streams + row.streams }),
        { downloads: 0, streams: 0 },
      );
      assert.deepEqual(total, { downloads: 1, streams: 1 }, 'a feed check is neither');
    });
  });

  describe('the comparison with the period before', () => {
    it('compares against the equal-length window immediately before', () => {
      clearLog();
      const range = resolveRange('7d', { timeZone: 'Europe/London' });
      logAt(range.from, { kind: 'download' });
      logAt(range.from, { kind: 'download' });
      logAt(range.prevFrom, { kind: 'download' });

      const overview = server.stats.overview(range);
      assert.equal(overview.downloads, 2, 'the current period has two');
      assert.equal(overview.previous.downloads, 1, 'the one before has one');
      assert.equal(overview.change.downloads.direction, 'up', 'two is more than one');
      assert.equal(overview.change.downloads.percent, 100, 'doubling reads as +100%');
    });

    it('reports no percentage when the earlier period was empty', () => {
      clearLog();
      const range = resolveRange('7d', { timeZone: 'Europe/London' });
      logAt(range.from, { kind: 'download' });

      const overview = server.stats.overview(range);
      assert.equal(
        overview.change.downloads.percent,
        null,
        'a rise measured from nothing has no percentage to report',
      );
      assert.equal(overview.change.downloads.absolute, 1, 'the absolute change is still real');
    });

    it('offers no comparison at all for all time', () => {
      clearLog();
      logAt(new Date().toISOString());
      const overview = server.stats.overview(resolveRange('all', { timeZone: 'Europe/London' }));
      assert.equal(overview.previous, null, 'there is no period before all time');
      assert.equal(overview.change, null, 'so there is no change to state');
    });

    it('reports the last request ever even when the period is empty', () => {
      clearLog();
      logAt('2020-01-01T12:00:00.000Z');
      const overview = server.stats.overview(resolveRange('7d', { timeZone: 'Europe/London' }));
      assert.equal(overview.downloads, 0, 'nothing happened in the last seven days');
      assert.equal(
        overview.lastEverAt,
        '2020-01-01T12:00:00.000Z',
        'but the page can still say when something last did',
      );
    });
  });

  describe('the per-show rollup', () => {
    it('honours the period', () => {
      clearLog();
      const range = resolveRange('7d', { timeZone: 'Europe/London' });
      logAt(range.from, { kind: 'download' });
      logAt('2020-01-01T12:00:00.000Z', { kind: 'download' });

      const all = server.stats.forShows();
      const recent = server.stats.forShows({ from: range.from, to: range.to });
      assert.equal(all[show.id].downloads, 2, 'all time sees both');
      assert.equal(recent[show.id].downloads, 1, 'the period sees only the recent one');
    });

    it('agrees with the per-show query it replaced', () => {
      clearLog();
      logAt(new Date().toISOString(), { kind: 'download' });
      logAt(new Date().toISOString(), { kind: 'stream' });
      logAt(new Date().toISOString(), { kind: 'feed' });

      const grouped = server.stats.forShows()[show.id];
      const single = server.stats.forShow(show.id);
      for (const key of ['downloads', 'streams', 'failures', 'bytes', 'episodesTouched', 'feedFetches']) {
        assert.equal(grouped[key], single[key], `${key} matches the query this one replaced`);
      }
    });
  });

  describe('the app breakdown', () => {
    it('groups by app family and orders by volume', () => {
      clearLog();
      const now = new Date().toISOString();
      logAt(now, { client: 'Pocket Casts' });
      logAt(now, { client: 'Pocket Casts' });
      logAt(now, { client: 'Overcast' });

      const rows = server.stats.byClient();
      assert.equal(rows[0].client, 'Pocket Casts', 'the busiest app is first');
      assert.equal(rows[0].n, 2, 'and its requests are counted together');
      assert.equal(rows[1].client, 'Overcast', 'the quieter one follows');
    });
  });

  describe('the page itself', () => {
    it('renders each range and says which one is showing', async () => {
      for (const [key, expected] of [
        ['7d', 'Last 7 days'],
        ['30d', 'Last 30 days'],
        ['90d', 'Last 90 days'],
        ['all', 'All time'],
      ]) {
        const response = await server.get(`/stats?range=${key}`);
        assert.equal(response.statusCode, 200, `/stats?range=${key} renders`);
        assert.ok(
          response.body.includes(expected.toLowerCase()) || response.body.includes(expected),
          `the page names the ${expected} period it is showing`,
        );
      }
    });

    it('falls back to the default period rather than erroring on nonsense', async () => {
      const response = await server.get('/stats?range=last-tuesday');
      assert.equal(response.statusCode, 200, 'an unknown range does not break the page');
      assert.ok(response.body.includes('last 30 days'), 'it shows the default period instead');
    });
  });
});
