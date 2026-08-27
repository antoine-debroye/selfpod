import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SEGMENT_STATUS } from '../../src/constants.js';
import { createTestServer } from '../helpers/http.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';

const framesFor = (seconds) => Math.round((seconds * 1000) / FRAME_MS);

let server;
let showDir;

beforeEach(async () => {
  server = await createTestServer();
  showDir = await server.makeShowFolder('tape-club');
  await server.login();
});

afterEach(async () => {
  await server.cleanup();
});

async function makeShow({ mode = 'review', count = 3 } = {}) {
  await writeFile(join(showDir, '.keep'), '');
  await server.scanner.scanAllNow('manual');
  const show = server.shows.getBySlug('tape-club');
  server.db.prepare('UPDATE shows SET ad_trim_mode = ? WHERE id = ?').run(mode, show.id);
  for (let n = 0; n < count; n += 1) {
    await writeFile(
      join(showDir, `episode-${n}.mp3`),
      stitch(
        segment(100_000 + n * 50_000, framesFor(45)),
        segment(2_000, framesFor(40)),
        segment(600_000 + n * 50_000, framesFor(45)),
      ),
    );
  }
  await server.scanner.scanAllNow('manual');
  return server.shows.get(show.id);
}

const page = (path) => server.get(path);
const post = (url, payload) =>
  server.request({
    method: 'POST',
    url,
    payload: new URLSearchParams(payload).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
const htmxPost = (url, payload) =>
  server.request({
    method: 'POST',
    url,
    payload: new URLSearchParams(payload).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true' },
  });

describe('the adverts page', () => {
  it('says what SelfPod cannot tell, rather than implying it can', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);

    const body = (await page(`/shows/${show.slug}/adverts`)).body;

    assert.match(body, /cannot tell a sponsor read\s*\n?\s*from a theme tune/i);
    assert.ok(!/\bdetected ad\b|\bthis is an ad\b/i.test(body), 'it claimed to know what an advert is');
  });

  it('offers a way to hear each segment before deciding', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [found] = server.adDetect.listSegments(show.id);

    const body = (await page(`/shows/${show.slug}/adverts`)).body;

    assert.ok(body.includes(`/api/ad-segments/${found.id}/sample.mp3`), 'no way to listen');
    // Not preloaded: a review session can hold a dozen of these, and each is a slice
    // of a real episode read off the disk.
    assert.match(body, /preload="none"/);
  });

  it('describes where the audio sits, in words', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);

    const body = (await page(`/shows/${show.slug}/adverts`)).body;

    assert.match(body, /every time|very start|very end|Between/i);
  });

  it('says how many episodes are being held, and why', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);

    const body = (await page(`/shows/${show.slug}/adverts`)).body;

    assert.match(body, /3 episodes are waiting/i);
    assert.match(body, /published as soon as you have decided/i);
  });
});

describe('a show whose episodes cannot be compared byte for byte', () => {
  it('says it looked and found nothing, rather than "not yet" for ever', async () => {
    // Comparing episodes finds audio that is *encoded* identically. A show mastered
    // and encoded in one pass has its theme tune encoded afresh every episode — same
    // sound, different bytes — and no number of further episodes will change that.
    // Measured on three real Planet Money episodes: nine matching frames out of
    // ninety thousand. Leaving someone on "nothing found yet" is a wait with no end.
    const show = await makeShow({ mode: 'review', count: 0 });
    for (let n = 0; n < 3; n += 1) {
      await writeFile(join(showDir, `unique-${n}.mp3`), stitch(segment(100_000 + n * 400_000, framesFor(90))));
    }
    await server.scanner.scanAllNow('manual');
    await server.adPipeline.processShow(show.id);

    const body = (await page(`/shows/${show.slug}/adverts`)).body;

    assert.match(body, /compared 3 episodes and found no repeated audio/i);
    assert.ok(!/nothing found yet/i.test(body), 'it told them to keep waiting');
    // And it points at the detector that does still apply.
    assert.match(body, /fetching one episode twice/i);
  });

  it('does not announce a verdict before it has listened to anything', async () => {
    // The bug this replaces was reported by the page itself. A real show was switched
    // on, and while it was still decoding its episodes the page said "SelfPod compared
    // 5 episodes and found no repeated audio". A minute later three segments were
    // sitting underneath that sentence.
    //
    // It was counting MP3 files in the folder rather than episodes it had listened to,
    // and those two numbers differ for exactly as long as the work takes.
    const show = await makeShow({ mode: 'review', count: 0 });
    for (let n = 0; n < 3; n += 1) {
      await writeFile(join(showDir, `unread-${n}.mp3`), stitch(segment(100_000 + n * 400_000, framesFor(90))));
    }
    await server.scanner.scanAllNow('manual');
    // Scanned, so the files are there — but nothing has been fingerprinted yet.

    const body = (await page(`/shows/${show.slug}/adverts`)).body;

    assert.ok(
      !/found no repeated audio/i.test(body),
      'it declared a result before comparing anything',
    );
    assert.match(body, /nothing found yet/i);
  });

  it('still says "not yet" when it genuinely has not looked at enough', async () => {
    const show = await makeShow({ mode: 'review', count: 0 });
    await writeFile(join(showDir, 'one.mp3'), stitch(segment(100_000, framesFor(90))));
    await server.scanner.scanAllNow('manual');
    await server.adPipeline.processShow(show.id);

    const body = (await page(`/shows/${show.slug}/adverts`)).body;

    assert.match(body, /nothing found yet/i);
    assert.ok(!/found no repeated audio/i.test(body));
  });
});

describe('the show page', () => {
  it('says an episode is being held, where someone would go looking for it', async () => {
    // This is where you come when an episode has not appeared. Being told only on
    // another page is how the feature gets reported as broken.
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);

    const body = (await page(`/shows/${show.slug}`)).body;

    assert.match(body, /3 episodes are not in your feed yet/i);
    assert.ok(body.includes(`/shows/${show.slug}/adverts`), 'no way to get to the decision');
  });

  it('says nothing about holds when there are none', async () => {
    const show = await makeShow({ mode: 'off' });

    const body = (await page(`/shows/${show.slug}`)).body;

    assert.ok(!/not in your feed yet/i.test(body));
    // The positive control: the page did render, and the link is there regardless.
    assert.ok(body.includes(`/shows/${show.slug}/adverts`));
  });
});

describe('deciding from the page', () => {
  it('cuts the audio and re-renders without a reload', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [found] = server.adDetect.listSegments(show.id);

    const response = await htmxPost(`/ui/shows/${show.slug}/ad-segments/${found.id}`, {
      status: SEGMENT_STATUS.APPROVED,
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Already decided/);
    assert.match(response.body, /Removed/);
    for (const episode of server.episodes.listByShow(show.id)) {
      assert.ok(episode.trimmed_filename, `${episode.filename} was not cut`);
    }
  });

  it('works without JavaScript, redirecting with a message', async () => {
    // Every interaction in this app has a plain-form action on the same URL.
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [found] = server.adDetect.listSegments(show.id);

    const response = await post(`/ui/shows/${show.slug}/ad-segments/${found.id}`, {
      status: SEGMENT_STATUS.APPROVED,
    });

    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, `/shows/${show.slug}/adverts`);
    assert.equal(server.episodes.listByShow(show.id)[0].trimmed_filename !== null, true);
  });

  it('offers to reverse a decision already taken', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [found] = server.adDetect.listSegments(show.id);
    await htmxPost(`/ui/shows/${show.slug}/ad-segments/${found.id}`, { status: SEGMENT_STATUS.APPROVED });

    const body = (await page(`/shows/${show.slug}/adverts`)).body;
    assert.match(body, /Put it back/);

    const response = await htmxPost(`/ui/shows/${show.slug}/ad-segments/${found.id}`, {
      status: SEGMENT_STATUS.REJECTED,
    });

    assert.match(response.body, /Kept/);
    assert.equal(
      server.episodes.get(server.episodes.listByShow(show.id)[0].id).trimmed_filename,
      null,
      'putting it back left the cut in place',
    );
  });

  it('refuses a segment belonging to another show', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [found] = server.adDetect.listSegments(show.id);
    const other = await server.makeShowFolder('other-club');
    await writeFile(join(other, 'x.mp3'), stitch(segment(1, framesFor(10))));
    await server.scanner.scanAllNow('manual');

    const response = await htmxPost(`/ui/shows/other-club/ad-segments/${found.id}`, {
      status: SEGMENT_STATUS.APPROVED,
    });

    assert.equal(response.statusCode, 404);
    assert.equal(
      server.adDetect.getSegment(found.id).status,
      SEGMENT_STATUS.CANDIDATE,
      'the decision went through anyway',
    );
  });
});

describe('changing what SelfPod does', () => {
  it('releases the held episodes in the same request', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    assert.equal(server.episodes.counts(show.id).held, 3);

    const response = await htmxPost(`/ui/shows/${show.slug}/ad-trim`, { mode: 'off', minEpisodes: '3' });

    assert.equal(response.statusCode, 200);
    assert.equal(server.episodes.counts(show.id).held, 0);
    assert.match(response.body, /not looking for repeated audio/i);
  });

  it('says how many episodes came back, when the form is a plain POST', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);

    const response = await post(`/ui/shows/${show.slug}/ad-trim`, { mode: 'off', minEpisodes: '3' });

    assert.equal(response.statusCode, 303);
    const flash = (await page(`/shows/${show.slug}/adverts`)).body;
    assert.match(flash, /3 episodes are now in your feed/i);
  });

  it('keeps the current setting rather than accepting a mode it does not have', async () => {
    const show = await makeShow();

    await htmxPost(`/ui/shows/${show.slug}/ad-trim`, { mode: 'aggressive', minEpisodes: '3' });

    assert.equal(server.shows.get(show.id).ad_trim_mode, 'review', 'a made-up mode was stored');
  });

  it('keeps the current window rather than accepting one that compares nothing', async () => {
    const show = await makeShow();

    await htmxPost(`/ui/shows/${show.slug}/ad-trim`, { mode: 'review', minEpisodes: '1' });

    assert.equal(server.shows.get(show.id).ad_auto_min_episodes, 3);
  });

  it('will not read the episodes of a show that has it switched off', async () => {
    const show = await makeShow({ mode: 'off' });

    const response = await post(`/ui/shows/${show.slug}/ad-detect`, {});

    assert.equal(response.statusCode, 303);
    assert.equal(server.adDetect.listSegments(show.id).length, 0);
  });
});

describe('text that came from somewhere else', () => {
  it('is escaped where an episode title reaches the page', async () => {
    // An episode subscribed from a remote feed carries that feed's title, and this
    // page renders it beside the audio. `<%~` is this app's raw sink; everything here
    // uses `<%=`, and this is what says so.
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [episode] = server.episodes.listByShow(show.id);
    server.episodes.setSystemFields(episode.id, {
      title: '<img src=x onerror="alert(1)">Ep',
    });

    const body = (await page(`/shows/${show.slug}/adverts`)).body;

    // Positive control first: the title did reach the page, so the absence below is
    // about escaping and not about the value never arriving.
    assert.ok(body.includes('&lt;img src=x'), 'the title never reached the page at all');
    assert.ok(!body.includes('<img src=x'), 'remote text was rendered as markup');
  });
});

describe('signing in', () => {
  it('is required for the adverts page', async () => {
    const show = await makeShow();
    const response = await server.app.inject({ method: 'GET', url: `/shows/${show.slug}/adverts` });
    assert.ok([302, 303, 401].includes(response.statusCode), `got ${response.statusCode}`);
  });
});
