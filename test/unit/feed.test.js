import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sharp from 'sharp';

import { SCAN_TRIGGER } from '../../src/constants.js';
import { SETTING_KEYS } from '../../src/services/settings.js';
import { createTestInstance } from '../helpers/harness.js';

let app;

beforeEach(async () => {
  app = await createTestInstance();
});

afterEach(async () => {
  await app.cleanup();
});

async function buildFeed(slug) {
  const show = app.shows.getBySlug(slug);
  const entry = app.feeds.build(show.id);
  assert.ok(entry, 'a feed should have been built');
  return { show, xml: entry.xml, etag: entry.etag };
}

async function seed(slug, files = ['sample.mp3']) {
  for (const [index, file] of files.entries()) {
    await app.addAudio(slug, file, typeof file === 'string' ? file : file.as);
    void index;
  }
  await app.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
  return app.shows.getBySlug(slug);
}

describe('feed structure (spec §8.3)', () => {
  it('emits the full documented channel skeleton', async () => {
    await seed('structure');
    const dir = join(app.config.showsDir, 'structure');
    await writeFile(
      join(dir, 'cover.jpg'),
      await sharp({ create: { width: 1500, height: 1500, channels: 3, background: '#3E2D4A' } })
        .jpeg()
        .toBuffer(),
    );
    await app.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    const { show, xml } = await buildFeed('structure');

    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<rss version="2\.0"/);
    assert.ok(xml.includes('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"'));
    assert.ok(xml.includes('xmlns:podcast="https://podcastindex.org/namespace/1.0"'));
    assert.ok(xml.includes('xmlns:content="http://purl.org/rss/1.0/modules/content/"'));

    assert.ok(xml.includes(`<title>${show.title}</title>`));
    assert.ok(xml.includes('<language>en</language>'));
    assert.ok(xml.includes('<itunes:owner>'));
    assert.match(xml, /<itunes:name>.+<\/itunes:name>/, 'the owner name must never be empty');
    assert.match(xml, /<itunes:author>.+<\/itunes:author>/, 'directories reject an empty author');
    assert.match(xml, /<itunes:category text="[^"]+"/);
    assert.match(xml, /<itunes:explicit>(true|false)<\/itunes:explicit>/);
    assert.ok(xml.includes('<itunes:image href="https://podcast.example.com/media/structure/'));
    assert.ok(xml.includes('<image>'), 'the plain RSS <image> block is also required');
    assert.ok(xml.includes('<podcast:locked>yes</podcast:locked>'));
    assert.ok(xml.includes(`<podcast:guid>${show.id}</podcast:guid>`), 'show-level UUID as podcast:guid');
    assert.ok(xml.includes('<generator>SelfPod</generator>'));
    assert.match(xml, /<lastBuildDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT<\/lastBuildDate>/);
  });

  it('always writes isPermaLink="false" on every guid', async () => {
    await seed('guids', ['sample.mp3', 'sample.m4a']);
    const { xml } = await buildFeed('guids');
    const guids = xml.match(/<guid[^>]*>/g) ?? [];
    assert.equal(guids.length, 2);
    for (const guid of guids) {
      assert.ok(guid.includes('isPermaLink="false"'), `guid missing isPermaLink: ${guid}`);
    }
  });

  it('uses the episode GUID, never anything derived from the filename', async () => {
    const show = await seed('guid-source');
    const episode = app.episodes.listByShow(show.id)[0];
    const { xml } = await buildFeed('guid-source');
    assert.ok(xml.includes(`>${episode.id}</guid>`));
    assert.match(episode.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('omits itunes:duration entirely when the duration is unknown', async () => {
    const show = await seed('no-duration');
    const episode = app.episodes.listByShow(show.id)[0];
    app.episodes.setSystemFields(episode.id, { duration_seconds: null });
    app.feeds.invalidate(show.id);

    const { xml } = await buildFeed('no-duration');
    assert.ok(!xml.includes('itunes:duration'), 'no empty or zero duration tag may be emitted');
  });

  it('formats a known duration as HH:MM:SS', async () => {
    const show = await seed('duration');
    const episode = app.episodes.listByShow(show.id)[0];
    app.episodes.setSystemFields(episode.id, { duration_seconds: 3492 });
    app.feeds.invalidate(show.id);
    const { xml } = await buildFeed('duration');
    assert.ok(xml.includes('<itunes:duration>00:58:12</itunes:duration>'));
  });

  it('emits season and episode numbers only when they are set', async () => {
    const show = await seed('numbering');
    const episode = app.episodes.listByShow(show.id)[0];
    let { xml } = await buildFeed('numbering');
    assert.ok(!xml.includes('itunes:season'));
    assert.ok(!xml.includes('itunes:episode>'));

    app.episodes.update(episode.id, { season: 2, episodeNumber: 42 });
    ({ xml } = await buildFeed('numbering'));
    assert.ok(xml.includes('<itunes:season>2</itunes:season>'));
    assert.ok(xml.includes('<itunes:episode>42</itunes:episode>'));
  });

  it('resolves the explicit flag from the episode override, else the show', async () => {
    const show = await seed('explicit');
    app.shows.update(show.id, { explicit: true });
    let { xml } = await buildFeed('explicit');
    assert.equal(countOccurrences(xml, '<itunes:explicit>true</itunes:explicit>'), 2, 'channel and item');

    const episode = app.episodes.listByShow(show.id)[0];
    app.episodes.update(episode.id, { explicit: false });
    ({ xml } = await buildFeed('explicit'));
    assert.ok(xml.includes('<itunes:explicit>false</itunes:explicit>'), 'the item override wins');
  });
});

describe('enclosures (spec §8.4)', () => {
  it('percent-encodes a filename with spaces, emoji and curly quotes into a valid URL', async () => {
    const nasty = "ep 42 🎙️ – it's ‘live’.m4a";
    await app.addAudio('nasty', 'sample.m4a', nasty);
    await app.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    const { xml } = await buildFeed('nasty');
    const url = xml.match(/<enclosure url="([^"]+)"/)?.[1];
    assert.ok(url, 'an enclosure URL should be present');

    // The URL must be usable verbatim, and decode back to the original filename.
    const parsed = new URL(url);
    assert.equal(decodeURIComponent(parsed.pathname.split('/').pop()), nasty);
    assert.ok(!url.includes(' '));
    assert.ok(!/[’‘]/u.test(url));
  });

  it('carries the real byte length and the MIME type from the shared map', async () => {
    const show = await seed('enclosure', ['sample.m4a']);
    const episode = app.episodes.listByShow(show.id)[0];
    const { xml } = await buildFeed('enclosure');
    assert.ok(xml.includes(`length="${episode.file_size_bytes}"`));
    assert.ok(xml.includes('type="audio/x-m4a"'), 'the m4a MIME type must be exact');
  });

  it('routes media by episode id, with the filename only as a suffix', async () => {
    const show = await seed('routing');
    const episode = app.episodes.listByShow(show.id)[0];
    const { xml } = await buildFeed('routing');
    const url = xml.match(/<enclosure url="([^"]+)"/)[1];
    assert.ok(
      url.includes(`/media/routing/${show.feed_token}/${episode.id}/`),
      `unexpected media URL shape: ${url}`,
    );
  });
});

describe('escaping and ordering', () => {
  it('escapes XML-significant characters coming from user input', async () => {
    const show = await seed('escaping');
    app.shows.update(show.id, {
      title: 'Tom & Jerry <live> "quoted"',
      description: "5 > 3 & 2 < 4 — it's ‘fine’",
    });
    const { xml } = await buildFeed('escaping');
    assert.ok(xml.includes('Tom &amp; Jerry &lt;live&gt;'), 'ampersands and angle brackets escaped');
    assert.ok(!xml.includes('<live>'), 'raw markup must never survive');

    // The document must still parse as XML.
    const { XMLParser } = await import('fast-xml-parser').catch(() => ({ XMLParser: null }));
    if (XMLParser) {
      const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
      assert.equal(parsed.rss.channel.title, 'Tom & Jerry <live> "quoted"');
    }
  });

  it('lists newest episodes first', async () => {
    const show = await seed('ordering', ['sample.mp3', 'sample.m4a', 'sample.flac']);
    const eps = app.episodes.listByShow(show.id);
    app.episodes.update(eps[0].id, { pubDate: '2026-01-01T00:00' });
    app.episodes.update(eps[1].id, { pubDate: '2026-06-01T00:00' });
    app.episodes.update(eps[2].id, { pubDate: '2026-03-01T00:00' });

    const { xml } = await buildFeed('ordering');
    const order = [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => new Date(m[1]).getTime());
    assert.deepEqual(order, [...order].sort((a, b) => b - a), 'pubDates must descend');
  });

  it('includes missing episodes but excludes removed ones', async () => {
    const show = await seed('visibility', ['sample.mp3', 'sample.m4a']);
    const [first, second] = app.episodes.listByShow(show.id);

    app.episodes.setSystemFields(first.id, { status: 'missing', missing_since: new Date().toISOString() });
    app.episodes.removeFromFeed(second.id);
    app.feeds.invalidate(show.id);

    const { xml } = await buildFeed('visibility');
    assert.ok(xml.includes(first.id), 'a missing file stays in the feed during its grace period');
    assert.ok(!xml.includes(second.id), 'a user-removed episode must not appear');
  });
});

describe('feed caching (spec §8.1)', () => {
  it('serves a cached copy for repeat requests', async () => {
    const show = await seed('cache');
    const a = app.feeds.build(show.id);
    const b = app.feeds.build(show.id);
    assert.equal(a.builtAt, b.builtAt, 'the second call should not rebuild');
    assert.equal(a.etag, b.etag);
  });

  it('invalidates immediately when the scanner reports a change, not on a timer', async () => {
    const show = await seed('cache-invalidate');
    const before = app.feeds.build(show.id);

    await app.addAudio('cache-invalidate', 'sample.m4a');
    await app.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    const after = app.feeds.build(show.id);
    assert.notEqual(after.etag, before.etag, 'a new episode must appear without waiting for the TTL');
    assert.ok(after.xml.includes('audio/x-m4a'));
  });

  it('invalidates every show when the public base URL changes', async () => {
    const show = await seed('cache-baseurl');
    const before = app.feeds.build(show.id);
    assert.ok(before.xml.includes('https://podcast.example.com'));

    app.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: 'https://new-host.example.org' });

    const after = app.feeds.build(show.id);
    assert.ok(after.xml.includes('https://new-host.example.org'));
    assert.ok(!after.xml.includes('podcast.example.com'));
  });

  it('invalidates when a show is edited', async () => {
    const show = await seed('cache-edit');
    const before = app.feeds.build(show.id);
    app.shows.update(show.id, { title: 'Renamed Show' });
    const after = app.feeds.build(show.id);
    assert.notEqual(after.etag, before.etag);
    assert.ok(after.xml.includes('Renamed Show'));
  });

  it('refuses to build a feed before a public base URL is configured', async () => {
    const bare = await createTestInstance({ env: { PUBLIC_BASE_URL: '' } });
    try {
      await bare.addAudio('unset', 'sample.mp3');
      await bare.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
      const show = bare.shows.getBySlug('unset');
      assert.equal(bare.feeds.build(show.id), null, 'no guessed URLs may be emitted');
    } finally {
      await bare.cleanup();
    }
  });
});

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}
