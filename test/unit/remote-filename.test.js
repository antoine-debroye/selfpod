import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { extensionFor, remoteEpisodeFilename, stemFromTitle } from '../../src/lib/remote-filename.js';
import { isPortableFilename, isSafeFilename } from '../../src/lib/slug.js';
import { uniqueTarget } from '../../src/lib/unique-filename.js';

const AUDIO = { contentType: 'audio/mpeg' };

function nameFor(title, extra = {}) {
  return remoteEpisodeFilename({ ...AUDIO, title, guid: `guid-${title}`, ...extra }).filename;
}

describe('a remote title never becomes a path', () => {
  it('neutralises directory traversal', () => {
    const filename = nameFor('../../etc/passwd');
    assert.ok(!filename.includes('/'), filename);
    assert.ok(!filename.includes('..'), filename);
    assert.ok(isPortableFilename(filename));
  });

  it('neutralises backslash separators, which SMB shares treat as paths too', () => {
    const filename = nameFor('..\\..\\windows\\system32');
    assert.ok(!filename.includes('\\'), filename);
    assert.ok(isPortableFilename(filename));
  });

  it('keeps a slash inside a name readable rather than silently joining words', () => {
    // "AC/DC" should not become "ACDC". A separator is removed because it is
    // dangerous, not because it means nothing.
    assert.match(nameFor('AC/DC live'), /AC-DC live/);
  });

  it('strips NUL and other control characters', () => {
    const filename = nameFor(`Episode${String.fromCharCode(0)}1${String.fromCharCode(31)}x`);
    assert.equal(filename, 'Episode1x.mp3');
  });

  it('refuses the characters Windows and SMB shares reject', () => {
    const filename = nameFor('a<b>c:d"e|f?g*h');
    for (const bad of ['<', '>', ':', '"', '|', '?', '*']) {
      assert.ok(!filename.includes(bad), `"${bad}" survived into ${filename}`);
    }
  });

  it('renames a device name rather than refusing the episode', () => {
    // Writing to CON on Windows silently goes nowhere. But refusing to download an
    // episode because a publisher titled it "Aux" would be the worse answer.
    for (const device of ['CON', 'nul', 'COM1', 'LPT9', 'aux', 'PRN']) {
      const filename = nameFor(device);
      assert.ok(isPortableFilename(filename), `${device} produced ${filename}`);
      assert.match(filename, /^_/, `${device} should be renamed, not refused`);
    }
  });

  it('does not rename a normal word that merely starts like a device', () => {
    assert.equal(nameFor('Constantinople'), 'Constantinople.mp3');
    assert.equal(nameFor('Nullify'), 'Nullify.mp3');
    assert.equal(nameFor('Auxiliary power'), 'Auxiliary power.mp3');
  });

  it('never produces a name the scanner would skip or a shell would read as a flag', () => {
    assert.ok(!nameFor('.hidden episode').startsWith('.'), 'a dotfile is invisible to the scanner');
    assert.ok(!nameFor('-i evil').startsWith('-'), 'a leading dash is an argument, not a name');
  });

  it('never leaves a trailing dot or space', () => {
    for (const title of ['Trailing dots...', 'Trailing space   ', 'mixed . . .']) {
      const filename = nameFor(title);
      const stem = filename.slice(0, filename.lastIndexOf('.'));
      assert.ok(!stem.endsWith('.') && !stem.endsWith(' '), filename);
    }
  });
});

describe('length is counted in bytes, and characters survive whole', () => {
  it('caps a very long title', () => {
    const filename = nameFor('x'.repeat(400));
    assert.ok(Buffer.byteLength(filename, 'utf8') <= 200, `${filename.length} chars`);
    assert.ok(isPortableFilename(filename));
  });

  it('caps a title whose characters are several bytes each', () => {
    // 400 characters of Japanese is 1,200 bytes. Counting characters would sail past
    // the filesystem's limit while looking like it had truncated.
    const filename = nameFor('あ'.repeat(400));
    assert.ok(Buffer.byteLength(filename, 'utf8') <= 200, `${Buffer.byteLength(filename)} bytes`);
  });

  it('does not cut a multi-byte character in half', () => {
    for (const character of ['あ', '🎧', 'é']) {
      const filename = nameFor(character.repeat(300));
      assert.ok(
        !filename.includes('�'),
        `truncation produced a replacement character: ${filename}`,
      );
      // A lone surrogate would round-trip through Buffer as U+FFFD.
      assert.equal(
        Buffer.from(filename, 'utf8').toString('utf8'),
        filename,
        'the name must survive a UTF-8 round trip intact',
      );
    }
  });

  it('keeps emoji and accents rather than stripping them', () => {
    // Acceptance step 2 exists because these were once broken in filenames.
    const filename = nameFor('Café ☕ and 🎧 emoji');
    assert.match(filename, /Café/);
    assert.match(filename, /🎧/);
    assert.ok(isPortableFilename(filename));
  });

  it('is bounded by construction, date prefix included', () => {
    // The stem cap, the 11-byte date prefix and a 5-byte extension together cannot
    // approach the 255-byte filesystem limit — for any script, not just ASCII. This
    // is asserted rather than assumed because an earlier draft carried an "if it
    // overflows, drop the date" branch that was in fact unreachable.
    for (const character of ['y', 'あ', '🎧']) {
      const filename = remoteEpisodeFilename({
        ...AUDIO,
        title: character.repeat(400),
        pubDate: '2025-03-04T09:00:00.000Z',
        guid: 'g',
      }).filename;
      const bytes = Buffer.byteLength(filename, 'utf8');
      assert.ok(bytes <= 160, `${character}: ${bytes} bytes`);
      assert.match(filename, /^2025-03-04-/, 'the date prefix survives; nothing needs dropping');
      assert.ok(isPortableFilename(filename));
    }
  });
});

describe('when a title yields nothing usable', () => {
  it('falls back to a name derived from the guid', () => {
    for (const title of ['', '   ', '...', '\\\\\\', null, undefined]) {
      const result = remoteEpisodeFilename({ ...AUDIO, title, guid: 'stable-guid' });
      assert.ok(isPortableFilename(result.filename), `${title} produced ${result.filename}`);
      assert.match(result.filename, /^remote-[0-9a-f]{12}\.mp3$/);
    }
  });

  it('gives the same item the same name every time, so a retry is idempotent', () => {
    const first = remoteEpisodeFilename({ ...AUDIO, title: '', guid: 'abc-123' }).filename;
    const again = remoteEpisodeFilename({ ...AUDIO, title: '', guid: 'abc-123' }).filename;
    assert.equal(first, again);
  });

  it('gives two different items different names', () => {
    const a = remoteEpisodeFilename({ ...AUDIO, title: '', guid: 'one' }).filename;
    const b = remoteEpisodeFilename({ ...AUDIO, title: '', guid: 'two' }).filename;
    assert.notEqual(a, b);
  });
});

describe('the extension comes from the server, not the URL', () => {
  it('prefers what the response said it was sending', () => {
    const result = remoteEpisodeFilename({
      title: 'x',
      contentType: 'audio/mp4',
      enclosureType: 'audio/mpeg',
      url: 'https://cdn.example.com/a.wav',
      guid: 'g',
    });
    assert.equal(result.extension, '.m4a', 'the live response outranks an older claim');
  });

  it('falls back to the feed\'s type when the response is unhelpful', () => {
    const result = remoteEpisodeFilename({
      title: 'x',
      contentType: 'application/octet-stream',
      enclosureType: 'audio/mpeg',
      url: 'https://cdn.example.com/a.wav',
      guid: 'g',
    });
    assert.equal(result.extension, '.mp3');
  });

  it('uses the URL only as a last resort', () => {
    const result = remoteEpisodeFilename({
      title: 'x',
      contentType: 'application/octet-stream',
      url: 'https://cdn.example.com/a.flac',
      guid: 'g',
    });
    assert.equal(result.extension, '.flac');
  });

  it('refuses when nothing maps to audio SelfPod can serve', () => {
    // Refusing here is what stops a paywall page being downloaded and left in the
    // show folder for the scanner to complain about.
    const result = remoteEpisodeFilename({
      title: 'x',
      contentType: 'text/html',
      url: 'https://cdn.example.com/page',
      guid: 'g',
    });
    assert.equal(result.filename, null);
    assert.equal(result.reason, 'unsupported_type');
  });

  it('does not let a URL suffix invent a type SelfPod does not serve', () => {
    assert.equal(extensionFor({ url: 'https://cdn.example.com/a.mp4' }), null);
    assert.equal(extensionFor({ url: 'https://cdn.example.com/a.exe' }), null);
    assert.equal(extensionFor({ url: 'not a url at all' }), null);
  });
});

describe('the strict predicate is stricter than the containment check', () => {
  it('catches what isSafeFilename waves through', () => {
    // The reason the assertion in remote-filename.js uses this one: asserting only
    // isSafeFilename would have been decorative.
    for (const name of ['CON.mp3', 'ends with dot.', 'ends with space ', '.hidden.mp3', '-dash.mp3', 'a<b>.mp3']) {
      assert.equal(isSafeFilename(name), true, `${name} is contained`);
      assert.equal(isPortableFilename(name), false, `${name} should not be portable`);
    }
  });

  it('still accepts ordinary names, including the collision suffix', () => {
    for (const name of ['Episode 12.mp3', 'ok (2).mp3', 'Café 🎧.mp3', 'a.b.c.mp3']) {
      assert.equal(isPortableFilename(name), true, name);
    }
  });

  it('is not confused by being asked twice about the same name', () => {
    // A /g regex would carry lastIndex between calls and alternate true/false.
    const name = 'clean name.mp3';
    assert.equal(isPortableFilename(name), isPortableFilename(name));
    assert.equal(isPortableFilename(name), true);
  });
});

describe('uniqueTarget never overwrites', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'selfpod-unique-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the name unchanged when nothing is there', async () => {
    assert.equal(await uniqueTarget(dir, 'free.mp3'), 'free.mp3');
  });

  it('steps aside for an existing file, keeping the extension', async () => {
    await writeFile(join(dir, 'taken.mp3'), 'x');
    assert.equal(await uniqueTarget(dir, 'taken.mp3'), 'taken (2).mp3');

    await writeFile(join(dir, 'taken (2).mp3'), 'x');
    assert.equal(await uniqueTarget(dir, 'taken.mp3'), 'taken (3).mp3');
  });

  it('handles a name with no extension', async () => {
    await writeFile(join(dir, 'noext'), 'x');
    assert.equal(await uniqueTarget(dir, 'noext'), 'noext (2)');
  });

  it('produces a name that is still portable', async () => {
    await writeFile(join(dir, 'portable.mp3'), 'x');
    assert.ok(isPortableFilename(await uniqueTarget(dir, 'portable.mp3')));
  });
});

describe('stemFromTitle', () => {
  it('turns tabs and newlines into spaces instead of deleting them', () => {
    // Regression: stripping control characters before collapsing whitespace removed
    // the tab entirely and welded two words together — "a\tb" became "ab".
    assert.equal(stemFromTitle('a   b\t\tc\n\nd'), 'a b c d');
    assert.equal(stemFromTitle('Two\tWords'), 'Two Words');
  });

  it('returns an empty string when nothing survives, rather than something odd', () => {
    assert.equal(stemFromTitle('...'), '');
    assert.equal(stemFromTitle('   '), '');
    assert.equal(stemFromTitle(null), '');
  });
});
