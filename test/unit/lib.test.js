import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AUDIO_MIME_TYPES, COVER_FILENAMES, SUPPORTED_EXTENSIONS, audioMimeType } from '../../src/constants.js';
import { formatDurationFeed, fromLocalInputValue, toLocalInputValue, toRFC2822 } from '../../src/lib/dates.js';
import { computeIdentityKey, WHOLE_FILE_THRESHOLD, WINDOW_BYTES } from '../../src/lib/identity.js';
import { encodePathSegment, feedUrl, mediaUrl, normaliseBaseUrl } from '../../src/lib/urls.js';
import { newFeedToken, tokensMatch } from '../../src/lib/tokens.js';

/** The filename from spec §17: spaces, an emoji, a curly quote and an en dash. */
const NASTY_FILENAME = "ep 42 🎙️ – it's ‘live’.m4a";

describe('MIME map (spec §6.1)', () => {
  it('covers exactly the seven documented formats with the documented types', () => {
    assert.deepEqual(AUDIO_MIME_TYPES, {
      '.mp3': 'audio/mpeg',
      '.m4a': 'audio/x-m4a',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.opus': 'audio/opus',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
    });
    assert.equal(SUPPORTED_EXTENSIONS.length, 7);
  });

  it('maps .m4a to audio/x-m4a, not audio/mp4', () => {
    // The prototype's duplicated table got this wrong, so an entire episode
    // never appeared in the feed.
    assert.equal(audioMimeType('2026-08-07-episode.m4a'), 'audio/x-m4a');
    assert.equal(audioMimeType('SHOUTING.M4A'), 'audio/x-m4a');
  });

  it('returns null for unsupported extensions rather than guessing', () => {
    assert.equal(audioMimeType('episode.wma'), null);
    assert.equal(audioMimeType('noextension'), null);
  });

  it('lists cover filenames in the documented priority order', () => {
    assert.deepEqual(COVER_FILENAMES, [
      'cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'folder.jpg', 'artwork.jpg',
    ]);
  });
});

describe('URL building (spec §8.3 requirement 1)', () => {
  it('produces a parseable URL for a filename with spaces, emoji and curly quotes', () => {
    const url = mediaUrl('https://podcast.example.com', 'late-night', 'tok123', 'guid-1', NASTY_FILENAME);
    const parsed = new URL(url); // throws if the URL is syntactically invalid
    assert.equal(parsed.origin, 'https://podcast.example.com');
    assert.ok(!url.includes(' '), 'no raw spaces may survive into the URL');
    assert.ok(!/[🎙]/u.test(url), 'no raw emoji may survive into the URL');
  });

  it('round-trips the filename exactly through decoding', () => {
    const url = mediaUrl('https://x.test', 'slug', 'tok', 'id', NASTY_FILENAME);
    const last = new URL(url).pathname.split('/').pop();
    assert.equal(decodeURIComponent(last), NASTY_FILENAME);
  });

  it('escapes path separators inside a segment so traversal cannot be smuggled in', () => {
    assert.equal(encodePathSegment('../../etc/passwd'), '..%2F..%2Fetc%2Fpasswd');
  });

  it('builds the documented feed URL shape', () => {
    assert.equal(
      feedUrl('https://podcast.example.com', 'my-show', 'abc123'),
      'https://podcast.example.com/feeds/my-show/abc123.xml',
    );
  });

  it('normalises base URLs and rejects unusable ones', () => {
    assert.equal(normaliseBaseUrl('https://a.test/'), 'https://a.test');
    assert.equal(normaliseBaseUrl('https://a.test/podcast/'), 'https://a.test/podcast');
    assert.equal(normaliseBaseUrl('  http://192.168.1.5:8080  '), 'http://192.168.1.5:8080');
    assert.equal(normaliseBaseUrl('podcast.example.com'), null, 'a scheme is required');
    assert.equal(normaliseBaseUrl('ftp://a.test'), null);
    assert.equal(normaliseBaseUrl(''), null);
    assert.equal(normaliseBaseUrl('https://a.test?x=1'), null);
  });
});

describe('dates (spec §8.3 requirement 4)', () => {
  it('formats RFC 2822 via the platform, not by hand', () => {
    const formatted = toRFC2822('2026-08-09T12:34:56.000Z');
    assert.equal(formatted, 'Sun, 09 Aug 2026 12:34:56 GMT');
    assert.match(formatted, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  });

  it('returns null for unparseable input instead of "Invalid Date"', () => {
    assert.equal(toRFC2822('not a date'), null);
  });

  it('formats durations as zero-padded HH:MM:SS for the feed', () => {
    assert.equal(formatDurationFeed(3492), '00:58:12');
    assert.equal(formatDurationFeed(3764), '01:02:44');
    assert.equal(formatDurationFeed(7), '00:00:07');
    assert.equal(formatDurationFeed(null), null);
  });

  it('round-trips a datetime-local value through a non-UTC zone', () => {
    const iso = fromLocalInputValue('2026-08-07T21:00', { timeZone: 'Europe/London' });
    assert.equal(iso, '2026-08-07T20:00:00.000Z'); // BST is UTC+1 in August
    assert.equal(toLocalInputValue(iso, { timeZone: 'Europe/London' }), '2026-08-07T21:00');
  });

  it('handles a winter date in the same zone (no DST offset)', () => {
    const iso = fromLocalInputValue('2026-01-15T09:30', { timeZone: 'Europe/London' });
    assert.equal(iso, '2026-01-15T09:30:00.000Z');
  });
});

describe('feed tokens (spec §12.2)', () => {
  it('carries at least 128 bits of entropy', () => {
    const token = newFeedToken();
    assert.equal(token.length, 22);
    const bits = 22 * Math.log2(62);
    assert.ok(bits >= 128, `expected >=128 bits, got ${bits.toFixed(1)}`);
  });

  it('generates distinct tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, newFeedToken));
    assert.equal(tokens.size, 500);
  });

  it('compares tokens without leaking length', () => {
    assert.equal(tokensMatch('abc', 'abc'), true);
    assert.equal(tokensMatch('abc', 'abd'), false);
    assert.equal(tokensMatch('abc', 'much longer value'), false);
    assert.equal(tokensMatch('abc', null), false);
  });
});

describe('content identity (spec §7.2)', () => {
  let dir;
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('is identical for the same bytes under a different filename', async () => {
    dir = await mkdtemp(join(tmpdir(), 'selfpod-identity-'));
    const bytes = Buffer.from('the same audio content'.repeat(100));
    const a = join(dir, 'original-name.mp3');
    const b = join(dir, 'renamed 🎧 file.mp3');
    await writeFile(a, bytes);
    await writeFile(b, bytes);
    assert.equal(await computeIdentityKey(a), await computeIdentityKey(b));
  });

  it('differs when the content differs at the same size', async () => {
    const a = join(dir, 'x.mp3');
    const b = join(dir, 'y.mp3');
    await writeFile(a, Buffer.alloc(4096, 1));
    await writeFile(b, Buffer.alloc(4096, 2));
    assert.notEqual(await computeIdentityKey(a), await computeIdentityKey(b));
  });

  it('differs when only the size differs', async () => {
    const a = join(dir, 'size-a.mp3');
    const b = join(dir, 'size-b.mp3');
    await writeFile(a, Buffer.alloc(1000, 7));
    await writeFile(b, Buffer.alloc(1001, 7));
    assert.notEqual(await computeIdentityKey(a), await computeIdentityKey(b));
  });

  it('notices a change in the head or tail window of a large file', async () => {
    const big = Buffer.alloc(WHOLE_FILE_THRESHOLD + WINDOW_BYTES, 9);
    const path = join(dir, 'big.wav');
    await writeFile(path, big);
    const before = await computeIdentityKey(path);

    big[0] = 1; // head window
    await writeFile(path, big);
    assert.notEqual(await computeIdentityKey(path), before);

    big[0] = 9;
    big[big.length - 1] = 1; // tail window
    await writeFile(path, big);
    assert.notEqual(await computeIdentityKey(path), before);
  });

  it('accepts the documented blind spot: a middle-only edit at identical size', async () => {
    // Hashing head+tail+size is what keeps a 5-minute rescan cheap on a NAS.
    // A middle-only edit that preserves the exact byte count is not detected;
    // the manual "Rescan now" action re-hashes to recover from that.
    const big = Buffer.alloc(WHOLE_FILE_THRESHOLD + WINDOW_BYTES * 2, 3);
    const path = join(dir, 'middle.wav');
    await writeFile(path, big);
    const before = await computeIdentityKey(path);
    big[Math.floor(big.length / 2)] = 42;
    await writeFile(path, big);
    assert.equal(await computeIdentityKey(path), before);
  });

  it('handles an empty file without throwing', async () => {
    const path = join(dir, 'empty.mp3');
    await writeFile(path, Buffer.alloc(0));
    assert.match(await computeIdentityKey(path), /^[a-f0-9]{64}$/);
  });
});
