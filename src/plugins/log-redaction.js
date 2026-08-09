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
