import { EVENTS } from '../../lib/events.js';
import { escapeHtml } from '../../lib/html.js';

/**
 * Server-sent events for live scan progress (spec §6.2 point 3).
 *
 * Two things this has to survive: a reverse proxy that severs idle connections
 * (Cloudflare cuts them at around 100 seconds), and one that buffers them. So the
 * stream sends a heartbeat comment every 25 seconds, and everything it drives in
 * the UI also resolves without it — a stalled stream slows the feedback down, it
 * never leaves the page showing something untrue.
 */
const HEARTBEAT_MS = 25_000;

/**
 * There is one admin, so a handful of open tabs is the realistic maximum. The cap
 * exists so a client reconnecting in a loop cannot pile up listeners and timers;
 * refusing the stream only costs live progress updates, which everything degrades
 * without anyway.
 */
const MAX_CLIENTS = 24;
let clients = 0;

export default async function eventRoutes(fastify, { events, logger }) {
  fastify.get('/ui/events', { preHandler: fastify.requireAdminPage }, async (request, reply) => {
    if (clients >= MAX_CLIENTS) {
      logger?.warn({ clients }, 'refused an SSE connection: too many already open');
      return reply.status(503).send({
        error: {
          message: 'Too many live update streams are already open. Close some SelfPod tabs and reload.',
          code: 'too_many_streams',
        },
      });
    }
    clients += 1;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Discourages proxy-level response buffering, which would otherwise hold
      // events until the stream closed.
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');

    /**
     * The htmx SSE extension swaps an event's `data` in verbatim, so for the
     * progress strip the data must be the HTML itself rather than a JSON envelope.
     * SSE frames are newline-delimited, so the payload is collapsed to one line.
     */
    const send = (event, data) => {
      if (reply.raw.writableEnded) return;
      const payload = String(data).replace(/\r?\n/g, ' ');
      reply.raw.write(`event: ${event}\ndata: ${payload}\n\n`);
    };

    const onScanStarted = (payload) => {
      const label =
        payload.scope === 'all'
          ? 'Scanning your whole library…'
          : `Scanning ${payload.slug ?? 'show'}…`;
      send(
        payload.scope === 'all' ? 'scan-progress-all' : `scan-progress-${payload.showId}`,
        progressHtml(payload.scope === 'all' ? 'all' : payload.showId, label),
      );
    };

    const onScanProgress = (payload) => {
      if (payload.scope !== 'all') return;
      send(
        'scan-progress-all',
        progressHtml('all', `Scanning ${payload.title ?? payload.slug} (${payload.index} of ${payload.total})…`),
      );
    };

    const onScanFinished = (payload) => {
      const scope = payload.scope === 'all' ? 'all' : payload.showId;
      // An empty swap clears the strip once the scan is done.
      send(`scan-progress-${scope}`, '');
      // These are used as triggers (hx-trigger="sse:scan-finished-…"), where the
      // payload is irrelevant — only the event name matters.
      if (payload.showId) send(`scan-finished-${payload.showId}`, 'done');
      if (payload.scope === 'all') send('scan-finished-all', 'done');
    };

    /* Listening for words, the same shape: a strip while it runs, a trigger when done. */
    const onTranscribeProgress = (payload) => {
      const label = transcribeLabel(payload);
      send(`transcribe-progress-${payload.showId}`, transcribeHtml(payload.showId, payload.slug, label));
    };
    const onTranscribeFinished = (payload) => {
      send(`transcribe-progress-${payload.showId}`, '');
      send(`transcribe-finished-${payload.showId}`, 'done');
    };
    const onTranscriptReady = (payload) => {
      send(`transcript-${payload.episodeId}`, 'ready');
    };

    events.on(EVENTS.SCAN_STARTED, onScanStarted);
    events.on(EVENTS.SCAN_PROGRESS, onScanProgress);
    events.on(EVENTS.SCAN_FINISHED, onScanFinished);
    events.on(EVENTS.TRANSCRIBE_PROGRESS, onTranscribeProgress);
    events.on(EVENTS.TRANSCRIBE_FINISHED, onTranscribeFinished);
    events.on(EVENTS.TRANSCRIPT_READY, onTranscriptReady);

    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(': ping\n\n');
    }, HEARTBEAT_MS);

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clients -= 1;
      clearInterval(heartbeat);
      events.off(EVENTS.SCAN_STARTED, onScanStarted);
      events.off(EVENTS.SCAN_PROGRESS, onScanProgress);
      events.off(EVENTS.SCAN_FINISHED, onScanFinished);
      events.off(EVENTS.TRANSCRIBE_PROGRESS, onTranscribeProgress);
      events.off(EVENTS.TRANSCRIBE_FINISHED, onTranscribeFinished);
      events.off(EVENTS.TRANSCRIPT_READY, onTranscriptReady);
      logger?.debug('SSE client disconnected');
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    // Returning the raw reply tells Fastify this response is managed by hand.
    return reply;
  });
}

function progressHtml(scope, label) {
  return `<div class="scan-progress" id="scan-progress" role="status" aria-live="polite" sse-swap="scan-progress-${escapeHtml(
    String(scope),
  )}" hx-swap="outerHTML"><span class="scan-progress__dot" aria-hidden="true"></span><span class="scan-progress__status">${escapeHtml(
    label,
  )}</span><span class="scan-progress__bar" aria-hidden="true"><i></i></span></div>`;
}

/** "Listened to 12 of 50, newest first — about 40 s each so far, roughly 25 minutes to go." */
export function transcribeLabel({ done = 0, total = 0, rate = null, title = null }) {
  const parts = [`Listened to ${done} of ${total}, newest first`];
  if (rate && done > 0) {
    // `rate` is audio seconds per second of work; an episode's windows are about nine
    // minutes, so the cost of one is estimated from that.
    const secondsEach = Math.round(540 / rate);
    const remaining = Math.max(0, total - done) * secondsEach;
    parts.push(`about ${secondsEach} s each so far`);
    if (remaining > 90) parts.push(`roughly ${Math.round(remaining / 60)} minutes to go`);
  } else if (title) {
    parts.push(`hearing “${title}”`);
  }
  return `${parts.join(' — ')}…`;
}

function transcribeHtml(showId, slug, label) {
  return `<div class="scan-progress transcribe-progress" id="transcribe-progress" role="status" aria-live="polite" sse-swap="transcribe-progress-${escapeHtml(
    String(showId),
  )}" hx-get="/ui/shows/${encodeURIComponent(String(slug ?? ''))}/transcribe-status" hx-trigger="load delay:5s" hx-swap="outerHTML"><span class="scan-progress__dot" aria-hidden="true"></span><span class="scan-progress__status">${escapeHtml(
    label,
  )}</span><span class="scan-progress__bar" aria-hidden="true"><i></i></span></div>`;
}
