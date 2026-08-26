import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SEGMENT_STATUS } from '../../src/constants.js';
import { frameProfile } from '../../src/lib/mp3-frames.js';
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

/** Programme, a 40s sponsor read at 45s in, more programme. */
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

describe('listing what a show repeats', () => {
  it('describes each segment well enough to decide without listening', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);

    const body = (await server.get(`/api/shows/${show.id}/ad-segments`)).json();

    assert.equal(body.mode, 'review');
    assert.ok(body.segments.length > 0, 'nothing was offered to review');
    const [found] = body.segments;
    assert.equal(found.status, SEGMENT_STATUS.CANDIDATE);
    assert.equal(found.episodeCount, 3);
    assert.match(found.durationLabel, /^\d+:\d\d$/);
    assert.ok(
      Math.abs(found.durationSeconds - 40) < 1,
      `a 40s sponsor read was described as ${found.durationSeconds}s`,
    );
    // Position is what separates a sponsor read from a theme tune faster than
    // anything else, so it is stated in words rather than left as offsets.
    assert.match(found.positionLabel, /every time/i);
    assert.match(found.sourceLabel, /repeats across 3 episodes/i);
    assert.ok(found.exemplar?.sampleUrl, 'there is no way to hear it');
  });

  it('says how many episodes are being held, not just that something is pending', async () => {
    // A page that says "waiting" without saying what for is how an operator decides
    // the feature is broken.
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);

    const body = (await server.get(`/api/shows/${show.id}/ad-segments`)).json();

    assert.equal(body.held, 3);
    assert.equal(body.awaiting, body.segments.length);
  });

  it('does not claim a segment is an advert', async () => {
    // SelfPod cannot tell a theme tune from a sponsor read, and a label that implied
    // it could would be the one thing that made the review meaningless.
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);

    const response = await server.get(`/api/shows/${show.id}/ad-segments`);
    const raw = response.body;

    // The positive control: an error page or an empty list would satisfy the negative
    // assertion below without the code under test ever having run.
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().segments.length > 0, 'there was nothing here to make a claim about');
    assert.ok(!/"(isAdvert|advert|confidence)"\s*:/.test(raw), `it claimed to know: ${raw.slice(0, 400)}`);
  });
});

describe('deciding about a segment', () => {
  it('cuts the audio as part of the same request', async () => {
    // A decision that has not reached the audio has not really been taken, and having
    // to wait for a scheduler tick to find out is how you conclude it did not work.
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [found] = server.adDetect.listSegments(show.id);

    const response = await server.request({
      method: 'POST',
      url: `/api/ad-segments/${found.id}/decide`,
      payload: { status: SEGMENT_STATUS.APPROVED },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().trimmed, 3);
    for (const episode of server.episodes.listByShow(show.id)) {
      assert.ok(episode.trimmed_filename, `${episode.filename} was not cut`);
      assert.equal(episode.publish_hold, null, `${episode.filename} is still held`);
    }
  });

  it('lets the episodes out of the feed once nothing is outstanding', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const feedUrl = `/feeds/${show.slug}/${show.feed_token}.xml`;
    assert.equal((await server.app.inject({ method: 'GET', url: feedUrl })).body.includes('<item>'), false);

    for (const found of server.adDetect.listSegments(show.id)) {
      await server.request({
        method: 'POST',
        url: `/api/ad-segments/${found.id}/decide`,
        payload: { status: SEGMENT_STATUS.REJECTED },
      });
    }

    // Rejected, not approved — so nothing is cut, and the episodes go out whole.
    const body = (await server.app.inject({ method: 'GET', url: feedUrl })).body;
    assert.equal(body.match(/<item>/g).length, 3);
    assert.ok(!body.includes('?v='), 'something was cut despite being rejected');
  });

  it('refuses a decision that is not one', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [found] = server.adDetect.listSegments(show.id);

    const response = await server.request({
      method: 'POST',
      url: `/api/ad-segments/${found.id}/decide`,
      payload: { status: 'maybe' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'unknown_status');
  });
});

describe('hearing the segment before deciding', () => {
  it('returns the segment alone, playable, and not the episode around it', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [found] = server.adDetect.listSegments(show.id);

    const response = await server.get(`/api/ad-segments/${found.id}/sample.mp3`);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'audio/mpeg');
    const frames = frameProfile(response.rawPayload).frameCount;
    assert.ok(
      Math.abs(frames * (FRAME_MS / 1000) - 40) < 1.5,
      `expected about 40s of audio, got ${(frames * (FRAME_MS / 1000)).toFixed(1)}s`,
    );
    // And it is genuinely a fraction of the episode it came from.
    const episode = server.episodes.get(found.occurrences[0].episode_id);
    assert.ok(frames < frameProfile(await originalOf(episode)).frameCount / 2);
  });

  it('is not cached anywhere, because the episode under it can change', async () => {
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [found] = server.adDetect.listSegments(show.id);

    const response = await server.get(`/api/ad-segments/${found.id}/sample.mp3`);

    assert.match(response.headers['cache-control'], /no-store/);
  });

  it('needs the admin session', async () => {
    // It reads an episode off the disk and returns part of it. That is a tool for
    // deciding, not a way to publish.
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    const [found] = server.adDetect.listSegments(show.id);

    const response = await server.app.inject({
      method: 'GET',
      url: `/api/ad-segments/${found.id}/sample.mp3`,
    });

    assert.equal(response.statusCode, 401);
  });
});

describe('turning the feature on and off', () => {
  it('releases the held episodes in the same request that switches it off', async () => {
    // Not on the next tick. Waiting five minutes to see whether a setting worked is
    // how an operator concludes it did not.
    const show = await makeShow();
    await server.adPipeline.processShow(show.id);
    assert.equal(server.episodes.counts(show.id).held, 3);

    const response = await server.request({
      method: 'PATCH',
      url: `/api/shows/${show.id}/ad-trim`,
      payload: { mode: 'off' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().released, 3);
    assert.equal(server.episodes.counts(show.id).held, 0);
  });

  it('refuses a mode it does not have', async () => {
    const show = await makeShow();
    const response = await server.request({
      method: 'PATCH',
      url: `/api/shows/${show.id}/ad-trim`,
      payload: { mode: 'aggressive' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'unknown_ad_trim_mode');
  });

  it('refuses a comparison window that cannot compare anything', async () => {
    const show = await makeShow();
    const response = await server.request({
      method: 'PATCH',
      url: `/api/shows/${show.id}/ad-trim`,
      payload: { minEpisodes: 1 },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /between 2 and 20/);
  });

  it('will not read your episodes for a show that has it switched off', async () => {
    const show = await makeShow({ mode: 'off' });
    const response = await server.request({ method: 'POST', url: `/api/shows/${show.id}/ad-detect` });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'ad_trim_off');
  });
});

async function originalOf(episode) {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(showDir, episode.filename));
}
