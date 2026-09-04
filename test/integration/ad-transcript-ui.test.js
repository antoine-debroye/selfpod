import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { SEGMENT_STATUS } from '../../src/constants.js';
import { createTestServer } from '../helpers/http.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';
import { cannedWhisper, whisperJson } from '../helpers/whisper.js';

const framesFor = (seconds) => Math.round((seconds * 1000) / FRAME_MS);
const episodeBytes = (n) => stitch(segment(700_000 + n * 90_000, framesFor(30)));

const READ = 'This episode is brought to you by Acme Storage go to acme dot com slash podcast and use code PODCAST for twenty percent off terms apply';
const READ_AGAIN = 'This episode is brought to you by Acme Storage go to acne dot com slash podcasts and use the code PODCAST for 20 percent off terms apply';
const PROGRAMME = [
  ['Welcome back to the show, today we have plenty to get through', 'Later on we hear from a listener who wrote in about pensions'],
  ['Good morning and thanks for joining us on a wet Tuesday', 'First up the council has voted on the new bypass again'],
  ['Hello everybody, a packed programme this morning with three guests', 'We start with the strike and what it means for commuters'],
];
const opening = (read, n) =>
  whisperJson([
    { from: 500, to: 13_000, text: read },
    { from: 13_600, to: 20_000, text: PROGRAMME[n % 3][0] },
    { from: 20_500, to: 29_000, text: PROGRAMME[n % 3][1] },
  ]);

let server;
afterEach(async () => {
  await server?.cleanup();
  server = null;
});

async function setUp({ mode = 'review', canned, minEpisodes = 2 } = {}) {
  server = await createTestServer({ whisper: cannedWhisper(canned) });
  await server.login();
  const dir = await server.makeShowFolder('spoken');
  await writeFile(join(dir, '.keep'), '');
  await server.scanner.scanAllNow('manual');
  const show = server.shows.getBySlug('spoken');
  server.db.prepare('UPDATE shows SET ad_trim_mode = ?, ad_auto_min_episodes = ? WHERE id = ?').run(mode, minEpisodes, show.id);
  for (const n of Object.keys(canned).map((name) => Number(name.match(/\d+/)[0]))) {
    await writeFile(join(dir, `episode-${n}.mp3`), episodeBytes(n));
  }
  await server.scanner.scanAllNow('manual');
  await server.adPipeline.processShow(show.id);
  return server.shows.get(show.id);
}

const spoken = (showId) => server.adDetect.listSegments(showId).filter((row) => row.source === 'transcript');

/** A browser's form post: url-encoded, and a redirect back unless htmx asked. */
const post = (url, payload, headers = {}) =>
  server.request({
    method: 'POST',
    url,
    payload: new URLSearchParams(payload).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  });
const htmx = { 'hx-request': 'true' };
const episodeNamed = (showId, name) => server.episodes.listByShow(showId).find((row) => row.filename === name);

describe('the review card for words', () => {
  it('shows the words, the cues that fired, and one sentence saying what happens next', async () => {
    const show = await setUp({ canned: { 'episode-1.mp3': opening(READ, 1), 'episode-2.mp3': opening(READ_AGAIN, 2) } });
    const page = await server.get(`/shows/${show.slug}/adverts`);
    assert.equal(page.statusCode, 200);
    const html = page.body;
    assert.match(html, /The same words in 2 episodes/);
    assert.match(html, /data-tx-word="/, 'no words on the card');
    assert.match(html, /tx__w--cut/, 'the cut is not marked in the words');
    assert.match(html, /tx__w--context/, 'no context either side of the cut');
    assert.match(html, /seg-cue">brought to you by</);
    assert.match(html, /This sounds like a sponsor read — it says “brought to you by”/);
    assert.match(html, /Remove it once and SelfPod cuts the same read from later episodes without asking/);
    assert.match(html, /sample\.mp3\?context=3/, 'the player has no context either side');
    assert.match(html, /name="startWord"/);
    assert.match(html, /name="endWord"/);
    // The page still obeys the content-security policy: no inline handlers.
    assert.doesNotMatch(html, /\son[a-z]+=/);
  });

  it('says why an automatic cut was made, on the card and in the JSON', async () => {
    const show = await setUp({ mode: 'auto', canned: { 'episode-1.mp3': opening(READ, 1), 'episode-2.mp3': opening(READ_AGAIN, 2) } });
    const api = await server.get(`/api/shows/${show.id}/ad-segments`);
    const [read] = api.json().segments;
    assert.equal(read.status, 'approved');
    assert.equal(read.why.verdict, 'will_cut');
    assert.match(read.why.sentence, /SelfPod cuts this on its own: it says “brought to you by”/);
    assert.ok(read.cues.some((cue) => cue.id === 'brought_to_you_by'));
    assert.ok(read.excerpt.words.length > 10);
    assert.equal(typeof read.heardClearly, 'boolean');
    const page = await server.get(`/shows/${show.slug}/adverts`);
    assert.match(page.body, /Removed automatically/);
    assert.match(page.body, /Put it back and stop cutting these words/);
  });

  it('moves the edges to the words you chose, and the words follow', async () => {
    const show = await setUp({ canned: { 'episode-1.mp3': opening(READ, 1), 'episode-2.mp3': opening(READ_AGAIN, 2) } });
    const [read] = spoken(show.id);
    const api = await server.get(`/api/shows/${show.id}/ad-segments`);
    const presented = api.json().segments.find((row) => row.id === read.id);
    const { cutStartWord, cutEndWord, episodeId } = presented.excerpt;

    // Trim two words off the start and one off the end.
    const response = await post(`/ui/shows/${show.slug}/ad-segments/${read.id}`, {
      status: 'approved',
      episodeId,
      startWord: String(cutStartWord + 2),
      endWord: String(cutEndWord - 1),
    });
    assert.equal(response.statusCode, 303, response.body.slice(0, 300));

    const after = server.adDetect.getSegment(read.id);
    assert.equal(after.status, SEGMENT_STATUS.APPROVED);
    assert.match(after.text, /^is brought to you by/, after.text);
    assert.match(after.text, /conditions$|terms$/, after.text);
    const own = server.adDetect.listSegments(show.id).find((row) => row.id === read.id).occurrences.find((row) => row.episode_id === episodeId);
    assert.ok(own.start_ms > 500, `the cut still starts at ${own.start_ms}`);
  });

  it('refuses edges in the wrong order, and says so', async () => {
    const show = await setUp({ canned: { 'episode-1.mp3': opening(READ, 1), 'episode-2.mp3': opening(READ_AGAIN, 2) } });
    const [read] = spoken(show.id);
    const api = await server.get(`/api/shows/${show.id}/ad-segments`);
    const { cutStartWord, cutEndWord, episodeId } = api.json().segments.find((row) => row.id === read.id).excerpt;
    const response = await post(
      `/ui/shows/${show.slug}/ad-segments/${read.id}`,
      { status: 'approved', episodeId, startWord: String(cutEndWord), endWord: String(cutStartWord) },
      htmx,
    );
    assert.equal(response.statusCode, 422);
    assert.equal(server.adDetect.getSegment(read.id).status, SEGMENT_STATUS.CANDIDATE, 'it decided anyway');
    const json = await server.post(`/api/ad-segments/${read.id}/decide`, { status: 'approved', episodeId, startWord: String(cutEndWord), endWord: String(cutStartWord) });
    assert.equal(json.statusCode, 400);
    assert.equal(json.json().error.code, 'invalid_word_range');
  });
});

describe('what SelfPod heard, on the episode page', () => {
  it('shows the words with the cut marked, and lets you teach it', async () => {
    const show = await setUp({ canned: { 'episode-1.mp3': opening(READ, 1), 'episode-2.mp3': opening('Nothing here but the programme, honestly, and some chat about the weather', 2) } });
    const first = episodeNamed(show.id, 'episode-1.mp3');
    const page = await server.get(`/shows/${show.slug}/episodes/${first.id}`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /What SelfPod heard/);
    assert.match(page.body, /The whole episode/);
    assert.match(page.body, /tx__w--candidate/, 'the waiting read is not highlighted');
    assert.match(page.body, /Tell SelfPod about these words/);
    assert.match(page.body, /This is an advert/);
    assert.match(page.body, /The programme starts here/);

    // Teach: the programme's first sentence is an advert too, apparently.
    const words = (await server.get(`/api/episodes/${first.id}/transcript`)).json().transcript.regions[0].words;
    const from = words.findIndex((word) => word.t === 'Good');
    const to = words.findIndex((word) => word.t === 'Tuesday');
    assert.ok(from > 0 && to > from, `words: ${words.map((word) => word.t).join(' ')}`);
    const taught = await post(`/ui/episodes/${first.id}/transcript/teach`, { region: '0', startWord: String(from), endWord: String(to), verdict: 'advert' });
    assert.equal(taught.statusCode, 303, taught.body.slice(0, 200));
    const segments = spoken(show.id);
    const welcome = segments.find((row) => /^good morning and thanks/.test(row.text));
    assert.ok(welcome, JSON.stringify(segments.map((row) => row.text)));
    assert.equal(welcome.status, SEGMENT_STATUS.APPROVED);
    assert.equal(server.episodes.get(first.id).trim_status, 'trimmed');

    const again = await server.get(`/shows/${show.slug}/episodes/${first.id}`);
    assert.match(again.body, /tx__w--approved/, 'the taught words are not struck through');
    assert.match(again.body, /Cut 0:1\d–0:20/);
  });

  it('turns chosen words into a boundary, and shows the boundary on the review page', async () => {
    const preRoll = (n) =>
      whisperJson(
        [
          { from: 300, to: 9_000, text: `Un spot différent chaque jour numéro ${n} à ${n} euros par mois sans engagement` },
          { from: 9_400, to: 11_000, text: 'Vous écoutez RMC' },
          { from: 11_200, to: 29_000, text: `RMC Apolline Matin et bonjour à tous ${PROGRAMME[n % 3].join(' ')}` },
        ],
        { language: 'fr' },
      );
    const show = await setUp({ canned: { 'episode-1.mp3': preRoll(1), 'episode-2.mp3': preRoll(2) } });
    const first = episodeNamed(show.id, 'episode-1.mp3');
    const words = (await server.get(`/api/episodes/${first.id}/transcript`)).json().transcript.regions[0].words;
    const from = words.findIndex((word) => word.t === 'Vous');
    const to = words.findIndex((word) => word.t === 'RMC');
    const response = await post(`/ui/episodes/${first.id}/transcript/teach`, { region: '0', startWord: String(from), endWord: String(to), verdict: 'programme_starts' });
    assert.equal(response.statusCode, 303);

    const markers = (await server.get(`/api/shows/${show.id}/ad-markers`)).json().markers;
    assert.equal(markers.length, 1);
    assert.equal(markers[0].text, 'Vous écoutez RMC');
    const boundary = spoken(show.id).find((row) => row.signature === `marker:${markers[0].id}`);
    assert.ok(boundary);
    assert.equal(boundary.episode_count, 2);

    const page = await server.get(`/shows/${show.slug}/adverts`);
    assert.match(page.body, /The boundary you set/);
    assert.match(page.body, /Everything before “Vous écoutez RMC” is cut, as you asked/);
    assert.match(page.body, /Forget this boundary/);
    const episodePage = await server.get(`/shows/${show.slug}/episodes/${first.id}`);
    assert.match(episodePage.body, /tx__w--approved/);
    assert.match(episodePage.body, /Everything before/);
    const adverts = (await server.get(`/api/episodes/${first.id}/transcript`)).json().adverts;
    assert.equal(adverts.stage, 'cut_before_marker');
    assert.match(adverts.sentence, /Cut the 0:09 before “Vous écoutez RMC”, as you asked/);

    const forgotten = await post(`/ui/shows/${show.slug}/ad-markers/${markers[0].id}/remove`, {});
    assert.equal(forgotten.statusCode, 303);
    assert.equal((await server.get(`/api/shows/${show.id}/ad-markers`)).json().markers.length, 0);
  });
});

describe('the settings', () => {
  it('saves where to listen, forgets old transcripts when it changes, and refuses nowhere at all', async () => {
    const show = await setUp({ canned: { 'episode-1.mp3': opening(READ, 1), 'episode-2.mp3': opening(READ_AGAIN, 2) } });
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM episode_transcripts').get().n, 2);

    const saved = await post(`/ui/shows/${show.slug}/ad-trim`, { mode: 'review', minEpisodes: '2', listenHeadMinutes: '3', listenTailMinutes: '2' });
    assert.equal(saved.statusCode, 303);
    const updated = server.shows.get(show.id);
    assert.equal(updated.ad_transcribe, 'edges');
    assert.equal(updated.ad_transcribe_head_seconds, 180);
    assert.equal(updated.ad_transcribe_tail_seconds, 120);
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM episode_transcripts').get().n, 0, 'old transcripts survived a change of windows');

    const whole = await server.request({ method: 'PATCH', url: `/api/shows/${show.id}/ad-trim`, payload: { listenWhole: true } });
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.json().listen.whole, true);

    const nowhere = await post(`/ui/shows/${show.slug}/ad-trim`, { mode: 'review', listenHeadMinutes: '0', listenTailMinutes: '0' }, htmx);
    assert.equal(nowhere.statusCode, 422);
    assert.match(nowhere.body, /Choose somewhere to listen, or turn the feature off/);

    const page = await server.get(`/shows/${show.slug}/adverts`);
    assert.match(page.body, /Where to listen/);
    assert.match(page.body, /name="listenHeadMinutes"/);
  });
});

describe('empty states', () => {
  it('says the recogniser is missing rather than that it is about to listen', async () => {
    server = await createTestServer();
    await server.login();
    const dir = await server.makeShowFolder('quiet');
    await writeFile(join(dir, 'episode-1.mp3'), episodeBytes(1));
    await server.scanner.scanAllNow('manual');
    const show = server.shows.getBySlug('quiet');
    server.db.prepare("UPDATE shows SET ad_trim_mode = 'review', ad_auto_min_episodes = 2 WHERE id = ?").run(show.id);
    await server.adPipeline.processShow(show.id);
    const page = await server.get(`/shows/${show.slug}/adverts`);
    assert.match(page.body, /SelfPod cannot read the words in this show's episodes/);
    assert.doesNotMatch(page.body, /still listening/);
    const episode = server.episodes.listByShow(show.id)[0];
    const episodePage = await server.get(`/shows/${show.slug}/episodes/${episode.id}`);
    assert.match(episodePage.body, /The speech recogniser is not available on this machine/);
  });
});

describe('the sample with context', () => {
  it('clamps the context to ten seconds', async () => {
    const show = await setUp({ canned: { 'episode-1.mp3': opening(READ, 1), 'episode-2.mp3': opening(READ_AGAIN, 2) } });
    const [read] = spoken(show.id);
    const plain = await server.get(`/api/ad-segments/${read.id}/sample.mp3`);
    const some = await server.get(`/api/ad-segments/${read.id}/sample.mp3?context=3`);
    const lots = await server.get(`/api/ad-segments/${read.id}/sample.mp3?context=99999`);
    assert.equal(plain.statusCode, 200);
    assert.ok(some.rawPayload.length > plain.rawPayload.length, 'context added nothing');
    // Ten seconds either side of a twelve-second cut, in a thirty-second file: bounded.
    assert.ok(lots.rawPayload.length <= episodeBytes(1).length);
    assert.ok(lots.rawPayload.length > some.rawPayload.length);
  });
});
