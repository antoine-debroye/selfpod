import { randomBytes } from 'node:crypto';

import { pingMatches } from '../../lib/instance-proof.js';
import { VERSION } from '../../version.js';

/**
 * Server-side reachability check for the public base URL.
 *
 * The browser test alone cannot tell "your public address is broken" from "your
 * browser refused to make the request", and it used to report both as the former —
 * confidently blaming DNS and the reverse proxy for an address that was working
 * perfectly. Extensions, strict privacy modes and HTTPS-only settings all block a
 * cross-origin request from a plain-HTTP LAN page, and none of that is a server
 * problem.
 *
 * So SelfPod asks its own public address too. That path exercises DNS, the tunnel or
 * reverse proxy, TLS and the origin, with no browser in the way, and it returns the
 * underlying error rather than a guess. Running both checks is what makes the verdict
 * honest: browser fails and server succeeds means the address is fine.
 *
 * A nonce is echoed by /health so a *different* server answering on that hostname —
 * an old container, another install — cannot pass as this one.
 */
const TIMEOUT_MS = 8000;

export default async function reachabilityRoutes(fastify, { settings, logger }) {
  fastify.post('/reachability', { preHandler: fastify.requireAdminApi }, async () => {
    const baseUrl = settings.publicBaseUrl();
    if (!baseUrl) {
      return {
        checked: false,
        reason: 'no_public_base_url',
        message: 'No public base URL is set yet, so there is nothing to test.',
      };
    }

    const ping = randomBytes(12).toString('hex');
    // Only ever the operator's own configured address, and only for an
    // authenticated admin — this is not a general-purpose fetcher.
    const url = `${baseUrl}/health?ping=${ping}`;
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        headers: { 'user-agent': `SelfPod/${VERSION} (self-check)`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
      const elapsedMs = Date.now() - startedAt;

      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      // Not `body.ping === ping`: every SelfPod echoes a nonce, so a reflection
      // proves only that *a* SelfPod answered. The proof has to be computed with
      // this install's own key.
      const sameInstance = pingMatches(settings.sessionSecret(), ping, body?.pong);
      return {
        checked: true,
        reachable: response.ok,
        status: response.status,
        elapsedMs,
        sameInstance,
        version: body?.version ?? null,
        // Spelling out the three outcomes here rather than in the browser keeps the
        // wording in one place, and the server is the only side that knows which
        // one happened.
        message: !response.ok
          ? `That address answered with HTTP ${response.status} instead of SelfPod's health check. Something else is serving that hostname, or your reverse proxy is pointing at the wrong container or port.`
          : sameInstance
            ? 'That address reaches this SelfPod.'
            : 'That address answers, but it is not this SelfPod — the reply did not come back from this container. Check whether an older copy is still running, or whether your proxy sends that hostname somewhere else.',
      };
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      logger?.warn({ err, elapsedMs }, 'the public base URL could not be reached from SelfPod itself');
      return {
        checked: true,
        reachable: false,
        status: null,
        elapsedMs,
        sameInstance: false,
        version: null,
        code: err?.cause?.code ?? err?.code ?? err?.name ?? null,
        message: describeFetchFailure(err, baseUrl, elapsedMs),
      };
    }
  });
}

/**
 * Turns a fetch failure into the sentence an operator can act on. The useful detail
 * is in `err.cause.code`, which names the actual failure — DNS, refused connection,
 * TLS — rather than the generic "fetch failed".
 */
function describeFetchFailure(err, baseUrl, elapsedMs) {
  const code = err?.cause?.code ?? err?.code ?? null;
  const name = err?.name ?? '';
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    /* keep the raw value */
  }

  if (name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') {
    return `Nothing answered at ${host} within ${Math.round(elapsedMs / 1000)} seconds. A tunnel that has just started can be slow on its first request, so try once more; if it keeps timing out, the tunnel or proxy is not forwarding to SelfPod.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `${host} does not resolve from inside the container. Check the DNS record exists, and that the container can reach a DNS server.`;
  }
  if (code === 'ECONNREFUSED') {
    return `${host} refused the connection. Something is resolving but nothing is listening — check your reverse proxy or tunnel is running and pointing at SelfPod's port.`;
  }
  if (code === 'CERT_HAS_EXPIRED' || String(code).startsWith('ERR_TLS') || String(code).includes('CERT')) {
    return `The TLS certificate for ${host} was rejected (${code}). Renew or fix the certificate on your reverse proxy.`;
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    return `The connection to ${host} was reset before a reply arrived. That usually means the proxy accepted the request and then could not reach SelfPod itself — check the address and port it forwards to.`;
  }
  return `SelfPod could not reach ${host}${code ? ` (${code})` : ''}. Check DNS, your reverse proxy or tunnel, and that the public base URL matches the hostname you serve SelfPod on.`;
}
