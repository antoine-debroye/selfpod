import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FIXTURE_DIR } from '../helpers/harness.js';
import { createTestServer } from '../helpers/http.js';

/**
 * The JSON API around a jingle found by sound (spec §19.9), exercised over real
 * fixture audio the way `ad-anchor.test.js` builds it — see that file's own header
 * for why synthetic frame noise will not do here.
 */
const JINGLE = readFileSync(join(FIXTURE_DIR, 'theme-48k.mp3'));
const PROGRAMME_A = readFileSync(join(FIXTURE_DIR, 'prog-a.mp3'));
const PROGRAMME_B = readFileSync(join(FIXTURE_DIR, 'prog-b.mp3'));
const PROGRAMME_C = readFileSync(join(FIXTURE_DIR, 'prog-c.mp3'));
const PREROLL_A = readFileSync(join(FIXTURE_DIR, 'sponsor-en-daniel.mp3'));
const PREROLL_B = readFileSync(join(FIXTURE_DIR, 'sponsor-en-samantha.mp3'));

let server;
let showDir;

beforeEach(async () => {
  server = await createTestServer();
  showDir = await server.makeShowFolder('jingle-show');
  await server.login();
});

afterEach(async () => {
  await server.cleanup();
});

async function makeShow({ mode = 'review' } = {}) {
  await writeFile(join(showDir, '.keep'), '');
  await server.scanner.scanAllNow('manual');
  const show = server.shows.getBySlug('jingle-show');
  server.db.prepare('UPDATE shows SET ad_trim_mode = ?, ad_transcribe = ? WHERE id = ?').run(mode, 'off', show.id);
  return server.shows.get(show.id);
}

async function addEpisode(name, ...parts) {
  await writeFile(join(showDir, name), Buffer.concat(parts));
  await server.scanner.scanAllNow('manual');
}

describe('the jingle proposal, over the API', () => {
  it('appears on GET /shows/:id/ad-segments once found, unconfirmed', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode('episode-1.mp3', JINGLE, PROGRAMME_B);
    await addEpisode('episode-2.mp3', PREROLL_A, JINGLE, PROGRAMME_C);
    await addEpisode('episode-3.mp3', PREROLL_B, JINGLE, PROGRAMME_A);
    await server.adPipeline.processShow(show.id);

    const response = await server.get(`/api/shows/${show.id}/ad-segments`);
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.ok(body.anchor, 'no anchor in the response');
    assert.equal(body.anchor.confirmed, false);
    assert.equal(body.anchor.origin, 'proposed');
  });

  it('needs the admin session, like every other route here', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode('episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode('episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);
    await server.adPipeline.processShow(show.id);
    const [anchor] = server.adDetect.listAnchors(show.id);

    const response = await server.request({
      method: 'POST',
      url: `/api/shows/${show.id}/ad-anchors/${anchor.id}/confirm`,
      authed: false,
    });
    assert.equal(response.statusCode, 401);
  });

  it('confirms a proposal and cuts what it found', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode('episode-1.mp3', JINGLE, PROGRAMME_B);
    await addEpisode('episode-2.mp3', PREROLL_A, JINGLE, PROGRAMME_C);
    await addEpisode('episode-3.mp3', PREROLL_B, JINGLE, PROGRAMME_A);
    await server.adPipeline.processShow(show.id);
    const [anchor] = server.adDetect.listAnchors(show.id);

    const response = await server.post(`/api/shows/${show.id}/ad-anchors/${anchor.id}/confirm`);
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.anchor.confirmed, true);

    const episodes = Object.fromEntries(server.episodes.listByShow(show.id).map((row) => [row.filename, row]));
    assert.ok(episodes['episode-2.mp3'].trimmed_filename, "confirming over the API didn't cut the pre-roll");
    assert.ok(episodes['episode-3.mp3'].trimmed_filename, "confirming over the API didn't cut the pre-roll");
  });

  it('dismisses a proposal, and it is not offered again', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode('episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode('episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);
    await server.adPipeline.processShow(show.id);
    const [anchor] = server.adDetect.listAnchors(show.id);

    const response = await server.post(`/api/shows/${show.id}/ad-anchors/${anchor.id}/dismiss`);
    assert.equal(response.statusCode, 200);

    await server.adPipeline.processShow(show.id);
    const after = JSON.parse((await server.get(`/api/shows/${show.id}/ad-segments`)).body);
    assert.equal(after.anchor, null, 'the dismissed proposal is still shown as current');
  });

  it('refuses to dismiss an anchor that is already confirmed', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode('episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode('episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);
    await server.adPipeline.processShow(show.id);
    const [anchor] = server.adDetect.listAnchors(show.id);
    await server.post(`/api/shows/${show.id}/ad-anchors/${anchor.id}/confirm`);

    const response = await server.post(`/api/shows/${show.id}/ad-anchors/${anchor.id}/dismiss`);
    assert.equal(response.statusCode, 400);
  });

  it('plays the exemplar clip, and nothing more of the episode', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode('episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode('episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);
    await server.adPipeline.processShow(show.id);
    const [anchor] = server.adDetect.listAnchors(show.id);

    const response = await server.get(`/api/ad-anchors/${anchor.id}/sample.mp3?context=1`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'audio/mpeg');
    assert.ok(Buffer.from(response.rawPayload).length > 0);
    assert.ok(
      Buffer.from(response.rawPayload).length < JINGLE.length,
      'the sample returned the whole jingle file or more, not a short clip of it',
    );
  });

  it('removes a confirmed anchor and puts back what it cut', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode('episode-1.mp3', JINGLE, PROGRAMME_B);
    await addEpisode('episode-2.mp3', PREROLL_A, JINGLE, PROGRAMME_C);
    await addEpisode('episode-3.mp3', PREROLL_B, JINGLE, PROGRAMME_A);
    await server.adPipeline.processShow(show.id);
    const [anchor] = server.adDetect.listAnchors(show.id);
    await server.post(`/api/shows/${show.id}/ad-anchors/${anchor.id}/confirm`);
    await server.adPipeline.processShow(show.id);
    assert.ok(server.episodes.listByShow(show.id).find((row) => row.filename === 'episode-2.mp3').trimmed_filename);

    const response = await server.request({ method: 'DELETE', url: `/api/ad-anchors/${anchor.id}` });
    assert.equal(response.statusCode, 200);
    await server.adPipeline.processShow(show.id);

    for (const episode of server.episodes.listByShow(show.id)) {
      assert.equal(episode.trimmed_filename, null, `${episode.filename} still carries a cut from the removed anchor`);
    }
  });
});

describe('pointing at the jingle by hand', () => {
  it('creates a confirmed anchor from a chosen range, and cuts to it', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await server.adPipeline.processShow(show.id);
    const [episode] = server.episodes.listByShow(show.id);

    const response = await server.post(`/api/episodes/${episode.id}/ad-anchor`, { startMs: 0, endMs: 4000 });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.anchor.confirmed, true);
    assert.equal(body.anchor.origin, 'pointed_at');
  });

  it('refuses a range that is too short to be a safe anchor', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await server.adPipeline.processShow(show.id);
    const [episode] = server.episodes.listByShow(show.id);

    const response = await server.post(`/api/episodes/${episode.id}/ad-anchor`, { startMs: 0, endMs: 900 });
    assert.equal(response.statusCode, 400);
  });

  it('refuses a range with the edges the wrong way round', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await server.adPipeline.processShow(show.id);
    const [episode] = server.episodes.listByShow(show.id);

    const response = await server.post(`/api/episodes/${episode.id}/ad-anchor`, { startMs: 4000, endMs: 1000 });
    assert.equal(response.statusCode, 400);
  });
});
