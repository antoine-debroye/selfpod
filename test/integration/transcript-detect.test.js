import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { PUBLISH_HOLDS, SEGMENT_SOURCES, SEGMENT_STATUS } from '../../src/constants.js';
import { WhisperError } from '../../src/lib/whisper-runner.js';
import { createTestServer } from '../helpers/http.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';
import { cannedWhisper, whisperJson } from '../helpers/whisper.js';

const framesFor = (seconds) => Math.round((seconds * 1000) / FRAME_MS);

/**
 * Every episode is thirty seconds of audio that sounds like nothing else, so the
 * acoustic detector finds nothing and everything below is the words' doing.
 */
function episodeBytes(n) {
  return stitch(segment(900_000 + n * 70_000, framesFor(30)));
}

const READ = 'This episode is brought to you by Acme Storage go to acme dot com slash podcast and use code PODCAST for twenty percent off terms apply';
const READ_AGAIN = 'This episode is brought to you by Acme Storage go to acne dot com slash podcasts and use the code PODCAST for 20 percent off terms apply';

/** Programme talk that is different every day, as programme talk is. */
const PROGRAMME = [
  ['Welcome back to the show, today we have plenty to get through', 'Later on we hear from a listener who wrote in about pensions'],
  ['Good morning and thanks for joining us on a wet Tuesday', 'First up the council has voted on the new bypass again'],
  ['Hello everybody, a packed programme this morning with three guests', 'We start with the strike and what it means for commuters'],
  ['Right then, lots to cover, so let us get straight into it', 'The weather first, and then a long chat about allotments'],
];

/** A sponsor read from 0.5 s to 13 s, then programme. */
function opening(read, n) {
  const [first, second] = PROGRAMME[n % PROGRAMME.length];
  return whisperJson([
    { from: 500, to: 13_000, text: read },
    { from: 13_600, to: 20_000, text: first },
    { from: 20_500, to: 29_000, text: second },
  ]);
}

let server;

afterEach(async () => {
  await server?.cleanup();
  server = null;
});

async function makeShow({ mode, whisper, minEpisodes = 3 }) {
  server = await createTestServer({ whisper });
  const dir = await server.makeShowFolder('spoken');
  await writeFile(join(dir, '.keep'), '');
  await server.scanner.scanAllNow('manual');
  const show = server.shows.getBySlug('spoken');
  server.db
    .prepare('UPDATE shows SET ad_trim_mode = ?, ad_auto_min_episodes = ? WHERE id = ?')
    .run(mode, minEpisodes, show.id);
  return { show: server.shows.get(show.id), dir };
}

async function addEpisode(dir, n) {
  await writeFile(join(dir, `episode-${n}.mp3`), episodeBytes(n));
  await server.scanner.scanAllNow('manual');
  return server.episodes.listByShow(server.shows.getBySlug('spoken').id).find((row) => row.filename === `episode-${n}.mp3`);
}

const spoken = (showId) => server.adDetect.listSegments(showId).filter((row) => row.source === SEGMENT_SOURCES.TRANSCRIPT);
const holds = (showId) => Object.fromEntries(server.episodes.listByShow(showId).map((row) => [row.filename, row.publish_hold]));

describe('hearing a sponsor read in the words', () => {
  it('finds the same read in two episodes that sound nothing alike, with its cues, and holds them for review', async () => {
    const { show, dir } = await makeShow({
      mode: 'review',
      minEpisodes: 2,
      whisper: cannedWhisper({ 'episode-1.mp3': opening(READ, 1), 'episode-2.mp3': opening(READ_AGAIN, 2) }),
    });
    await addEpisode(dir, 1);
    await addEpisode(dir, 2);

    await server.adPipeline.processShow(show.id);

    const acoustic = server.adDetect.listSegments(show.id).filter((row) => row.source === SEGMENT_SOURCES.CORPUS);
    assert.deepEqual(acoustic, [], 'the acoustic detector found something in audio built to share nothing');

    const found = spoken(show.id);
    assert.equal(found.length, 1, JSON.stringify(found.map((row) => row.raw_text)));
    const [read] = found;
    assert.equal(read.status, SEGMENT_STATUS.CANDIDATE);
    assert.equal(read.episode_count, 2);
    assert.match(read.text, /^this episode is brought to you by acme storage/);
    assert.match(read.raw_text, /^This episode is brought to you by Acme Storage/);
    assert.ok(read.cue_score >= 0.67, `cue score ${read.cue_score}`);
    const cues = JSON.parse(read.cues).map((cue) => cue.id);
    assert.ok(cues.includes('brought_to_you_by'), cues.join());
    assert.ok(cues.includes('use_code') || cues.includes('use_the_code'), cues.join());
    // Below the show's threshold of three, but the words carry it — so the reason it
    // waits is the mode, not a hold.
    assert.equal(read.hold_reason, null);
    assert.equal(read.language, 'en');

    // The cut list points at the read, in frames, a little wider than the words.
    for (const occurrence of read.occurrences) {
      assert.ok(occurrence.start_ms <= 500 && occurrence.start_ms >= 0, `starts at ${occurrence.start_ms}`);
      assert.ok(occurrence.end_ms >= 13_000 && occurrence.end_ms < 14_500, `ends at ${occurrence.end_ms}`);
      assert.ok(occurrence.end_frame > occurrence.start_frame);
    }

    assert.deepEqual(holds(show.id), { 'episode-1.mp3': PUBLISH_HOLDS.AWAITING_REVIEW, 'episode-2.mp3': PUBLISH_HOLDS.AWAITING_REVIEW });
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM episode_transcripts WHERE status = ?').get('ok').n, 2);
  });

  it('holds a new episode until it has been heard, then only for the decision', async () => {
    const { show, dir } = await makeShow({ mode: 'review', whisper: cannedWhisper({}), minEpisodes: 2 });
    const episode = await addEpisode(dir, 1);
    assert.equal(episode.publish_hold, PUBLISH_HOLDS.AWAITING_CORPUS);
    // Nothing has listened yet, so the hold stands however the segments look.
    server.adPipeline.settle(show.id);
    assert.equal(server.episodes.get(episode.id).publish_hold, PUBLISH_HOLDS.AWAITING_CORPUS);
    await addEpisode(dir, 2);
    await server.adPipeline.processShow(show.id);
    // Heard (as silence), compared, nothing to decide: published.
    assert.deepEqual(holds(show.id), { 'episode-1.mp3': null, 'episode-2.mp3': null });
  });

  it('cuts the read from the next episode without asking once you have removed it, in review mode', async () => {
    const whisper = cannedWhisper({
      'episode-1.mp3': opening(READ, 1),
      'episode-2.mp3': opening(READ_AGAIN, 2),
      'episode-3.mp3': opening(READ_AGAIN, 3),
    });
    const { show, dir } = await makeShow({ mode: 'review', whisper, minEpisodes: 2 });
    await addEpisode(dir, 1);
    await addEpisode(dir, 2);
    await server.adPipeline.processShow(show.id);
    const [read] = spoken(show.id);
    server.adDetect.decide(read.id, SEGMENT_STATUS.APPROVED);
    await server.adPipeline.processShow(show.id);
    assert.deepEqual(holds(show.id), { 'episode-1.mp3': null, 'episode-2.mp3': null });

    // Day three: the same words, a slightly different transcription.
    const third = await addEpisode(dir, 3);
    assert.equal(third.publish_hold, PUBLISH_HOLDS.AWAITING_CORPUS);
    const result = await server.adPipeline.processShow(show.id);

    const after = spoken(show.id);
    assert.equal(after.length, 1, 'the same read was offered again under a new name');
    assert.equal(after[0].status, SEGMENT_STATUS.APPROVED);
    assert.equal(after[0].episode_count, 3);
    assert.equal(result.heard.rememberedCuts, 1);
    assert.equal(server.episodes.get(third.id).publish_hold, null, 'a decided read still held the episode');
    const trimmed = server.episodes.get(third.id);
    assert.equal(trimmed.trim_status, 'trimmed');
    const bytes = await readFile(join(server.config.trimmedDir, show.id, trimmed.trimmed_filename));
    assert.ok(bytes.length < episodeBytes(3).length, 'nothing was cut from the trimmed copy');
  });

  it('never offers again what you chose to keep, and says so', async () => {
    const whisper = cannedWhisper({
      'episode-1.mp3': opening(READ, 1),
      'episode-2.mp3': opening(READ_AGAIN, 2),
      'episode-3.mp3': opening(READ, 3),
    });
    const { show, dir } = await makeShow({ mode: 'review', whisper, minEpisodes: 2 });
    await addEpisode(dir, 1);
    await addEpisode(dir, 2);
    await server.adPipeline.processShow(show.id);
    const [read] = spoken(show.id);
    server.adDetect.decide(read.id, SEGMENT_STATUS.REJECTED);

    await addEpisode(dir, 3);
    await server.adPipeline.processShow(show.id);

    const after = spoken(show.id);
    assert.equal(after.length, 1);
    assert.equal(after[0].status, SEGMENT_STATUS.REJECTED);
    assert.equal(after[0].episode_count, 3);
    assert.equal(after[0].hold_reason, 'matches_kept_words');
    assert.deepEqual(Object.values(holds(show.id)), [null, null, null]);
  });

  it('cuts a read heard twice on its own in automatic mode, but only offers one heard once', async () => {
    const canned = {
      'episode-1.mp3': opening(READ, 1),
      'episode-2.mp3': opening('Nothing much here just the usual chat about the weather and the news of the day', 2),
    };
    const { show, dir } = await makeShow({ mode: 'auto', whisper: cannedWhisper(canned), minEpisodes: 2 });
    await addEpisode(dir, 1);
    await addEpisode(dir, 2);
    await server.adPipeline.processShow(show.id);

    let [read] = spoken(show.id);
    assert.equal(spoken(show.id).length, 1);
    assert.equal(read.status, SEGMENT_STATUS.CANDIDATE, 'a read heard once was cut on its own');
    assert.equal(read.hold_reason, 'only_heard_once');
    assert.equal(read.episode_count, 1);
    // Automatic mode does not stop the feed for something it will not act on.
    assert.deepEqual(Object.values(holds(show.id)), [null, null]);

    // Day three carries the same read, transcribed a little differently.
    canned['episode-3.mp3'] = opening(READ_AGAIN, 3);
    const third = await addEpisode(dir, 3);
    await server.adPipeline.processShow(show.id);

    [read] = spoken(show.id);
    assert.equal(spoken(show.id).length, 1, 'the same read was offered again under a new name');
    assert.equal(read.status, SEGMENT_STATUS.APPROVED);
    assert.equal(read.auto_approved, 1);
    assert.equal(read.episode_count, 2);
    assert.equal(read.hold_reason, null);
    assert.equal(server.episodes.get(third.id).trim_status, 'trimmed');
    assert.equal(server.episodes.listByShow(show.id).find((row) => row.filename === 'episode-1.mp3').trim_status, 'trimmed');
  });

  it('cuts everything before the words you said the programme starts with', async () => {
    const preRoll = (n) =>
      whisperJson(
        [
          { from: 300, to: 9_000, text: `A different advert every day number ${n} with a price of ${n} euros par mois sans engagement` },
          { from: 9_400, to: 11_000, text: 'Vous écoutez RMC' },
          { from: 11_200, to: 29_000, text: `RMC Apolline Matin et bonjour à tous ${PROGRAMME[n % PROGRAMME.length].join(' ')}` },
        ],
        { language: 'fr' },
      );
    const whisper = cannedWhisper({ 'episode-1.mp3': preRoll(1), 'episode-2.mp3': preRoll(2), 'episode-3.mp3': whisperJson([{ from: 200, to: 5000, text: 'Nothing to hear here at all really' }]) });
    const { show, dir } = await makeShow({ mode: 'review', whisper });
    await addEpisode(dir, 1);
    await addEpisode(dir, 2);
    await addEpisode(dir, 3);

    const marker = server.adDetect.addMarker({ showId: show.id, role: 'programme_starts', rawText: 'Vous écoutez RMC', language: 'fr' });
    const result = await server.adPipeline.processShow(show.id);

    const found = spoken(show.id);
    const boundary = found.find((row) => row.signature === `marker:${marker.id}`);
    assert.ok(boundary, 'no segment for the boundary');
    assert.equal(boundary.status, SEGMENT_STATUS.APPROVED);
    assert.equal(boundary.episode_count, 2, 'the episode without the words was cut');
    assert.equal(result.heard.markerCuts, 2);
    for (const occurrence of boundary.occurrences) {
      assert.equal(occurrence.start_ms, 0);
      assert.ok(occurrence.end_ms >= 9_000 && occurrence.end_ms <= 9_500, `cut ends at ${occurrence.end_ms}, the jingle starts at 9 400`);
    }
    // The pre-roll was different words each day, and it was not offered as a read of
    // its own: the boundary already has it.
    assert.equal(found.filter((row) => row.signature !== `marker:${marker.id}`).length, 0, JSON.stringify(found.map((r) => r.raw_text)));
    // Nothing left to decide, so review mode publishes.
    assert.deepEqual(Object.values(holds(show.id)), [null, null, null]);

    // Forgetting the boundary puts the audio back — and with nothing spoken for, the
    // two near-identical pre-rolls are offered as the repeated read they are.
    server.adDetect.removeMarker(marker.id);
    await server.adPipeline.processShow(show.id);
    const remaining = spoken(show.id);
    assert.ok(!remaining.some((row) => row.signature.startsWith('marker:')), 'the boundary segment survived');
    assert.equal(remaining.length, 1, JSON.stringify(remaining.map((row) => row.raw_text)));
    assert.equal(remaining[0].status, SEGMENT_STATUS.CANDIDATE);
    assert.ok(server.episodes.listByShow(show.id).every((row) => row.trimmed_filename === null), 'a trimmed copy survived the boundary being removed');
  });

  it('gives up loudly when the recogniser keeps failing, and releases the episodes', async () => {
    const whisper = cannedWhisper({
      'episode-1.mp3': new WhisperError('crashed', 'ggml: illegal instruction'),
      'episode-2.mp3': new WhisperError('crashed', 'ggml: illegal instruction'),
      'episode-3.mp3': new WhisperError('timeout', 'gave up'),
    });
    const { show, dir } = await makeShow({ mode: 'review', whisper });
    await addEpisode(dir, 1);
    await addEpisode(dir, 2);
    await addEpisode(dir, 3);
    // The probe itself uses the stub: make it pass, then fail the real runs.
    const result = await server.adPipeline.processShow(show.id);

    assert.ok(result.transcribed.failed >= 1, JSON.stringify(result.transcribed));
    const issue = server.health.list().find((row) => row.key === 'whisper_failing');
    assert.ok(issue, `no health warning: ${JSON.stringify(server.health.list())}`);
    assert.equal(issue.level, 'warn');
    assert.equal(server.transcriber.available(), false);
    assert.deepEqual(Object.values(holds(show.id)), [null, null, null], 'episodes were held for a recogniser that is not coming');
    const rows = server.db.prepare('SELECT status, failure, attempts FROM episode_transcripts').all();
    assert.ok(rows.every((row) => row.status === 'failed'));
  });

  it('listens to the whole episode when asked, and to both ends by default', async () => {
    const { show } = await makeShow({ mode: 'review', whisper: cannedWhisper({}) });
    const long = 60 * 60 * 1000;
    assert.deepEqual(server.transcriber.windowsFor(server.transcriber.scopeFor(show), long), [
      { kind: 'head', fromMs: 0, toMs: 300_000 },
      { kind: 'tail', fromMs: long - 240_000, toMs: long },
    ]);
    assert.deepEqual(server.transcriber.windowsFor(server.transcriber.scopeFor(show), 400_000), [
      { kind: 'whole', fromMs: 0, toMs: 400_000 },
    ]);
    server.db.prepare("UPDATE shows SET ad_transcribe = 'whole' WHERE id = ?").run(show.id);
    assert.deepEqual(server.transcriber.windowsFor(server.transcriber.scopeFor(server.shows.get(show.id)), long), [
      { kind: 'whole', fromMs: 0, toMs: long },
    ]);
  });
});

describe('a pre-roll first found by ear', () => {
  /** Programme of its own, with the same forty-second pre-roll audio in front. */
  function withPreRoll(n) {
    return stitch(segment(2_000, framesFor(40)), segment(500_000 + n * 60_000, framesFor(30)));
  }
  const preRollWords = (n) =>
    whisperJson([
      { from: 500, to: 39_000, text: READ },
      { from: 40_500, to: 69_000, text: PROGRAMME[n % PROGRAMME.length].join(' ') },
    ]);

  it('is let go by the theme-tune guard once its words say sponsor, and stays let go', async () => {
    const whisper = cannedWhisper({ 'episode-1.mp3': preRollWords(1), 'episode-2.mp3': preRollWords(2), 'episode-3.mp3': preRollWords(3) });
    const { show, dir } = await makeShow({ mode: 'auto', whisper, minEpisodes: 3 });
    for (const n of [1, 2, 3]) {
      await writeFile(join(dir, `episode-${n}.mp3`), withPreRoll(n));
    }
    await server.scanner.scanAllNow('manual');
    await server.adPipeline.processShow(show.id);

    const acoustic = () => server.adDetect.listSegments(show.id).filter((row) => row.source === SEGMENT_SOURCES.CORPUS);
    let [preRoll] = acoustic();
    assert.ok(preRoll, 'the acoustic detector did not find the shared pre-roll');
    assert.match(preRoll.text ?? '', /^this episode is brought to you by/, 'the words were not attached to the acoustic segment');
    assert.equal(preRoll.status, SEGMENT_STATUS.APPROVED, `held: ${preRoll.hold_reason}`);
    assert.equal(spoken(show.id).length, 0, 'the same read was offered a second time under the words');

    // The next tick re-runs the acoustic detector, which has never heard the words.
    await server.adPipeline.processShow(show.id);
    [preRoll] = acoustic();
    assert.equal(preRoll.status, SEGMENT_STATUS.APPROVED);
    assert.equal(preRoll.hold_reason, null, 'the theme-tune guard closed again on the next run');
  });
});

describe('changing the speech recogniser', () => {
  it('reads every episode again, rather than leaving them on the old model', async () => {
    /*
     * The reason for pointing WHISPER_MODEL at a better model is that it hears words
     * the smaller one gets wrong. Keeping the transcripts the old one made would have
     * meant the owner made the change, waited, and watched the same words stay wrong,
     * with nothing anywhere saying why.
     */
    const whisper = cannedWhisper({ 'episode-1.mp3': opening(READ, 1), 'episode-2.mp3': opening(READ_AGAIN, 2) });
    const { show, dir } = await makeShow({ mode: 'review', whisper, minEpisodes: 2 });
    await addEpisode(dir, 1);
    await addEpisode(dir, 2);
    await server.adPipeline.processShow(show.id);

    const before = server.db.prepare('SELECT episode_id, model FROM episode_transcripts').all();
    assert.equal(before.length, 2);
    assert.ok(before.every((row) => /base/.test(row.model)), JSON.stringify(before));
    const fresh = server.shows.get(show.id);
    assert.ok(
      server.episodes.listByShow(show.id).every((episode) => !server.transcriber.needsTranscript(episode, fresh)),
      'an episode was owed a transcript before the model changed',
    );

    // The same instance, pointed at the other model the image ships.
    const listening = await createTestServer({
      whisper: cannedWhisper({}),
      env: { DATA_DIR: server.config.dataDir, WHISPER_MODEL: 'small' },
    });
    try {
      const show2 = listening.shows.getBySlug('spoken');
      const owed = listening.episodes
        .listByShow(show2.id)
        .filter((episode) => listening.transcriber.needsTranscript(episode, show2));
      assert.equal(owed.length, 2, 'changing the model left the old transcripts in place');
    } finally {
      await listening.cleanup();
    }
  });
});
