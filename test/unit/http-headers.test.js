import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { etagMatches, notModifiedSince, preferredEncoding } from '../../src/lib/http-headers.js';

/**
 * Locks down conditional-request and content-negotiation parsing.
 *
 * Every failure mode covered here is silent: no exception, no log line, no error
 * status. A wrong answer just means every podcast app re-downloads the whole feed
 * on every poll — which on a home NAS behind a domestic uplink is the difference
 * between a feed that costs nothing to host and one that saturates the connection.
 * The cases that used to break in production are called out by name below.
 */

/** The shape of tag SelfPod issues: strong, quoted, opaque. */
const OUR_TAG = '"a1b2c3"';

describe('If-None-Match (RFC 9110 §13.1.2, weak comparison)', () => {
  it('matches a single strong ETag against itself', () => {
    assert.equal(etagMatches('"a1b2c3"', OUR_TAG), true, 'a client echoing our exact tag must match');
  });

  it('matches a weak W/"…" header against the strong tag we issued (the Cloudflare case)', () => {
    // Cloudflare Tunnel — which the README recommends — re-emits strong ETags as
    // weak ones, so this is what a real subscriber's request looks like.
    assert.equal(etagMatches('W/"a1b2c3"', OUR_TAG), true, 'W/ prefix must be ignored under weak comparison');
    assert.equal(etagMatches('"a1b2c3"', 'W/"a1b2c3"'), true, 'the marker must be ignored on either side');
  });

  it('matches a tag anywhere in a comma-separated list, not only the first', () => {
    assert.equal(
      etagMatches('"old-one", W/"older", "a1b2c3"', OUR_TAG),
      true,
      'If-None-Match is a list; a match in last position counts',
    );
    assert.equal(etagMatches('"a1b2c3", "something-else"', OUR_TAG), true, 'a match in first position counts too');
  });

  it('matches * because any representation we hold satisfies it', () => {
    assert.equal(etagMatches('*', OUR_TAG), true, '* means "any current representation"');
    assert.equal(etagMatches('  *  ', OUR_TAG), true, 'surrounding whitespace must not defeat *');
  });

  it('matches a tag whose opaque part contains a comma', () => {
    // A comma is legal inside an opaque-tag. split(',') would cut `"a1b2,c3"`
    // into `"a1b2` and `c3"` and never match this tag again — silently.
    const commaTag = '"a1b2,c3"';
    assert.equal(etagMatches('"a1b2,c3"', commaTag), true, 'a lone tag containing a comma must match itself');
    assert.equal(
      etagMatches('W/"unrelated", "a1b2,c3"', commaTag),
      true,
      'a comma-bearing tag inside a list must still match',
    );
    assert.equal(
      etagMatches('"a1b2,c3", "other"', commaTag),
      true,
      'the comma inside the tag must not be read as a list separator',
    );
  });

  it('does not match a different tag', () => {
    assert.equal(etagMatches('"different"', OUR_TAG), false, 'a different tag must not match');
    assert.equal(etagMatches('W/"different"', OUR_TAG), false, 'a different weak tag must not match');
    assert.equal(etagMatches('"a1b2c3x"', OUR_TAG), false, 'a tag that merely shares a prefix must not match');
  });

  it('does not match an empty, missing or non-string header', () => {
    assert.equal(etagMatches('', OUR_TAG), false, 'an empty header matches nothing');
    assert.equal(etagMatches(undefined, OUR_TAG), false, 'an absent header matches nothing');
    assert.equal(etagMatches(null, OUR_TAG), false, 'a null header matches nothing');
    assert.equal(etagMatches(['"a1b2c3"'], OUR_TAG), false, 'a repeated header arriving as an array matches nothing');
  });

  it('does not match an unquoted bare token', () => {
    assert.equal(etagMatches('a1b2c3', OUR_TAG), false, 'an unquoted token is not an entity-tag');
    assert.equal(etagMatches('"a1b2c3"', 'a1b2c3'), false, 'an unquoted tag on our side must not match either');
  });

  it('does not match when our own tag is empty or not a string', () => {
    assert.equal(etagMatches('"a1b2c3"', ''), false, 'no tag of our own means nothing to compare');
    assert.equal(etagMatches('*', ''), false, 'not even * matches when we hold no tag');
    assert.equal(etagMatches('"a1b2c3"', null), false, 'a null tag matches nothing');
  });
});

describe('If-Modified-Since', () => {
  const SINCE = 'Sun, 09 Aug 2026 12:00:00 GMT';

  it('reports a dated copy fresh when Last-Modified is at or before If-Modified-Since', () => {
    assert.equal(
      notModifiedSince(SINCE, new Date('2026-08-09T12:00:00.000Z')),
      true,
      'the same second must count as unmodified',
    );
    assert.equal(
      notModifiedSince(SINCE, new Date('2026-08-09T09:15:00.000Z')),
      true,
      'an older copy must count as unmodified',
    );
  });

  it('reports it stale when Last-Modified is later', () => {
    assert.equal(
      notModifiedSince(SINCE, new Date('2026-08-09T12:00:01.000Z')),
      false,
      'one second newer means a new episode may be in the feed',
    );
    assert.equal(
      notModifiedSince(SINCE, new Date('2026-08-10T08:00:00.000Z')),
      false,
      'a day newer must be reported stale',
    );
  });

  it('ignores sub-second precision, which an HTTP-date cannot carry', () => {
    // The Last-Modified we sent was truncated to whole seconds on the way out,
    // so the If-Modified-Since coming back can never carry these 400ms. Without
    // flooring, this copy looks stale on every request and never stops downloading.
    assert.equal(
      notModifiedSince(SINCE, new Date('2026-08-09T12:00:00.400Z')),
      true,
      'milliseconds past the shared second must still count as unmodified',
    );
    assert.equal(
      notModifiedSince(SINCE, new Date('2026-08-09T12:00:00.999Z')),
      true,
      'the very end of the shared second must still count as unmodified',
    );
  });

  it('rejects an unparseable If-Modified-Since rather than treating it as fresh', () => {
    assert.equal(notModifiedSince('yesterday-ish', new Date('2020-01-01T00:00:00Z')), false, 'garbage is not a date');
    assert.equal(notModifiedSince('', new Date('2020-01-01T00:00:00Z')), false, 'an empty header is not a date');
    assert.equal(notModifiedSince(undefined, new Date('2020-01-01T00:00:00Z')), false, 'a missing header is not a date');
  });

  it('rejects a non-Date lastModified', () => {
    assert.equal(notModifiedSince(SINCE, '2026-08-09T12:00:00.000Z'), false, 'an ISO string is not a Date');
    assert.equal(notModifiedSince(SINCE, 1786550400000), false, 'an epoch number is not a Date');
    assert.equal(notModifiedSince(SINCE, null), false, 'no stored timestamp means we cannot claim freshness');
    assert.equal(notModifiedSince(SINCE, new Date('nonsense')), false, 'an Invalid Date must not read as fresh');
  });
});

describe('Accept-Encoding', () => {
  it('prefers brotli over gzip when both are offered unweighted', () => {
    assert.equal(preferredEncoding('gzip, deflate, br'), 'br', 'our order decides, not the order the client listed');
    assert.equal(preferredEncoding('br, gzip'), 'br', 'brotli stays first when the client agrees');
  });

  it('picks gzip when brotli is refused with br;q=0', () => {
    assert.equal(preferredEncoding('br;q=0, gzip'), 'gzip', 'q=0 is a refusal, so fall through to gzip');
    assert.equal(preferredEncoding('gzip;q=0.5, br;q=0'), 'gzip', 'a weighted gzip is still acceptable');
  });

  it('honours a bare * as the weight for anything not named', () => {
    assert.equal(preferredEncoding('*'), 'br', 'a wildcard accepts our first choice');
    assert.equal(preferredEncoding('gzip, *'), 'br', 'the wildcard covers brotli even though only gzip is named');
    assert.equal(preferredEncoding('br;q=0, *'), 'gzip', 'an explicit refusal must beat the wildcard');
    assert.equal(preferredEncoding('*;q=0'), null, 'a wildcard refusal means send it uncompressed');
  });

  it('returns null for a missing, empty or identity-only Accept-Encoding', () => {
    assert.equal(preferredEncoding(undefined), null, 'no header means send it uncompressed');
    assert.equal(preferredEncoding(''), null, 'an empty header means send it uncompressed');
    assert.equal(preferredEncoding('   '), null, 'a whitespace-only header means send it uncompressed');
    assert.equal(preferredEncoding('identity'), null, 'identity-only means the client wants the raw bytes');
    assert.equal(preferredEncoding('deflate'), null, 'a client accepting only codings we do not have gets raw bytes');
  });

  it('never throws and never implies a 406 when nothing on offer is acceptable', () => {
    // A podcast app that cannot read the feed is worse than one that reads a
    // bigger copy, so the answer is always "send it uncompressed", never an error.
    assert.equal(preferredEncoding('br;q=0, gzip;q=0'), null, 'both refused means uncompressed, not a failure');
    assert.equal(preferredEncoding('nonsense;;;q=;'), null, 'a malformed header must not throw');
  });

  it('is case-insensitive about coding names', () => {
    assert.equal(preferredEncoding('GZIP'), 'gzip', 'an uppercase coding name is the same coding');
    assert.equal(preferredEncoding('BR;Q=0, GZip'), 'gzip', 'the q parameter name is case-insensitive too');
    assert.equal(preferredEncoding('gzip', ['BR', 'GZIP']), 'GZIP', 'our own spelling is returned unchanged');
  });

  it('respects a caller-supplied server preference order', () => {
    assert.equal(preferredEncoding('gzip, br', ['gzip', 'br']), 'gzip', 'the caller decides which coding wins');
  });
});
