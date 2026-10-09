import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { SEGMENT_STATUS } from '../../src/constants.js';
import { FIXTURE_DIR } from '../helpers/harness.js';
import { createTestServer } from '../helpers/http.js';
import { cannedWhisper, whisperJson } from '../helpers/whisper.js';

/**
 * The advert pass runs every few minutes for every show, and nearly every run finds
 * what it found last time. It used to pay full price for that: every fingerprint of
 * the show loaded into memory, the jingle looked for in every episode again, every
 * transcript parsed and every known read matched against every episode again. These
 * prove the pass now does that work only when something it reads has changed — and,
 * just as important, that it still does it when something has.
 *
 * Real fixture audio, as in ad-anchor.test.js, so the jingle search genuinely runs;
 * a canned recogniser, so the words search does too.
 */
const JINGLE = readFileSync(join(FIXTURE_DIR, 'theme-48k.mp3'));
const PROGRAMME_A = readFileSync(join(FIXTURE_DIR, 'prog-a.mp3'));
const PROGRAMME_B = readFileSync(join(FIXTURE_DIR, 'prog-b.mp3'));
const PROGRAMME_C = readFileSync(join(FIXTURE_DIR, 'prog-c.mp3'));
const PREROLL_A = readFileSync(join(FIXTURE_DIR, 'sponsor-en-daniel.mp3'));
const PREROLL_B = readFileSync(join(FIXTURE_DIR, 'sponsor-en-samantha.mp3'));

const READ = 'brought to you by acme storage go to acme dot com slash podcast use code PODCAST for twenty percent off terms apply';

/**
 * The jingle's words, then a welcome, then the sponsor read — after the jingle, where
 * the confirmed anchor claims nothing, so the read is offered as a row of its own.
 */
function opening({ jingleWordsAtMs }) {
  const sentences = [];
  sentences.push({ from: jingleWordsAtMs, to: jingleWordsAtMs + 3000, text: 'ecoutez le generique de la station' });
  sentences.push({ from: jingleWordsAtMs + 3500, to: jingleWordsAtMs + 8000, text: 'bonjour a tous et bienvenue' });
  sentences.push({ from: jingleWordsAtMs + 9000, to: jingleWordsAtMs + 20000, text: READ });
  return whisperJson(sentences, { language: 'fr' });
}

let server;

afterEach(async () => {
  await server?.cleanup();
  server = null;
});

/** A show with a confirmed jingle and a sponsor read already offered, settled by two passes. */
async function settledShow() {
  const whisper = cannedWhisper({
    'episode-0.mp3': opening({ jingleWordsAtMs: 500 }),
    'episode-1.mp3': opening({ jingleWordsAtMs: 8000 }),
    'episode-2.mp3': opening({ jingleWordsAtMs: 8000 }),
    'episode-3.mp3': opening({ jingleWordsAtMs: 8000 }),
  });
  server = await createTestServer({ whisper });
  const dir = await server.makeShowFolder('jingle-show');
  await writeFile(join(dir, '.keep'), '');
  await server.scanner.scanAllNow('manual');
  const created = server.shows.getBySlug('jingle-show');
  server.db
    .prepare(
      `UPDATE shows SET ad_trim_mode = 'review', ad_auto_min_episodes = 3,
              ad_transcribe = 'edges', ad_transcribe_head_seconds = 60, ad_transcribe_tail_seconds = 60 WHERE id = ?`,
    )
    .run(created.id);
  const show = server.shows.get(created.id);

  const addEpisode = async (name, ...parts) => {
    await writeFile(join(dir, name), Buffer.concat(parts));
    await server.scanner.scanAllNow('manual');
    return server.episodes.listByShow(show.id).find((row) => row.filename === name);
  };
  await addEpisode('episode-0.mp3', JINGLE, PROGRAMME_A);
  await addEpisode('episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
  await addEpisode('episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);

  await server.adPipeline.processShow(show.id);
  const [proposal] = server.adDetect.listAnchors(show.id);
  assert.ok(proposal, 'setup: no jingle was proposed');
  server.adDetect.confirmAnchor(proposal.id);
  const second = await server.adPipeline.processShow(show.id);
  assert.equal(second.detection, 'ran', 'setup: confirming the jingle did not make the next pass look');
  assert.ok(server.adDetect.listSegments(show.id).some((row) => row.text?.includes('acme')), 'setup: the read was never heard');
  return { show, dir, addEpisode };
}

const workDelta = (before) => {
  const now = server.adDetect.workDone();
  return Object.fromEntries(Object.keys(now).map((key) => [key, now[key] - before[key]]));
};

describe('a pass over a show nothing has happened to', () => {
  it('reads no fingerprints, looks for no jingle, matches no words and searches nothing', async () => {
    const { show } = await settledShow();
    const before = server.adDetect.workDone();

    const result = await server.adPipeline.processShow(show.id);

    assert.equal(result.detection, 'skipped');
    assert.equal(result.anchored.skipped, 'unchanged');
    assert.deepEqual(
      workDelta(before),
      { fingerprintsComputed: 0, fingerprintsLoaded: 0, anchorsLocated: 0, phrasesLocated: 0, corpusSearches: 0 },
      'an unchanged show cost real work',
    );
    // And it still settles what is cheap to settle, and changes nothing.
    assert.equal(result.trimmed.trimmed, 0);
    assert.ok(result.held + result.released >= 0);
  });

  it('skips again on the pass after that, not only once', async () => {
    const { show } = await settledShow();
    await server.adPipeline.processShow(show.id);
    const before = server.adDetect.workDone();
    const third = await server.adPipeline.processShow(show.id);
    assert.equal(third.detection, 'skipped');
    assert.equal(workDelta(before).anchorsLocated, 0);
  });
});

describe('a new episode', () => {
  it('is looked for the jingle in, and the episodes already checked are not', async () => {
    const { show, addEpisode } = await settledShow();
    const anchor = server.adDetect.listAnchors(show.id)[0];
    const before = server.adDetect.workDone();

    const fresh = await addEpisode('episode-3.mp3', PREROLL_B, JINGLE, PROGRAMME_A);
    const result = await server.adPipeline.processShow(show.id);

    assert.equal(result.detection, 'ran');
    const delta = workDelta(before);
    assert.equal(delta.fingerprintsComputed, 1, 'only the new file should have been decoded');
    assert.equal(delta.anchorsLocated, 1, 'the jingle was looked for in episodes it had already been found in');
    const hit = server.db
      .prepare('SELECT * FROM ad_anchor_hits WHERE anchor_id = ? AND episode_id = ?')
      .get(anchor.id, fresh.id);
    assert.ok(hit?.heard, 'the new episode was not checked for the jingle');
    assert.ok(server.episodes.get(fresh.id).trimmed_filename, "the new episode's pre-roll was not cut");
    // The read it carries was matched too: the words search ran for the new transcript.
    assert.ok(delta.phrasesLocated > 0, 'the known read was not looked for in the new episode');
  });

  it('is looked for again when its file is replaced, and the untouched episodes are not', async () => {
    const { show, addEpisode } = await settledShow();
    const anchor = server.adDetect.listAnchors(show.id)[0];
    const checkedBefore = Object.fromEntries(
      server.db.prepare('SELECT episode_id, checked_at FROM ad_anchor_hits WHERE anchor_id = ?').all(anchor.id)
        .map((row) => [row.episode_id, row.checked_at]),
    );
    const untouched = server.episodes.listByShow(show.id).filter((row) => row.filename !== 'episode-2.mp3');
    const before = server.adDetect.workDone();

    // Re-published at the same path, with the same audio in a different order. To the
    // scanner that is a new episode, and the row the old file had re-reads the same
    // path: every episode fingerprinted afresh here is one the jingle must be looked
    // for in again — and nothing else is.
    await addEpisode('episode-2.mp3', PREROLL_A, JINGLE, PROGRAMME_C);
    const result = await server.adPipeline.processShow(show.id);

    assert.equal(result.detection, 'ran');
    const delta = workDelta(before);
    assert.ok(delta.fingerprintsComputed >= 1, 'setup: the replaced file was not read');
    assert.equal(delta.anchorsLocated, delta.fingerprintsComputed, 'the jingle was looked for in episodes whose fingerprint had not changed');
    for (const episode of untouched) {
      const row = server.db.prepare('SELECT checked_at FROM ad_anchor_hits WHERE anchor_id = ? AND episode_id = ?').get(anchor.id, episode.id);
      assert.equal(row.checked_at, checkedBefore[episode.id], `${episode.filename} was checked again for nothing`);
    }
  });
});

describe('what the owner does', () => {
  it('a decision makes the next pass look again', async () => {
    const { show } = await settledShow();
    await server.adPipeline.processShow(show.id); // gate closed
    const read = server.adDetect.listSegments(show.id).find((row) => row.text?.includes('acme'));
    assert.equal(read.status, SEGMENT_STATUS.CANDIDATE, 'setup: the read was already decided');

    server.adDetect.decide(read.id, SEGMENT_STATUS.APPROVED);
    const result = await server.adPipeline.processShow(show.id);

    assert.equal(result.detection, 'ran', 'a decision did not reopen detection');
    assert.ok(result.trimmed.trimmed >= 2, 'the approved read was not cut');
    // Closed again behind it.
    assert.equal((await server.adPipeline.processShow(show.id)).detection, 'skipped');
  });

  it('a boundary taught by its words is applied on the very next pass', async () => {
    const { show } = await settledShow();
    await server.adPipeline.processShow(show.id);

    server.adDetect.addMarker({ showId: show.id, role: 'programme_starts', rawText: 'bonjour a tous', language: 'fr' });
    const result = await server.adPipeline.processShow(show.id);

    assert.equal(result.detection, 'ran');
    const boundary = server.adDetect.listSegments(show.id).find((row) => row.kind === 'boundary_words');
    assert.ok(boundary, 'the taught boundary produced no cut');
    assert.ok(boundary.occurrences.length >= 2, 'the boundary was not located in the episodes that say it');
  });

  it('a catalogue row changed underneath the detectors is noticed and put right', async () => {
    // The same guarantee ad-pipeline.test.js relies on, stated for the gate: the key
    // covers what detection wrote, so an edit to it is a reason to look again.
    const { show } = await settledShow();
    await server.adPipeline.processShow(show.id);
    const jingle = server.adDetect.listSegments(show.id).find((row) => row.kind === 'jingle');
    const [occurrence] = jingle.occurrences;
    server.db
      .prepare('DELETE FROM ad_segment_occurrences WHERE segment_id = ? AND episode_id = ?')
      .run(jingle.id, occurrence.episode_id);

    const result = await server.adPipeline.processShow(show.id);

    assert.equal(result.detection, 'ran');
    const restored = server.adDetect.getSegment(jingle.id);
    assert.equal(restored.occurrence_count, jingle.occurrence_count, 'the deleted occurrence was not re-found');
  });
});
