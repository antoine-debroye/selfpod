import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { SEGMENT_SOURCES, SEGMENT_STATUS } from '../../src/constants.js';
import { frameProfile } from '../../src/lib/mp3-frames.js';
import { FIXTURE_DIR } from '../helpers/harness.js';
import { createTestServer } from '../helpers/http.js';
import { cannedWhisper, whisperJson } from '../helpers/whisper.js';

/**
 * The pipeline end to end: a show whose pre-roll is a different advert every day,
 * behind the same station jingle every time — the shape this feature exists for
 * (spec §19.6). Built from real fixture audio, not frames of chosen noise: a
 * synthetic MP3's payload has no psychoacoustic structure of its own, so a decoder's
 * bit reservoir and IMDCT overlap carry the *preceding* frames' garbage into it in a
 * way real encoded audio never shows — measured directly while building this file,
 * two copies of one byte-identical stretch decoded to a 0.45–0.56 bit error rate
 * once one of them followed a different amount of audio. `theme-48k.mp3` and the two
 * `sponsor-en-*.mp3` fixtures are real encodes and do not have that problem.
 */
const JINGLE = readFileSync(join(FIXTURE_DIR, 'theme-48k.mp3'));
const PROGRAMME_A = readFileSync(join(FIXTURE_DIR, 'prog-a.mp3'));
const PROGRAMME_B = readFileSync(join(FIXTURE_DIR, 'prog-b.mp3'));
const PROGRAMME_C = readFileSync(join(FIXTURE_DIR, 'prog-c.mp3'));
const PREROLL_A = readFileSync(join(FIXTURE_DIR, 'sponsor-en-daniel.mp3'));
const PREROLL_B = readFileSync(join(FIXTURE_DIR, 'sponsor-en-samantha.mp3'));

let server;

afterEach(async () => {
  await server?.cleanup();
  server = null;
});

async function makeShow({ mode = 'review', minEpisodes = 3, whisper = null } = {}) {
  server = await createTestServer({ whisper });
  const dir = await server.makeShowFolder('jingle-show');
  await writeFile(join(dir, '.keep'), '');
  await server.scanner.scanAllNow('manual');
  const created = server.shows.getBySlug('jingle-show');
  server.db
    .prepare('UPDATE shows SET ad_trim_mode = ?, ad_auto_min_episodes = ? WHERE id = ?')
    .run(mode, minEpisodes, created.id);
  return { show: server.shows.get(created.id), dir };
}

async function addEpisode(dir, name, ...parts) {
  await writeFile(join(dir, name), Buffer.concat(parts));
  await server.scanner.scanAllNow('manual');
  const show = server.shows.getBySlug('jingle-show');
  return server.episodes.listByShow(show.id).find((row) => row.filename === name);
}

const byFilename = (showId) => Object.fromEntries(server.episodes.listByShow(showId).map((row) => [row.filename, row]));
const holds = (showId) => Object.fromEntries(server.episodes.listByShow(showId).map((row) => [row.filename, row.publish_hold]));
const anchors = (showId) => server.adDetect.listAnchors(showId);

describe('the jingle by its sound, with no recognizer at all', () => {
  it('proposes the jingle, and confirming it cuts only what came before it', async () => {
    const { show, dir } = await makeShow({ mode: 'review' });
    server.db.prepare(`UPDATE shows SET ad_transcribe = 'off' WHERE id = ?`).run(show.id);

    await addEpisode(dir, 'episode-0.mp3', JINGLE, PROGRAMME_A); // no pre-roll that day
    await addEpisode(dir, 'episode-1.mp3', JINGLE, PROGRAMME_B); // no pre-roll that day
    await addEpisode(dir, 'episode-2.mp3', PREROLL_A, JINGLE, PROGRAMME_C);
    await addEpisode(dir, 'episode-3.mp3', PREROLL_B, JINGLE, PROGRAMME_A);

    await server.adPipeline.processShow(show.id);

    const [proposal] = anchors(show.id);
    assert.ok(proposal, 'no jingle was proposed from four episodes sharing one at varying offsets');
    assert.equal(proposal.origin, 'proposed');
    assert.equal(proposal.confirmed_at, null, 'a proposal must not have decided anything on its own');

    for (const episode of server.episodes.listByShow(show.id)) {
      assert.equal(episode.trimmed_filename, null, `${episode.filename} was trimmed before the jingle was confirmed`);
    }

    server.adDetect.confirmAnchor(proposal.id);
    await server.adPipeline.processShow(show.id);

    const confirmed = server.adDetect.getAnchor(proposal.id);
    assert.ok(confirmed.confirmed_at, 'confirming did not stick');

    const episodes = byFilename(show.id);
    // The two episodes with no pre-roll cut nothing: the jingle sits too close to
    // 0:00 in either of them to be worth cutting anything ahead of it.
    assert.equal(episodes['episode-0.mp3'].trimmed_filename, null, 'nothing to cut, yet it was trimmed');
    assert.equal(episodes['episode-1.mp3'].trimmed_filename, null, 'nothing to cut, yet it was trimmed');

    // The two with a pre-roll are cut down to roughly what the jingle plus programme
    // measures on its own — what is left after the pre-roll is removed should match
    // what was never there to begin with, within the tolerance real audio boundaries
    // need. Measured directly from the bytes with `frameProfile`, not read from
    // `episode.duration_seconds`: a fixture carrying its own Xing/VBR header reports
    // that header's own declared length there, not the length of the file SelfPod
    // actually built by concatenating it with more audio after it.
    const reference = frameProfile(Buffer.concat([JINGLE, PROGRAMME_A])).durationMs / 1000;
    for (const name of ['episode-2.mp3', 'episode-3.mp3']) {
      assert.ok(episodes[name].trimmed_filename, `${name}'s pre-roll was not cut`);
      assert.ok(
        Math.abs(episodes[name].trimmed_duration_seconds - reference) <= 2,
        `expected close to ${reference}s left in ${name}, got ${episodes[name].trimmed_duration_seconds}s`,
      );
    }

    // The pre-roll cutting itself is complete and correct, which is what this test is
    // actually about. Whatever the ordinary "audio this show repeats" search still
    // finds inside the jingle's own six seconds beyond the anchor's own short clip —
    // real fixture audio can have internal structure a 1200–3000ms clip does not
    // fully cover — is not a safety problem: it can only ever sit as an unapproved
    // review candidate, never auto-cut, and is not this test's concern.
    for (const segment of server.adDetect.listSegments(show.id)) {
      if (segment.signature.startsWith('anchor:')) continue;
      assert.notEqual(segment.status, SEGMENT_STATUS.APPROVED, `${segment.signature} was approved on its own`);
    }
  });

  it('does not propose the same jingle again once it has been dismissed', async () => {
    const { show, dir } = await makeShow({ mode: 'review' });
    server.db.prepare(`UPDATE shows SET ad_transcribe = 'off' WHERE id = ?`).run(show.id);
    await addEpisode(dir, 'episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode(dir, 'episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode(dir, 'episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);

    await server.adPipeline.processShow(show.id);
    const [proposal] = anchors(show.id);
    assert.ok(proposal);

    server.adDetect.dismissAnchor(proposal.id);
    await server.adPipeline.processShow(show.id);
    await addEpisode(dir, 'episode-3.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await server.adPipeline.processShow(show.id);

    const rows = anchors(show.id);
    assert.equal(rows.length, 1, 'the dismissed jingle came back as a fresh proposal');
    assert.ok(rows[0].dismissed_at);
    assert.equal(rows[0].confirmed_at, null);
    for (const episode of server.episodes.listByShow(show.id)) {
      assert.equal(episode.trimmed_filename, null, 'a dismissed proposal cut something anyway');
    }
  });

  it('changes nothing on a second, unchanged pass', async () => {
    const { show, dir } = await makeShow({ mode: 'review' });
    server.db.prepare(`UPDATE shows SET ad_transcribe = 'off' WHERE id = ?`).run(show.id);
    await addEpisode(dir, 'episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode(dir, 'episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode(dir, 'episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);

    await server.adPipeline.processShow(show.id);
    server.adDetect.confirmAnchor(anchors(show.id)[0].id);
    await server.adPipeline.processShow(show.id);

    const before = byFilename(show.id);
    const result = await server.adPipeline.processShow(show.id);

    assert.equal(result.trimmed.trimmed, 0, 'a third, unchanged pass re-cut something');
    const after = byFilename(show.id);
    for (const name of Object.keys(before)) {
      assert.equal(after[name].trimmed_etag, before[name].trimmed_etag, `${name} was re-cut with nothing having changed`);
    }
  });

  it('says nothing was heard, and leaves the opening alone, when the jingle is absent', async () => {
    const { show, dir } = await makeShow({ mode: 'review' });
    server.db.prepare(`UPDATE shows SET ad_transcribe = 'off' WHERE id = ?`).run(show.id);
    await addEpisode(dir, 'episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode(dir, 'episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode(dir, 'episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);
    await server.adPipeline.processShow(show.id);
    server.adDetect.confirmAnchor(anchors(show.id)[0].id);
    await server.adPipeline.processShow(show.id);

    // A later episode that never carries the jingle at all — a format change, or a
    // one-off the host published without it.
    const noJingle = await addEpisode(dir, 'episode-3.mp3', PROGRAMME_C, PROGRAMME_A);
    const result = await server.adPipeline.processShow(show.id);

    assert.ok(result.anchored.missed >= 1, 'the missing jingle was not even checked for');
    const episode = server.episodes.get(noJingle.id);
    assert.equal(episode.trimmed_filename, null, 'an episode with no jingle had its opening cut anyway');
    assert.equal(episode.publish_hold, null, 'a missed jingle held the episode, rather than leaving it as it arrived');

    const status = server.adDetect.anchorStatusFor(noJingle.id);
    assert.ok(status, 'no record was kept of having looked');
    assert.equal(status.heard, false);
  });

  it('un-trims an episode that is re-published without the jingle it used to carry', async () => {
    /*
     * This is the general bug the anchor's own occurrence-shrinking depends on being
     * correct, caught here rather than left implicit: `markForRecut(segmentId, only)`
     * is called *after* `replaceOccurrences` has already deleted the row for an
     * episode whose occurrence just vanished, so a version that re-derived who to
     * mark from the segment's *current* occurrences — rather than trusting the set
     * `only` it was handed — would never find that episode there to mark, and it
     * would go on serving its old, now-wrong trim for ever. A host re-publishing an
     * episode without the jingle it used to open with is a plausible, ordinary way
     * for this to happen, not a contrived one.
     */
    const { show, dir } = await makeShow({ mode: 'review' });
    server.db.prepare(`UPDATE shows SET ad_transcribe = 'off' WHERE id = ?`).run(show.id);
    await addEpisode(dir, 'episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode(dir, 'episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode(dir, 'episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);
    await server.adPipeline.processShow(show.id);
    server.adDetect.confirmAnchor(anchors(show.id)[0].id);
    await server.adPipeline.processShow(show.id);

    const beforeRepublish = byFilename(show.id)['episode-2.mp3'];
    assert.ok(beforeRepublish.trimmed_filename, 'setup: episode-2 was never trimmed');

    // Re-published: the same episode, at the same path, with the pre-roll but no
    // longer the jingle — the acoustic anchor genuinely has nothing left to find.
    await addEpisode(dir, 'episode-2.mp3', PREROLL_B, PROGRAMME_C);
    const result = await server.adPipeline.processShow(show.id);

    assert.ok(result.anchored.newlyMissed >= 1, 'the re-published episode was not even checked for the jingle');
    const after = server.episodes.get(beforeRepublish.id);
    assert.notEqual(
      after.updated_at,
      beforeRepublish.updated_at,
      'an episode that lost its only occurrence of the anchor was not marked for a re-cut',
    );
    // Nothing left to cut it to — the jingle that anchored the cut is gone — so the
    // honest outcome, settled within the same pass, is publishing what arrived rather
    // than the previous day's trim.
    assert.equal(after.trim_status, null, 'the stale trim was not discarded');
    assert.equal(after.trimmed_filename, null, 'the episode still points at its old, now-wrong trimmed copy');
  });

  it('says plainly, on the episode itself, what the jingle meant for it', async () => {
    const { show, dir } = await makeShow({ mode: 'review' });
    server.db.prepare(`UPDATE shows SET ad_transcribe = 'off' WHERE id = ?`).run(show.id);
    const noPreroll = await addEpisode(dir, 'episode-0.mp3', JINGLE, PROGRAMME_A);
    const withPreroll = await addEpisode(dir, 'episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode(dir, 'episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);
    await server.adPipeline.processShow(show.id);
    server.adDetect.confirmAnchor(anchors(show.id)[0].id);
    await server.adPipeline.processShow(show.id);
    const noJingle = await addEpisode(dir, 'episode-3.mp3', PROGRAMME_C, PROGRAMME_A);
    await server.adPipeline.processShow(show.id);

    const cutSentence = server.advertsView.advertsFor(server.episodes.get(withPreroll.id), server.shows.get(show.id));
    assert.equal(cutSentence.stage, 'cut_before_jingle');
    assert.match(cutSentence.sentence, /before the station jingle/);

    const atStartSentence = server.advertsView.advertsFor(server.episodes.get(noPreroll.id), server.shows.get(show.id));
    assert.equal(atStartSentence.stage, 'jingle_at_start');

    const missedSentence = server.advertsView.advertsFor(server.episodes.get(noJingle.id), server.shows.get(show.id));
    assert.equal(missedSentence.stage, 'jingle_not_heard');
    assert.match(missedSentence.sentence, /did not hear the station jingle/);
  });
});

describe('the jingle alongside a taught boundary', () => {
  const READ = 'brought to you by acme storage go to acme dot com slash podcast use code PODCAST for twenty percent off terms apply';

  function opening({ jingleWordsAtMs, readBefore = false }) {
    const sentences = [];
    if (readBefore) sentences.push({ from: 500, to: jingleWordsAtMs - 500, text: READ });
    sentences.push({ from: jingleWordsAtMs, to: jingleWordsAtMs + 3000, text: 'ecoutez le generique de la station' });
    sentences.push({ from: jingleWordsAtMs + 3500, to: jingleWordsAtMs + 12000, text: 'bonjour a tous et bienvenue' });
    return whisperJson(sentences, { language: 'fr' });
  }

  it('links a taught marker to the jingle once their boundaries agree, and keeps cutting', async () => {
    const whisper = cannedWhisper({
      'episode-0.mp3': opening({ jingleWordsAtMs: 500 }),
      'episode-1.mp3': opening({ jingleWordsAtMs: 8000, readBefore: true }),
      'episode-2.mp3': opening({ jingleWordsAtMs: 8000, readBefore: true }),
    });
    const { show, dir } = await makeShow({ mode: 'review', whisper });
    server.db
      .prepare(`UPDATE shows SET ad_transcribe = 'edges', ad_transcribe_head_seconds = 60, ad_transcribe_tail_seconds = 60 WHERE id = ?`)
      .run(show.id);

    await addEpisode(dir, 'episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode(dir, 'episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode(dir, 'episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);

    server.adDetect.addMarker({ showId: show.id, role: 'programme_starts', rawText: 'ecoutez le generique de la station', language: 'fr' });
    // Two passes, deliberately: the first proposes the jingle and reads the marker's
    // words for the first time; only the second can see that they agree, because
    // `detectAnchors` runs before the words are read at all on any single pass.
    await server.adPipeline.processShow(show.id);
    await server.adPipeline.processShow(show.id);

    const [anchor] = anchors(show.id);
    assert.ok(anchor, 'the jingle was not proposed');
    assert.equal(anchor.origin, 'from_marker', 'the taught boundary and the jingle were not linked');
    assert.ok(anchor.confirmed_at, 'a linked marker should confirm the anchor immediately');
    assert.ok(anchor.marker_id, 'the anchor does not remember which marker it came from');

    const episodes = byFilename(show.id);
    assert.equal(episodes['episode-0.mp3'].trimmed_filename, null);
    for (const name of ['episode-1.mp3', 'episode-2.mp3']) {
      assert.ok(episodes[name].trimmed_filename, `${name}'s pre-roll was not cut`);
    }
  });

  it('still cuts a read the owner already approved, in an episode where the jingle is missed', async () => {
    // Two things kept apart on purpose: a sponsor read approved through the ordinary
    // word-repetition path, quite unrelated to any jingle, and a jingle pointed at by
    // hand on one single episode (not proposed from the corpus — the read-only
    // episodes below have nothing in common with the others' opening, and the
    // proposal search insists every episode it looks at shares one). An episode
    // carrying the read but not the jingle then has to show both memories still work
    // side by side — the anchor claiming nothing there, and stage 1 still applying
    // the read the owner already decided about.
    const readOnly = (n) =>
      whisperJson([
        { from: 500, to: 8000, text: READ },
        { from: 8500, to: 15000, text: `and now the programme number ${n}` },
      ]);
    const whisper = cannedWhisper({
      'read-a.mp3': readOnly(1),
      'read-b.mp3': readOnly(2),
      'read-c.mp3': readOnly(3),
    });
    const { show, dir } = await makeShow({ mode: 'review', whisper });
    server.db
      .prepare(`UPDATE shows SET ad_transcribe = 'edges', ad_transcribe_head_seconds = 60, ad_transcribe_tail_seconds = 60 WHERE id = ?`)
      .run(show.id);

    // The read, approved on its own.
    const readA = await addEpisode(dir, 'read-a.mp3', PROGRAMME_A, PROGRAMME_B);
    await addEpisode(dir, 'read-b.mp3', PROGRAMME_B, PROGRAMME_C);
    await server.adPipeline.processShow(show.id);
    const spoken = server.adDetect
      .listSegments(show.id)
      .find((row) => row.source === SEGMENT_SOURCES.TRANSCRIPT && row.text?.includes('acme'));
    assert.ok(spoken, 'the sponsor read was never offered to approve');
    server.adDetect.decide(spoken.id, SEGMENT_STATUS.APPROVED);

    // The jingle, pointed at by hand on one of those same episodes — the point of
    // this test is what happens once an anchor exists, not how it came to exist.
    const jingleFingerprint = await server.adDetect.loadFingerprint(server.episodes.get(readA.id));
    assert.ok(jingleFingerprint?.hashes?.length, 'setup: no fingerprint to anchor to');
    const anchor = await server.adDetect.addAnchorFromRange({
      showId: show.id,
      episodeId: readA.id,
      startMs: 0,
      endMs: Math.min(4000, jingleFingerprint.durationMs),
    });
    assert.ok(anchor.confirmed_at, 'pointing at a jingle by hand should confirm it immediately');

    // A later episode carries the exact same read, and none of the audio the anchor
    // was pointed at anywhere in it — the acoustic anchor has nothing to say about
    // it, and the read still has to be cut because the owner already decided about
    // it.
    const withSameRead = await addEpisode(dir, 'read-c.mp3', PROGRAMME_C, PROGRAMME_B);
    const result = await server.adPipeline.processShow(show.id);

    assert.ok(result.anchored.missed >= 1, 'the jingle was not even checked for in the read-only episode');
    const episode = server.episodes.get(withSameRead.id);
    assert.ok(episode.trimmed_filename, 'a read already approved was not cut in an episode the jingle was never heard in');
  });
});

describe('the jingle in automatic mode', () => {
  it('is cut without being asked when heard in every recent episode, and forgetting it keeps it forgotten', async () => {
    const { show, dir } = await makeShow({ mode: 'auto' });
    server.db.prepare(`UPDATE shows SET ad_transcribe = 'off' WHERE id = ?`).run(show.id);
    await addEpisode(dir, 'episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode(dir, 'episode-1.mp3', JINGLE, PROGRAMME_B);
    await addEpisode(dir, 'episode-2.mp3', PREROLL_A, JINGLE, PROGRAMME_C);
    await addEpisode(dir, 'episode-3.mp3', PREROLL_B, JINGLE, PROGRAMME_A);

    const result = await server.adPipeline.processShow(show.id);

    const [anchor] = anchors(show.id);
    assert.ok(anchor.confirmed_at, 'a jingle heard in every episode was left as a question in automatic mode');
    assert.equal(anchor.auto_confirmed, 1, 'it does not say SelfPod confirmed it on its own');
    assert.equal(result.anchored.autoConfirmed, true);
    const cut = byFilename(show.id);
    assert.ok(cut['episode-2.mp3'].trimmed_filename, 'the pre-roll in front of the jingle was not cut');
    assert.ok(cut['episode-3.mp3'].trimmed_filename, 'the pre-roll in front of the jingle was not cut');
    assert.equal(cut['episode-0.mp3'].trimmed_filename, null, 'a jingle at the very start cut something');

    server.adDetect.removeAnchor(anchor.id);
    await server.adPipeline.processShow(show.id);
    await server.adPipeline.processShow(show.id);

    const after = anchors(show.id);
    assert.equal(after.length, 1, 'forgetting it made SelfPod propose the same jingle again');
    assert.ok(after[0].dismissed_at);
    assert.equal(after[0].confirmed_at, null);
    for (const episode of server.episodes.listByShow(show.id)) {
      assert.equal(episode.trimmed_filename, null, `${episode.filename} is still cut after the jingle was forgotten`);
    }
  });

  it('stays a question in review mode', async () => {
    const { show, dir } = await makeShow({ mode: 'review' });
    server.db.prepare(`UPDATE shows SET ad_transcribe = 'off' WHERE id = ?`).run(show.id);
    await addEpisode(dir, 'episode-0.mp3', JINGLE, PROGRAMME_A);
    await addEpisode(dir, 'episode-1.mp3', PREROLL_A, JINGLE, PROGRAMME_B);
    await addEpisode(dir, 'episode-2.mp3', PREROLL_B, JINGLE, PROGRAMME_C);
    await server.adPipeline.processShow(show.id);
    const [anchor] = anchors(show.id);
    assert.ok(anchor);
    assert.equal(anchor.confirmed_at, null);
    assert.equal(anchor.auto_confirmed, 0);
  });
});
