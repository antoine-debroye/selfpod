import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromLocalInputValue } from '../../src/lib/dates.js';
import { bucketEdges, resolveRange } from '../../src/lib/time-range.js';

/**
 * Local midnight, on every day of a year, in zones whose clocks change at awkward
 * hours. The single-probe version was an hour out at midnight on the transition days
 * in Sydney, Auckland, Lord Howe and Santiago, and nowhere else — which is why the
 * London-only tests never saw it.
 */
const ZONES = [
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Santiago',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'UTC',
];

function localClock(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

describe('local midnight across a year of clock changes', () => {
  for (const timeZone of ZONES) {
    it(`reads back as 00:00 on every day of 2026 in ${timeZone}`, () => {
      const wrong = [];
      for (let d = new Date(Date.UTC(2026, 0, 1)); d.getUTCFullYear() === 2026; d = new Date(d.getTime() + 86_400_000)) {
        const day = d.toISOString().slice(0, 10);
        const instant = fromLocalInputValue(`${day}T00:00`, { timeZone });
        const clock = localClock(instant, timeZone);
        if (clock === `${day}T00:00`) continue;
        // Chile springs forward at midnight, so 00:00 does not exist that day: the
        // answer must then be the first instant of the day, with the day before
        // ending the minute earlier.
        const minuteBefore = localClock(new Date(instant).getTime() - 60_000, timeZone);
        if (clock.startsWith(day) && !minuteBefore.startsWith(day)) continue;
        wrong.push({ day, instant, clock, minuteBefore });
      }
      assert.deepEqual(wrong, [], 'midnight landed on the wrong hour on these days');
    });
  }

  it('keeps every afternoon as well, not only midnight', () => {
    for (const timeZone of ['Australia/Sydney', 'America/Santiago']) {
      for (const day of ['2026-04-05', '2026-10-04', '2026-09-06']) {
        const instant = fromLocalInputValue(`${day}T15:30`, { timeZone });
        assert.equal(localClock(instant, timeZone), `${day}T15:30`, `${timeZone} ${day}`);
      }
    }
  });

  it('gives the Sydney chart a 23-hour day on the October transition, starting at local midnight', () => {
    const timeZone = 'Australia/Sydney';
    const range = resolveRange('7d', { timeZone, now: new Date('2026-10-07T12:00:00Z') });
    const buckets = bucketEdges({ from: range.from, to: range.to, timeZone });
    const transition = buckets.find((bucket) => bucket.key === '2026-10-04');
    assert.ok(transition, 'the transition day is in the range');
    assert.equal(localClock(transition.start, timeZone), '2026-10-04T00:00');
    assert.equal((new Date(transition.end) - new Date(transition.start)) / 3.6e6, 23);
    for (const bucket of buckets) {
      assert.equal(localClock(bucket.start, timeZone).slice(11), '00:00', `${bucket.key} starts at midnight`);
    }
  });
});
