import { formatDateTime, formatDuration, formatTimeOfDay, relativeTime, toLocalInputValue } from '../../lib/dates.js';
import {
  ITEM_DECISION,
  LANGUAGES,
  REMOTE_MAX_ITEMS_PER_POLL,
  SUPPORTED_EXTENSIONS_LABEL,
} from '../../constants.js';
import { APPLE_CATEGORIES, CATEGORY_NAMES } from './apple-categories.js';

/**
 * What happened to a remote episode, said in words.
 *
 * Every decision gets a sentence fragment, because a bare enum in the one place
 * someone looks to find out where an episode went is not an answer. The order is the
 * order the filter lists them in: what arrived, then what is on its way, then the
 * refusals, then the failures — roughly how interesting each is to someone who came
 * here asking "where is that episode?".
 */
const LEDGER_DECISIONS = Object.freeze([
  { value: ITEM_DECISION.DOWNLOADED, label: 'In your feed', cls: 'badge-ok' },
  { value: ITEM_DECISION.MATCHED, label: 'Waiting to download', cls: 'badge-warn' },
  { value: ITEM_DECISION.DOWNLOADING, label: 'Downloading', cls: 'badge-warn' },
  { value: ITEM_DECISION.PENDING, label: 'Not looked at yet', cls: 'badge-mute' },
  { value: ITEM_DECISION.REJECTED_DECLARED, label: "Didn't match your rules", cls: 'badge-mute' },
  { value: ITEM_DECISION.REJECTED_MEASURED, label: 'Too short or too long', cls: 'badge-mute' },
  { value: ITEM_DECISION.SKIPPED_BACKFILL, label: 'Older than your backfill limit', cls: 'badge-mute' },
  { value: ITEM_DECISION.DUPLICATE, label: 'Identical to one you already have', cls: 'badge-mute' },
  { value: ITEM_DECISION.DELETED_BY_USER, label: 'You deleted this one', cls: 'badge-mute' },
  { value: ITEM_DECISION.REJECTED_BLOCKED, label: 'Refused: audio on a private address', cls: 'badge-err' },
  { value: ITEM_DECISION.FAILED, label: "Couldn't be fetched", cls: 'badge-err' },
]);

/**
 * Helpers exposed to every template. Formatting lives here rather than in the
 * templates so the same "58:12" or "48.2 MB" appears everywhere.
 */
export function createViewHelpers({ config }) {
  const timeZone = config.timeZone;

  return {
    formatBytes(bytes) {
      if (bytes === null || bytes === undefined) return '—';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = Number(bytes);
      if (!Number.isFinite(value)) return '—';
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      const decimals = unit === 0 ? 0 : value < 10 ? 1 : 1;
      return `${value.toFixed(decimals)} ${units[unit]}`;
    },

    formatDuration(seconds) {
      return formatDuration(seconds) ?? '—';
    },

    formatDate(value) {
      return formatDateTime(value, { timeZone, withTime: false }) || '—';
    },

    formatDateTime(value) {
      return formatDateTime(value, { timeZone }) || '—';
    },

    formatTime(value) {
      return formatTimeOfDay(value, { timeZone }) || '';
    },

    relativeTime(value) {
      return relativeTime(value);
    },

    dateTimeInputValue(value) {
      return toLocalInputValue(value, { timeZone });
    },

    formatInterval(seconds) {
      const n = Number(seconds);
      if (!Number.isFinite(n)) return '—';
      if (n < 120) return `${n} sec`;
      const minutes = Math.round(n / 60);
      if (minutes < 120) return `${minutes} min`;
      const hours = n / 3600;
      return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
    },

    /** Dot colour + label for a show or episode state. */
    badgeFor(health, counts) {
      if (health === 'error') return { cls: 'badge-err', label: 'Scan failed' };
      if (health === 'warn') return { cls: 'badge-warn', label: 'Needs attention' };
      const n = counts?.inFeed ?? 0;
      return { cls: 'badge-ok', label: `${n} ep${n === 1 ? '' : 's'}` };
    },

    episodeBadge(episode) {
      // Scheduled first: it is the only one of these that describes the future, and an
      // episode waiting on its date is far more interesting than the fact that it is
      // otherwise perfectly ordinary.
      if (episode?.scheduled) return { cls: 'badge-info', label: 'Scheduled' };
      if (episode?.status === 'missing') return { cls: 'badge-warn', label: 'Missing' };
      if (episode?.status === 'removed') return { cls: 'badge-mute', label: 'Not in feed' };
      return { cls: 'badge-ok', label: 'Active' };
    },

    /** Deterministic gradient per show, so a coverless show still looks designed. */
    placeholderGradient(seed) {
      const palettes = [
        ['#3E2D4A', '#1E1830'],
        ['#2A6F97', '#16384D'],
        ['#C44536', '#7A2418'],
        ['#4A8C5C', '#22452C'],
        ['#B84A1E', '#5C2410'],
        ['#3B4A6B', '#1B2236'],
      ];
      let hash = 0;
      for (const char of String(seed ?? '')) hash = (hash * 31 + char.charCodeAt(0)) % 997;
      const [from, to] = palettes[hash % palettes.length];
      return `linear-gradient(135deg, ${from}, ${to})`;
    },

    /** Up to three initials for a cover placeholder. */
    initials(title) {
      const words = String(title ?? '')
        .split(/[\s—–-]+/)
        .filter(Boolean);
      if (!words.length) return '??';
      if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
      return words.slice(0, 3).map((w) => w[0].toUpperCase()).join('');
    },

    /**
     * Stacked column geometry for the requests-per-day chart.
     *
     * Heights are worked out here rather than in the template so the markup sets no
     * numbers of its own, and so the page and its htmx fragment cannot drift. The rows
     * arrive already aligned to the buckets — one per bucket, zeros included — because
     * a chart that closes the gap over a quiet Tuesday tells a different story from
     * the data.
     */
    dailySeries(rows, { series = [] } = {}) {
      const columns = (rows ?? []).map((row) => {
        const values = series.map((s) => ({ ...s, value: Number(row[s.key] ?? 0) }));
        const total = values.reduce((sum, v) => sum + v.value, 0);
        return { key: row.key, label: row.label, values, total };
      });

      const max = columns.reduce((highest, col) => Math.max(highest, col.total), 0);
      const empty = max === 0;

      for (const col of columns) {
        col.segments = col.values.map((v) => ({
          ...v,
          // Share of the tallest column, so the stack reaches the top exactly once.
          pct: max === 0 ? 0 : (v.value / max) * 100,
        }));
        col.title = `${col.label} — ${col.values
          .map((v) => `${v.value.toLocaleString('en')} ${v.label.toLowerCase()}`)
          .join(', ')}`;
      }

      // Three ticks: first, middle, last. More than that and they collide at 360px.
      const ticks = empty
        ? []
        : [columns[0], columns[Math.floor((columns.length - 1) / 2)], columns[columns.length - 1]]
            .filter(Boolean)
            .map((col) => ({ label: col.label }));

      const peak = columns.reduce(
        (best, col) => (best === null || col.total > best.total ? col : best),
        null,
      );

      return {
        empty,
        max,
        mid: Math.round(max / 2),
        total: columns.reduce((sum, col) => sum + col.total, 0),
        columns,
        ticks,
        peak,
        series,
      };
    },

    /**
     * Horizontal share bars, longest first.
     *
     * `pct` is bar length as a share of the biggest row, so the largest always fills
     * its track; `share` is the percentage of the whole, which is the number printed.
     * Anything past `limit` is summed rather than drawn as a sliver nobody can compare.
     */
    shareBars(rows, { labelKey = 'client', valueKey = 'n', limit = 8 } = {}) {
      const all = (rows ?? [])
        .map((row) => ({ label: String(row[labelKey] ?? 'Unknown'), value: Number(row[valueKey] ?? 0) }))
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value);

      const total = all.reduce((sum, row) => sum + row.value, 0);
      const kept = all.slice(0, limit);
      const biggest = kept[0]?.value ?? 0;

      return {
        total,
        other: all.slice(limit).reduce((sum, row) => sum + row.value, 0),
        rows: kept.map((row) => ({
          ...row,
          pct: biggest === 0 ? 0 : (row.value / biggest) * 100,
          share: total === 0 ? 0 : Math.round((row.value / total) * 100),
          // "Unknown" and "Other" are the absence of a classification, not an app, and
          // the bar should not read as one.
          vague: row.label === 'Unknown' || row.label === 'Other',
        })),
      };
    },

    /**
     * The "vs the previous period" line under a headline number.
     *
     * Whether up is good is the caller's business: more downloads and more failures
     * are not the same news, so the tone is decided here from `higherIsBetter` and the
     * stylesheet never has to know which card it is on.
     */
    changeLine(change, { higherIsBetter = true, periodLabel = 'the previous period' } = {}) {
      if (!change) return null;
      const { absolute, percent, direction } = change;
      if (direction === 'flat') {
        return { tone: 'flat', glyph: '=', label: `no change vs ${periodLabel}` };
      }
      const tone = (direction === 'up') === higherIsBetter ? 'good' : 'bad';
      const glyph = direction === 'up' ? '▲' : '▼';
      // A rise from zero has no percentage — see changeFrom in services/stats.js.
      const size =
        percent === null
          ? `${absolute > 0 ? '+' : ''}${absolute.toLocaleString('en')}`
          : `${percent > 0 ? '+' : '−'}${Math.abs(Math.round(percent)).toLocaleString('en')}%`;
      return { tone, glyph, label: `${size} vs ${periodLabel}` };
    },

    /**
     * Every ledger decision, in words, in the order the filter offers them.
     *
     * One list rather than a map inlined in the template: the filter and the rows
     * have to agree about what a decision is called, and a second copy is how the
     * chip that says "Didn't match your rules" comes to filter to something that
     * reads as "rejected_declared" in the table underneath.
     */
    ledgerDecisions: LEDGER_DECISIONS,

    /** Badge class and wording for one ledger decision. */
    ledgerBadge(decision) {
      return LEDGER_DECISIONS.find((entry) => entry.value === decision)
        ?? { value: decision, label: decision, cls: 'badge-mute' };
    },

    /** Dot colour + label for one episode-timeline event, mirroring episodeBadge. */
    episodeEventBadge(event) {
      if (event === 'added') return { cls: 'badge-ok', label: 'Added' };
      if (event === 'missing') return { cls: 'badge-warn', label: 'Went missing' };
      if (event === 'expired') return { cls: 'badge-err', label: 'Expired' };
      return { cls: 'badge-mute', label: 'Removed' };
    },

    /** Pseudo-random but stable waveform bars for the episode preview strip. */
    waveformBars(seed, count = 40) {
      const bars = [];
      let value = 0;
      for (const char of String(seed ?? 'selfpod')) value = (value * 31 + char.charCodeAt(0)) % 10007;
      for (let i = 0; i < count; i += 1) {
        value = (value * 1103515245 + 12345) % 2147483648;
        bars.push(28 + (value % 68));
      }
      return bars;
    },

    /** How many queued episodes one check may take, so the UI can promise the truth. */
    perPollLimit: REMOTE_MAX_ITEMS_PER_POLL,

    languages: LANGUAGES,
    categories: APPLE_CATEGORIES,
    categoryNames: CATEGORY_NAMES,
    supportedFormats: SUPPORTED_EXTENSIONS_LABEL,
    timeZone,
  };
}
