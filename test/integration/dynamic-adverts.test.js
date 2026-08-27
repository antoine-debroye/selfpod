import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SEGMENT_SOURCES, SEGMENT_STATUS } from '../../src/constants.js';
import { SETTING_KEYS } from '../../src/services/settings.js';
import { createTestInstance } from '../helpers/harness.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';

const framesFor = (seconds) => Math.round((seconds * 1000) / FRAME_MS);

let app;
let server;
let origin;
let audioRequests;
/** What the sentinel stitches into the episode right now. */
let advert;
/** How long the advert the sentinel is currently inserting runs for. */
let advertSeconds;

/**
 * One episode, with whichever advert the host is currently inserting.
 *
 * The programme either side is the same audio every time, which is what makes the
 * difference between two downloads identify the advert exactly. The channel mode
 * changes across the join, as it does when an advert is encoded separately — which is
 * also the signal that makes SelfPod willing to spend a second download at all.
 */
function episode(advertSeed, advertSeconds = 20) {
  return stitch(
    segment(10_000, framesFor(30), { channelMode: 'joint' }),
    segment(advertSeed, framesFor(advertSeconds), { channelMode: 'stereo' }),
    segment(90_000, framesFor(30), { channelMode: 'joint' }),
  );
}

function rss() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Tape Club</title><language>en-gb</language>
<item><title>An interview with someone</title><guid isPermaLink="false">a</guid>
<pubDate>${new Date('2025-03-04T09:00:00Z').toUTCString()}</pubDate>
<itunes:duration>4800</itunes:duration>
<enclosure url="${origin}/audio/a.mp3" type="audio/mpeg" length="900000"/></item>
</channel></rss>`;
}

beforeEach(async () => {
  audioRequests = [];
  advert = 50_000;
  advertSeconds = 20;

  server = createServer((req, res) => {
    if (req.url.startsWith('/audio/')) {
      audioRequests.push(req.url);
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(episode(advert, advertSeconds));
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    return res.end(rss());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  app = await createTestInstance({ env: { ALLOW_PRIVATE_FEED_HOSTS: '127.0.0.1' } });
  app.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '1' });
  await app.makeShowFolder('tape-club');
  await app.scanner.scanAllNow('manual');
});

afterEach(async () => {
  await app.cleanup();
  await new Promise((resolve) => server.close(resolve));
});

/** Subscribes, downloads the one episode, and returns the show and the ledger row. */
async function take({ mode = 'review' } = {}) {
  const show = app.shows.getBySlug('tape-club');
  app.db.prepare('UPDATE shows SET ad_trim_mode = ? WHERE id = ?').run(mode, show.id);
  const subscription = app.subscriptions.create(show.id, {
    feedUrl: `${origin}/feed.xml`,
    backfillCount: 10,
  });
  await app.remoteFeeds.pollNow(subscription.id);
  const [item] = app.subscriptions.items({ subscriptionId: subscription.id });
  return { show: app.shows.get(show.id), subscription, item };
}

/** Moves the deadline into the past, as a day passing would. */
function makeDue(itemId) {
  app.subscriptions.markItem(itemId, {
    recheck_after: new Date(Date.now() - 60_000).toISOString(),
  });
}

describe('deciding whether an episode is worth downloading twice', () => {
  it('marks one whose audio changes format part-way through', async () => {
    const { item } = await take();

    assert.equal(item.decision, 'downloaded');
    assert.ok(item.recheck_after, 'a stitched-looking episode was not marked for a second look');
    assert.match(item.recheck_reason, /channelMode/, `unhelpful reason: ${item.recheck_reason}`);
    // A day, not minutes. The host caches its stitch per listener, and two requests
    // from this container seconds apart are the same listener by construction.
    const wait = new Date(item.recheck_after) - Date.now();
    assert.ok(wait > 23 * 3600_000, `only waiting ${Math.round(wait / 3600_000)}h`);
  });

  it('marks one that arrives longer than the feed said it would be', async () => {
    // The signal that found this in the wild, and the only one that fires on a host
    // which serves cleanly encoded audio. The feed says how long the programme runs; an
    // advert stitched in on the way out does not change that number, so audio past the
    // stated length is audio the publisher did not count.
    //
    // The episode here is deliberately innocent in every other respect — one encode,
    // one format, no header to disagree with — exactly as the real files were.
    const plain = stitch(segment(10_000, framesFor(80)));
    server.close();
    server = createServer((req, res) => {
      if (req.url.startsWith('/audio/')) {
        audioRequests.push(req.url);
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(plain);
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      // The feed claims a minute; the file is eighty seconds.
      return res.end(rss().replace('<itunes:duration>4800</itunes:duration>', '<itunes:duration>60</itunes:duration>'));
    });
    await new Promise((resolve) => server.listen(Number(origin.split(':')[2]), '127.0.0.1', resolve));

    const { item } = await take();

    assert.equal(item.decision, 'downloaded');
    assert.ok(item.recheck_after, 'an episode 20s longer than declared was not marked for a second look');
    assert.match(item.recheck_reason, /longer than the 60s the feed states/);
  });

  it('leaves an ordinary episode alone', async () => {
    // The case that has to be right: a second download is a second counted listen in
    // the publisher's figures for an episode taken once.
    const plain = stitch(segment(10_000, framesFor(80)));
    server.close();
    server = createServer((req, res) => {
      if (req.url.startsWith('/audio/')) {
        audioRequests.push(req.url);
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(plain);
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(rss());
    });
    await new Promise((resolve) => server.listen(Number(origin.split(':')[2]), '127.0.0.1', resolve));

    const { item } = await take();

    assert.equal(item.decision, 'downloaded');
    assert.equal(item.recheck_after, null, 'a plainly-encoded episode was queued for a second download');
  });
});

describe('the second download', () => {
  it('is not made before the day is up', async () => {
    const { item } = await take();
    assert.equal(audioRequests.length, 1);

    const result = await app.remoteFeeds.recheckDue();

    assert.equal(result.rechecked, 0);
    assert.equal(audioRequests.length, 1, 'it went back for the audio early');
    assert.equal(app.subscriptions.getItem(item.id).rechecked_at, null);
  });

  it('finds exactly the audio that changed, and calls it an advert', async () => {
    const { show, item } = await take();
    makeDue(item.id);
    // A day has passed and the host is now inserting a different advert.
    advert = 777_000;

    const result = await app.remoteFeeds.recheckDue();

    assert.equal(result.rechecked, 1);
    assert.equal(audioRequests.length, 2);
    assert.equal(app.subscriptions.getItem(item.id).recheck_outcome, 'differs');

    const [found] = app.adDetect.listSegments(show.id).filter((row) => row.source === SEGMENT_SOURCES.DIFF);
    assert.ok(found, 'the difference between two downloads was not recorded');
    assert.ok(
      Math.abs(found.duration_ms / 1000 - 20) < 1.5,
      `a 20s advert was recorded as ${(found.duration_ms / 1000).toFixed(1)}s`,
    );
    // It starts where the programme's first half ends, not at zero.
    assert.ok(
      Math.abs(found.exemplar_start_ms / 1000 - 30) < 1.5,
      `recorded as starting at ${(found.exemplar_start_ms / 1000).toFixed(1)}s`,
    );
  });

  it('cuts what the copy on disk contains, not what the second copy contained', async () => {
    // The adverts in two stitches are rarely the same length, and everything after
    // the first one therefore sits at a different offset in each file. Frame ranges
    // taken from the second copy and applied to the first cut the wrong audio — the
    // programme, silently, at an offset nobody would think to check. Both files here
    // are deliberately different lengths so the two answers cannot coincide.
    const { show, item } = await take();
    makeDue(item.id);
    advert = 777_000;
    advertSeconds = 45;

    await app.remoteFeeds.recheckDue();

    const [found] = app.adDetect.listSegments(show.id).filter((row) => row.source === SEGMENT_SOURCES.DIFF);
    assert.ok(found, 'nothing was recorded');
    assert.ok(
      Math.abs(found.duration_ms / 1000 - 20) < 1.5,
      `the advert in the file on disk is 20s; recorded ${(found.duration_ms / 1000).toFixed(1)}s — the length of the one in the second copy is 45s`,
    );

    // And the frames named have to be the advert's, in the file that is on the share.
    const occurrence = app.db
      .prepare('SELECT * FROM ad_segment_occurrences WHERE segment_id = ?')
      .get(found.id);
    assert.equal(occurrence.start_frame, framesFor(30), 'the cut starts in the wrong place');
    assert.equal(occurrence.end_frame, framesFor(50), 'the cut ends in the wrong place');
  });

  it('does not keep the second copy', async () => {
    // The copy on the share is the one the owner has. Replacing it with a
    // differently-advertised one would be a strange thing to do to a file they can see.
    const { item } = await take();
    const { readdir } = await import('node:fs/promises');
    const before = await readdir(join(app.config.showsDir, 'tape-club'));
    makeDue(item.id);
    advert = 777_000;

    await app.remoteFeeds.recheckDue();

    assert.deepEqual(await readdir(join(app.config.showsDir, 'tape-club')), before);
    assert.deepEqual(await readdir(app.config.tempDir), [], 'the second copy was left in the temp folder');
  });

  it('does not ask again once it has looked', async () => {
    // "We looked and it was the same" is the answer most of the time. Re-asking it
    // every day would be the whole cost of the feature for none of the benefit.
    const { item } = await take();
    makeDue(item.id);

    await app.remoteFeeds.recheckDue();
    assert.equal(app.subscriptions.getItem(item.id).recheck_outcome, 'identical');
    assert.equal(audioRequests.length, 2);

    await app.remoteFeeds.recheckDue();
    assert.equal(audioRequests.length, 2, 'it went back a third time for nothing');
  });

  it('records that two identical downloads taught it nothing', async () => {
    const { show, item } = await take();
    makeDue(item.id);
    // The host serves the same stitch, which is what a cache hit looks like and is
    // what most second downloads get.

    await app.remoteFeeds.recheckDue();

    assert.equal(app.subscriptions.getItem(item.id).recheck_outcome, 'identical');
    assert.equal(
      app.adDetect.listSegments(show.id).filter((row) => row.source === SEGMENT_SOURCES.DIFF).length,
      0,
      'it invented an advert out of two identical files',
    );
  });

  it('says so when the difference is only in the copy it did not keep', async () => {
    // The host is stitching, but this download came back without the advert the other
    // one had. There is nothing in the file on the share to remove. Recording that as
    // "the same" would be untrue, and would hide the fact that the show does insert
    // adverts dynamically.
    const { show, item } = await take();
    makeDue(item.id);
    // Same programme, plus an advert the copy on disk does not have.
    const longer = stitch(
      segment(10_000, framesFor(30), { channelMode: 'joint' }),
      segment(50_000, framesFor(20), { channelMode: 'stereo' }),
      segment(90_000, framesFor(30), { channelMode: 'joint' }),
      segment(600_000, framesFor(25), { channelMode: 'stereo' }),
    );
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url.startsWith('/audio/')) {
        audioRequests.push(req.url);
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(longer);
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(rss());
    });

    await app.remoteFeeds.recheckDue();

    assert.equal(app.subscriptions.getItem(item.id).recheck_outcome, 'differs_elsewhere');
    assert.equal(
      app.adDetect.listSegments(show.id).length,
      0,
      'it recorded a cut for audio that is not in the file it has',
    );
  });

  it('refuses to cut anything when the two files have nothing in common', async () => {
    // Not two stitches of one episode — more likely the publisher replaced the audio.
    // Treating that as an advert would remove the whole programme.
    const { show, item } = await take();
    makeDue(item.id);
    const replaced = stitch(segment(500_000, framesFor(80)));
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      if (req.url.startsWith('/audio/')) {
        audioRequests.push(req.url);
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(replaced);
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(rss());
    });

    await app.remoteFeeds.recheckDue();

    assert.equal(app.subscriptions.getItem(item.id).recheck_outcome, 'not_comparable');
    assert.equal(
      app.adDetect.listSegments(show.id).length,
      0,
      'it offered to cut audio on the strength of a replaced file',
    );
  });

  it('takes only a couple at a time', async () => {
    // This re-fetches episodes SelfPod already has, and each one counts again in the
    // publisher's figures, so it is a trickle rather than a sweep.
    const { subscription } = await take();
    const rows = [];
    for (let n = 0; n < 5; n += 1) {
      const created = app.subscriptions.upsertItem(subscription.id, {
        guid: `extra-${n}`,
        guidSource: 'guid',
        title: `Extra ${n}`,
        enclosureUrl: `${origin}/audio/extra-${n}.mp3`,
        pubDate: new Date().toISOString(),
      });
      app.subscriptions.markItem(created.id, {
        decision: 'downloaded',
        episode_id: app.episodes.listByShow(app.shows.getBySlug('tape-club').id)[0].id,
        recheck_after: new Date(Date.now() - 60_000).toISOString(),
      });
      rows.push(created);
    }
    const before = audioRequests.length;

    await app.remoteFeeds.recheckDue();

    assert.equal(audioRequests.length - before, 2, 'it fetched more than a couple in one go');
  });
});

describe('what the difference is treated as', () => {
  it('is approved without the guards a merely-repeated segment faces', async () => {
    // A theme tune is in both copies of an episode, so it cannot be what differs
    // between them. Anything found this way is an advert by construction.
    const { show, item } = await take({ mode: 'auto' });
    makeDue(item.id);
    advert = 777_000;

    await app.remoteFeeds.recheckDue();

    const [found] = app.adDetect.listSegments(show.id).filter((row) => row.source === SEGMENT_SOURCES.DIFF);
    assert.ok(found);
    assert.equal(found.status, SEGMENT_STATUS.APPROVED);
    assert.equal(found.auto_approved, 1);
    assert.equal(found.hold_reason, null, 'a diffed segment was held back by a corpus guard');
  });

  it('waits to be asked in review mode, like everything else', async () => {
    const { show, item } = await take({ mode: 'review' });
    makeDue(item.id);
    advert = 777_000;

    await app.remoteFeeds.recheckDue();

    const [found] = app.adDetect.listSegments(show.id).filter((row) => row.source === SEGMENT_SOURCES.DIFF);
    assert.equal(found.status, SEGMENT_STATUS.CANDIDATE);
  });
});
