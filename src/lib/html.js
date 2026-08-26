/**
 * HTML escaping for the few places SelfPod builds markup by hand.
 *
 * This lived as a module-private helper inside `web/routes/events.js`, which was
 * safe only for as long as that file was the sole place building HTML in code.
 * It is not any more: the SSE stream carries progress lines that will name a
 * remote feed, and the htmx SSE extension swaps an event's `data` into the DOM
 * verbatim (see the comment in events.js). A second copy of this function, or a
 * call site that forgets it, is stored XSS in a page that has an admin session.
 *
 * Note that the Content-Security-Policy does not save us here. `script-src 'self'`
 * blocks `<script>` and inline handlers, but an injected `hx-get="/api/settings"
 * hx-trigger="load"` is not script — htmx will simply obey it. Escaping is the
 * control, and it has to be the same one everywhere.
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
