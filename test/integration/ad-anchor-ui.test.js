import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FIXTURE_DIR } from '../helpers/harness.js';
import { createTestServer } from '../helpers/http.js';

/** The proposal card on the Adverts page, over real fixture audio — see ad-anchor.test.js. */
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

const post = (url, payload) =>
  server.request({
    method: 'POST',
    url,
    payload: new URLSearchParams(payload).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });

describe('the jingle proposal card', () => {
  it('offers a confirm/dismiss card, works with script off, and confirming cuts', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode('episode-1.mp3', JINGLE, PROGRAMME_B);
    await addEpisode('episode-2.mp3', PREROLL_A, JINGLE, PROGRAMME_C);
    await addEpisode('episode-3.mp3', PREROLL_B, JINGLE, PROGRAMME_A);
    await server.adPipeline.processShow(show.id);
    const [anchor] = server.adDetect.listAnchors(show.id);
    assert.ok(anchor, 'setup: no proposal was made');

    const page = await server.get(`/shows/${show.slug}/adverts`);
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('Is this the station jingle?'), 'the proposal did not render');
    assert.ok(page.body.includes(`/ad-anchors/${anchor.id}/confirm`), 'no confirm form on the page');
    assert.ok(page.body.includes(`/ad-anchors/${anchor.id}/dismiss`), 'no dismiss form on the page');

    // A plain form POST, with no htmx header — the no-JS path.
    const response = await post(`/ui/shows/${show.slug}/ad-anchors/${anchor.id}/confirm`, {});
    assert.equal(response.statusCode, 303, 'a plain form post did not redirect back');

    const episodes = Object.fromEntries(server.episodes.listByShow(show.id).map((row) => [row.filename, row]));
    assert.ok(episodes['episode-2.mp3'].trimmed_filename, 'confirming through the form did not cut the pre-roll');
    assert.ok(episodes['episode-3.mp3'].trimmed_filename, 'confirming through the form did not cut the pre-roll');

    const after = await server.get(`/shows/${show.slug}/adverts`);
    assert.ok(!after.body.includes('Is this the station jingle?'), 'the confirmed anchor is still shown as a question');
    assert.ok(after.body.includes('The station jingle'), 'the confirmed jingle is not listed as a rule');
    assert.ok(after.body.includes(`/ad-anchors/${anchor.id}/remove`), 'a confirmed anchor has no way to remove it');
    assert.match(after.body, /<button[^>]*>Forget<\/button>/);
  });

  it('dismisses the proposal through htmx, and nothing is cut', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode('episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode('episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);
    await server.adPipeline.processShow(show.id);
    const [anchor] = server.adDetect.listAnchors(show.id);
    // The positive control: the question was on the page, so its absence below means something.
    assert.ok((await server.get(`/shows/${show.slug}/adverts`)).body.includes('Is this the station jingle?'), 'setup: no proposal shown');

    const response = await server.request({
      method: 'POST',
      url: `/ui/shows/${show.slug}/ad-anchors/${anchor.id}/dismiss`,
      payload: new URLSearchParams({}).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'hx-request': 'true' },
    });
    assert.equal(response.statusCode, 200, 'an htmx request should re-render the panel, not redirect');
    assert.ok(response.body.includes('id="ad-panel"'), 'the panel did not come back');
    assert.ok(!response.body.includes('Is this the station jingle?'), 'the dismissed proposal is still shown');

    for (const episode of server.episodes.listByShow(show.id)) {
      assert.equal(episode.trimmed_filename, null, 'dismissing cut something anyway');
    }
  });

  it('removing a confirmed anchor puts the audio back', async () => {
    const show = await makeShow();
    await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode('episode-1.mp3', JINGLE, PROGRAMME_B);
    await addEpisode('episode-2.mp3', PREROLL_A, JINGLE, PROGRAMME_C);
    await addEpisode('episode-3.mp3', PREROLL_B, JINGLE, PROGRAMME_A);
    await server.adPipeline.processShow(show.id);
    const [anchor] = server.adDetect.listAnchors(show.id);
    await post(`/ui/shows/${show.slug}/ad-anchors/${anchor.id}/confirm`, {});
    assert.ok(server.episodes.listByShow(show.id).find((row) => row.filename === 'episode-2.mp3').trimmed_filename);

    const response = await post(`/ui/shows/${show.slug}/ad-anchors/${anchor.id}/remove`, {});
    assert.equal(response.statusCode, 303);

    for (const episode of server.episodes.listByShow(show.id)) {
      assert.equal(episode.trimmed_filename, null, `${episode.filename} still carries a cut after the anchor was removed`);
    }
  });
});
