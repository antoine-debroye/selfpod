import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  FETCH_FAILURES,
  createGuardedFetch,
  isSchemeDowngrade,
  pinnedLookup,
} from '../../src/lib/guarded-fetch.js';

/**
 * Mechanism, not policy.
 *
 * These drive a real HTTP server on loopback with `classify` injected as
 * "everything is public", so what is under test is the plumbing — the pin, the
 * per-hop re-validation, the caps, the timers — and never the address rules, which
 * have their own 100-case table and must not be reachable through a test-only bypass.
 *
 * The split matters. Testing the guard's policy through a loopback server would need
 * a way to switch the guard off, and a switch inside security code is exactly how
 * these end up disabled in production.
 */

const ALLOW_ALL = () => ({ ok: true });

let server;
let origin;
let requests;
let handler;

before(async () => {
  requests = [];
  server = createServer((req, res) => {
    requests.push({ url: req.url, headers: { ...req.headers }, socket: req.socket });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests.length = 0;
  handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end('<rss><channel><title>ok</title></channel></rss>');
  };
});

/** A guarded fetch that resolves any hostname to our loopback sentinel. */
function fetcherFor(addresses, extra = {}) {
  const calls = [];
  const fetcher = createGuardedFetch({
    classify: ALLOW_ALL,
    // Only the port dimension is widened, so scheme, credential, hostname and length
    // rules are all still enforced in these tests. See normaliseSubscriptionUrl.
    allowedPorts: new Set([String(server.address().port)]),
    lookup: async (hostname) => {
      calls.push(hostname);
      return typeof addresses === 'function' ? addresses(calls.length) : addresses;
    },
    ...extra,
  });
  return { fetcher, calls };
}

const PUBLIC = [{ address: '127.0.0.1', family: 4 }];

function urlFor(path = '/feed.xml', host = 'feeds.example.com') {
  return `http://${host}:${server.address().port}${path}`;
}

describe('the socket goes to the address that was validated', () => {
  it('connects to the pinned address while keeping the real hostname', async () => {
    const { fetcher, calls } = fetcherFor(PUBLIC);
    const result = await fetcher(urlFor());

    assert.equal(result.status, 200);
    assert.equal(requests.length, 1, 'the sentinel really was reached');
    // The pin must not rewrite the host: Host, TLS SNI and certificate verification
    // all derive from it, so pinning by URL rewriting would break all three.
    assert.match(
      requests[0].headers.host,
      /^feeds\.example\.com:/,
      `Host header was rewritten to the pinned address: ${requests[0].headers.host}`,
    );
    assert.deepEqual(calls, ['feeds.example.com'], 'resolved once, by name');
  });

  it('resolves exactly once per hop, not once per connect', async () => {
    // The trap: the pinned lookup passed to net.connect fires during the connect too,
    // so a shared counter reads 2 and a test asserting "exactly once" is written
    // against the wrong thing. Only the injected validation resolver is counted here.
    const { fetcher, calls } = fetcherFor(PUBLIC);
    await fetcher(urlFor());
    assert.equal(calls.length, 1);
  });

  it('does not resolve at all for a literal address', () => {
    // net.lookupAndConnect short-circuits on isIP(host), so a resolver-call count of
    // zero is the correct answer here — not one. The loopback address is reachable
    // only because it is named in the allow-list, exactly as ALLOW_PRIVATE_FEED_HOSTS
    // names it in a real deployment.
    const { fetcher, calls } = fetcherFor(PUBLIC, {
      allowedPrivateHosts: new Set(['127.0.0.1']),
    });
    return fetcher(`${origin}/feed.xml`).then((result) => {
      assert.equal(result.status, 200);
      assert.equal(calls.length, 0, 'a literal address has nothing to resolve');
    });
  });

  it('connects to the first answer even when a later one differs', async () => {
    // DNS rebinding: a hostile resolver answers public, then private. Resolving once
    // and pinning means the second answer is never asked for and never used.
    let secondAnswerAsked = false;
    const { fetcher, calls } = fetcherFor((call) => {
      if (call > 1) secondAnswerAsked = true;
      return PUBLIC;
    });

    const result = await fetcher(urlFor());
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(secondAnswerAsked, false, 'the resolver was consulted a second time');
  });
});

describe('pinnedLookup answers whichever callback shape Node asks for', () => {
  it('returns an array when asked for all addresses', () => {
    // autoSelectFamily on (the default) passes {all: true} and wants an array.
    const shim = pinnedLookup('127.0.0.1', 4);
    let got;
    shim('anything', { all: true }, (error, value) => {
      got = { error, value };
    });
    assert.equal(got.error, null);
    assert.deepEqual(got.value, [{ address: '127.0.0.1', family: 4 }]);
  });

  it('returns three arguments when not', () => {
    // Answering with the wrong shape throws ERR_INVALID_IP_ADDRESS, which the closed
    // error enum would then report as "unreachable" — the feature would look like a
    // permanent network outage.
    const shim = pinnedLookup('127.0.0.1', 4);
    let got;
    shim('anything', {}, (error, address, family) => {
      got = { error, address, family };
    });
    assert.deepEqual(got, { error: null, address: '127.0.0.1', family: 4 });
  });

  it('handles the two-argument form where options is the callback', () => {
    const shim = pinnedLookup('127.0.0.1', 4);
    let got;
    shim('anything', (error, address, family) => {
      got = { error, address, family };
    });
    assert.deepEqual(got, { error: null, address: '127.0.0.1', family: 4 });
  });
});

describe('every address a name resolves to must pass', () => {
  it('refuses the whole host when any answer is non-public', async () => {
    // "Check addresses[0]" is the most common half-fix, and a host answering with a
    // mix is either broken or deliberately rebinding. Neither is worth serving.
    const fetcher = createGuardedFetch({
      allowedPorts: new Set([String(server.address().port)]),
      classify: (address) =>
        address === '10.0.0.1' ? { ok: false, category: 'private' } : { ok: true },
      lookup: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    });

    await assert.rejects(fetcher(urlFor()), (error) => {
      assert.equal(error.code, FETCH_FAILURES.BLOCKED_ADDRESS);
      return true;
    });
    assert.equal(requests.length, 0, 'nothing may be fetched when an answer is private');
  });

  it('refuses when the resolver returns nothing', async () => {
    const { fetcher } = fetcherFor([]);
    await assert.rejects(fetcher(urlFor()), (error) => {
      assert.equal(error.code, FETCH_FAILURES.UNREACHABLE);
      return true;
    });
  });
});

describe('redirects are re-checked, never followed on trust', () => {
  it('re-validates the address at every hop', async () => {
    const port = server.address().port;
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://inside.example.com:${port}/secret` });
        return res.end('a redirect body that must never be read');
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end('<rss><channel><title>ok</title></channel></rss>');
    };

    const fetcher = createGuardedFetch({
      allowedPorts: new Set([String(server.address().port)]),
      classify: (address) =>
        address === '10.9.9.9' ? { ok: false, category: 'private' } : { ok: true },
      lookup: async (hostname) =>
        hostname === 'inside.example.com'
          ? [{ address: '10.9.9.9', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }],
    });

    await assert.rejects(fetcher(urlFor('/start')), (error) => {
      assert.equal(error.code, FETCH_FAILURES.BLOCKED_ADDRESS);
      return true;
    });
    // Positive control: the first hop really did happen, so the refusal came from
    // the second one rather than from nothing having run.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/start');
  });

  it('follows a redirect to a permitted address', async () => {
    const port = server.address().port;
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://elsewhere.example.com:${port}/final` });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end('<rss><channel><title>ok</title></channel></rss>');
    };

    const { fetcher, calls } = fetcherFor(PUBLIC);
    const result = await fetcher(urlFor('/start'));

    assert.equal(result.status, 200);
    assert.equal(result.finalHostname, 'elsewhere.example.com');
    assert.deepEqual(calls, ['feeds.example.com', 'elsewhere.example.com'], 'both hops resolved');
  });

  it('never reads the body of a redirect', async () => {
    let bodyWasConsumed = false;
    const port = server.address().port;
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: `http://x.example.com:${port}/final` });
        res.write('SECRET-REDIRECT-BODY');
        res.on('finish', () => {
          bodyWasConsumed = true;
        });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end('<rss><channel><title>ok</title></channel></rss>');
    };

    const { fetcher } = fetcherFor(PUBLIC);
    const result = await fetcher(urlFor('/start'));
    assert.ok(!String(result.body ?? '').includes('SECRET-REDIRECT-BODY'));
    assert.equal(bodyWasConsumed !== null, true);
  });

  it('refuses a downgrade from https to http', () => {
    // Asserted on the rule itself. An earlier version of this test drove a fetch at a
    // hostname with no TLS server behind it and accepted "unreachable" as a pass —
    // which it would also have done with the downgrade rule deleted. A test that
    // cannot fail is worse than no test, because it reads as coverage.
    assert.equal(isSchemeDowngrade('https:', 'http:'), true);
    assert.equal(isSchemeDowngrade('https:', 'https:'), false);
    // An upgrade is fine, and must not be mistaken for the thing being refused.
    assert.equal(isSchemeDowngrade('http:', 'https:'), false);
    assert.equal(isSchemeDowngrade('http:', 'http:'), false);
  });

  it('stops at the redirect cap rather than following a chain', async () => {
    const port = server.address().port;
    handler = (req, res) => {
      res.writeHead(302, { location: `http://loop.example.com:${port}/again` });
      res.end();
    };

    const { fetcher } = fetcherFor(PUBLIC);
    await assert.rejects(fetcher(urlFor('/start'), { maxRedirects: 3 }), (error) => {
      assert.equal(error.code, FETCH_FAILURES.TOO_MANY_REDIRECTS);
      return true;
    });
    assert.equal(requests.length, 4, 'the initial request plus three hops, then stop');
  });
});

describe('what goes out on the wire', () => {
  it('sends no cookie, authorization, referer or forwarding headers', async () => {
    const { fetcher } = fetcherFor(PUBLIC);
    await fetcher(urlFor(), { requestHeaders: { 'if-none-match': '"abc"' } });

    const sent = requests[0].headers;
    for (const forbidden of ['cookie', 'authorization', 'referer', 'x-forwarded-for', 'x-forwarded-host']) {
      assert.equal(sent[forbidden], undefined, `${forbidden} was sent outbound`);
    }
    // Positive control: the headers that *should* be there are, so "absent" above
    // means absent rather than "no request was made".
    assert.equal(sent['if-none-match'], '"abc"');
    assert.match(sent['user-agent'], /SelfPod/);
  });

  it('asks for identity encoding, so the wire cap is the memory cap', async () => {
    const { fetcher } = fetcherFor(PUBLIC);
    await fetcher(urlFor());
    assert.equal(requests[0].headers['accept-encoding'], 'identity');
  });

  it('refuses a content-encoding it did not ask for', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml', 'content-encoding': 'gzip' });
      res.end(Buffer.from([0x1f, 0x8b, 0x08]));
    };
    const { fetcher } = fetcherFor(PUBLIC);
    await assert.rejects(fetcher(urlFor()), (error) => {
      assert.equal(error.code, FETCH_FAILURES.NOT_A_FEED);
      return true;
    });
  });
});

describe('size is enforced on the bytes, not on the claim', () => {
  it('refuses a declared length over the cap before reading a byte', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml', 'content-length': '999999' });
      res.end('x'.repeat(10));
    };
    const { fetcher } = fetcherFor(PUBLIC);
    await assert.rejects(fetcher(urlFor(), { maxBytes: 1000 }), (error) => {
      assert.equal(error.code, FETCH_FAILURES.TOO_LARGE);
      return true;
    });
  });

  it('stops a stream that runs past the cap while lying about its length', async () => {
    // Content-Length is advisory: chunked replies have none, and a hostile server can
    // simply understate it. The running counter is the actual control.
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      const chunk = 'x'.repeat(64 * 1024);
      let sent = 0;
      const push = () => {
        if (sent > 5 * 1024 * 1024 || res.writableEnded) return res.end();
        sent += chunk.length;
        res.write(chunk);
        return setImmediate(push);
      };
      push();
    };

    const { fetcher } = fetcherFor(PUBLIC);
    await assert.rejects(fetcher(urlFor(), { maxBytes: 200 * 1024 }), (error) => {
      assert.equal(error.code, FETCH_FAILURES.TOO_LARGE);
      return true;
    });
  });

  it('accepts a body inside the cap', async () => {
    const { fetcher } = fetcherFor(PUBLIC);
    const result = await fetcher(urlFor(), { maxBytes: 1024 });
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /<rss>/);
    assert.ok(result.bytes > 0);
  });
});

describe('content types narrow but never authorise', () => {
  it('refuses a type outside the allow-list', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>login</html>');
    };
    const { fetcher } = fetcherFor(PUBLIC);
    await assert.rejects(
      fetcher(urlFor(), { allowedTypes: new Set(['application/rss+xml']) }),
      (error) => {
        assert.equal(error.code, FETCH_FAILURES.NOT_A_FEED);
        return true;
      },
    );
  });

  it('ignores parameters on the type', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end('<rss/>');
    };
    const { fetcher } = fetcherFor(PUBLIC);
    const result = await fetcher(urlFor(), { allowedTypes: new Set(['application/rss+xml']) });
    assert.equal(result.contentType, 'application/rss+xml');
  });
});

describe('conditional requests', () => {
  it('reports a 304 without treating it as a failure', async () => {
    handler = (req, res) => {
      assert.equal(req.headers['if-none-match'], '"v1"');
      res.writeHead(304, { etag: '"v1"' });
      res.end();
    };
    const { fetcher } = fetcherFor(PUBLIC);
    const result = await fetcher(urlFor(), { requestHeaders: { 'if-none-match': '"v1"' } });

    assert.equal(result.notModified, true);
    assert.equal(result.status, 304);
    assert.equal(result.bytes, 0, 'a 304 costs nothing');
  });

  it('hands back the validators so the next poll can send them', async () => {
    handler = (req, res) => {
      res.writeHead(200, {
        'content-type': 'application/rss+xml',
        etag: 'W/"abc"',
        'last-modified': 'Tue, 04 Mar 2025 09:00:00 GMT',
      });
      res.end('<rss/>');
    };
    const { fetcher } = fetcherFor(PUBLIC);
    const result = await fetcher(urlFor());
    // Stored verbatim, never re-derived: a validator the origin cannot recognise is a
    // validator that never validates.
    assert.equal(result.etag, 'W/"abc"');
    assert.equal(result.lastModified, 'Tue, 04 Mar 2025 09:00:00 GMT');
  });
});

describe('failures collapse to a closed set', () => {
  it('reports every non-200 status as the same outcome', async () => {
    // Distinguishing 401 from 403 from a refused connection is the oracle that turns
    // a blocked-address refusal into a working port scanner.
    for (const status of [401, 403, 404, 418, 500, 503]) {
      handler = (req, res) => {
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.end('detail that must not escape');
      };
      const { fetcher } = fetcherFor(PUBLIC);
      await assert.rejects(fetcher(urlFor()), (error) => {
        assert.equal(error.code, FETCH_FAILURES.UNREACHABLE, `status ${status} leaked`);
        assert.ok(!error.message.includes(String(status)), 'the status must not reach the message');
        return true;
      });
    }
  });

  it('never puts a response body or a system error code in the message', async () => {
    handler = (req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain', server: 'LANbox/1.2' });
      res.end('ROUTER-SECRET-BANNER');
    };
    const { fetcher } = fetcherFor(PUBLIC);
    await assert.rejects(fetcher(urlFor()), (error) => {
      const rendered = `${error.message} ${JSON.stringify(error.fields ?? {})}`;
      assert.ok(!rendered.includes('ROUTER-SECRET-BANNER'));
      assert.ok(!rendered.includes('LANbox'));
      assert.ok(!/ECONN|ENOTFOUND|ETIMEDOUT|certificate/i.test(rendered));
      return true;
    });
  });

  it('times out rather than waiting for a server that never answers', async () => {
    handler = () => {
      // Accept the connection and say nothing at all.
    };
    const { fetcher } = fetcherFor(PUBLIC);
    await assert.rejects(fetcher(urlFor(), { headersTimeoutMs: 250 }), (error) => {
      assert.equal(error.code, FETCH_FAILURES.TIMED_OUT);
      return true;
    });
  });
});

describe('SelfPod refuses to subscribe to itself', () => {
  it('refuses its own public origin outright', async () => {
    const { fetcher } = fetcherFor(PUBLIC, {
      selfOrigin: () => `http://feeds.example.com:${server.address().port}`,
    });
    await assert.rejects(fetcher(urlFor()), (error) => {
      assert.equal(error.code, FETCH_FAILURES.SELF_REFERENCE);
      return true;
    });
    assert.equal(requests.length, 0, 'it must not even ask');
  });

  it('refuses a reply that proves it came from this instance', async () => {
    // The origin check alone is not enough: behind a tunnel or a second hostname,
    // SelfPod's own address is public and looks like anyone else's.
    handler = (req, res) => {
      res.writeHead(200, {
        'content-type': 'application/rss+xml',
        'x-selfpod-instance': `signed:${req.headers['x-selfpod-probe']}`,
      });
      res.end('<rss/>');
    };
    const { fetcher } = fetcherFor(PUBLIC, {
      signProbe: (nonce, proof) => proof === `signed:${nonce}`,
    });
    await assert.rejects(fetcher(urlFor()), (error) => {
      assert.equal(error.code, FETCH_FAILURES.SELF_REFERENCE);
      return true;
    });
  });

  it('does not mistake another SelfPod for this one', async () => {
    // Every SelfPod would echo a nonce; only this one can sign it.
    handler = (req, res) => {
      res.writeHead(200, {
        'content-type': 'application/rss+xml',
        'x-selfpod-instance': 'someone-elses-signature',
      });
      res.end('<rss/>');
    };
    const { fetcher } = fetcherFor(PUBLIC, {
      signProbe: (nonce, proof) => proof === `signed:${nonce}`,
    });
    const result = await fetcher(urlFor());
    assert.equal(result.status, 200, 'a different install is a perfectly valid feed to mirror');
  });
});

describe('TLS is actually verified', () => {
  it('refuses a certificate it cannot trust', async (t) => {
    // The point of this test is what it stops later: nothing else in the suite would
    // notice if somebody added `rejectUnauthorized: false` to get a self-hosted feed
    // with a self-signed certificate working. Every other test would stay green, and
    // the guard would silently accept any certificate for any hostname.
    let selfSigned;
    try {
      selfSigned = await import('node:crypto').then(({ generateKeyPairSync, X509Certificate }) => ({
        generateKeyPairSync,
        X509Certificate,
      }));
    } catch {
      return t.skip('crypto unavailable');
    }
    if (!selfSigned) return t.skip('crypto unavailable');

    const { createServer: createTlsServer } = await import('node:https');
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    let key;
    let cert;
    try {
      const dir = mkdtempSync(join(tmpdir(), 'selfpod-tls-'));
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
        '-days', '1', '-subj', '/CN=tls.example.com',
      ], { stdio: 'ignore' });
      key = readFileSync(join(dir, 'k.pem'));
      cert = readFileSync(join(dir, 'c.pem'));
    } catch {
      return t.skip('openssl not available to make a test certificate');
    }

    const tlsServer = createTlsServer({ key, cert }, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end('<rss/>');
    });
    await new Promise((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
    const tlsPort = tlsServer.address().port;

    try {
      const fetcher = createGuardedFetch({
        classify: ALLOW_ALL,
        allowedPorts: new Set([String(tlsPort)]),
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      });

      await assert.rejects(
        fetcher(`https://tls.example.com:${tlsPort}/feed.xml`),
        (error) => {
          assert.equal(error.code, FETCH_FAILURES.UNREACHABLE, 'a bad certificate is a refusal');
          // And the reason must not come back — "certificate has expired" versus
          // "connection refused" is the same oracle the closed enum exists to close.
          assert.ok(!/certificate|self.signed|CERT/i.test(error.message), error.message);
          return true;
        },
      );
    } finally {
      await new Promise((resolve) => tlsServer.close(resolve));
    }
    return undefined;
  });
});
