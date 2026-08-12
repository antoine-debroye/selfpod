import { fromLocalInputValue } from './dates.js';

/**
 * Time ranges for the stats views, resolved as half-open `[from, to)` instants in
 * the instance's configured zone.
 *
 * Everything here is calendar arithmetic on a `YYYY-MM-DD` triple rather than
 * millisecond arithmetic on an instant, because the two disagree twice a year and
 * the disagreement is silent. Adding 86_400_000 ms to a local midnight lands at
 * 23:00 or 01:00 local on the day either side of a DST transition, and because each
 * boundary is derived from the previous one the error never cancels out: every
 * subsequent day boundary in the range stays an hour off, so a download logged at
 * 23:30 is counted on the wrong day for the rest of the chart. `Date.UTC(y, m-1, d + n)`
 * on the triple asks the calendar instead, which is the question actually being asked
 * — "seven days ago" means seven calendar days, not 168 hours.
 *
 * Ranges are half-open on purpose. A closed `[from, to]` on local midnights either
 * drops today's partial day or double-counts the boundary instant depending on which
 * comparison the query uses; `to` being *tomorrow's* local midnight means today's
 * events are in, and no event can belong to two buckets.
 */

export const RANGES = Object.freeze({
  '7d': Object.freeze({ days: 7, label: 'Last 7 days', lede: 'over the last 7 days' }),
  '30d': Object.freeze({ days: 30, label: 'Last 30 days', lede: 'over the last 30 days' }),
  '90d': Object.freeze({ days: 90, label: 'Last 90 days', lede: 'over the last 90 days' }),
  all: Object.freeze({ days: null, label: 'All time', lede: 'across everything recorded' }),
});

export const DEFAULT_RANGE = '30d';

/**
 * Resolves a range key into bounds. The key arrives from a query string, so it is
 * whatever the caller typed — an unknown or missing key falls back to the default
 * rather than throwing, because a stale bookmark should still render a dashboard.
 *
 * `prevFrom` exists so a view can show "up 12% on the previous period" from one
 * resolve. It is the local midnight `2 * days - 1` days back, which makes the previous
 * window abut the current one exactly: `[prevFrom, from)` and `[from, to)` share the
 * edge at `from`, so no event falls in both and none falls in the gap between them.
 * Deriving it by subtracting a duration from `from` instead would drift by an hour
 * across a transition and quietly move events between the two periods being compared.
 */
export function resolveRange(key, { timeZone, now = new Date() } = {}) {
  const resolvedKey = Object.prototype.hasOwnProperty.call(RANGES, key) ? key : DEFAULT_RANGE;
  const { days, label, lede } = RANGES[resolvedKey];

  if (days === null) {
    return { key: resolvedKey, label, lede, days: null, from: null, to: null, prevFrom: null };
  }

  const instant = now instanceof Date ? now : new Date(now);
  const today = localDay(Number.isNaN(instant.getTime()) ? new Date() : instant, timeZone);

  return {
    key: resolvedKey,
    label,
    lede,
    days,
    // `days - 1` back, not `days`: "the last 7 days" is seven calendar days counting
    // today, which is what the label promises the reader.
    from: localMidnight(shiftDay(today, -(days - 1)), timeZone),
    to: localMidnight(shiftDay(today, 1), timeZone),
    prevFrom: localMidnight(shiftDay(today, -(2 * days - 1)), timeZone),
  };
}

/**
 * Splits `[from, to)` into buckets for a chart, widening them until the count fits
 * under `max` — a 90-day range gets daily bars, two years gets months.
 *
 * Adjacent buckets share an edge by construction: bucket i's `end` is literally the
 * string used as bucket i+1's `start`. That matters because the interesting days are
 * the 23- and 25-hour ones. Computing each bucket's `end` as `start + 24h` would leave
 * an hour uncovered on the spring-forward day and an hour claimed by two buckets on the
 * autumn one, so a download at 01:30 would vanish from the chart or be counted twice —
 * and only ever on two days a year, which is exactly the kind of bug nobody reports.
 */
export function bucketEdges({ from, to, timeZone, max = 92 }) {
  if (!from || !to) return [];

  const firstDay = localDay(new Date(from), timeZone);
  const lastDay = localDay(new Date(to), timeZone);
  const dayCount = daysBetween(firstDay, lastDay);
  if (!Number.isFinite(dayCount) || dayCount <= 0) return [];

  // Narrowest width that fits. Months are the fallback rather than a fourth, wider
  // step because beyond a couple of years the chart stops being a chart anyway.
  let boundaries;
  let width;
  if (dayCount <= max) {
    boundaries = strideDays(firstDay, lastDay, 1);
    width = 'day';
  } else if (Math.ceil(dayCount / 7) <= max) {
    boundaries = strideDays(firstDay, lastDay, 7);
    width = 'week';
  } else {
    boundaries = monthBoundaries(firstDay, lastDay);
    width = 'month';
  }

  const labelFor = labeller(width, timeZone);

  return boundaries.slice(0, -1).map((day, i) => {
    const start = localMidnight(day, timeZone);
    return {
      key: day,
      label: labelFor(start),
      start,
      // The next boundary, never `start` plus a fixed duration — see above.
      end: localMidnight(boundaries[i + 1], timeZone),
    };
  });
}

/**
 * Boundaries every `stride` calendar days, with the final one pinned to `lastDay` so
 * the buckets still cover the whole range. Truncating instead would drop the tail —
 * usually the most recent days, which are the ones anyone is actually looking at.
 */
function strideDays(firstDay, lastDay, stride) {
  const boundaries = [];
  for (let day = firstDay; daysBetween(day, lastDay) > 0; day = shiftDay(day, stride)) {
    boundaries.push(day);
  }
  boundaries.push(lastDay);
  return boundaries;
}

/** Calendar months, so buckets line up with the months on the axis rather than 30-day slabs. */
function monthBoundaries(firstDay, lastDay) {
  const boundaries = [firstDay];
  for (let day = nextMonthStart(firstDay); daysBetween(day, lastDay) > 0; day = nextMonthStart(day)) {
    boundaries.push(day);
  }
  boundaries.push(lastDay);
  return boundaries;
}

/** Axis ticks are short by necessity — there may be ninety of them across one chart. */
function labeller(width, timeZone) {
  const options = width === 'month'
    ? { month: 'short', year: 'numeric' }
    : { day: 'numeric', month: 'short' };
  if (timeZone) options.timeZone = timeZone;
  const formatter = new Intl.DateTimeFormat('en-GB', options);
  return (instant) => formatter.format(new Date(instant));
}

/**
 * The local calendar day an instant falls on. `en-CA` is used purely because it emits
 * `YYYY-MM-DD`, which sorts and parses without further handling.
 */
function localDay(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    // Passing `timeZone: undefined` is not the same as omitting it in every engine,
    // so omit it and let Intl use the process zone the container sets from `TZ`.
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/** Midnight at the start of a local day, as an instant. Reuses the DST-correct probe. */
function localMidnight(day, timeZone) {
  return fromLocalInputValue(`${day}T00:00`, { timeZone });
}

/** `delta` calendar days from a `YYYY-MM-DD`, letting `Date.UTC` normalise month and year overflow. */
function shiftDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

function nextMonthStart(day) {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** Whole calendar days from `a` to `b`. Both are midnight-anchored triples, so this is exact. */
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000;
}
