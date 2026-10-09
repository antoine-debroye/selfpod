/**
 * Date helpers. RFC 2822 formatting goes through `Date.prototype.toUTCString()`
 * rather than being hand-assembled from padded parts (spec §8.3 requirement 4):
 * `toUTCString` emits exactly `Sat, 09 Aug 2026 12:00:00 GMT`, which is a valid
 * RFC 2822 date-time as required for `pubDate` and `lastBuildDate`.
 */

export function nowIso() {
  return new Date().toISOString();
}

export function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toRFC2822(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toUTCString();
}

/** `HH:MM:SS`, or `MM:SS` when under an hour — the form Apple documents for itunes:duration. */
export function formatDuration(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) return null;
  const seconds = Math.max(0, Math.round(Number(totalSeconds)));
  if (!Number.isFinite(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Zero-padded `HH:MM:SS` for the feed, where a leading hour of 00 is harmless. */
export function formatDurationFeed(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined) return null;
  const seconds = Math.max(0, Math.round(Number(totalSeconds)));
  if (!Number.isFinite(seconds)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

const RELATIVE_UNITS = [
  { limit: 45, divisor: 1, unit: 'second' },
  { limit: 45 * 60, divisor: 60, unit: 'minute' },
  { limit: 22 * 3600, divisor: 3600, unit: 'hour' },
  { limit: 26 * 86400, divisor: 86400, unit: 'day' },
  { limit: 320 * 86400, divisor: 30 * 86400, unit: 'month' },
  { limit: Infinity, divisor: 365 * 86400, unit: 'year' },
];

/** "2m ago" / "in 5m" — used all over the dashboard and activity log. */
export function relativeTime(value, now = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const deltaSeconds = (date.getTime() - now) / 1000;
  const abs = Math.abs(deltaSeconds);
  if (abs < 10) return 'just now';
  for (const { limit, divisor, unit } of RELATIVE_UNITS) {
    if (abs < limit) {
      const value2 = Math.round(deltaSeconds / divisor);
      const magnitude = Math.abs(value2);
      const plural = magnitude === 1 ? unit : `${unit}s`;
      return deltaSeconds < 0 ? `${magnitude} ${plural} ago` : `in ${magnitude} ${plural}`;
    }
  }
  return '';
}

/**
 * Human date/time in the instance's configured zone. `timeZone: undefined` lets
 * Intl fall back to the process zone, which the container sets from `TZ`.
 */
export function formatDateTime(value, { timeZone, withTime = true } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const options = withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  if (timeZone) options.timeZone = timeZone;
  return new Intl.DateTimeFormat('en-GB', options).format(date);
}

export function formatTimeOfDay(value, { timeZone } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const options = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  if (timeZone) options.timeZone = timeZone;
  return new Intl.DateTimeFormat('en-GB', options).format(date);
}

/**
 * `datetime-local` input value (`YYYY-MM-DDTHH:mm`) rendered in the given zone,
 * so the publish-date field shows the same wall-clock time the UI displays.
 */
export function toLocalInputValue(value, { timeZone } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

/**
 * Reads a `datetime-local` value back, interpreting it in the given zone.
 *
 * The zone's offset is probed at the wall-clock instant read as UTC, and then once
 * more at the instant that first guess produced. One probe was enough for London
 * and New York, where the clocks change in the small hours and the first guess
 * lands on the right side of the change; it was an hour out at midnight on the
 * transition days in Sydney, Auckland and Santiago, where the guess — ten or eleven
 * hours later than the real instant — fell on the far side of a 02:00 change. The
 * second probe catches that. The one ambiguous hour when clocks go back has two
 * defensible answers; the earlier offset wins.
 */
export function fromLocalInputValue(input, { timeZone } = {}) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const match = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    const fallback = new Date(input);
    return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
  }
  const [, y, mo, d, h, mi, s = '00'] = match;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (!timeZone) return new Date(asUtc).toISOString();
  const firstOffset = zoneOffsetMs(new Date(asUtc), timeZone);
  const firstGuess = asUtc - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(firstGuess), timeZone);
  if (secondOffset === firstOffset) return new Date(firstGuess).toISOString();
  const secondGuess = asUtc - secondOffset;
  // Two different answers: the wall-clock time asked for sits beside a clock change.
  // Each guess is judged by what it reads back as in the zone. One that reads back
  // exactly wins (the earlier instant on the one night a time occurs twice). In the
  // hour the clocks skip no instant reads back exactly, so the first instant on the
  // far side of the gap wins — it is the start of the day that was asked for, which
  // is what a midnight is used for; the other guess belongs to the day before.
  const readback = (instant) => instant + zoneOffsetMs(new Date(instant), timeZone);
  const candidates = [firstGuess, secondGuess].sort((a, b) => a - b);
  const exact = candidates.filter((instant) => readback(instant) === asUtc);
  if (exact.length) return new Date(exact[0]).toISOString();
  const onOrAfter = candidates.filter((instant) => readback(instant) >= asUtc);
  return new Date(onOrAfter.length ? onOrAfter[0] : candidates[candidates.length - 1]).toISOString();
}

function zoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const hour = get('hour') === 24 ? 0 : get('hour');
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asIfUtc - date.getTime();
}

export function isoPlusSeconds(iso, seconds) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + seconds * 1000).toISOString();
}

export function secondsSince(iso, now = Date.now()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (now - date.getTime()) / 1000;
}
