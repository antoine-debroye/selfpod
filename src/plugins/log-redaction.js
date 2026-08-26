/**
 * Feed and media URLs embed a show's `feed_token`, which is the credential that
 * authorises access to that show. Fastify logs `req.url` for every request, so
 * without this the tokens would be written in clear text into `docker logs`, the
 * TrueNAS log viewer, and any log shipper — a private feed leaked by its own
 * access log.
 */

const TOKEN_PATHS = [
  // /feeds/{slug}/{token}.xml
  { pattern: /^(\/feeds\/[^/]+\/)([^/]+)(\.xml)(\?.*)?$/, replace: (m, a, _t, c, q) => `${a}***${c}${q ?? ''}` },
  // /media/{slug}/{token}/...
  { pattern: /^(\/media\/[^/]+\/)([^/]+)(\/.*)?$/, replace: (m, a, _t, rest) => `${a}***${rest ?? ''}` },
];

export function redactUrl(url) {
  if (typeof url !== 'string') return url;
  for (const { pattern, replace } of TOKEN_PATHS) {
    if (pattern.test(url)) return url.replace(pattern, replace);
  }
  return url;
}

/**
 * A remote feed's URL, reduced to scheme and host.
 *
 * `redactUrl` above only rewrites SelfPod's *own* inbound request paths, so it does
 * nothing for an outbound address — and a subscription's feed URL is a credential in
 * exactly the same sense a feed token is. Private and premium podcast feeds identify
 * the listener with a token in the path or the query string; logging one in full puts
 * a working subscription link into `docker logs`, the NAS log viewer, and any log
 * shipper, for anyone who can read them.
 *
 * The host is kept because it is the part an operator needs in order to act on a log
 * line at all. It is also what makes a sweep visible: every outbound request leaves a
 * trail naming where it went.
 */
export function redactFeedUrl(url) {
  if (typeof url !== 'string') return url;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/***`;
  } catch {
    // Not parseable, so nothing can be assumed about which parts are sensitive.
    return '***';
  }
}

/** Serializers passed to Fastify's logger options. */
export const loggerSerializers = {
  req(request) {
    return {
      method: request.method,
      url: redactUrl(request.url),
      remoteAddress: request.ip,
    };
  },
  res(reply) {
    return { statusCode: reply.statusCode };
  },
};

export const loggerRedactPaths = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
];
