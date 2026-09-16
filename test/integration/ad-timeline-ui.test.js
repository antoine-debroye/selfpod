import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SEGMENT_STATUS } from '../../src/constants.js';
import { ALLOWED_BUTTON_LABELS, RETIRED_WORDS } from '../../src/lib/adverts-vocabulary.js';
import { barMarks } from '../../src/lib/cut-bar.js';
import { SETTING_KEYS } from '../../src/services/settings.js';
import { FIXTURE_DIR } from '../helpers/harness.js';
import { createTestServer } from '../helpers/http.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';

/**
 * The Adverts page as the owner uses it: every episode as a bar, what is cut and why,
 * and the five things they can do about it — each checked against the audio, not only
 * against the markup, because a button that re-renders nicely and cuts nothing is the
 * failure these pages exist to prevent.
 */

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

/** Three episodes sharing a 40-second stretch 45 seconds in, found by comparing them. */
async function makeShow({ mode = 'review', count = 3, process = true } = {}) {
  await writeFile(join(showDir, '.keep'), '');
  await server.scanner.scanAllNow('manual');
  const show = server.shows.getBySlug('tape-club');
  server.db.prepare('UPDATE shows SET ad_trim_mode = ? WHERE id = ?').run(mode, show.id);
  for (let n = 0; n < count; n += 1) {
    await writeFile(
      join(showDir, `episode-${n}.mp3`),
      stitch(segment(100_000 + n * 50_000, framesFor(45)), segment(2_000, framesFor(40)), segment(600_000 + n * 50_000, framesFor(45))),
    );
  }
  await server.scanner.scanAllNow('manual');
  if (process) await server.adPipeline.processShow(show.id);
  return server.shows.get(show.id);
}

const form = (headers = {}) => ({ 'content-type': 'application/x-www-form-urlencoded', ...headers });
const post = (url, payload = {}) => server.request({ method: 'POST', url, payload: new URLSearchParams(payload).toString(), headers: form() });
const htmxPost = (url, payload = {}) =>
  server.request({ method: 'POST', url, payload: new URLSearchParams(payload).toString(), headers: form({ 'hx-request': 'true' }) });
const page = async (path) => (await server.get(path)).body;
const byName = (showId) => Object.fromEntries(server.episodes.listByShow(showId).map((row) => [row.filename, row]));

/** The HTML of one episode's bar on the page. */
function barOf(html, episodeId) {
  const start = html.indexOf(`<article class="cutbar" id="ep-${episodeId}"`);
  assert.ok(start >= 0, `no bar for ${episodeId}`);
  return html.slice(start, html.indexOf('</article>', start));
}

/** Every label on a button that submits, in a piece of HTML. */
function submitLabels(html) {
  const labels = [];
  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (/type="button"/.test(match[1])) continue;
    labels.push(match[2].replace(/<[^>]+>/g, '').trim());
  }
  return labels;
}

async function approveAll(show) {
  const [found] = server.adDetect.listSegments(show.id);
  const response = await htmxPost(`/ui/shows/${show.slug}/ad-segments/${found.id}`, { status: SEGMENT_STATUS.APPROVED });
  assert.equal(response.statusCode, 200);
  for (const episode of server.episodes.listByShow(show.id)) assert.ok(episode.trimmed_filename, `setup: ${episode.filename} was not cut`);
  return { found, response };
}

describe('episode by episode', () => {
  it('draws one bar per episode, each mark where the arithmetic puts it', async () => {
    const show = await makeShow();
    const [found] = server.adDetect.listSegments(show.id);
    const html = await page(`/shows/${show.slug}/adverts`);

    const episodes = server.episodes.listByShow(show.id);
    assert.equal((html.match(/<article class="cutbar"/g) ?? []).length, episodes.length);
    for (const episode of episodes) {
      const occurrence = found.occurrences.find((row) => row.episode_id === episode.id);
      const [expected] = barMarks([{ startMs: occurrence.start_ms, endMs: occurrence.end_ms }], episode.duration_seconds * 1000);
      const bar = barOf(html, episode.id);
      assert.ok(
        bar.includes(`class="cutbar__mark cutbar__mark--waiting" style="left:${expected.left}%;width:${expected.width}%"`),
        `the mark is not at ${expected.left}% / ${expected.width}%:\n${bar.slice(0, 900)}`,
      );
      // The stretch in words, a way to hear it in this episode's original, and the two choices.
      assert.match(bar, /data-play-from="\d+" data-play-to="\d+"/);
      assert.ok(bar.includes(`src="/api/episodes/${episode.id}/audio?copy=original"`));
      assert.match(bar, /<button[^>]*>Remove<\/button>/);
      assert.match(bar, /<button[^>]*>Keep<\/button>/);
      assert.match(bar, /cut-pill--waiting">waiting</);
    }
  });

  it('counts what was cut once it is removed', async () => {
    const show = await makeShow();
    const before = await page(`/shows/${show.slug}/adverts`);
    assert.match(before, /<dt>Episodes cut<\/dt><dd>0<\/dd>/);
    assert.match(before, /<dt>Waiting<\/dt><dd>3<\/dd>/);

    const { response } = await approveAll(show);

    assert.match(response.body, /<dt>Episodes cut<\/dt><dd>3<\/dd>/);
    // Three 40-second cuts.
    assert.match(response.body, /<dt>Minutes removed<\/dt><dd>2<\/dd>/);
    assert.match(response.body, /<dt>Waiting<\/dt><dd>0<\/dd>/);
    assert.match(response.body, /<dt>Held<\/dt><dd>0<\/dd>/);
    assert.equal((response.body.match(/cutbar__mark--cut/g) ?? []).length, 3);
    assert.equal((response.body.match(/cut-pill--cut">cut 0:40</g) ?? []).length, 3);
  });

  it('keeps without JavaScript, and a kept stretch leaves the bars for the Kept list', async () => {
    const show = await makeShow();
    const [found] = server.adDetect.listSegments(show.id);

    const response = await post(`/ui/shows/${show.slug}/ad-segments/${found.id}`, { status: SEGMENT_STATUS.REJECTED });

    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, `/shows/${show.slug}/adverts`);
    assert.equal(server.adDetect.getSegment(found.id).status, SEGMENT_STATUS.REJECTED);
    const html = await page(`/shows/${show.slug}/adverts`);
    assert.match(html, /Kept \(1\)/);
    assert.equal((html.match(/<article class="cutbar"/g) ?? []).length, 3, 'the episodes went with the stretch');
    assert.doesNotMatch(html, /cutbar__mark/, 'a kept stretch is still drawn');
    // And from the Kept list it can be removed after all.
    assert.ok(html.includes(`action="/ui/shows/${show.slug}/ad-segments/${found.id}"`));
    assert.ok(html.includes(`action="/ui/shows/${show.slug}/segments/${found.id}/forget"`));
  });

  it('removes without JavaScript too', async () => {
    const show = await makeShow();
    const [found] = server.adDetect.listSegments(show.id);
    const response = await post(`/ui/shows/${show.slug}/ad-segments/${found.id}`, { status: SEGMENT_STATUS.APPROVED });
    assert.equal(response.statusCode, 303);
    for (const episode of server.episodes.listByShow(show.id)) assert.ok(episode.trimmed_filename);
  });
});

describe('putting a cut back', () => {
  it('Restore here changes that episode and no other', async () => {
    const show = await makeShow();
    const { found } = await approveAll(show);
    const before = byName(show.id);
    const target = before['episode-1.mp3'];
    const html = await page(`/shows/${show.slug}/adverts`);
    const url = `/ui/episodes/${target.id}/segments/${found.id}/restore`;
    assert.ok(barOf(html, target.id).includes(`action="${url}"`), 'the bar does not offer Restore here');

    const response = await htmxPost(url);

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /id="ad-panel"/);
    const after = byName(show.id);
    assert.equal(after['episode-1.mp3'].trimmed_filename, null, 'the restored episode is still cut');
    assert.equal(after['episode-0.mp3'].trimmed_filename, before['episode-0.mp3'].trimmed_filename, 'another episode was re-cut');
    assert.equal(after['episode-2.mp3'].trimmed_filename, before['episode-2.mp3'].trimmed_filename, 'another episode was re-cut');
    assert.equal(server.adDetect.getSegment(found.id).status, SEGMENT_STATUS.APPROVED, 'the rule stopped applying elsewhere');

    const bar = barOf(response.body, target.id);
    assert.match(bar, /cutbar__mark--restored/);
    assert.match(bar, /class="stretch__state">Restored here</);
    assert.match(bar, /Restored in this episode; the rule still applies elsewhere\./);
  });

  it('undoing a restore cuts that episode again', async () => {
    const show = await makeShow();
    const { found } = await approveAll(show);
    const target = byName(show.id)['episode-0.mp3'];
    await htmxPost(`/ui/episodes/${target.id}/segments/${found.id}/restore`);
    assert.equal(server.episodes.get(target.id).trimmed_filename, null);
    const [restore] = server.adDetect.restoresIn(target.id);
    const undo = `/ui/episodes/${target.id}/restores/${restore.id}/undo`;
    const html = await page(`/shows/${show.slug}/adverts`);
    assert.ok(barOf(html, target.id).includes(`action="${undo}"`), 'no way to take the restore back');

    // From the episode's own page, with script off.
    const response = await post(undo, { returnTo: `episode:${target.id}` });

    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, `/shows/${show.slug}/episodes/${target.id}`);
    assert.ok(server.episodes.get(target.id).trimmed_filename, 'undoing the restore did not cut it again');
    assert.equal(server.adDetect.restoresIn(target.id).length, 0);
  });

  it('Restore everywhere and stop puts it back in every episode', async () => {
    const show = await makeShow();
    const { found } = await approveAll(show);

    const response = await post(`/ui/shows/${show.slug}/segments/${found.id}/stop`);

    assert.equal(response.statusCode, 303);
    for (const episode of server.episodes.listByShow(show.id)) {
      assert.equal(episode.trimmed_filename, null, `${episode.filename} is still cut`);
    }
    assert.equal(server.adDetect.getSegment(found.id).status, SEGMENT_STATUS.REJECTED, 'it will be offered again');
    assert.doesNotMatch(await page(`/shows/${show.slug}/adverts`), /Restore everywhere and stop/);
  });
});

describe('teaching', () => {
  it('turns typed words into a boundary, and refuses nothing or one word', async () => {
    const show = await makeShow();

    const empty = await htmxPost(`/ui/shows/${show.slug}/ad-markers`, { position: 'starts', text: '   ' });
    assert.equal(empty.statusCode, 422);
    assert.match(empty.body, /Type at least two words the programme says/);
    const oneWord = await htmxPost(`/ui/shows/${show.slug}/ad-markers`, { position: 'starts', text: 'RMC' });
    assert.equal(oneWord.statusCode, 422);
    const noPosition = await post(`/ui/shows/${show.slug}/ad-markers`, { position: 'somewhere', text: 'Vous écoutez RMC' });
    assert.equal(noPosition.statusCode, 303);
    assert.equal(server.adDetect.listMarkers(show.id).length, 0, 'a refused boundary was stored');

    const response = await htmxPost(`/ui/shows/${show.slug}/ad-markers`, { position: 'ends_inclusive', text: 'Vous écoutez RMC' });

    assert.equal(response.statusCode, 200);
    const [marker] = server.adDetect.listMarkers(show.id);
    assert.equal(marker.raw_text, 'Vous écoutez RMC');
    assert.equal(marker.role, 'programme_ends');
    assert.equal(marker.inclusive, 1);
    assert.match(response.body, /rule__title">“Vous écoutez RMC”/);
    assert.match(response.body, /The programme ends, and these words go too/);
  });

  it('teaches a stretch by time from the episode page, and says what is wrong with a bad one', async () => {
    const show = await makeShow();
    const episode = byName(show.id)['episode-0.mp3'];
    const url = `/ui/episodes/${episode.id}/teach-range`;
    const card = await page(`/shows/${show.slug}/episodes/${episode.id}`);
    assert.ok(card.includes(`action="${url}"`), 'no teach-range form on the episode page');

    const backwards = await htmxPost(url, { from: '0:15', to: '0:05', kind: 'advert' });
    assert.equal(backwards.statusCode, 422);
    assert.match(backwards.body, /Say a first and a last moment, in that order, within the episode\./);
    const short = await htmxPost(url, { from: '0:05', to: '0:05.5', kind: 'advert' });
    assert.equal(short.statusCode, 422);
    assert.match(short.body, /That is less than a second/);
    const nonsense = await htmxPost(url, { from: 'soon', to: '0:05', kind: 'advert' });
    assert.equal(nonsense.statusCode, 422);

    const response = await post(url, { from: '0:05', to: '0:15', kind: 'advert' });

    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, `/shows/${show.slug}/episodes/${episode.id}`);
    const taught = server.adDetect.listSegments(show.id).find((row) => row.kind === 'taught_range');
    assert.ok(taught, 'nothing was taught');
    assert.equal(taught.status, SEGMENT_STATUS.APPROVED);
    assert.ok(server.adDetect.cutListFor(episode.id).some((cut) => cut.startMs <= 5_100 && cut.endMs >= 14_900));
    const after = await page(`/shows/${show.slug}/episodes/${episode.id}`);
    assert.match(after, /A stretch you marked as an advert\./);
  });
});

describe('the work strip', () => {
  it('is always on the page, says what is owed, and empties once it is done', async () => {
    const show = await makeShow({ process: false });

    const waiting = await page(`/shows/${show.slug}/adverts`);
    assert.match(waiting, /<div id="ad-work"[^>]*sse-swap="ad-work-[^"]+"[^>]*>/);
    assert.match(waiting, /3 episodes to read/);
    assert.ok(waiting.includes(`hx-get="/ui/shows/${show.slug}/ad-work" hx-trigger="load delay:10s"`), 'no poll while work is owed');
    const strip = await server.get(`/ui/shows/${show.slug}/ad-work`);
    assert.equal(strip.statusCode, 200);
    assert.match(strip.body, /3 episodes to read/);

    await server.adPipeline.processShow(show.id);

    const done = await page(`/shows/${show.slug}/adverts`);
    assert.match(done, /<div id="ad-work"[^>]*hx-swap="innerHTML"><\/div>/, 'the strip is gone, or not empty');
    assert.equal((await server.get(`/ui/shows/${show.slug}/ad-work`)).body, '');
    assert.equal((await server.get(`/api/shows/${show.id}/ad-work`)).json().sentence, '');
  });
});

describe('a jingle SelfPod offers', () => {
  it('is on the page on a cold load, with Remove and Keep', async () => {
    const JINGLE = readFileSync(join(FIXTURE_DIR, 'theme-48k.mp3'));
    const programmes = ['prog-a.mp3', 'prog-b.mp3', 'prog-c.mp3'].map((name) => readFileSync(join(FIXTURE_DIR, name)));
    const prerolls = ['sponsor-en-daniel.mp3', 'sponsor-en-samantha.mp3'].map((name) => readFileSync(join(FIXTURE_DIR, name)));
    await writeFile(join(showDir, '.keep'), '');
    await server.scanner.scanAllNow('manual');
    const show = server.shows.getBySlug('tape-club');
    server.db.prepare("UPDATE shows SET ad_trim_mode = 'review', ad_transcribe = 'off' WHERE id = ?").run(show.id);
    await writeFile(join(showDir, 'episode-0.mp3'), Buffer.concat([JINGLE, programmes[0]]));
    await writeFile(join(showDir, 'episode-1.mp3'), Buffer.concat([prerolls[0], JINGLE, programmes[1]]));
    await writeFile(join(showDir, 'episode-2.mp3'), Buffer.concat([prerolls[1], JINGLE, programmes[2]]));
    await server.scanner.scanAllNow('manual');
    await server.adPipeline.processShow(show.id);
    const [anchor] = server.adDetect.listAnchors(show.id);
    assert.ok(anchor && !anchor.confirmed_at, 'setup: no proposal');

    const html = await page(`/shows/${show.slug}/adverts`);

    const start = html.indexOf('rule--offered');
    assert.ok(start >= 0, 'the offered jingle is not a rule on the page');
    const rule = html.slice(start, html.indexOf('</li>', start));
    assert.match(rule, /Is this the station jingle\?/);
    assert.ok(rule.includes(`/api/ad-anchors/${anchor.id}/sample.mp3`), 'no way to hear it');
    assert.ok(rule.includes(`action="/ui/shows/${show.slug}/ad-anchors/${anchor.id}/confirm"`));
    assert.ok(rule.includes(`action="/ui/shows/${show.slug}/ad-anchors/${anchor.id}/dismiss"`));
    assert.deepEqual(submitLabels(rule), ['Remove', 'Keep']);
  });
});

describe('the rest of the app', () => {
  it('puts each episode’s state in the episode table, linked to its bar', async () => {
    const show = await makeShow();
    const table = await page(`/shows/${show.slug}`);
    assert.match(table, /<th scope="col">Adverts<\/th>/);
    for (const episode of server.episodes.listByShow(show.id)) {
      assert.ok(
        table.includes(`<a class="cut-pill cut-pill--waiting" href="/shows/${show.slug}/adverts#ep-${episode.id}"`),
        `no pill for ${episode.filename}`,
      );
    }
    assert.match(table, /hx-trigger="sse:ad-changed-[^"]+ from:body"/, 'the table does not refresh when the cuts change');

    await approveAll(show);
    const fragment = await server.get(`/ui/shows/${show.slug}/episode-table`);
    assert.equal(fragment.statusCode, 200);
    assert.equal((fragment.body.match(/cut-pill--cut" href="[^"]+"[^>]*>cut 0:40</g) ?? []).length, 3);

    server.db.prepare("UPDATE shows SET ad_trim_mode = 'off' WHERE id = ?").run(show.id);
    assert.doesNotMatch(await page(`/shows/${show.slug}`), /<th scope="col">Adverts<\/th>/);
  });

  it('says on the dashboard card how much was cut', async () => {
    const show = await makeShow();
    assert.match(await page('/'), /3 waiting/);
    await approveAll(show);
    assert.match(await page('/'), /2 min of adverts cut/);
    const card = await server.get(`/ui/shows/${show.slug}/card`);
    assert.match(card.body, /2 min of adverts cut/);
  });

  it('gives the ledger a caption and a link, not a button inside the ledger form', async () => {
    const show = await makeShow();
    await approveAll(show);
    server.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '1' });
    const subscription = server.subscriptions.create(show.id, { feedUrl: 'https://feeds.example.com/tape-club.xml' });
    const episode = byName(show.id)['episode-0.mp3'];
    const item = server.subscriptions.upsertItem(subscription.id, { guid: 'ep-0', guidSource: 'guid', title: 'Episode zero', pubDate: new Date().toISOString() });
    server.subscriptions.markItem(item.id, { decision: 'downloaded', episode_id: episode.id, filename: episode.filename });

    const html = await page(`/shows/${show.slug}/subscription`);

    assert.match(html, /Episode zero/, 'setup: the row is not on the page');
    assert.match(html, /Cut 0:40\./);
    assert.ok(html.includes(`<a href="/shows/${show.slug}/episodes/${episode.id}">See the cuts</a>`));
    assert.doesNotMatch(html, /formaction="[^"]*ad-segments/, 'a decision button is back inside the ledger form');
  });

  it('pages the timeline thirty episodes at a time', async () => {
    const show = await makeShow({ count: 0, process: false });
    for (let n = 0; n < 31; n += 1) {
      await writeFile(join(showDir, `short-${String(n).padStart(2, '0')}.mp3`), stitch(segment(1_000_000 + n * 1_000, framesFor(2))));
    }
    await server.scanner.scanAllNow('manual');

    const html = await page(`/shows/${show.slug}/adverts`);
    assert.equal((html.match(/<article class="cutbar"/g) ?? []).length, 30);
    const next = html.match(/hx-get="(\/ui\/shows\/tape-club\/ad-timeline\?before=[^"]+)"/);
    assert.ok(next, 'no "Show older"');
    const older = await server.get(next[1].replace(/&amp;/g, '&'));
    assert.equal(older.statusCode, 200);
    assert.equal((older.body.match(/<article class="cutbar"/g) ?? []).length, 1);
    assert.doesNotMatch(older.body, /Show older/);
    const shown = new Set([...html.matchAll(/id="ep-([^"]+)"/g), ...older.body.matchAll(/id="ep-([^"]+)"/g)].map((match) => match[1]));
    assert.equal(shown.size, 31, 'an episode was shown twice or not at all');
  });
});

describe('the original audio', () => {
  it('is streamed to the owner, with ranges, and never cached', async () => {
    const show = await makeShow();
    await approveAll(show);
    const episode = byName(show.id)['episode-0.mp3'];
    const url = `/api/episodes/${episode.id}/audio?copy=original`;

    const whole = await server.get(url);
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers['content-type'], 'audio/mpeg');
    assert.equal(whole.headers['cache-control'], 'private, no-store');
    // The file on the share, not the cut copy subscribers get.
    assert.equal(whole.rawPayload.length, episode.file_size_bytes);

    const part = await server.request({ url, headers: { range: 'bytes=0-99' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.rawPayload.length, 100);

    // Without `copy`, still the hop to the published copy.
    assert.equal((await server.get(`/api/episodes/${episode.id}/audio`)).statusCode, 307);

    const stranger = await server.request({ url, authed: false });
    assert.equal(stranger.statusCode, 401);
  });
});

describe('the JSON API', () => {
  it('lists the bars, restores, undoes, stops and teaches', async () => {
    const show = await makeShow();
    const [found] = server.adDetect.listSegments(show.id);
    const cuts = (await server.get(`/api/shows/${show.id}/ad-cuts`)).json();
    assert.equal(cuts.episodes.length, 3);
    for (const bar of cuts.episodes) {
      assert.equal(bar.state, 'waiting');
      assert.equal(bar.stretches.length, 1);
      assert.equal(bar.stretches[0].kind, 'repeated_audio');
      assert.equal(bar.stretches[0].reason.key, 'repeated_sound');
    }

    await server.post(`/api/ad-segments/${found.id}/decide`, { status: 'approved' });
    const episode = byName(show.id)['episode-2.mp3'];
    const refused = await server.post(`/api/ad-segments/${found.id}/restore`, {});
    assert.equal(refused.statusCode, 400);
    const restored = await server.post(`/api/ad-segments/${found.id}/restore`, { episodeId: episode.id });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(server.episodes.get(episode.id).trimmed_filename, null);
    const bar = (await server.get(`/api/shows/${show.id}/ad-cuts`)).json().episodes.find((row) => row.id === episode.id);
    assert.equal(bar.stretches[0].state, 'restored');

    const undone = await server.request({ method: 'DELETE', url: `/api/ad-restores/${restored.json().restore.id}` });
    assert.equal(undone.statusCode, 200);
    assert.ok(server.episodes.get(episode.id).trimmed_filename, 'the undo did not cut it again');

    const stopped = await server.post(`/api/ad-segments/${found.id}/stop`, {});
    assert.equal(stopped.statusCode, 200);
    assert.equal(stopped.json().removed, 'decision');
    assert.equal(server.episodes.get(episode.id).trimmed_filename, null);

    const unknown = await server.post(`/api/episodes/${episode.id}/teach-range`, { startMs: 0, endMs: 5000, kind: 'sponsor' });
    assert.equal(unknown.statusCode, 400);
    const taught = await server.post(`/api/episodes/${episode.id}/teach-range`, { startMs: 1000, endMs: 9000, kind: 'advert' });
    assert.equal(taught.statusCode, 200, taught.body);
    assert.equal(taught.json().segment.kind, 'taught_range');
    assert.ok(server.episodes.get(episode.id).trimmed_filename, 'teaching a range did not cut it');

    const work = (await server.get(`/api/shows/${show.id}/ad-work`)).json();
    assert.equal(work.work.toRead, 0);
  });
});

describe('the words on these pages', () => {
  it('uses only the vocabulary on its buttons, and none of the retired words', async () => {
    const show = await makeShow();
    const { found } = await approveAll(show);
    const episodes = byName(show.id);
    await htmxPost(`/ui/episodes/${episodes['episode-0.mp3'].id}/segments/${found.id}/restore`);
    await htmxPost(`/ui/shows/${show.slug}/ad-markers`, { position: 'starts', text: 'Vous écoutez RMC' });

    const adverts = await page(`/shows/${show.slug}/adverts`);
    const episodePage = await page(`/shows/${show.slug}/episodes/${episodes['episode-0.mp3'].id}`);
    const panel = adverts.slice(adverts.indexOf('<div id="ad-panel"'));
    const cardStart = episodePage.indexOf('<section class="form-card" id="episode-adverts"');
    const card = episodePage.slice(cardStart, episodePage.indexOf('</section>', cardStart));

    const labels = [...submitLabels(panel), ...submitLabels(card)];
    // Positive control: the pages did render their decisions.
    for (const expected of ['Restore here', 'Restore everywhere and stop', 'Remove', 'Forget', 'Teach', 'Save', 'Check now']) {
      assert.ok(labels.includes(expected), `no "${expected}" button to check: ${labels.join(', ')}`);
    }
    for (const label of labels) {
      assert.ok(ALLOWED_BUTTON_LABELS.includes(label), `"${label}" is not in the vocabulary`);
    }
    for (const html of [adverts, episodePage]) {
      for (const word of RETIRED_WORDS) assert.ok(!html.includes(word), `"${word}" is back`);
    }
  });
});
