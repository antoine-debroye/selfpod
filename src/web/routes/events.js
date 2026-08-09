import { EVENTS } from '../../lib/events.js';

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

export default async function eventRoutes(fastify, { events, logger }) {
  fastify.get('/ui/events', { preHandler: fastify.requireAdminPage }, async (request, reply) => {
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

    events.on(EVENTS.SCAN_STARTED, onScanStarted);
    events.on(EVENTS.SCAN_PROGRESS, onScanProgress);
    events.on(EVENTS.SCAN_FINISHED, onScanFinished);

    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(': ping\n\n');
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      events.off(EVENTS.SCAN_STARTED, onScanStarted);
      events.off(EVENTS.SCAN_PROGRESS, onScanProgress);
      events.off(EVENTS.SCAN_FINISHED, onScanFinished);
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
