import { EventEmitter } from 'node:events';

/**
 * In-process event bus.
 *
 * The important consumer is the feed cache: a scan that actually changed
 * something emits `show:changed`, which drops that show's cached XML
 * immediately. Relying on the cache TTL alone is what made the hand-rolled
 * prototype feel stale after every edit (spec §8.1).
 */
export const EVENTS = Object.freeze({
  /** A show's feed content changed. Payload: { showId, slug? } */
  SHOW_CHANGED: 'show:changed',
  /** An episode's words are on disk; the page showing them can refresh. */
  TRANSCRIPT_READY: 'transcript:ready',
  /** Progress through a show's listening, for the strip on the Adverts page. */
  TRANSCRIBE_PROGRESS: 'transcribe:progress',
  TRANSCRIBE_FINISHED: 'transcribe:finished',
  /** The set of shows changed (folder added/removed). Payload: {} */
  SHOWS_CHANGED: 'shows:changed',
  /** Instance settings changed. Payload: { keys: string[] } */
  SETTINGS_CHANGED: 'settings:changed',
  /** Scan lifecycle, relayed to the browser over SSE. */
  SCAN_STARTED: 'scan:started',
  SCAN_PROGRESS: 'scan:progress',
  SCAN_FINISHED: 'scan:finished',
  /** Degraded-state changes (permissions, watcher mode). Payload: { key, state } */
  HEALTH_CHANGED: 'health:changed',
});

export function createEventBus({ logger } = {}) {
  const bus = new EventEmitter();
  // Many independent subscribers (feed cache, SSE clients, watcher heuristics)
  // legitimately listen to the same event; the default limit of 10 would warn.
  bus.setMaxListeners(100);

  if (logger) {
    bus.on('error', (err) => logger.error({ err }, 'event bus error'));
  }

  return bus;
}
