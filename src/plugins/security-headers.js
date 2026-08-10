import fp from 'fastify-plugin';

/**
 * Response hardening headers.
 *
 * SelfPod's admin interface is routinely published to the internet through a tunnel,
 * so it should not rely on nobody finding it. None of these headers stop an attacker
 * who has the password; what they do is shrink what a *bug* can be turned into — an
 * injected script, a framed login page, a leaked feed token in a Referer header.
 *
 * The content security policy is strict about scripts on purpose, and it can afford
 * to be: every script in this app is an external file under /assets, so there is no
 * inline JavaScript to whitelist and `script-src 'self'` needs no escape hatch. That
 * single line is what turns a hypothetical HTML-injection bug from "attacker runs
 * code in the admin's session" into "attacker renders some harmless markup".
 *
 * Styles are the one concession: templates use inline `style` attributes for layout,
 * so `style-src` allows inline. Injected CSS is a far smaller problem than injected
 * script, and the alternative is rewriting every template for no security gain that
 * matters.
 */
function securityHeadersPlugin(fastify, { settings, config }, done) {
  /**
   * The browser-side reachability test fetches the public base URL from a page that
   * may be served on a different origin (the LAN address), so that origin has to be
   * allowed in `connect-src` or the check fails as "blocked" every time.
   */
  function connectSources() {
    const sources = new Set(["'self'"]);
    try {
      const baseUrl = settings?.publicBaseUrl?.();
      if (baseUrl) sources.add(new URL(baseUrl).origin);
    } catch {
      /* an unparseable base URL simply adds nothing */
    }
    return [...sources].join(' ');
  }

  function policy() {
    return [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "media-src 'self'",
      "font-src 'self'",
      `connect-src ${connectSources()}`,
      "form-action 'self'",
      // Nothing in SelfPod is meant to be embedded, and the login form least of all.
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
    ].join('; ');
  }

  fastify.addHook('onSend', async (request, reply, payload) => {
    // /health is deliberately readable cross-origin so the dashboard's reachability
    // test works; leaving its CORS header alone matters more than policing a
    // response that contains a version string.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    // The feed token is a credential and it is printed on the show page. `no-referrer`
    // guarantees no navigation away from these pages can carry the URL anywhere.
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'geolocation=(), camera=(), microphone=(), payment=()');

    // Only the HTML surface needs a content policy; applying it to audio and RSS
    // costs bytes on every episode download for no benefit.
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.includes('text/html')) {
      reply.header('content-security-policy', policy());
    }

    // Opt-in only. SelfPod is commonly reached over plain HTTP on a LAN as well as
    // over HTTPS through a tunnel, and an HSTS header sent from the tunnel would
    // apply to that hostname forever — a good thing when deliberate, a lockout when
    // it is a surprise.
    if (config?.hstsEnabled && request.protocol === 'https') {
      reply.header('strict-transport-security', 'max-age=15552000; includeSubDomains');
    }
    return payload;
  });

  done();
}

export default fp(securityHeadersPlugin, { name: 'selfpod-security-headers' });
