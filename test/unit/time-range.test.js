import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_RANGE, RANGES, bucketEdges, resolveRange } from '../../src/lib/time-range.js';

/**
 * These bounds decide which day every download is counted on, so the whole stats view
 * is only ever as correct as they are — and the ways they go wrong are all silent.
 *
 * The failure this file mostly exists to prevent is millisecond day arithmetic. Adding
 * 86_400_000 ms to a local midnight is right for 363 days a year and an hour out for the
 * other two, and because each boundary is derived from the last, one bad day poisons
 * every boundary after it: numbers still render, totals still look plausible, and the
 * only symptom is downloads landing on the wrong bar. Nobody files that bug. So the DST
 * cases are pinned to real Europe/London transitions with a fixed `now`, and the exact
 * UTC instants are asserted rather than merely their spacing.
 *
 * The other half is the half-open `[from, to)` contract. Buckets must share edges and
 * periods must abut, otherwise an event near a boundary is either counted twice or lost,
 * and a "down 4% on last month" figure quietly reports a rounding artefact as a trend.
 *
 * Every test passes an explicit `now`; a range helper tested against the wall clock
 * passes until the day the suite happens to run across a boundary.
 */
describe('time ranges', () => {
  describe('resolveRange', () => {
    const NOW = new Date('2026-08-12T12:00:00Z');

    it('falls back to the default rather than throwing on a key it does not know', () => {
      for (const key of ['bogus', '', null, undefined, '7', 42, {}]) {
        const range = resolveRange(key, { timeZone: 'UTC', now: NOW });
        assert.equal(range.key, DEFAULT_RANGE, `${String(key)} should resolve to the default`);
        assert.equal(range.days, 30, `${String(key)} should get the 30-day window`);
        assert.equal(range.label, 'Last 30 days', `${String(key)} should get the default label`);
      }
    });

    it('does not let a prototype key masquerade as a range', () => {
      const range = resolveRange('constructor', { timeZone: 'UTC', now: NOW });
      assert.equal(range.key, DEFAULT_RANGE, 'inherited properties are not ranges');
    });

    it('offers a label and a lede for every range, so a caller never prints undefined', () => {
      for (const [key, { label, lede }] of Object.entries(RANGES)) {
        assert.ok(label, `${key} needs a label`);
        assert.ok(lede, `${key} needs a lede`);
        const resolved = resolveRange(key, { timeZone: 'UTC', now: NOW });
        assert.equal(resolved.label, label, `${key} should carry its own label through`);
        assert.equal(resolved.lede, lede, `${key} should carry its own lede through`);
      }
      assert.equal(RANGES['7d'].lede, 'over the last 7 days', 'the lede reads as part of a sentence');
      assert.equal(RANGES.all.lede, 'across everything recorded', 'all-time has no "last N days" to offer');
    });

    it('spans seven local calendar days and ends at tomorrow local midnight', () => {
      const { from, to, days } = resolveRange('7d', { timeZone: 'UTC', now: NOW });
      assert.equal(days, 7, 'a 7d range is seven days');
      // Today is 12 Aug, so the window opens on the 6th — seven days counting today,
      // not seven days before today, which is what the label promises the reader.
      assert.equal(from, '2026-08-06T00:00:00.000Z', 'the window opens six days back, including today');
      assert.equal(to, '2026-08-13T00:00:00.000Z', "the window closes at tomorrow's midnight");
      assert.equal(
        (new Date(to) - new Date(from)) / 86_400_000,
        7,
        'seven days of coverage, so today\'s partial day is counted',
      );
    });

    it('abuts the previous period exactly, with no gap and no overlap', () => {
      const { from, to, prevFrom } = resolveRange('30d', { timeZone: 'UTC', now: NOW });
      const current = new Date(to) - new Date(from);
      const previous = new Date(from) - new Date(prevFrom);
      assert.equal(previous, current, 'the two periods being compared must be the same length');
      assert.equal(prevFrom, '2026-06-14T00:00:00.000Z', 'the previous window opens 59 days back');
      // `from` is the shared edge: `[prevFrom, from)` and `[from, to)` meet there, so no
      // event can fall in both periods or in a gap between them.
      assert.ok(new Date(prevFrom) < new Date(from), 'the previous period comes first');
    });

    it('returns null bounds for all time, so a query can skip the date filter entirely', () => {
      const range = resolveRange('all', { timeZone: 'Europe/London', now: NOW });
      assert.equal(range.key, 'all', 'the key survives');
      assert.equal(range.days, null, 'all time has no day count');
      assert.equal(range.from, null, 'no lower bound');
      assert.equal(range.to, null, 'no upper bound');
      assert.equal(range.prevFrom, null, 'nothing to compare all time against');
      assert.equal(range.label, 'All time', 'all time is labelled as such');
    });

    it('keeps the range table frozen, since it is shared across every request', () => {
      assert.ok(Object.isFrozen(RANGES), 'the table must not be mutable');
      assert.ok(Object.isFrozen(RANGES['7d']), 'nor its entries');
    });
  });

  /**
   * Europe/London puts the clocks forward at 01:00 GMT on the last Sunday of March —
   * 29 March in 2026. That day has 23 hours. Every assertion below would still pass if
   * the implementation added 24 hours per bucket *except* the exact-instant ones, which
   * is precisely why the instants are spelled out.
   */
  describe('bucketEdges across a DST transition', () => {
    const LONDON = 'Europe/London';

    it('still yields exactly seven daily buckets with shared edges', () => {
      const { from, to } = resolveRange('7d', { timeZone: LONDON, now: new Date('2026-04-05T12:00:00Z') });
      const buckets = bucketEdges({ from, to, timeZone: LONDON });

      assert.equal(buckets.length, 7, 'seven local days means seven buckets, transition or not');
      assert.equal(buckets[0].start, from, 'the first bucket opens where the range opens');
      assert.equal(buckets.at(-1).end, to, 'the last bucket closes where the range closes');
      for (let i = 0; i < buckets.length - 1; i += 1) {
        assert.equal(
          buckets[i].end,
          buckets[i + 1].start,
          `bucket ${buckets[i].key} must hand off exactly to ${buckets[i + 1].key}`,
        );
      }
    });

    it('gives the spring-forward day 23 hours rather than dropping or duplicating one', () => {
      // The previous period of that same 7-day range is 23–30 March, which contains the
      // transition itself.
      const { from, prevFrom } = resolveRange('7d', { timeZone: LONDON, now: new Date('2026-04-05T12:00:00Z') });
      const buckets = bucketEdges({ from: prevFrom, to: from, timeZone: LONDON });

      assert.equal(buckets.length, 7, 'seven calendar days, one of which is short');
      const shortDay = buckets.find((b) => b.key === '2026-03-29');
      assert.ok(shortDay, 'the transition day must have a bucket of its own');
      assert.equal(shortDay.start, '2026-03-29T00:00:00.000Z', 'it opens at GMT midnight');
      assert.equal(shortDay.end, '2026-03-29T23:00:00.000Z', 'and closes at BST midnight, 23 hours later');
      assert.equal(
        (new Date(shortDay.end) - new Date(shortDay.start)) / 3_600_000,
        23,
        'the short day is 23 hours, not 24',
      );

      const total = buckets.reduce((sum, b) => sum + (new Date(b.end) - new Date(b.start)), 0);
      assert.equal(
        total,
        new Date(from) - new Date(prevFrom),
        'the buckets must tile the period exactly — no hour covered twice, none missed',
      );
    });

    it('shifts the local midnight offset partway through a range that spans the transition', () => {
      const { from, to } = resolveRange('30d', { timeZone: LONDON, now: new Date('2026-04-15T12:00:00Z') });
      const buckets = bucketEdges({ from, to, timeZone: LONDON });
      const startFor = (key) => buckets.find((b) => b.key === key)?.start;

      assert.equal(buckets.length, 30, 'thirty local days, thirty buckets');
      // A London local midnight is midnight UTC in winter, and 23:00 UTC the previous
      // day once BST begins. If both forms are not present the range never crossed the
      // transition and this test is not testing what it claims to.
      assert.equal(startFor('2026-03-28'), '2026-03-28T00:00:00.000Z', 'GMT: local midnight is midnight UTC');
      assert.equal(startFor('2026-03-30'), '2026-03-29T23:00:00.000Z', 'BST: local midnight is 23:00 UTC the day before');
      assert.ok(
        buckets.some((b) => b.start.endsWith('T00:00:00.000Z')),
        'some edges must sit at midnight UTC',
      );
      assert.ok(
        buckets.some((b) => b.start.endsWith('T23:00:00.000Z')),
        'and some at 23:00 UTC — the offset genuinely changes mid-range',
      );
      assert.equal(buckets.at(-1).end, to, 'the tail still reaches the end of the range');
    });
  });

  describe('bucketEdges widths', () => {
    it('returns nothing when there is no lower bound, as on all time with an empty log', () => {
      assert.deepEqual(bucketEdges({ from: null, to: '2026-08-13T00:00:00.000Z', timeZone: 'UTC' }), []);
      assert.deepEqual(bucketEdges({ from: null, to: null, timeZone: 'UTC' }), []);
    });

    it('keeps daily buckets while they fit under the cap', () => {
      const { from, to } = resolveRange('90d', { timeZone: 'UTC', now: new Date('2026-08-12T12:00:00Z') });
      const buckets = bucketEdges({ from, to, timeZone: 'UTC' });
      assert.equal(buckets.length, 90, 'ninety days still fits in ninety-two buckets');
      assert.equal(
        (new Date(buckets[0].end) - new Date(buckets[0].start)) / 86_400_000,
        1,
        'so the buckets stay one day wide',
      );
      assert.equal(buckets.at(-1).label, '12 Aug', 'an axis tick is short enough to read');
    });

    it('steps up to weeks before it reaches months', () => {
      const buckets = bucketEdges({
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-08-13T00:00:00.000Z',
        timeZone: 'UTC',
      });
      assert.ok(buckets.length <= 92, `224 days must fit under the cap, got ${buckets.length}`);
      assert.equal(
        (new Date(buckets[0].end) - new Date(buckets[0].start)) / 86_400_000,
        7,
        'a week is the narrowest width that fits, so weeks it is',
      );
      assert.equal(buckets.at(-1).end, '2026-08-13T00:00:00.000Z', 'the final partial week still reaches the end');
    });

    it('fits two years by widening the buckets, not by truncating the range', () => {
      const to = '2026-08-13T00:00:00.000Z';
      const buckets = bucketEdges({ from: '2024-08-13T00:00:00.000Z', to, timeZone: 'UTC' });

      assert.ok(buckets.length <= 92, `two years must fit under the cap, got ${buckets.length}`);
      assert.ok(
        new Date(buckets[0].end) - new Date(buckets[0].start) > 86_400_000,
        'the cap is met by making buckets wider than a day',
      );
      // The distinction that matters: a truncated range would also come in under the cap,
      // and would silently hide the most recent — most interesting — data.
      assert.equal(buckets.at(-1).end, to, 'the last bucket still reaches the end of the range');
      assert.equal(buckets[0].start, '2024-08-13T00:00:00.000Z', 'and the first still starts at the beginning');
      assert.equal(buckets[0].label, 'Aug 2024', 'month-wide buckets are labelled by month');
      assert.equal(buckets[0].key, '2024-08-13', 'the key stays the starting day, stable across renders');

      for (let i = 0; i < buckets.length - 1; i += 1) {
        assert.equal(buckets[i].end, buckets[i + 1].start, `bucket ${buckets[i].key} must abut the next`);
      }
    });

    it('honours a lower cap by widening sooner', () => {
      const args = { from: '2026-06-14T00:00:00.000Z', to: '2026-08-13T00:00:00.000Z', timeZone: 'UTC' };
      const daily = bucketEdges(args);
      const coarse = bucketEdges({ ...args, max: 20 });
      assert.equal(daily.length, 60, 'sixty days fits the default cap as daily buckets');
      assert.ok(coarse.length <= 20, `a cap of 20 must be respected, got ${coarse.length}`);
      assert.ok(coarse.length < daily.length, 'a lower cap produces fewer, wider buckets');
      assert.equal(coarse.at(-1).end, args.to, 'and still covers the whole range');
    });
  });
});
