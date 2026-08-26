import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

import {
  REMOTE_HEADERS_TIMEOUT_MS,
  REMOTE_MAX_REDIRECTS,
  REMOTE_MIN_BYTES_PER_SECOND,
  REMOTE_STALL_TIMEOUT_MS,
  REMOTE_TOTAL_TIMEOUT_MS,
  contentTypeEssence,
} from '../constants.js';
import { classifyAddress, normaliseSubscriptionUrl } from './address-rules.js';
import { AppError } from './errors.js';

/**
 * The only place SelfPod fetches a URL somebody supplied (spec §18.4).
 *
 * Before this feature there was exactly one outbound request — the reachability
 * self-check — and its safety rested on three properties, written down at the top of
 * routes/api/reachability.js. One of them cannot survive a subscription feature and is
 * replaced here rather than quietly weakened:
 *
 *   OLD  "It takes no URL parameter."
 *   NEW  Only an authenticated admin, same-origin, can supply one; it is refused
 *        unless http/https on port 80/443 with no credentials and every address it
 *        resolves to is public unicast; the socket connects to the one address that
 *        was validated; and the whole check runs again at every redirect hop and
 *        every scheduled poll, never once at subscribe time.
 *
 * That last clause is the one worth reading twice. Validating a URL when it is saved
 * and trusting the row afterwards is the most natural way to build this and is worth
 * nothing: the name is resolved again on every poll, months later, by a background
 * timer with nobody watching.
 *
 * ## Why node:https rather than fetch
 *
 * `fetch` follows redirects inside undici, beneath the place where a per-hop check
 * could run — and `redirect: 'manual'` on the call does not stop a dispatcher
 * configured with `maxRedirections`. Getting that wrong is invisible and total. Core
 * `http`/`https` has no redirect follower at all, which is exactly the property wanted
 * here, and it is also the only way to pin the connection without adding undici as a
 * direct dependency to a deliberately small tree.
 */

/**
 * Every way a fetch can fail, as a closed set.
 *
 * The wording is deliberately coarse, and `UNREACHABLE` deliberately absorbs
 * ECONNREFUSED, EHOSTUNREACH, ECONNRESET, TLS failures and every non-200 status into
 * one indistinguishable outcome.
 *
 * reachability.js does the opposite — it turns each of those into its own sentence —
 * and that is right *there*, because the target is an address the operator configured
 * and can already see. Here the target can be anything, so telling the caller which
 * one happened is a port scanner: "refused" versus "timed out" versus "TLS error" is
 * precisely the oracle that turns a blocked-address refusal into a working sweep of a
 * subnet. The detail goes to the log, which the operator can read and an attacker
 * cannot.
 */
export const FETCH_FAILURES = Object.freeze({
  BAD_URL: 'bad_url',
  BAD_SCHEME: 'bad_scheme',
  CREDENTIALS_IN_URL: 'credentials_in_url',
  BLOCKED_PORT: 'blocked_port',
  BLOCKED_ADDRESS: 'blocked_address',
  SCHEME_DOWNGRADE: 'scheme_downgrade',
  TOO_MANY_REDIRECTS: 'too_many_redirects',
  SELF_REFERENCE: 'self_reference',
  UNREACHABLE: 'unreachable',
  TIMED_OUT: 'timed_out',
  TOO_LARGE: 'too_large',
  NOT_A_FEED: 'not_a_feed',
});

/** Decisions that must never be retried: retrying is itself the attack. */
export const TERMINAL_FETCH_FAILURES = Object.freeze([
  FETCH_FAILURES.BAD_URL,
  FETCH_FAILURES.BAD_SCHEME,
  FETCH_FAILURES.CREDENTIALS_IN_URL,
  FETCH_FAILURES.BLOCKED_PORT,
  FETCH_FAILURES.BLOCKED_ADDRESS,
  FETCH_FAILURES.SCHEME_DOWNGRADE,
  FETCH_FAILURES.SELF_REFERENCE,
]);

const MESSAGES = Object.freeze({
  bad_url: 'That is not a URL SelfPod can use. It needs to be a full web address, like https://example.com/feed.xml.',
  bad_scheme: 'Feed addresses have to start with http:// or https://.',
  credentials_in_url: 'That address has a username or password in it. Paste the feed URL on its own — a private feed carries its token in the path, not in a login.',
  blocked_port: 'SelfPod only fetches feeds on the standard web ports (80 and 443).',
  blocked_address: 'That address is on a private or local network. SelfPod will only fetch feeds from public addresses, so that it can never be used to reach the rest of your network.',
  scheme_downgrade: 'That address redirected from https to plain http, which SelfPod will not follow.',
  too_many_redirects: 'That address redirected too many times.',
  self_reference: 'That is one of SelfPod\'s own feeds. Subscribing to yourself would download and republish your own episodes on every poll.',
  unreachable: 'SelfPod could not reach that address.',
  timed_out: 'That address took too long to answer.',
  too_large: 'That file is larger than the limit SelfPod is set to accept.',
  not_a_feed: 'That address did not return something SelfPod can use.',
});

/**
 * Whether following this redirect would drop from https to plain http.
 *
 * Exported so it can be tested directly. Driving it end-to-end would need a TLS
 * server whose certificate Node trusts, and the only ways to arrange that in a test
 * are to disable certificate verification or to inject a CA — both of which would put
 * a switch inside the code that verifies certificates, which is precisely the switch
 * that ends up flipped in production. The rule is two comparisons; the wiring that
 * calls it is exercised by the redirect tests above it.
 */
export function isSchemeDowngrade(fromProtocol, toProtocol) {
  return fromProtocol === 'https:' && toProtocol === 'http:';
}

export function fetchFailure(code, detail) {
  const error = new AppError(MESSAGES[code] ?? MESSAGES.unreachable, { code, status: 502 });
  // Kept for the log only. Never returned to a caller, and never rendered.
  if (detail) error.detail = detail;
  return error;
}

/**
 * The pin.
 *
 * `http.request` forwards a `lookup` option down to `net.connect`, so returning a
 * fixed address here is what makes the socket go to the address that was validated
 * rather than to whatever the resolver answers a second time. That closes the
 * rebinding window: an attacker serving a public address on the first query and
 * 192.168.1.1 on the second gets checked once and connected once, to the same answer.
 *
 * Crucially the *hostname* is untouched, so the Host header, TLS SNI and certificate
 * verification all still use the real name. Pinning by rewriting the URL to an IP
 * would break all three; pinning through `lookup` breaks none of them.
 *
 * Both callback shapes are handled because Node picks between them: with
 * `autoSelectFamily` on (the default) it passes `{all: true}` and wants an array, and
 * with it off it wants `(err, address, family)`. Answering with the wrong one throws
 * ERR_INVALID_IP_ADDRESS — which the closed error enum above would then report as
 * "unreachable", i.e. the feature would look like a network outage for ever.
 */
export function pinnedLookup(address, family) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const wantsAll = options && typeof options === 'object' && options.all;
    if (wantsAll) return done(null, [{ address, family }]);
    return done(null, address, family);
  };
}

async function defaultLookup(hostname) {
  // `lookup`, not `resolve4`: it goes through the OS resolver and so honours
  // /etc/hosts and the container's resolv.conf, which is what an actual connect would
  // do. `resolve4` would validate an answer that the connect then ignores.
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export function createGuardedFetch({
  lookup = defaultLookup,
  classify = classifyAddress,
  allowedPrivateHosts = new Set(),
  selfOrigin = () => null,
  signProbe = null,
  // Widens only which ports are acceptable. See normaliseSubscriptionUrl: every
  // other rule stays live, so this can never be the thing that lets a private
  // address through.
  allowedPorts = null,
  logger,
} = {}) {
  /**
   * Resolves a hostname and returns the single address the socket may use.
   *
   * Refuses the whole host if **any** returned address is non-public, rather than
   * filtering down to the public ones. A host that answers with a mix is either broken
   * or deliberately rebinding, and there is no benign case worth serving. Picking
   * `addresses[0]` and checking only that is the most common half-fix.
   */
  async function resolveAndCheck(hostname) {
    // `isIP` and not `classify(hostname).ok`, which is a different question wearing
    // the same shape. Asking the classifier "is this a literal?" happens to work for
    // a public IP and is wrong for everything else — it treats every hostname the
    // classifier approves of as an address, and hands the socket a name where it
    // wants four octets (ERR_INVALID_IP_ADDRESS, reported as "unreachable", i.e. a
    // feature that looks like a permanent network outage).
    const literal = isIP(hostname);
    if (literal !== 0) {
      // Nothing to resolve, but the rules still apply.
      const verdict = classify(hostname);
      if (!verdict.ok && !allowedPrivateHosts.has(hostname.toLowerCase())) {
        throw fetchFailure(FETCH_FAILURES.BLOCKED_ADDRESS, `${hostname} is ${verdict.category}`);
      }
      return { address: hostname, family: literal };
    }

    let addresses;
    try {
      addresses = await lookup(hostname);
    } catch (error) {
      throw fetchFailure(FETCH_FAILURES.UNREACHABLE, `dns ${error?.code ?? error?.message}`);
    }
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (!list.length) throw fetchFailure(FETCH_FAILURES.UNREACHABLE, 'dns returned nothing');

    for (const entry of list) {
      const address = String(entry.address ?? entry);
      if (allowedPrivateHosts.has(address.toLowerCase())) continue;
      const verdict = classify(address);
      if (!verdict.ok) {
        throw fetchFailure(
          FETCH_FAILURES.BLOCKED_ADDRESS,
          `${hostname} resolves to ${address} (${verdict.category})`,
        );
      }
    }

    const first = list[0];
    return { address: String(first.address ?? first), family: Number(first.family) || 4 };
  }

  /**
   * One request, to one pinned address, with no redirect following.
   *
   * Four timers, because they catch four different failures. A single total budget
   * kills a legitimate two-hour download on a slow line. A single idle timer lets an
   * attacker hold the socket open for ever at one byte every 59 seconds — and since
   * outbound work is serialised, that one socket would block every other subscription.
   * The throughput floor is what actually closes that last one.
   */
  function requestOnce(url, pinned, options) {
    const {
      accept,
      requestHeaders,
      maxBytes,
      deadline,
      headersTimeoutMs,
      stallTimeoutMs,
      minBytesPerSecond,
      allowedTypes,
      sink,
      probeNonce,
      userAgent,
    } = options;

    return new Promise((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      let settled = false;
      let headersTimer = null;
      let stallTimer = null;
      let request = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(headersTimer);
        clearInterval(stallTimer);
        fn(value);
      };

      const abort = (failure) => {
        try {
          request?.destroy();
        } catch {
          // Already gone; the rejection below is what matters.
        }
        finish(reject, failure);
      };

      const headers = {
        // Names SelfPod, so a publisher looking at their logs can see what this is
        // and block it if they would rather not be mirrored.
        'user-agent': userAgent,
        accept,
        // Node's client does not decompress, so whatever is asked for here is what
        // must be handled. Asking for identity makes the wire cap the memory cap and
        // removes the compressed-bomb gap entirely.
        'accept-encoding': 'identity',
        // No cookies, no Authorization, no inbound headers forwarded, no Referer.
        // A private feed's token lives in its path, and a redirect must not carry it
        // anywhere as a header.
        ...requestHeaders,
      };
      if (probeNonce) headers['x-selfpod-probe'] = probeNonce;

      try {
        request = transport.request(url, {
          method: 'GET',
          // No connection pooling. A pooled socket could be reused by a later request
          // under a different pin, which would silently undo the whole guarantee.
          agent: false,
          lookup: pinnedLookup(pinned.address, pinned.family),
          // One address, no Happy Eyeballs race — otherwise "the exact address that
          // was validated" has no single referent and cannot be asserted.
          autoSelectFamily: false,
          headers,
        });
      } catch (error) {
        return finish(reject, fetchFailure(FETCH_FAILURES.UNREACHABLE, error?.message));
      }

      headersTimer = setTimeout(
        () => abort(fetchFailure(FETCH_FAILURES.TIMED_OUT, 'no headers')),
        headersTimeoutMs,
      );

      request.on('error', (error) =>
        finish(reject, fetchFailure(FETCH_FAILURES.UNREACHABLE, error?.code ?? error?.message)),
      );

      request.on('response', (response) => {
        clearTimeout(headersTimer);

        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400 && location) {
          // The body of a redirect is never counted, sniffed or surfaced.
          response.destroy();
          return finish(resolve, { redirectTo: String(location), status });
        }

        // A reply that proves it came from this instance means the operator has
        // pointed SelfPod at its own feed — which would download and republish its
        // own episodes on every poll. Behind a tunnel the address is public, so no
        // address rule can catch this.
        if (probeNonce && response.headers['x-selfpod-instance']) {
          const proof = String(response.headers['x-selfpod-instance']);
          if (signProbe && signProbe(probeNonce, proof)) {
            response.destroy();
            return finish(reject, fetchFailure(FETCH_FAILURES.SELF_REFERENCE));
          }
        }

        if (status === 304) {
          response.destroy();
          return finish(resolve, {
            status,
            notModified: true,
            etag: response.headers.etag ?? null,
            lastModified: response.headers['last-modified'] ?? null,
            bytes: 0,
          });
        }

        if (status !== 200) {
          response.destroy();
          return finish(reject, fetchFailure(FETCH_FAILURES.UNREACHABLE, `http ${status}`));
        }

        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          response.destroy();
          return finish(
            reject,
            fetchFailure(FETCH_FAILURES.NOT_A_FEED, `unrequested encoding ${encoding}`),
          );
        }

        const contentType = contentTypeEssence(response.headers['content-type']);
        if (allowedTypes && (!contentType || !allowedTypes.has(contentType))) {
          response.destroy();
          return finish(
            reject,
            fetchFailure(FETCH_FAILURES.NOT_A_FEED, `content-type ${contentType}`),
          );
        }

        // Checked first because it is cheap, but it is advisory: chunked replies have
        // no length and a hostile one can simply lie. The counter below is the control.
        const declared = Number.parseInt(response.headers['content-length'] ?? '', 10);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.destroy();
          return abort(fetchFailure(FETCH_FAILURES.TOO_LARGE, `declared ${declared}`));
        }

        const chunks = sink ? null : [];
        let received = 0;
        let lastChunkAt = Date.now();
        const startedAt = Date.now();

        stallTimer = setInterval(() => {
          const now = Date.now();
          if (now > deadline) {
            return abort(fetchFailure(FETCH_FAILURES.TIMED_OUT, 'total budget'));
          }
          if (now - lastChunkAt > stallTimeoutMs) {
            return abort(fetchFailure(FETCH_FAILURES.TIMED_OUT, 'stalled'));
          }
          // A rolling stall timer alone is satisfied by one byte every 59 seconds.
          // After the first minute, require the transfer to be actually moving.
          const elapsed = (now - startedAt) / 1000;
          if (elapsed > 60 && received / elapsed < minBytesPerSecond) {
            return abort(
              fetchFailure(FETCH_FAILURES.TIMED_OUT, `throughput ${Math.round(received / elapsed)}B/s`),
            );
          }
        }, 5000);

        response.on('data', (chunk) => {
          received += chunk.length;
          lastChunkAt = Date.now();
          if (received > maxBytes) {
            response.destroy();
            return abort(fetchFailure(FETCH_FAILURES.TOO_LARGE, `streamed past ${maxBytes}`));
          }
          if (chunks) chunks.push(chunk);
          else if (!sink.write(chunk)) response.pause();
          return undefined;
        });

        if (sink) sink.on('drain', () => response.resume());

        response.on('error', (error) =>
          abort(fetchFailure(FETCH_FAILURES.UNREACHABLE, error?.code ?? error?.message)),
        );

        response.on('end', () =>
          finish(resolve, {
            status,
            bytes: received,
            body: chunks ? Buffer.concat(chunks) : null,
            contentType,
            etag: response.headers.etag ?? null,
            lastModified: response.headers['last-modified'] ?? null,
          }),
        );
      });

      request.end();
    });
  }

  /**
   * Fetches a URL, re-validating at every hop.
   *
   * @returns {Promise<{status, bytes, body, contentType, finalHostname, etag, lastModified, notModified}>}
   */
  return async function guardedFetch(rawUrl, options = {}) {
    const {
      accept = '*/*',
      allowedTypes = null,
      maxBytes = 5 * 1024 * 1024,
      totalTimeoutMs = REMOTE_TOTAL_TIMEOUT_MS,
      headersTimeoutMs = REMOTE_HEADERS_TIMEOUT_MS,
      stallTimeoutMs = REMOTE_STALL_TIMEOUT_MS,
      minBytesPerSecond = REMOTE_MIN_BYTES_PER_SECOND,
      maxRedirects = REMOTE_MAX_REDIRECTS,
      requestHeaders = {},
      sink = null,
      detectSelf = true,
      userAgent = 'SelfPod (+feed subscription)',
    } = options;

    const deadline = Date.now() + totalTimeoutMs;
    const probeNonce = detectSelf && signProbe ? randomBytes(12).toString('hex') : null;

    let target = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (Date.now() > deadline) throw fetchFailure(FETCH_FAILURES.TIMED_OUT, 'budget before hop');

      const normalised = normaliseSubscriptionUrl(target, {
        allowedPorts,
        allowedHosts: allowedPrivateHosts,
      });
      if (normalised.reason) throw fetchFailure(normalised.reason);
      const { url, hostname } = normalised;

      // Cheap and decisive: an operator's first instinct is to paste their own feed
      // URL to see what happens, and the signed probe below only catches it once the
      // request has already gone out.
      const own = selfOrigin();
      if (own) {
        try {
          if (new URL(own).origin === url.origin) throw fetchFailure(FETCH_FAILURES.SELF_REFERENCE);
        } catch (error) {
          if (error instanceof AppError) throw error;
        }
      }

      const pinned = await resolveAndCheck(hostname);

      logger?.debug({ host: url.host, address: pinned.address, hop }, 'outbound fetch');

      const result = await requestOnce(url, pinned, {
        accept,
        requestHeaders,
        maxBytes,
        deadline,
        headersTimeoutMs,
        stallTimeoutMs,
        minBytesPerSecond,
        allowedTypes,
        sink,
        probeNonce,
        userAgent,
      });

      if (!result.redirectTo) return { ...result, finalHostname: hostname };

      let next;
      try {
        // A relative Location is legal and common.
        next = new URL(result.redirectTo, url);
      } catch {
        throw fetchFailure(FETCH_FAILURES.BAD_URL, 'unreadable Location');
      }
      if (isSchemeDowngrade(url.protocol, next.protocol)) {
        throw fetchFailure(FETCH_FAILURES.SCHEME_DOWNGRADE);
      }
      // Round the whole loop again: normalise, resolve, classify, re-pin. Never
      // "same host, so skip" — the point is that nothing is trusted twice.
      target = next.href;
    }

    throw fetchFailure(FETCH_FAILURES.TOO_MANY_REDIRECTS);
  };
}
