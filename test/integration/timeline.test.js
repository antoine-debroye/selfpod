import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';
import { TIMELINE_EVENT } from '../../src/services/timeline.js';

/**
 * The episode timeline.
 *
 * `scan_log` records `added: 3` and no filenames, so "when did that episode appear,
 * and when did it go?" had no answer. The timeline derives one from columns `episodes`
 * has always had, which is what makes it retroactive: none of the tests below write a
 * timeline record, because there is nothing to write — every episode here is seeded
 * through the ordinary scanner and removal paths, exactly as a library that predates
 * this feature was.
 *
 * Two behaviours are worth more than the rest. One episode must be able to report more
 * than one event, because an expired episode genuinely both went missing and expired,
 * and a view that showed only the last thing that happened would hide the interesting
 * half. And paging must be stable: a scan stamps twenty episodes with the same
 * millisecond, so without a tiebreaker the second page repeats rows the first already
 * showed and skips others entirely — the failure mode nobody notices until they are
 * hunting a specific episode that the list swears is not there.
 *
 * The last test in the file is not a bug report. This is a derived view of current
 * state, so restoring an episode erases its removal, and that limit is pinned down
 * here rather than left for someone to discover.
 */
describe('the episode timeline', () => {
  let server;

  /** ISO timestamps carry milliseconds; spacing the phases keeps the order well-defined. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  before(async () => {
    server = await createTestServer();
    await server.login();
  });

  after(async () => {
    await server.cleanup();
  });

  /** Seeds a show from real audio files and returns it with its episodes. */
  async function seedShow(slug, fixtures) {
    for (const [fixture, as] of fixtures) await server.addAudio(slug, fixture, as);
    await server.scanner.scanAllNow('manual');
    const show = server.shows.getBySlug(slug);
    return { show, episodes: server.episodes.listByShow(show.id) };
  }

  describe('what it derives from an untouched library', () => {
    it('reports an episode scanned long before this feature existed', async () => {
      const { show, episodes } = await seedShow('archive', [['sample.m4a', 'first.m4a']]);
      const episode = episodes[0];

      const [event] = server.timeline.list({ showId: show.id });
      assert.ok(event, 'an episode that exists must have an "added" event');
      assert.equal(event.event, TIMELINE_EVENT.ADDED);
      assert.equal(event.episodeId, episode.id, 'the event names the episode');
      assert.equal(event.episodeTitle, episode.title);
      assert.equal(event.filename, 'first.m4a', 'the filename is the thing scan_log never kept');
      assert.equal(event.showTitle, show.title);
      assert.equal(event.showSlug, show.slug);
      assert.equal(event.status, 'active');
      // The timestamp is the episode's own created_at, not a moment this feature
      // invented — which is why the history is complete on the first page load.
      assert.equal(event.at, episode.created_at, 'the event time is the row\'s own created_at');
    });

    it('carries no row for an episode nothing has happened to beyond being added', async () => {
      const show = server.shows.getBySlug('archive');
      const events = server.timeline.list({ showId: show.id, limit: 200 });
      assert.equal(events.length, 1, 'one episode, one event — no phantom missing or removed rows');
    });
  });

  describe('an episode with more than one thing in its past', () => {
    let show;
    let episode;

    before(async () => {
      const seeded = await seedShow('pruned', [['sample.mp3', 'unwanted.mp3']]);
      show = seeded.show;
      episode = seeded.episodes[0];
      await tick();
      server.episodes.removeFromFeed(episode.id);
    });

    it('appears once per event, newest first', () => {
      const events = server.timeline.list({ showId: show.id, limit: 200 });
      assert.equal(events.length, 2, 'added and removed are two rows, not one row that changed');
      assert.deepEqual(
        events.map((row) => row.event),
        [TIMELINE_EVENT.REMOVED, TIMELINE_EVENT.ADDED],
        'the removal is the newer of the two and must lead',
      );
      assert.ok(events[0].at > events[1].at, 'newest first means strictly descending timestamps');
      assert.ok(
        events.every((row) => row.episodeId === episode.id),
        'both rows describe the same episode',
      );
      assert.equal(events[0].status, 'removed', 'each row carries the episode\'s current status');
    });

    it('does not claim the removed episode also went missing', () => {
      const events = server.timeline.list({ showId: show.id, limit: 200 });
      assert.ok(
        !events.some((row) => row.event === TIMELINE_EVENT.MISSING),
        'removeFromFeed clears missing_since, so there is no missing event to report',
      );
    });
  });

  describe('an episode whose file vanished for good', () => {
    let show;
    let episode;

    before(async () => {
      // Driven entirely through the real code path: the scanner soft-marks the file
      // as missing, and the grace sweep is what later calls it expired.
      const seeded = await seedShow('vanished', [['sample.aac', 'gone.aac']]);
      show = seeded.show;
      episode = seeded.episodes[0];

      await tick();
      await rm(join(server.config.showsDir, 'vanished', 'gone.aac'), { force: true });
      await server.scanner.scanAllNow('manual');

      await tick();
      const swept = server.episodes.sweepMissing(0);
      assert.equal(swept.length, 1, 'the grace sweep must actually have expired it');
    });

    it('reports both that it went missing and that it expired', () => {
      const events = server.timeline.list({ showId: show.id, limit: 200 });
      assert.deepEqual(
        events.map((row) => row.event),
        [TIMELINE_EVENT.EXPIRED, TIMELINE_EVENT.MISSING, TIMELINE_EVENT.ADDED],
        'sweepMissing leaves missing_since set on purpose, so both events are real',
      );
      assert.equal(
        new Set(events.map((row) => row.episodeId)).size,
        1,
        'three events, one episode row — this is why the query is a UNION ALL',
      );
      assert.equal(events[0].status, 'expired');
    });

    it('does not also call it removed', () => {
      const events = server.timeline.list({ showId: show.id, limit: 200 });
      assert.ok(
        !events.some((row) => row.event === TIMELINE_EVENT.REMOVED),
        'removed_at is set by the sweep too; only the status tells the two apart',
      );
      const fresh = server.episodes.get(episode.id);
      assert.equal(fresh.status, 'expired', 'the row itself is expired, not removed');
      assert.ok(fresh.removed_at, 'the sweep does set removed_at, which is the trap being avoided');
    });
  });

  describe('filtering', () => {
    it('narrows to one kind of event and excludes the others', () => {
      const show = server.shows.getBySlug('vanished');
      const missing = server.timeline.list({ showId: show.id, events: ['missing'], limit: 200 });
      assert.equal(missing.length, 1, 'exactly the one missing event');
      assert.equal(missing[0].event, TIMELINE_EVENT.MISSING);

      const expired = server.timeline.list({ showId: show.id, events: ['expired'], limit: 200 });
      assert.deepEqual(expired.map((row) => row.event), [TIMELINE_EVENT.EXPIRED]);

      const both = server.timeline.list({
        showId: show.id,
        events: ['missing', 'expired'],
        limit: 200,
      });
      assert.deepEqual(both.map((row) => row.event), [TIMELINE_EVENT.EXPIRED, TIMELINE_EVENT.MISSING]);
      assert.ok(
        !both.some((row) => row.event === TIMELINE_EVENT.ADDED),
        'asking for missing and expired must not smuggle added back in',
      );
    });

    it('treats a filter naming every event as no filter at all', () => {
      const show = server.shows.getBySlug('vanished');
      const all = server.timeline.list({ showId: show.id, events: Object.values(TIMELINE_EVENT), limit: 200 });
      const unfiltered = server.timeline.list({ showId: show.id, limit: 200 });
      assert.deepEqual(all, unfiltered, 'restating the whole set changes nothing');
    });

    it('confines the timeline to one show', async () => {
      await seedShow('elsewhere', [['sample.ogg', 'other.ogg']]);
      const mine = server.shows.getBySlug('archive');
      const theirs = server.shows.getBySlug('elsewhere');

      const events = server.timeline.list({ showId: mine.id, limit: 200 });
      assert.ok(events.length > 0, 'the show being filtered to must still have events');
      assert.ok(
        events.every((row) => row.showId === mine.id),
        'another show\'s episodes must not leak in',
      );
      assert.ok(
        !events.some((row) => row.showSlug === theirs.slug),
        'and neither must its slug',
      );

      const everything = server.timeline.list({ limit: 200 });
      assert.ok(
        everything.some((row) => row.showId === theirs.id),
        'unfiltered, the other show is present — so the filter did the excluding',
      );
    });

    it('honours a half-open time window', () => {
      const all = server.timeline.list({ limit: 200 });
      const cutoff = all[all.length - 1].at;
      const since = server.timeline.list({ from: cutoff, limit: 200 });
      assert.equal(since.length, all.length, 'from is inclusive of its own boundary');
      const before = server.timeline.list({ to: cutoff, limit: 200 });
      assert.ok(
        !before.some((row) => row.at === cutoff),
        'to is exclusive, so paging by day cannot double-count midnight',
      );
    });
  });

  describe('paging', () => {
    let show;
    let stamp;

    before(async () => {
      // Six episodes, then every created_at forced to one instant — which is what a
      // real scan of a folder produces often enough to matter.
      await seedShow('bulk', [
        ['sample.m4a', 'a.m4a'],
        ['sample.mp3', 'b.mp3'],
        ['sample.aac', 'c.aac'],
        ['sample.ogg', 'd.ogg'],
        ['sample.opus', 'e.opus'],
        ['sample.wav', 'f.wav'],
      ]);
      show = server.shows.getBySlug('bulk');
      stamp = '2026-03-01T12:00:00.000Z';
      server.db.prepare('UPDATE episodes SET created_at = ? WHERE show_id = ?').run(stamp, show.id);
    });

    it('seeded six episodes sharing a single timestamp', () => {
      const events = server.timeline.list({ showId: show.id, limit: 200 });
      assert.equal(events.length, 6, 'six distinct files are six episodes');
      assert.ok(
        events.every((row) => row.at === stamp),
        'the whole point of this fixture is that the timestamps collide',
      );
    });

    it('returns each event exactly once across two consecutive pages', () => {
      const first = server.timeline.list({ showId: show.id, limit: 3, offset: 0 });
      const second = server.timeline.list({ showId: show.id, limit: 3, offset: 3 });
      assert.equal(first.length, 3);
      assert.equal(second.length, 3);

      const ids = [...first, ...second].map((row) => row.episodeId);
      assert.equal(
        new Set(ids).size,
        6,
        'without the episode_id tiebreaker, page two repeats rows page one already showed',
      );
      const unpaged = server.timeline.list({ showId: show.id, limit: 200 }).map((row) => row.episodeId);
      assert.deepEqual(ids, unpaged, 'the two pages reassemble the unpaged order exactly');
    });

    it('gives the same order every time it is asked', () => {
      const once = server.timeline.list({ showId: show.id, limit: 200 }).map((row) => row.episodeId);
      const twice = server.timeline.list({ showId: show.id, limit: 200 }).map((row) => row.episodeId);
      assert.deepEqual(twice, once, 'a stable sort is what makes OFFSET paging meaningful');
    });

    it('breaks a tied timestamp on the episode id rather than on the query plan', () => {
      // Ids are UUIDs, so this order has nothing to do with insertion order — which
      // is exactly the point. Drop the tiebreaker and the rows come back in whatever
      // order the plan happened to produce, which is not an order the database
      // promises to repeat across two OFFSET queries.
      const ids = server.timeline.list({ showId: show.id, limit: 200 }).map((row) => row.episodeId);
      assert.deepEqual(
        ids,
        [...ids].sort().reverse(),
        'tied events must fall back to episode_id descending, giving OFFSET a defined order to page over',
      );
    });

    it('clamps a limit nobody should be asking for', () => {
      assert.equal(server.timeline.list({ limit: 0 }).length, 1, 'a limit of zero still returns a row');
      assert.ok(server.timeline.list({ limit: 100000, offset: -5 }).length > 0, 'and nothing throws');
    });
  });

  describe('count', () => {
    it('matches the number of rows an unfiltered list returns', () => {
      const rows = server.timeline.list({ limit: 200 });
      assert.ok(rows.length > 5, 'the fixtures must have produced a decent number of events');
      assert.equal(
        server.timeline.count(),
        rows.length,
        'a total that disagrees with the list is how a pager offers pages that are empty',
      );
    });

    it('matches for a filtered case too', () => {
      const show = server.shows.getBySlug('vanished');
      const rows = server.timeline.list({ showId: show.id, events: ['missing', 'expired'], limit: 200 });
      assert.equal(server.timeline.count({ showId: show.id, events: ['missing', 'expired'] }), rows.length);
      assert.equal(rows.length, 2, 'and the filtered count is the one that could silently drift');

      const added = server.timeline.list({ events: ['added'], limit: 200 });
      assert.equal(server.timeline.count({ events: ['added'] }), added.length);
    });

    it('returns a plain zero rather than a row', () => {
      const n = server.timeline.count({ showId: 'no-such-show' });
      assert.equal(typeof n, 'number', 'callers add this to things; it must be a number');
      assert.equal(n, 0);
    });
  });

  describe('the known limit: this is a view of the present, not a log', () => {
    it('drops the removal event when the episode is restored — deliberately, not by accident', async () => {
      const { show, episodes } = await seedShow('undone', [['sample.flac', 'second-thoughts.flac']]);
      const episode = episodes[0];

      await tick();
      server.episodes.removeFromFeed(episode.id);
      const removed = server.timeline.list({ showId: show.id, limit: 200 });
      assert.deepEqual(
        removed.map((row) => row.event),
        [TIMELINE_EVENT.REMOVED, TIMELINE_EVENT.ADDED],
        'the removal is visible while it stands',
      );

      await tick();
      server.episodes.restoreToFeed(episode.id);

      // restoreToFeed nulls removed_at — the very column this view reads — so the
      // removal cannot be reported any more. An append-only event table would keep
      // it; this design trades that for being retroactive across an entire existing
      // library, and says so rather than pretending the history is complete.
      const restored = server.timeline.list({ showId: show.id, limit: 200 });
      assert.deepEqual(
        restored.map((row) => row.event),
        [TIMELINE_EVENT.ADDED],
        'once restored, the episode looks like it was never removed',
      );
      assert.equal(
        server.timeline.count({ showId: show.id }),
        1,
        'and the count agrees, rather than counting a row the list cannot show',
      );
    });
  });

  describe('the event filter cannot reach the SQL', () => {
    it('ignores a value smuggled in alongside a legitimate one', () => {
      const smuggled = ['added', "'; DROP TABLE episodes; --"];
      const hostile = server.timeline.list({ events: smuggled, limit: 200 });
      const honest = server.timeline.list({ events: ['added'], limit: 200 });

      assert.deepEqual(hostile, honest, 'it behaves as if only the known event was asked for');
      assert.ok(hostile.length > 0, 'and it still returns the added events it should');
      assert.ok(
        hostile.every((row) => row.event === TIMELINE_EVENT.ADDED),
        'nothing outside the whitelist widened the result either',
      );
      assert.equal(
        server.timeline.count({ events: smuggled }),
        honest.length,
        'count is built from the same clause and must agree',
      );

      // The obvious thing to check, and the reason the payload is shaped that way.
      const survivors = server.db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n;
      assert.ok(survivors > 0, 'the episodes table is still there');
    });

    it('treats a filter of nothing but junk as no filter, not as a broken query', () => {
      // Every value is discarded, which leaves no recognised event to filter on. The
      // clause is then omitted entirely rather than emitting `IN ()`, which SQLite
      // would reject outright.
      const junk = server.timeline.list({ events: ['nonsense', 42, null], limit: 200 });
      const everything = server.timeline.list({ limit: 200 });
      assert.deepEqual(junk, everything, 'an unrecognisable filter narrows nothing');
      assert.equal(server.timeline.count({ events: ['nonsense'] }), everything.length);
    });

    it('is unbothered by an events value that is not a list at all', () => {
      const everything = server.timeline.list({ limit: 200 });
      assert.deepEqual(server.timeline.list({ events: 'added', limit: 200 }), everything);
      assert.deepEqual(server.timeline.list({ events: null, limit: 200 }), everything);
    });
  });
});
