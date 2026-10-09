import { EVENTS } from '../../lib/events.js';
import { escapeHtml } from '../../lib/html.js';
import { workStripHtml } from '../../services/adverts-view.js';

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

export default async function eventRoutes(fastify, { events, logger, shows, adPipeline }) {
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

    /*
     * The strip is the same partial the rescan button swaps in, rendered here rather
     * than assembled by hand. The partial carries the slow poll of /ui/scan-status
     * that clears the strip when the stream dies mid-scan; the hand-built copy used
     * to leave that out, so the first SSE message replaced a strip that could clear
     * itself with one that could not. Rendering is asynchronous, so each strip goes
     * out through one queue and a later event can never overtake an earlier one.
     */
    let queue = Promise.resolve();
    const sendStrip = (event, scope, label) => {
      queue = queue
        .then(() => renderStrip(fastify, scope, label))
        .then((html) => send(event, html))
        .catch((err) => logger?.debug({ err }, 'could not render the scan-progress strip for the live stream'));
    };
    const sendAfterStrips = (event, data) => {
      queue = queue.then(() => send(event, data)).catch(() => {});
    };

    const onScanStarted = (payload) => {
      const label =
        payload.scope === 'all'
          ? 'Scanning your whole library…'
          : `Scanning ${payload.slug ?? 'show'}…`;
      const scope = payload.scope === 'all' ? 'all' : payload.showId;
      sendStrip(`scan-progress-${scope}`, scope, label);
    };

    const onScanProgress = (payload) => {
      if (payload.scope !== 'all') return;
      sendStrip('scan-progress-all', 'all', `Scanning ${payload.title ?? payload.slug} (${payload.index} of ${payload.total})…`);
    };

    const onScanFinished = (payload) => {
      // Queued behind any strip still rendering, or the clear would arrive before
      // what it clears.
      for (const [event, data] of scanFinishedEvents(payload)) sendAfterStrips(event, data);
    };

    /*
     * What a show still owes, as the inside of the Adverts page's work strip — the same
     * HTML the page renders, from the same function. Sent when the pipeline says the
     * work changed, and after each episode heard, which is the slow part.
     */
    const sendWork = (payload) => {
      const show = payload?.showId ? shows?.get?.(payload.showId) : null;
      if (!show) return;
      let owed = null;
      try {
        owed = adPipeline?.workOwed?.(show.id) ?? null;
      } catch (err) {
        logger?.debug({ err }, 'could not work out what a show owes for the live strip');
      }
      send(`cuts-work-${show.id}`, workStripHtml(show, owed));
    };
    /* A trigger only: the panel, the episode table, the card and the episode page each
       fetch themselves again when it arrives. */
    const onAdChanged = (payload) => {
      if (payload?.showId) send(`ad-changed-${payload.showId}`, 'done');
    };
    const onTranscriptReady = (payload) => {
      send(`transcript-${payload.episodeId}`, 'ready');
    };

    events.on(EVENTS.SCAN_STARTED, onScanStarted);
    events.on(EVENTS.SCAN_PROGRESS, onScanProgress);
    events.on(EVENTS.SCAN_FINISHED, onScanFinished);
    events.on(EVENTS.TRANSCRIBE_PROGRESS, sendWork);
    events.on(EVENTS.AD_WORK, sendWork);
    events.on(EVENTS.AD_CHANGED, onAdChanged);
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
      events.off(EVENTS.TRANSCRIBE_PROGRESS, sendWork);
      events.off(EVENTS.AD_WORK, sendWork);
      events.off(EVENTS.AD_CHANGED, onAdChanged);
      events.off(EVENTS.TRANSCRIPT_READY, onTranscriptReady);
      logger?.debug('SSE client disconnected');
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    // Returning the raw reply tells Fastify this response is managed by hand.
    return reply;
  });
}

/**
 * What the stream says when a scan finishes, as [event, data] pairs. The events are
 * triggers (hx-trigger="sse:scan-finished-…"), so only the names matter.
 *
 * Three names, because three things listen. `scan-finished-<show>` is the show's
 * own page: the readiness card re-reads itself whenever its show was scanned, as
 * part of a sweep or alone. `show-scanned-<show>` is the dashboard card, and is only
 * sent for a scan of that show on its own: during a library-wide sweep every show
 * finishes in turn, and a card that re-read itself at each would be N fetches for
 * one press of Rescan all. The grid re-reads itself once instead, on
 * `scan-finished-all`.
 */
export function scanFinishedEvents(payload) {
  const scope = payload.scope === 'all' ? 'all' : payload.showId;
  // An empty swap clears the strip once the scan is done.
  const events = [[`scan-progress-${scope}`, '']];
  if (payload.showId) {
    events.push([`scan-finished-${payload.showId}`, 'done']);
    if (!payload.parentScanId) events.push([`show-scanned-${payload.showId}`, 'done']);
  }
  if (payload.scope === 'all') events.push(['scan-finished-all', 'done']);
  return events;
}

/**
 * The scan-progress strip for the stream: partials/scan-progress.eta, the one the
 * rescan buttons use, so the two cannot drift apart. The hand-written copy below is
 * the fallback if rendering fails, and carries the same polling backstop.
 */
export async function renderStrip(fastify, scope, label) {
  try {
    return await fastify.view('partials/scan-progress.eta', { scope, label });
  } catch {
    return progressHtml(scope, label);
  }
}

function progressHtml(scope, label) {
  const safeScope = escapeHtml(String(scope));
  return `<div class="scan-progress" id="scan-progress" role="status" aria-live="polite" sse-swap="scan-progress-${safeScope}" hx-get="/ui/scan-status?scope=${encodeURIComponent(
    String(scope),
  )}" hx-trigger="load delay:2500ms" hx-swap="outerHTML"><span class="scan-progress__dot" aria-hidden="true"></span><span class="scan-progress__status">${escapeHtml(
    label,
  )}</span><span class="scan-progress__bar" aria-hidden="true"><i></i></span></div>`;
}
