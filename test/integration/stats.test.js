import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';
import { classifyClient } from '../../src/services/stats.js';
import { resolveRange } from '../../src/lib/time-range.js';

/**
 * Play and download statistics.
 *
 * The behaviour these lock down is mostly about *not* overstating things: one
 * request must produce exactly one row, a player seeking must not be counted as a
 * download, and a failure must be recorded rather than silently dropped — that
 * last one is the whole reason the feature exists.
 */
describe('play and download statistics', () => {
  let server;
  let show;
  let episode;
  let mediaBase;

  before(async () => {
    server = await createTestServer();
    await server.addAudio('metrics', 'sample.m4a', 'first-episode.m4a');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('metrics');
    episode = server.episodes.listByShow(show.id)[0];
    mediaBase = `/media/${show.slug}/${show.feed_token}`;
    await server.login();
  });

  after(async () => {
    await server.cleanup();
  });

  /** Recording happens once the response ends, so give the event loop a turn. */
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  function audioUrl() {
    return `${mediaBase}/${episode.id}/${encodeURIComponent(episode.filename)}`;
  }

  function rowsFor(episodeId = episode.id) {
    return server.db
      .prepare('SELECT * FROM media_access WHERE episode_id = ? ORDER BY id')
      .all(episodeId);
  }

  function clearLog() {
    server.db.prepare('DELETE FROM media_access').run();
  }

  it('records a whole-file request as one download', async () => {
    clearLog();
    const response = await server.app.inject({
      url: audioUrl(),
      headers: { 'user-agent': 'Pocket Casts/7.5 (iPhone; iOS 18.2)' },
    });
    assert.equal(response.statusCode, 200);
    await settle();

    const rows = rowsFor();
    // One request, one row. A response that emitted both `finish` and `close`
    // previously logged twice, which silently doubled every figure on the page.
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'download');
    assert.equal(rows[0].status_code, 200);
    assert.equal(rows[0].client, 'Pocket Casts');
    assert.equal(rows[0].bytes_sent, episode.file_size_bytes);
    assert.equal(rows[0].error, null);
  });

  it('counts a range request as a stream rather than a download', async () => {
    clearLog();
    const response = await server.app.inject({
      url: audioUrl(),
      headers: { range: 'bytes=0-1023', 'user-agent': 'Overcast/2024 (+http://overcast.fm/)' },
    });
    assert.equal(response.statusCode, 206);
    await settle();

    const totals = server.stats.forEpisode(episode.id);
    assert.equal(totals.streams, 1);
    assert.equal(totals.downloads, 0, 'seeking through an episode is not a download');
    assert.equal(rowsFor()[0].range_header, 'bytes=0-1023');
  });

  it('records a feed poll separately from episode traffic', async () => {
    clearLog();
    await server.app.inject({
      url: `/feeds/${show.slug}/${show.feed_token}.xml`,
      headers: { 'user-agent': 'Pocket Casts/7.5' },
    });
    await settle();

    const rollup = server.stats.forShow(show.id);
    assert.equal(rollup.feedFetches, 1);
    assert.equal(rollup.downloads, 0);
    assert.equal(rollup.streams, 0);
  });

  /**
   * The count alone does not answer the question people actually ask, which is "why
   * has my podcast app not picked up the new episode?". If nothing has fetched the
   * feed since the episode appeared, there is nothing wrong to investigate.
   */
  it('reports when the feed was last checked, and by which app', async () => {
    clearLog();
    await server.app.inject({
      url: `/feeds/${show.slug}/${show.feed_token}.xml`,
      headers: { 'user-agent': 'Pocket Casts/7.5 (server)' },
    });
    await settle();

    const rollup = server.stats.forShow(show.id);
    assert.equal(rollup.feedFetches, 1);
    assert.ok(rollup.feedLastAt, 'the time of the last feed check must be available');
    assert.equal(rollup.feedLastClient, 'Pocket Casts');

    // And it must reach the show page, next to the count.
    const page = await server.request({ method: 'GET', url: `/shows/${show.slug}` });
    assert.match(page.body, /feed checks/i);
    assert.match(page.body, /Pocket Casts/);
  });

  it('says so plainly when no app has ever checked the feed', async () => {
    clearLog();
    const rollup = server.stats.forShow(show.id);
    assert.equal(rollup.feedFetches, 0);
    assert.equal(rollup.feedLastAt, null);
    assert.equal(rollup.feedLastClient, null);
    const page = await server.request({ method: 'GET', url: `/shows/${show.slug}` });
    assert.equal(page.statusCode, 200);
  });

  it('records a failure with a reason when the file is gone', async () => {
    clearLog();
    const path = join(server.config.showsDir, 'metrics', episode.filename);
    const backup = `${path}.stashed`;
    const { rename } = await import('node:fs/promises');
    await rename(path, backup);
    try {
      const response = await server.app.inject({
        url: audioUrl(),
        headers: { 'user-agent': 'Pocket Casts/7.5 (iPhone)' },
      });
      assert.equal(response.statusCode, 404);
      await settle();

      const rows = rowsFor();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status_code, 404);
      assert.match(rows[0].error, /not on disk/);
      assert.equal(server.stats.forEpisode(episode.id).failures, 1);
      assert.equal(server.stats.recentFailures().length, 1);
    } finally {
      await rename(backup, path);
    }
  });

  it('explains a read that fails after the size check passed', async () => {
    clearLog();
    // Reading can fail *after* stat succeeded — the file deleted between the two, or
    // the share dropping mid-transfer — and that arrives as a bare 500 from the
    // static handler with nobody having set a reason. Standing a directory where the
    // file was reproduces it deterministically: stat succeeds, the read cannot.
    const { mkdir, rename, rm } = await import('node:fs/promises');
    const path = join(server.config.showsDir, 'metrics', episode.filename);
    const stashed = `${path}.stashed`;
    await rename(path, stashed);
    await mkdir(path);
    try {
      const response = await server.app.inject({
        url: audioUrl(),
        headers: { 'user-agent': 'Pocket Casts/7.5 (iPhone)' },
      });
      assert.ok(response.statusCode >= 400, `expected a failure, got ${response.statusCode}`);
      await settle();

      const [row] = server.stats.list({ episodeId: episode.id });
      assert.ok(row, 'the failed request must be recorded at all');
      assert.equal(row.ok, false);
      assert.ok(
        row.error && row.error.trim().length > 0,
        'a failure with no reason is as useless as no record at all',
      );
      assert.match(row.error, new RegExp(episode.filename.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      await rm(path, { recursive: true, force: true });
      await rename(stashed, path);
    }
  });

  it('never stores the feed token or the raw user agent', async () => {
    clearLog();
    await server.app.inject({
      url: audioUrl(),
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    await settle();

    const dump = JSON.stringify(rowsFor());
    assert.ok(!dump.includes(show.feed_token), 'the token is a credential and must not be logged');
    assert.ok(!dump.includes('AppleWebKit'), 'only a coarse client family is kept');
    assert.equal(rowsFor()[0].client, 'Browser');
  });

  it('does not count the owner browsing the admin interface', async () => {
    clearLog();
    await server.request({ method: 'GET', url: `/shows/${show.slug}` });
    await server.request({ method: 'GET', url: '/stats' });
    await settle();
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM media_access').get().n, 0);
  });

  it('does not count the owner previewing an episode from the editor', async () => {
    clearLog();
    // The episode editor plays audio through this same public route, so without
    // the session check the owner would inflate their own numbers.
    const preview = await server.request({ method: 'GET', url: audioUrl() });
    assert.equal(preview.statusCode, 200);
    await server.request({ method: 'GET', url: `${mediaBase}/cover.jpg` });
    await settle();

    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM media_access').get().n, 0);

    // The same URL without the session — a real subscriber — still counts.
    await server.app.inject({ url: audioUrl(), headers: { 'user-agent': 'Pocket Casts/7.5' } });
    await settle();
    assert.equal(server.stats.forEpisode(episode.id).downloads, 1);
  });

  it('rolls up per episode and per show without double counting', async () => {
    clearLog();
    for (let i = 0; i < 3; i += 1) {
      await server.app.inject({ url: audioUrl(), headers: { 'user-agent': 'AntennaPod/3.4' } });
    }
    await server.app.inject({
      url: audioUrl(),
      headers: { range: 'bytes=100-200', 'user-agent': 'AntennaPod/3.4' },
    });
    await settle();

    const perEpisode = server.stats.forEpisode(episode.id);
    assert.equal(perEpisode.downloads, 3);
    assert.equal(perEpisode.streams, 1);

    const byEpisode = server.stats.forShowEpisodes(show.id);
    assert.equal(byEpisode[episode.id].downloads, 3);

    const rollup = server.stats.forShow(show.id);
    assert.equal(rollup.downloads, 3);
    assert.equal(rollup.episodesTouched, 1);
    assert.deepEqual(rollup.clients, [{ client: 'AntennaPod', n: 4 }]);

    const busiest = server.stats.busiest();
    assert.equal(busiest[0].episodeId, episode.id);
    assert.equal(busiest[0].downloads, 3);
    assert.equal(busiest[0].showSlug, show.slug);
  });

  it('flags a successful response that sent far less than the whole file', async () => {
    clearLog();
    server.stats.record({
      episodeId: episode.id,
      showId: show.id,
      kind: 'download',
      statusCode: 200,
      bytesSent: 1000,
      totalBytes: 1_000_000,
    });
    const [row] = server.stats.list({ episodeId: episode.id });
    assert.equal(row.ok, true);
    assert.equal(row.incomplete, true, 'a truncated download is what a failure looks like server-side');
  });

  /**
   * The abort path as the route really records it: `bytes_sent` NULL, because the
   * Content-Length header says what was promised rather than what arrived, plus the
   * sentence saying the app hung up. It used to be shown as a green 200, counted as
   * a download, and exported as "ok" — the one outcome the log exists to expose.
   */
  it('neither counts nor greenlights a download the app abandoned', async () => {
    clearLog();
    server.stats.record({
      episodeId: episode.id,
      showId: show.id,
      kind: 'download',
      statusCode: 200,
      bytesSent: null,
      totalBytes: episode.file_size_bytes,
      userAgent: 'Pocket Casts/7.5 (iPhone)',
      error: 'The app disconnected before the transfer finished, so this download is incomplete.',
    });
    const [row] = server.stats.list({ episodeId: episode.id });
    assert.equal(row.ok, true, 'the response itself did not fail');
    assert.equal(row.incomplete, true, 'but the file never arrived, and the log must say so');
    assert.equal(server.stats.forEpisode(episode.id).downloads, 0, 'not a download anyone received');
    assert.equal(server.stats.forShow(show.id).downloads, 0);
    assert.equal(server.stats.overview().downloads, 0);
    assert.equal(server.stats.busiest(5).length, 0, 'an abandoned fetch is not evidence of interest');

    const csv = await server.get('/stats/access-log.csv');
    assert.match(csv.body, /,download,200,partial,/, 'the export says partial, not ok');
  });

  it('still counts a stream the player stopped part-way through', async () => {
    clearLog();
    server.stats.record({
      episodeId: episode.id,
      showId: show.id,
      kind: 'stream',
      statusCode: 206,
      bytesSent: null,
      totalBytes: episode.file_size_bytes,
      rangeHeader: 'bytes=40000-',
      error: 'The app disconnected before the transfer finished, so this download is incomplete.',
    });
    // A player that has buffered enough and closes the connection is behaving
    // normally; refusing to count it would hide most real listening.
    assert.equal(server.stats.forEpisode(episode.id).streams, 1);
    assert.equal(server.stats.list({ episodeId: episode.id })[0].incomplete, false);
  });

  it('keeps an episode\'s history after the episode is deleted, and says so', async () => {
    clearLog();
    await server.addAudio('metrics', 'sample.mp3', 'short-lived.mp3');
    await server.scanner.scanAllNow('manual');
    const doomed = server.episodes.listByShow(show.id).find((e) => e.filename === 'short-lived.mp3');
    assert.ok(doomed);
    server.stats.record({ episodeId: doomed.id, showId: show.id, kind: 'download', statusCode: 200, bytesSent: 5, totalBytes: 5, userAgent: 'Overcast/2024' });
    assert.equal(server.stats.forShow(show.id).downloads, 1);

    await server.episodes.deleteWithFile(doomed.id);
    assert.equal(server.episodes.get(doomed.id), undefined ?? server.episodes.get(doomed.id), 'the episode is gone');
    assert.equal(server.stats.forShow(show.id).downloads, 1, 'the download that happened still happened');
    assert.equal(server.stats.overview().downloads, 1);
    const [row] = server.stats.list({ showId: show.id });
    assert.equal(row.episodeDeleted, true);

    const page = await server.get('/stats', { accept: 'text/html' });
    assert.match(page.body, /An episode since deleted/);
    const csv = await server.get('/stats/access-log.csv');
    assert.match(csv.body, /\(deleted episode\)/);
  });

  it('counts a failed cover or feed request as a failure, the same as the log does', async () => {
    clearLog();
    server.stats.record({ showId: show.id, kind: 'cover', statusCode: 404, userAgent: 'Overcast/2024', error: 'no cover' });
    server.stats.record({ showId: show.id, kind: 'feed', statusCode: 500, userAgent: 'Overcast/2024', error: 'boom' });
    server.stats.record({ episodeId: episode.id, showId: show.id, kind: 'download', statusCode: 200, bytesSent: 9, totalBytes: 9 });
    const failuresInLog = server.stats.count({ failuresOnly: true });
    assert.equal(failuresInLog, 2);
    assert.equal(server.stats.overview().failures, failuresInLog, 'the card and the log agree');
    assert.equal(server.stats.forShow(show.id).failures, 2);
    assert.equal(server.stats.forShow(show.id).downloads, 1);
    assert.equal(server.stats.forShow(show.id).bytes, 9, 'bytes are still the audio bytes only');
    assert.equal(server.stats.forShow(show.id).episodesTouched, 1);
  });

  it('scopes every figure on the page to the chosen show, and says so', async () => {
    clearLog();
    await server.addAudio('other-show', 'sample.m4a', 'elsewhere.m4a');
    await server.scanner.scanAllNow('manual');
    const other = server.shows.getBySlug('other-show');
    const elsewhere = server.episodes.listByShow(other.id)[0];
    server.stats.record({ episodeId: episode.id, showId: show.id, kind: 'download', statusCode: 200, bytesSent: 9, totalBytes: 9 });
    for (let i = 0; i < 3; i += 1) {
      server.stats.record({ episodeId: elsewhere.id, showId: other.id, kind: 'download', statusCode: 200, bytesSent: 9, totalBytes: 9 });
    }
    assert.equal(server.stats.overview().downloads, 4);
    assert.equal(server.stats.overview({ showId: show.id }).downloads, 1);

    const page = await server.get(`/stats?showId=${show.slug}`, { accept: 'text/html' });
    assert.match(page.body, new RegExp(`<strong>${show.title}</strong> only`));
    assert.match(page.body, /\(every show\)/);
    assert.ok(!page.body.includes('elsewhere'), 'the other show\'s rows are not on a page about this one');
    const context = server.statsContext({ query: { showId: show.slug } });
    assert.equal(context.overview.downloads, 1, 'the cards follow the filter');
    assert.deepEqual(context.showStats.map((row) => row.slug), [show.slug], 'the per-show table is that show');
    assert.equal(context.busiest.every((row) => row.showSlug === show.slug), true);
    assert.equal(context.daily.reduce((sum, bucket) => sum + bucket.downloads, 0), 1, 'the chart too');
  });

  it('compares the previous period to the same point rather than to its whole', () => {
    clearLog();
    const now = new Date('2026-07-13T09:00:00Z');
    const range = resolveRange('7d', { timeZone: 'UTC', now });
    const stamp = (iso) =>
      server.db
        .prepare(`INSERT INTO media_access (episode_id, show_id, requested_at, kind, status_code, bytes_sent, total_bytes) VALUES (?, ?, ?, 'download', 200, 1, 1)`)
        .run(episode.id, show.id, iso);
    // 7 days to 09:00 on 13 July: this period opened on the 7th, the previous on the
    // 30th of June, and the same point in it is 09:00 on the 6th.
    assert.equal(range.prevTo, '2026-07-06T09:00:00.000Z');
    stamp('2026-07-07T08:00:00Z'); // this period, before now
    stamp('2026-06-30T08:00:00Z'); // previous period, before the same point
    stamp('2026-07-06T12:00:00Z'); // previous period, after the same point: not yet comparable
    const overview = server.stats.overview({ from: range.from, to: range.to, prevFrom: range.prevFrom, prevTo: range.prevTo });
    assert.equal(overview.downloads, 1);
    assert.equal(overview.previous.downloads, 1, 'the afternoon download on the 6th is not counted yet');
    assert.equal(overview.change.downloads.direction, 'flat');
  });

  it('exports every row, not the first fifty thousand', async () => {
    clearLog();
    const insert = server.db.prepare(
      `INSERT INTO media_access (episode_id, show_id, requested_at, kind, status_code, bytes_sent, total_bytes) VALUES (?, ?, ?, 'stream', 206, 1, 1)`,
    );
    const many = 50_250;
    server.db.transaction(() => {
      for (let i = 0; i < many; i += 1) insert.run(episode.id, show.id, `2026-07-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(6, '0')}Z`);
    })();
    const csv = await server.get('/stats/access-log.csv?range=all');
    assert.equal(csv.statusCode, 200);
    assert.equal(csv.body.split('\r\n').filter(Boolean).length, many + 1, 'a header plus every row');
    clearLog();
  });

  it('does not record a HEAD request at all', async () => {
    clearLog();
    const response = await server.app.inject({
      method: 'HEAD',
      url: audioUrl(),
      headers: { 'user-agent': 'Overcast/2024 (+http://overcast.fm/)' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(Number(response.headers['content-length']), episode.file_size_bytes);
    await settle();
    // Fastify runs the GET handler for a HEAD, so this used to be a "download" of
    // the file's whole size with nothing sent. Apps and validators HEAD enclosures
    // routinely; some episodes' figures doubled.
    assert.equal(rowsFor().length, 0);
    assert.equal(server.stats.forEpisode(episode.id).downloads, 0);
  });

  it('records a 304 as nothing sent, and does not count it as a download', async () => {
    clearLog();
    const first = await server.app.inject({
      url: audioUrl(),
      headers: { 'user-agent': 'Mozilla/5.0 Safari/605' },
    });
    assert.equal(first.statusCode, 200);
    const revalidated = await server.app.inject({
      url: audioUrl(),
      headers: { 'user-agent': 'Mozilla/5.0 Safari/605', 'if-none-match': first.headers.etag },
    });
    assert.equal(revalidated.statusCode, 304);
    await settle();

    const rows = rowsFor();
    assert.equal(rows.length, 2);
    assert.equal(rows[1].status_code, 304);
    assert.equal(rows[1].bytes_sent, 0, 'a 304 is a fact of zero bytes, not an unknown');
    const totals = server.stats.forEpisode(episode.id);
    assert.equal(totals.downloads, 1, 'the revalidation is not a second download');
    assert.equal(totals.failures, 0, 'nor is it a failure');
    assert.equal(totals.bytes, episode.file_size_bytes);
  });

  /**
   * Apple Podcasts fetches every episode with `Range: bytes=0-` and is answered with
   * a 206 carrying the whole file. Counting that as a stream meant the most common
   * app on iPhones never registered a download, so the figure under-counted one
   * app's listeners and nobody else's.
   */
  it('counts a range from byte zero that delivered the whole file as a download', async () => {
    clearLog();
    const probe = await server.app.inject({
      url: audioUrl(),
      headers: { range: 'bytes=0-1', 'user-agent': 'AppleCoreMedia/1.0.0 (iPhone)' },
    });
    assert.equal(probe.statusCode, 206);
    const whole = await server.app.inject({
      url: audioUrl(),
      headers: { range: 'bytes=0-', 'user-agent': 'AppleCoreMedia/1.0.0 (iPhone)' },
    });
    assert.equal(whole.statusCode, 206);
    const explicit = await server.app.inject({
      url: audioUrl(),
      headers: {
        range: `bytes=0-${episode.file_size_bytes - 1}`,
        'user-agent': 'AppleCoreMedia/1.0.0 (iPhone)',
      },
    });
    assert.equal(explicit.statusCode, 206);
    await settle();

    const rows = rowsFor();
    assert.deepEqual(
      rows.map((row) => [row.range_header, row.kind]),
      [
        ['bytes=0-1', 'stream'],
        ['bytes=0-', 'download'],
        [`bytes=0-${episode.file_size_bytes - 1}`, 'download'],
      ],
    );
    const totals = server.stats.forEpisode(episode.id);
    assert.equal(totals.downloads, 2);
    assert.equal(totals.streams, 1, 'the two-byte probe is a probe');
    assert.equal(rows[0].client, 'Apple media player');
  });

  it('keeps the range a resuming client asked for, even when answered with the whole file', async () => {
    clearLog();
    // A version the episode never had: the address is from an earlier cut, and the
    // client is resuming from the middle, so it is handed the whole file with a 200.
    const response = await server.app.inject({
      url: `${audioUrl()}?v=stale`,
      headers: { range: 'bytes=5000-', 'user-agent': 'Pocket Casts/7.5 (iPhone)' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['accept-ranges'], 'none');
    await settle();

    const [row] = rowsFor();
    assert.equal(row.kind, 'download', 'the whole file went out');
    assert.equal(row.range_header, 'bytes=5000-', 'and the log still shows why it was asked for');
    assert.equal(row.bytes_sent, episode.file_size_bytes);
  });

  it('filters the log to failures only', async () => {
    clearLog();
    await server.app.inject({ url: audioUrl(), headers: { 'user-agent': 'curl/8.4.0' } });
    server.stats.record({
      episodeId: episode.id,
      showId: show.id,
      kind: 'download',
      statusCode: 404,
      error: 'Deliberate.',
    });
    await settle();

    assert.equal(server.stats.count({}), 2);
    assert.equal(server.stats.count({ failuresOnly: true }), 1);
    const failures = server.stats.list({ failuresOnly: true });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].statusCode, 404);
  });

  it('keeps the log bounded', () => {
    clearLog();
    server.db
      .prepare(
        `INSERT INTO media_access (episode_id, show_id, requested_at, kind, status_code)
         VALUES (?, ?, ?, 'download', 200)`,
      )
      .run(episode.id, show.id, '2019-01-01T00:00:00.000Z');
    server.stats.record({ episodeId: episode.id, showId: show.id, kind: 'download', statusCode: 200 });

    assert.equal(server.stats.trim(365), 1, 'only the ancient row goes');
    assert.equal(server.stats.count({}), 1);
  });

  it('survives a database it cannot write to, rather than breaking downloads', () => {
    clearLog();
    server.db.prepare('DROP TABLE IF EXISTS media_access_backup').run();
    // A record() that throws must be swallowed: statistics are never worth
    // failing a subscriber's download for.
    assert.doesNotThrow(() =>
      server.stats.record({ episodeId: episode.id, showId: show.id, kind: null, statusCode: null }),
    );
  });

  describe('the JSON API', () => {
    it('requires the admin session', async () => {
      const anonymous = await server.app.inject({ method: 'GET', url: '/api/stats' });
      assert.equal(anonymous.statusCode, 401);
    });

    it('returns the overview, per-show totals and recent failures', async () => {
      clearLog();
      await server.app.inject({ url: audioUrl(), headers: { 'user-agent': 'Podcasts/1580.3 (iPhone)' } });
      await settle();

      const response = await server.request({ method: 'GET', url: '/api/stats' });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.overview.downloads, 1);
      const row = body.shows.find((s) => s.slug === show.slug);
      assert.equal(row.downloads, 1);
      assert.deepEqual(row.clients, [{ client: 'Apple Podcasts', n: 1 }]);
      assert.deepEqual(body.recentFailures, []);
    });

    it('serves the raw log with its filters', async () => {
      const response = await server.request({
        method: 'GET',
        url: `/api/stats/log?showId=${show.slug}&limit=5`,
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.equal(body.filter.show.slug, show.slug);
      assert.ok(body.entries.length >= 1);
      assert.ok(!JSON.stringify(body).includes(show.feed_token));
    });

    it('404s for a show that does not exist', async () => {
      const response = await server.request({ method: 'GET', url: '/api/shows/nope/stats' });
      assert.equal(response.statusCode, 404);
    });
  });

  describe('the statistics page', () => {
    it('shows the numbers, the failure and the plain-language reason', async () => {
      clearLog();
      await server.app.inject({ url: audioUrl(), headers: { 'user-agent': 'Pocket Casts/7.5' } });
      server.stats.record({
        episodeId: episode.id,
        showId: show.id,
        kind: 'download',
        statusCode: 404,
        error: 'first-episode.m4a is not on disk.',
      });
      await settle();

      const page = await server.request({ method: 'GET', url: '/stats' });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Access log/);
      assert.match(page.body, /Pocket Casts/);
      assert.match(page.body, /is not on disk/);
      assert.match(page.body, /requests, not listens/, 'the page must not imply these are listens');
      assert.ok(!page.body.includes(show.feed_token), 'the page must not leak the token either');
    });

    it('filters to failures through the htmx fragment', async () => {
      const fragment = await server.request({ method: 'GET', url: '/ui/stats/log?failuresOnly=1' });
      assert.equal(fragment.statusCode, 200);
      assert.match(fragment.body, /is not on disk/);
      assert.ok(!fragment.body.includes('<html'), 'a fragment must render bare');
    });

    it('needs a session', async () => {
      const anonymous = await server.app.inject({ method: 'GET', url: '/stats' });
      assert.equal(anonymous.statusCode, 303);
      assert.match(anonymous.headers.location, /^\/login/);
    });

    it('puts the per-episode counts in the show page', async () => {
      const page = await server.request({ method: 'GET', url: `/shows/${show.slug}` });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /Fetches/);
      assert.match(page.body, /Reach/);
    });

    it('gives one episode its own numbers and its own log', async () => {
      clearLog();
      await server.app.inject({ url: audioUrl(), headers: { 'user-agent': 'Overcast/2024' } });
      server.stats.record({
        episodeId: episode.id,
        showId: show.id,
        kind: 'download',
        statusCode: 404,
        error: 'A deliberate failure for this one file.',
      });
      await settle();

      const page = await server.request({
        method: 'GET',
        url: `/shows/${show.slug}/episodes/${episode.id}`,
      });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /This episode's reach/);
      assert.match(page.body, /A deliberate failure for this one file/);
      assert.match(page.body, /Overcast/);
    });
  });
});

describe('client classification', () => {
  it('names the well-known podcast apps', () => {
    assert.equal(classifyClient('Pocket Casts/7.5 (iPhone; iOS 18.2)'), 'Pocket Casts');
    assert.equal(classifyClient('Overcast/2024 (+http://overcast.fm/)'), 'Overcast');
    assert.equal(classifyClient('AntennaPod/3.4.0'), 'AntennaPod');
    assert.equal(classifyClient('Podcasts/1580.3 (iPhone; iOS 18.2)'), 'Apple Podcasts');
    // The system player speaks for whichever app is streaming through it, so it is
    // named for what it is rather than credited to Apple Podcasts.
    assert.equal(classifyClient('AppleCoreMedia/1.0.0 (iPhone)'), 'Apple media player');
    assert.equal(classifyClient('Spotify/8.9 iOS'), 'Spotify');
  });

  it('falls back to something honest rather than guessing', () => {
    assert.equal(classifyClient(null), 'Unknown');
    assert.equal(classifyClient(''), 'Unknown');
    assert.equal(classifyClient('SomeNewPodcastApp/1.0'), 'Other');
  });

  it('recognises a plain browser and the command line', () => {
    assert.equal(classifyClient('curl/8.4.0'), 'Command line');
    assert.equal(
      classifyClient('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120'),
      'Browser',
    );
  });
});

/** The one that started all of this: a filename long enough to 414 the route. */
describe('a download that used to fail is recorded as a success', () => {
  it('logs the long-filename request that podcast apps rejected', async () => {
    const server = await createTestServer();
    try {
      const long =
        '2026-08-03-Bulletin météo : forte dépression sur Ceuta, retour à la normale annoncé depuis Madrid.m4a';
      await server.addAudio('longnames', 'sample.m4a', long);
      await server.scanner.scanAllNow('manual');
      const show = server.shows.getBySlug('longnames');
      const episode = server.episodes.listByShow(show.id)[0];

      const response = await server.app.inject({
        url: `/media/${show.slug}/${show.feed_token}/${episode.id}/${encodeURIComponent(long)}`,
        headers: { 'user-agent': 'Pocket Casts/7.5 (iPhone; iOS 18.2)' },
      });
      assert.equal(response.statusCode, 200);
      await new Promise((resolve) => setTimeout(resolve, 60));

      const totals = server.stats.forEpisode(episode.id);
      assert.equal(totals.downloads, 1);
      assert.equal(totals.failures, 0);
    } finally {
      await server.cleanup();
    }
  });
});

/**
 * Filtering and sorting the access log.
 *
 * The log grew from two filters to seven, and a sort. Two failure modes are worth
 * pinning down. The first is a filter reaching the rows but not the total, which used
 * to be structurally possible because `list` and `count` built their WHERE clauses
 * separately — the log would then read "40 of 312" while showing something else.
 *
 * The second is the sort key: it is the only part of this query that becomes SQL text
 * rather than a bound parameter, so it has to come from a whitelist and nowhere else.
 */
describe('filtering and sorting the access log', () => {
  let server;
  let show;
  let episode;

  before(async () => {
    server = await createTestServer();
    await server.addAudio('logfilter', 'sample.m4a', 'first-episode.m4a');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('logfilter');
    episode = server.episodes.listByShow(show.id)[0];
    await server.login();
  });

  after(async () => {
    await server.cleanup();
  });

  function clearLog() {
    server.db.prepare('DELETE FROM media_access').run();
  }

  function logRow({
    kind = 'download',
    statusCode = 200,
    client = 'Overcast',
    bytes = 1000,
    at = new Date().toISOString(),
  } = {}) {
    server.db
      .prepare(
        `INSERT INTO media_access
           (episode_id, show_id, requested_at, kind, status_code, bytes_sent, total_bytes, client)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(episode.id, show.id, at, kind, statusCode, bytes, bytes, client);
  }

  /** The invariant behind the "N of M" line under every log. */
  function assertAgree(filter, expected, message) {
    assert.equal(server.stats.list({ ...filter, limit: 500 }).length, expected, `${message} (rows)`);
    assert.equal(server.stats.count(filter), expected, `${message} (total)`);
  }

  it('filters by request type, and treats all four types as no filter at all', () => {
    clearLog();
    logRow({ kind: 'download' });
    logRow({ kind: 'stream' });
    logRow({ kind: 'feed' });
    logRow({ kind: 'cover' });

    assertAgree({ kinds: ['download'] }, 1, 'only downloads');
    assertAgree({ kinds: ['download', 'stream'] }, 2, 'downloads and streams');
    assertAgree({ kinds: ['download', 'stream', 'feed', 'cover'] }, 4, 'every type is no narrowing');
    assertAgree({}, 4, 'and neither is no filter');
  });

  it('ignores a request type it does not recognise rather than returning nothing', () => {
    clearLog();
    logRow({ kind: 'download' });
    assertAgree({ kinds: ['nonsense'] }, 1, 'an unknown type drops out of the filter');
  });

  it('matches an app exactly rather than by substring', () => {
    clearLog();
    logRow({ client: 'Pocket Casts' });
    logRow({ client: 'Apple Podcasts' });

    assertAgree({ client: 'Pocket Casts' }, 1, 'the named app');
    assertAgree({ client: 'Pocket' }, 0, 'a prefix is not a match');
  });

  it('keeps rows and total in step for every combination', () => {
    clearLog();
    logRow({ kind: 'download', statusCode: 200, client: 'Overcast' });
    logRow({ kind: 'download', statusCode: 404, client: 'Overcast' });
    logRow({ kind: 'stream', statusCode: 200, client: 'Castro' });

    assertAgree({ failuresOnly: true }, 1, 'failures only');
    assertAgree({ failuresOnly: true, client: 'Overcast' }, 1, 'failures from one app');
    assertAgree({ kinds: ['stream'], client: 'Overcast' }, 0, 'a combination nothing matches');
    assertAgree({ showId: show.id, kinds: ['download'] }, 2, 'one show, one type');
  });

  it('sorts by size sent, largest first', () => {
    clearLog();
    logRow({ bytes: 10 });
    logRow({ bytes: 5000 });
    logRow({ bytes: 300 });

    const rows = server.stats.list({ sort: 'bytes', dir: 'desc' });
    assert.deepEqual(rows.map((row) => row.bytesSent), [5000, 300, 10], 'largest first');

    const ascending = server.stats.list({ sort: 'bytes', dir: 'asc' });
    assert.deepEqual(ascending.map((row) => row.bytesSent), [10, 300, 5000], 'and the other way');
  });

  it('shows each row exactly once when paging through a column full of ties', () => {
    clearLog();
    // Every row shares a status code, which is the ordinary case: without a tiebreaker
    // the database is free to return them in a different order per page, so rows appear
    // twice and others are never seen at all.
    for (let i = 0; i < 10; i += 1) logRow({ statusCode: 200, bytes: i });

    const filter = { sort: 'status', dir: 'desc' };
    const first = server.stats.list({ ...filter, limit: 5, offset: 0 });
    const second = server.stats.list({ ...filter, limit: 5, offset: 5 });
    const ids = new Set([...first, ...second].map((row) => row.id));
    assert.equal(ids.size, 10, 'ten rows over two pages, none repeated and none skipped');
  });

  it('falls back to newest-first when the sort key is not one it offers', () => {
    clearLog();
    logRow({ at: '2026-01-01T00:00:00.000Z' });
    logRow({ at: '2026-06-01T00:00:00.000Z' });

    const rows = server.stats.list({ sort: 'filename' });
    assert.equal(rows[0].requestedAt, '2026-06-01T00:00:00.000Z', 'newest first, as if unsorted');
  });

  it('cannot have its query rewritten through the sort key or direction', () => {
    clearLog();
    logRow();
    logRow();

    // If either reached the SQL as text, this would throw or return the wrong rows.
    const bySort = server.stats.list({ sort: 'a.requested_at; DROP TABLE media_access; --' });
    const byDir = server.stats.list({ sort: 'time', dir: 'DESC; DROP TABLE media_access; --' });
    assert.equal(bySort.length, 2, 'a smuggled sort key changes nothing');
    assert.equal(byDir.length, 2, 'and neither does a smuggled direction');
    assert.equal(server.stats.count({}), 2, 'the table is still there');
  });

  it('carries every filter through the htmx fragment and the pager', async () => {
    clearLog();
    for (let i = 0; i < 60; i += 1) logRow({ client: 'Castro' });

    const fragment = await server.get('/ui/stats/log?client=Castro&kind=download&failuresOnly=');
    assert.equal(fragment.statusCode, 200, 'the fragment renders');
    assert.ok(!fragment.body.includes('<html'), 'a fragment must not be wrapped in a layout');
    assert.match(
      fragment.body,
      /\/ui\/stats\/log\/rows\?[^"]*client=Castro/,
      'the pager URL keeps the app filter',
    );
    assert.match(fragment.body, /\/ui\/stats\/log\/rows\?[^"]*kind=download/, 'and the type filter');
  });

  it('puts the page URL in the address bar while fetching the fragment', async () => {
    const fragment = await server.get('/ui/stats/log?client=Castro');
    assert.equal(
      fragment.headers['hx-push-url'],
      '/stats?client=Castro',
      'what someone reloads or bookmarks is the page, not the fragment',
    );

    const rows = await server.get('/ui/stats/log/rows?client=Castro&offset=40');
    assert.equal(
      rows.headers['hx-push-url'],
      'false',
      'paging is not a filter, so it must not reach the address bar',
    );
  });

  it('returns only rows from the pager, so appending cannot duplicate the table', async () => {
    clearLog();
    for (let i = 0; i < 60; i += 1) logRow();

    const rows = await server.get('/ui/stats/log/rows?offset=40');
    assert.ok(!rows.body.includes('id="access-log"'), 'the pager response is not the whole container');
    assert.ok(!rows.body.includes('<thead'), 'nor a second table head');
    assert.ok(rows.body.trim().startsWith('<tr'), 'it is rows, which is what a tbody can accept');
  });

  it('offers the opposite direction on the column that is already sorted', async () => {
    clearLog();
    logRow();

    const page = await server.get('/stats?sort=bytes&dir=desc');
    assert.match(page.body, /href="\/stats\?[^"]*sort=bytes[^"]*dir=asc"/, 'clicking it flips to ascending');
    assert.match(page.body, /aria-sort="descending"/, 'and a screen reader is told which way it runs');
  });
});

/**
 * Conditional polls are still polls.
 *
 * "When was this feed last checked, and by which app" exists to answer *why hasn't my
 * podcast app picked up the new episode?* — and the answer is nearly always that
 * nothing has fetched the feed since it appeared. That figure was being computed from
 * 200s alone, so an app behaving perfectly and receiving 304s was invisible: in the
 * steady state the count sat still and the "last checked" time went stale while the app
 * was polling every fifteen minutes.
 */
describe('recording conditional feed polls', () => {
  let server;
  let show;

  before(async () => {
    server = await createTestServer();
    await server.addAudio('polled', 'sample.m4a', 'first-episode.m4a');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('polled');
    await server.login();
  });

  after(async () => {
    await server.cleanup();
  });

  /** Recording happens once the response ends, so give the event loop a turn. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  function clearLog() {
    server.db.prepare('DELETE FROM media_access').run();
  }

  function poll(headers = {}) {
    return server.app.inject({
      method: 'GET',
      url: `/feeds/${show.slug}/${show.feed_token}.xml`,
      headers: { 'user-agent': 'Pocket Casts/7.5 (iPhone; iOS 18.2)', ...headers },
    });
  }

  it('counts a 304 as a feed check, so a well-behaved app is not invisible', async () => {
    clearLog();
    const first = await poll();
    await settle();
    const afterFirst = server.stats.forShow(show.id).feedFetches;

    const second = await poll({ 'if-none-match': first.headers.etag });
    assert.equal(second.statusCode, 304, 'the second poll revalidates');
    await settle();

    assert.equal(
      server.stats.forShow(show.id).feedFetches,
      afterFirst + 1,
      'the revalidation is a feed check like any other',
    );
  });

  it('records zero bytes for a 304, not null, because nothing is not the same as unknown', async () => {
    clearLog();
    const first = await poll();
    await settle();
    await poll({ 'if-none-match': first.headers.etag });
    await settle();

    const rows = server.db
      .prepare("SELECT bytes_sent, status_code FROM media_access WHERE kind = 'feed' ORDER BY id")
      .all();
    assert.equal(rows.length, 2, 'both polls are on record');
    assert.equal(rows[1].status_code, 304, 'the second is the revalidation');
    assert.equal(
      rows[1].bytes_sent,
      0,
      'null is reserved for a transfer that died and cannot be measured',
    );
  });

  it('moves the last-checked time and names the app on a 304', async () => {
    clearLog();
    const first = await poll();
    await settle();
    const before = server.stats.forShow(show.id).feedLastAt;

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await poll({ 'if-none-match': first.headers.etag, 'user-agent': 'Overcast/2024 (+http://overcast.fm/)' });
    await settle();

    const after = server.stats.forShow(show.id);
    assert.notEqual(after.feedLastAt, before, 'the page can say when it was really last checked');
    assert.equal(after.feedLastClient, 'Overcast', 'and by which app');
  });

  it('leaves the served-bytes total at zero however often the feed is polled', async () => {
    clearLog();
    const first = await poll();
    await settle();
    for (let i = 0; i < 5; i += 1) {
      await poll({ 'if-none-match': first.headers.etag });
      await settle();
    }
    assert.equal(
      server.stats.forShow(show.id).bytes,
      0,
      'feed traffic has never counted as audio served, and counting 304s must not change that',
    );
  });
});
