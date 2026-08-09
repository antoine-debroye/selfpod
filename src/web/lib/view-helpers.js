import { formatDateTime, formatDuration, formatTimeOfDay, relativeTime, toLocalInputValue } from '../../lib/dates.js';
import { LANGUAGES, SUPPORTED_EXTENSIONS_LABEL } from '../../constants.js';
import { APPLE_CATEGORIES, CATEGORY_NAMES } from './apple-categories.js';

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

    episodeBadge(status) {
      if (status === 'missing') return { cls: 'badge-warn', label: 'Missing' };
      if (status === 'removed') return { cls: 'badge-mute', label: 'Not in feed' };
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

    languages: LANGUAGES,
    categories: APPLE_CATEGORIES,
    categoryNames: CATEGORY_NAMES,
    supportedFormats: SUPPORTED_EXTENSIONS_LABEL,
    timeZone,
  };
}
