import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sharp from 'sharp';

import { PREVIOUS_BASE_URL_WINDOW_DAYS, SCAN_TRIGGER } from '../../src/constants.js';
import { SETTING_KEYS } from '../../src/services/settings.js';
import { createTestInstance, mp3WithEmbeddedArtwork } from '../helpers/harness.js';

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

/**
 * Forwarding subscribers after the public address changes.
 *
 * `<itunes:new-feed-url>` is the only mechanism that moves a subscription across, and
 * it is emitted for a bounded window rather than for ever — so what these check is not
 * only that it appears, but that it stops.
 */
describe('itunes:new-feed-url after a base-URL change', () => {
  const NEW_HOST = 'https://moved.example.org';

  function newFeedUrls(xml) {
    return [...xml.matchAll(/<itunes:new-feed-url>([^<]+)<\/itunes:new-feed-url>/g)].map((m) => m[1]);
  }

  /** Backdates the recorded move without waiting sixty days for it. */
  function backdate(days) {
    app.settings.setRaw(
      SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL_SET_AT,
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
    );
    app.feeds.invalidate();
  }

  it('is absent from a feed when no move has been recorded', async () => {
    await seed('no-move');
    const { xml } = await buildFeed('no-move');
    assert.ok(
      !xml.includes('itunes:new-feed-url'),
      'a show that has never moved must not tell apps to go anywhere',
    );
  });

  it('names the current feed URL once the base URL changes', async () => {
    const show = await seed('moved');
    app.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: NEW_HOST });

    const { xml } = await buildFeed('moved');
    assert.deepEqual(
      newFeedUrls(xml),
      [`${NEW_HOST}/feeds/moved/${show.feed_token}.xml`],
      'the element carries where the feed is now, not where it was',
    );

    // The same document is served at both addresses, so the value has to equal the
    // feed's own self link — an app already on the new address then does nothing.
    const self = xml.match(/<atom:link href="([^"]+)" rel="self"/)?.[1];
    assert.equal(newFeedUrls(xml)[0], self, 'new-feed-url and atom:link self must agree');
  });

  it('disappears once the move is forgotten', async () => {
    await seed('forgotten');
    app.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: NEW_HOST });
    assert.equal(newFeedUrls((await buildFeed('forgotten')).xml).length, 1);

    app.settings.forgetPreviousBaseUrl();

    const { xml } = await buildFeed('forgotten');
    assert.ok(!xml.includes('itunes:new-feed-url'), 'the owner said the move is done');
  });

  it('disappears once the recorded change is older than the window', async () => {
    await seed('expired-window');
    app.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: NEW_HOST });

    backdate(PREVIOUS_BASE_URL_WINDOW_DAYS - 1);
    assert.equal(
      newFeedUrls((await buildFeed('expired-window')).xml).length,
      1,
      'still inside the window, so apps that poll rarely still get moved',
    );

    backdate(PREVIOUS_BASE_URL_WINDOW_DAYS + 1);
    assert.ok(
      !newFeedUrls((await buildFeed('expired-window')).xml).length,
      'a forwarding note nobody switched off must not become permanent',
    );
  });

  /**
   * The cache entry is keyed on the base URL, so the previous one has to be part of
   * that key too. Without it the element outlives the state it is built from: it
   * lingers for up to a TTL after being switched off — and the expiry of the window,
   * which fires no event at all, would never invalidate anything.
   */
  it('changes within the same build rather than lingering behind the cache', async () => {
    const show = await seed('cache-forwarding');
    app.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: NEW_HOST });
    const before = app.feeds.build(show.id);
    assert.equal(newFeedUrls(before.xml).length, 1);

    // Deliberately no invalidate() and no event the feed cache listens to: only the
    // recorded timestamp moves, exactly as it does when the window quietly runs out.
    app.settings.setRaw(
      SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL_SET_AT,
      new Date(Date.now() - (PREVIOUS_BASE_URL_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString(),
    );

    const after = app.feeds.build(show.id);
    assert.ok(!after.xml.includes('itunes:new-feed-url'), 'the very next build must be honest');
    assert.notEqual(after.etag, before.etag, 'and the ETag moves with the body');
  });

  it('records the move whichever caller changes the address', async () => {
    // The setup wizard and the settings page are separate callers of settings.update;
    // recording in either route alone is how one of them silently forwards nobody.
    await seed('wizard-move');
    assert.equal(app.settings.previousPublicBaseUrl(), null);

    app.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: NEW_HOST });
    assert.equal(app.settings.previousPublicBaseUrl(), 'https://podcast.example.com');

    // Re-saving the same address is not a move, and must not restart the window.
    const setAt = app.settings.getRaw(SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL_SET_AT);
    app.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: `${NEW_HOST}/` });
    assert.equal(app.settings.previousPublicBaseUrl(), 'https://podcast.example.com');
    assert.equal(app.settings.getRaw(SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL_SET_AT), setAt);
  });

  it('is not exported to config.json, since a finished move must not come back', async () => {
    await seed('not-exported');
    app.settings.update({ [SETTING_KEYS.PUBLIC_BASE_URL]: NEW_HOST });
    await app.settings.exportToDisk();

    const exported = JSON.parse(await readFile(app.config.configPath, 'utf8'));
    assert.equal(exported[SETTING_KEYS.PUBLIC_BASE_URL], NEW_HOST);
    assert.ok(!(SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL in exported));
    assert.ok(!(SETTING_KEYS.PREVIOUS_PUBLIC_BASE_URL_SET_AT in exported));
  });
});

/**
 * Publish dates in the future.
 *
 * The episode form has always offered a datetime picker, and a date in the future
 * looked exactly like scheduling while publishing the episode immediately — the app
 * did something reasonable and never said it had.
 *
 * It also caused a quieter fault. `lastBuildDate` takes the newest timestamp among the
 * feed's items and clamps it to now; a future date always won that comparison, so the
 * clamp returned `Date.now()` on every rebuild, the build date churned every minute,
 * the ETag churned with it, and every conditional poll re-downloaded the whole feed for
 * as long as any episode carried a future date.
 */
describe('scheduled episodes', () => {
  function reschedule(show, offsetMs) {
    const episode = app.episodes.listByShow(show.id)[0];
    app.db
      .prepare('UPDATE episodes SET pub_date = ? WHERE id = ?')
      .run(new Date(Date.now() + offsetMs).toISOString(), episode.id);
    app.feeds.invalidate(show.id);
    return episode;
  }

  it('keeps an episode with a future publish date out of the feed', async () => {
    const show = await seed('sched');
    const episode = reschedule(show, 60 * 60 * 1000);

    const { xml } = await buildFeed('sched');
    assert.ok(!xml.includes(episode.id), 'a scheduled episode has no item in the feed');
    assert.ok(!xml.includes('<item>'), 'and with only that episode, the feed has no items at all');
  });

  it('puts it in the feed once its date has passed', async () => {
    const show = await seed('sched-due');
    const episode = reschedule(show, -60 * 1000);

    const { xml } = await buildFeed('sched-due');
    assert.ok(xml.includes(episode.id), 'once the time passes the episode publishes itself');
  });

  it('emits the scheduled instant as the item pubDate, not the moment it went live', async () => {
    const show = await seed('sched-date');
    // Far enough back that "the scheduled time" and "now" cannot be confused for
    // each other by a coarse comparison.
    const episode = reschedule(show, -3 * 60 * 60 * 1000);
    const stored = app.episodes.get(episode.id).pub_date;

    const { xml } = await buildFeed('sched-date');
    const published = xml.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1];
    assert.ok(published, 'the item carries a pubDate');
    assert.equal(
      new Date(published).getTime(),
      Math.floor(new Date(stored).getTime() / 1000) * 1000,
      'a subscriber is told when the owner said it was published, not when the feed noticed',
    );
    assert.ok(
      Date.now() - new Date(published).getTime() > 2 * 60 * 60 * 1000,
      'and that is hours ago, not the moment of the build',
    );
  });

  it('keeps lastBuildDate and the ETag still while an episode is scheduled', async () => {
    const show = await seed('sched-stable');
    reschedule(show, 24 * 60 * 60 * 1000);

    const first = app.feeds.build(show.id);
    app.feeds.invalidate(show.id);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = app.feeds.build(show.id);

    assert.equal(
      second.etag,
      first.etag,
      'a rebuild a second later must not churn the ETag, or every poll re-downloads the feed',
    );
    assert.equal(
      second.lastModified.getTime(),
      first.lastModified.getTime(),
      'and the build date holds still too',
    );
  });

  it('counts a scheduled episode apart from the ones in the feed', async () => {
    const show = await seed('sched-counts');
    reschedule(show, 60 * 60 * 1000);

    const counts = app.episodes.counts(show.id);
    assert.equal(counts.scheduled, 1, 'it is counted as scheduled');
    assert.equal(counts.inFeed, 0, 'and not as in the feed');
    assert.equal(counts.active, 1, 'while still being an ordinary active episode');
    assert.equal(
      counts.inFeed,
      app.episodes.listForFeed(show.id).length,
      'inFeed is exactly what the feed query returns, or the two have drifted',
    );
  });

  it('does not treat a removed episode with a future date as scheduled', async () => {
    const show = await seed('sched-removed');
    const episode = reschedule(show, 60 * 60 * 1000);
    app.episodes.removeFromFeed(episode.id);

    assert.equal(
      app.episodes.isScheduled(app.episodes.get(episode.id)),
      false,
      'removed means the owner took it out, which is not the same as waiting',
    );
  });

  it('leaves a schedule alone across a rescan', async () => {
    const show = await seed('sched-rescan');
    const episode = reschedule(show, 60 * 60 * 1000);
    const before = app.episodes.get(episode.id).pub_date;

    await app.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    assert.equal(
      app.episodes.get(episode.id).pub_date,
      before,
      'a scan must never move a publish date the owner set',
    );
  });
});

describe('per-episode artwork in the feed', () => {
  async function seedWithArt(slug, { cover = true, art = true } = {}) {
    const dir = await app.makeShowFolder(slug);
    if (art) {
      await writeFile(
        join(dir, 'ep-one.mp3'),
        await mp3WithEmbeddedArtwork(
          await sharp({ create: { width: 1500, height: 1500, channels: 3, background: '#204020' } })
            .jpeg()
            .toBuffer(),
        ),
      );
    } else {
      await app.addAudio(slug, 'sample.mp3', 'ep-one.mp3');
    }
    if (cover) {
      await writeFile(
        join(dir, 'cover.jpg'),
        await sharp({ create: { width: 1500, height: 1500, channels: 3, background: '#3E2D4A' } })
          .jpeg()
          .toBuffer(),
      );
    }
    await app.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    return app.shows.getBySlug(slug);
  }

  /** The `<itunes:image>` inside `<item>`, as opposed to the channel's own. */
  function itemImages(xml) {
    const items = xml.split('<item>').slice(1);
    return items.flatMap((item) => [...item.matchAll(/<itunes:image href="([^"]+)"/g)].map((m) => m[1]));
  }

  it('points an item at the episode’s own artwork when it has some', async () => {
    const show = await seedWithArt('art-own');
    const [episode] = app.episodes.listByShow(show.id);
    const { xml } = await buildFeed('art-own');

    const [href] = itemImages(xml);
    assert.ok(href, 'the item should carry an image');
    assert.ok(
      href.startsWith(
        `https://podcast.example.com/media/art-own/${show.feed_token}/${episode.id}/cover.jpg`,
      ),
      `episode artwork URL expected, got ${href}`,
    );
  });

  it('busts the cache with the artwork’s own content hash', async () => {
    const show = await seedWithArt('art-hash');
    const [episode] = app.episodes.listByShow(show.id);
    const { xml } = await buildFeed('art-hash');

    const [href] = itemImages(xml);
    // The hash and not a timestamp: replacing the image gives it a URL nothing has
    // cached, and re-extracting the identical image leaves the URL alone.
    assert.ok(href.endsWith(`?v=${episode.art_etag}`), `expected the art hash in ${href}`);
    assert.match(episode.art_etag, /^[0-9a-f]{64}$/);
  });

  it('falls back to the show cover for an episode with no artwork of its own', async () => {
    const show = await seedWithArt('art-fallback', { art: false });
    const { xml } = await buildFeed('art-fallback');

    const [href] = itemImages(xml);
    assert.ok(
      href.startsWith(`https://podcast.example.com/media/art-fallback/${show.feed_token}/cover.jpg`),
      `show cover URL expected, got ${href}`,
    );
  });

  it('omits the element entirely when there is neither', async () => {
    await seedWithArt('art-none', { art: false, cover: false });
    const { xml } = await buildFeed('art-none');

    assert.deepEqual(itemImages(xml), [], 'no artwork anywhere means no element, never an empty one');
  });
});
