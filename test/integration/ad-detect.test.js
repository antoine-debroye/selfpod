import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SEGMENT_STATUS } from '../../src/constants.js';
import { createTestInstance } from '../helpers/harness.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';

const framesFor = (seconds) => Math.round((seconds * 1000) / FRAME_MS);

let app;
let showDir;

beforeEach(async () => {
  app = await createTestInstance();
  showDir = await app.makeShowFolder('tape-club');
});

afterEach(async () => {
  await app.cleanup();
});

/**
 * Writes `count` episodes of one show: the same theme, the same sponsor read, the
 * same outro, and programme audio of its own. What a produced podcast is.
 */
async function makeEpisodes(count, { themeSeconds = 25, sponsorSeconds = 30, outroSeconds = 30 } = {}) {
  for (let n = 0; n < count; n += 1) {
    const file = stitch(
      segment(1_000, framesFor(themeSeconds)),
      segment(100_000 + n * 50_000, framesFor(40)),
      segment(2_000, framesFor(sponsorSeconds)),
      segment(600_000 + n * 50_000, framesFor(40)),
      segment(3_000, framesFor(outroSeconds)),
    );
    await writeFile(join(showDir, `episode-${n}.mp3`), file);
  }
  await app.scanner.scanAllNow('manual');
  return app.shows.getBySlug('tape-club');
}

function setMode(show, mode, extra = {}) {
  app.db
    .prepare('UPDATE shows SET ad_trim_mode = ?, ad_auto_min_episodes = ? WHERE id = ?')
    .run(mode, extra.minEpisodes ?? 3, show.id);
  return app.shows.get(show.id);
}

describe('fingerprinting an episode', () => {
  it('writes the hashes outside the show folder, and records what they describe', async () => {
    const show = await makeEpisodes(1);
    const [episode] = app.episodes.listByShow(show.id);

    const result = await app.adDetect.fingerprintEpisode(episode);

    assert.ok(result.frameCount > 0);
    // Derived data lives with the other derived data, never in the user's own folder.
    const stored = await readdir(join(app.config.fingerprintDir, show.id));
    assert.equal(stored.length, 1);
    assert.match(stored[0], new RegExp(`^${episode.id}\\.\\d+\\.fp$`));

    const files = await readdir(showDir);
    assert.ok(
      files.every((name) => name.endsWith('.mp3')),
      `SelfPod put something in the user's folder: ${files.join(', ')}`,
    );
  });

  it('does not read the file again when nothing about it changed', async () => {
    const show = await makeEpisodes(1);
    const [episode] = app.episodes.listByShow(show.id);

    await app.adDetect.fingerprintEpisode(episode);
    const again = await app.adDetect.fingerprintEpisode(episode);

    assert.equal(again.skipped, 'unchanged');
  });

  it('notices a file that was replaced', async () => {
    // Keyed on the audio's own digest, so a rename costs nothing and a genuinely
    // different file is picked up even at the same path.
    const show = await makeEpisodes(1);
    const [episode] = app.episodes.listByShow(show.id);
    await app.adDetect.fingerprintEpisode(episode);

    await writeFile(join(showDir, episode.filename), segment(900_000, 500));
    const after = await app.adDetect.fingerprintEpisode(episode);

    assert.ok(!after.skipped, 'a replaced file must be re-read');
    assert.equal(after.frameCount, 500);
  });

  it('says plainly that it cannot fingerprint a format it cannot read', async () => {
    // Only MP3 frames can be read without decoding. A silent skip would leave the
    // owner wondering why a show never produces any candidates.
    await app.addAudio('tape-club', 'sample.m4a', 'not-an-mp3.m4a');
    await app.scanner.scanAllNow('manual');
    const show = app.shows.getBySlug('tape-club');
    const episode = app.episodes.listByShow(show.id).find((e) => e.filename.endsWith('.m4a'));

    const result = await app.adDetect.fingerprintEpisode(episode);
    assert.equal(result.skipped, 'unsupported_format');
    assert.equal(result.extension, '.m4a');
  });

  it('forgets the fingerprint when the episode goes', async () => {
    // Through the delete the owner actually performs, not through a helper. Collecting
    // derived files used to be a method nothing called — the row went with the cascade
    // and the file stayed on the share for ever.
    const show = await makeEpisodes(1);
    const [episode] = app.episodes.listByShow(show.id);
    await app.adDetect.fingerprintEpisode(episode);
    assert.equal((await readdir(join(app.config.fingerprintDir, show.id))).length, 1);

    await app.episodes.deleteWithFile(episode.id);

    const stored = await readdir(join(app.config.fingerprintDir, show.id)).catch(() => []);
    assert.deepEqual(stored, [], 'derived data must not outlive what it describes');
    assert.equal(
      app.db.prepare('SELECT COUNT(*) AS n FROM episode_fingerprints').get().n,
      0,
      'the row outlived the episode',
    );
  });
});

describe('cataloguing what a show repeats', () => {
  it('finds the theme, the sponsor read and the outro', async () => {
    const show = setMode(await makeEpisodes(5), 'review');
    await app.adDetect.fingerprintShow(show.id);

    const result = await app.adDetect.detectForShow(show.id);
    assert.equal(result.segments, 3);

    const segments = app.adDetect.listSegments(show.id);
    assert.equal(segments.length, 3);
    for (const entry of segments) {
      assert.equal(entry.episode_count, 5);
      assert.equal(entry.status, SEGMENT_STATUS.CANDIDATE, 'review mode asks first');
      assert.ok(entry.duration_ms > 20_000);
      assert.ok(entry.exemplar_episode_id, 'and offers somewhere to hear it');
    }
  });

  it('does nothing at all while the show is set to off', async () => {
    const show = await makeEpisodes(4); // default mode is 'off'
    await app.adDetect.fingerprintShow(show.id);

    const result = await app.adDetect.detectForShow(show.id);
    assert.equal(result.skipped, 'mode_off');
    assert.deepEqual(app.adDetect.listSegments(show.id), []);
  });

  it('needs more than one episode before it can find repetition', async () => {
    const show = setMode(await makeEpisodes(1), 'review');
    await app.adDetect.fingerprintShow(show.id);
    assert.equal((await app.adDetect.detectForShow(show.id)).skipped, 'not_enough_episodes');
  });

  it('re-running it does not duplicate what it already found', async () => {
    const show = setMode(await makeEpisodes(4), 'review');
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);
    await app.adDetect.detectForShow(show.id);

    assert.equal(app.adDetect.listSegments(show.id).length, 3);
  });

  it('never un-decides something the owner already ruled on', async () => {
    // The corpus grows every week. A new episode must not quietly re-ask about a
    // segment that was rejected, nor re-open one that was approved.
    const show = setMode(await makeEpisodes(4), 'review');
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);

    const [first, second] = app.adDetect.listSegments(show.id);
    app.adDetect.decide(first.id, SEGMENT_STATUS.APPROVED);
    app.adDetect.decide(second.id, SEGMENT_STATUS.REJECTED);

    await makeEpisodes(6);
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);

    assert.equal(app.adDetect.getSegment(first.id).status, SEGMENT_STATUS.APPROVED);
    assert.equal(app.adDetect.getSegment(second.id).status, SEGMENT_STATUS.REJECTED);
  });

  it('keeps the episode count current as more episodes arrive', async () => {
    const show = setMode(await makeEpisodes(3), 'review');
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);
    assert.equal(app.adDetect.listSegments(show.id)[0].episode_count, 3);

    await makeEpisodes(6);
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);
    assert.equal(app.adDetect.listSegments(show.id)[0].episode_count, 6);
  });
});

describe('automatic mode', () => {
  it('approves a sponsor read on sight, and holds the theme tune back', async () => {
    // The whole guard, end to end. "Appears in at least three episodes" cuts the theme
    // on episode three, which is the guaranteed first behaviour of automatic mode on
    // any show with a theme — not a corner case.
    const show = setMode(await makeEpisodes(5), 'auto');
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);

    const segments = app.adDetect.listSegments(show.id);
    const approved = segments.filter((entry) => entry.status === SEGMENT_STATUS.APPROVED);
    const held = segments.filter((entry) => entry.status === SEGMENT_STATUS.CANDIDATE);

    assert.equal(approved.length, 1, 'only the mid-episode read');
    assert.equal(approved[0].auto_approved, 1);
    assert.equal(held.length, 2, 'the theme and the outro wait to be asked about');
    assert.deepEqual(
      held.map((entry) => entry.hold_reason).sort(),
      ['always_at_the_end', 'always_at_the_start'],
    );
    for (const entry of held) {
      assert.ok(entry.holdMessage, 'and each says why, in words');
    }
  });

  it('holds everything back until it has seen enough episodes', async () => {
    const show = setMode(await makeEpisodes(2), 'auto', { minEpisodes: 5 });
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);

    const segments = app.adDetect.listSegments(show.id);
    assert.ok(segments.length > 0, 'they are still catalogued');
    assert.ok(
      segments.every((entry) => entry.status === SEGMENT_STATUS.CANDIDATE),
      'but none is cut yet',
    );
    assert.ok(segments.some((entry) => entry.hold_reason === 'seen_too_few_times'));
  });

  it('lets the owner reverse a cut it made on their behalf', async () => {
    const show = setMode(await makeEpisodes(5), 'auto');
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);

    const approved = app.adDetect
      .listSegments(show.id)
      .find((entry) => entry.status === SEGMENT_STATUS.APPROVED);
    const after = app.adDetect.decide(approved.id, SEGMENT_STATUS.REJECTED);

    assert.equal(after.status, SEGMENT_STATUS.REJECTED);
    assert.equal(after.auto_approved, 0, 'and it is no longer recorded as automatic');
  });
});

describe('the cut list for an episode', () => {
  it('contains only what was approved', async () => {
    const show = setMode(await makeEpisodes(5), 'review');
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);
    const [episode] = app.episodes.listByShow(show.id);

    assert.deepEqual(app.adDetect.cutListFor(episode.id), [], 'nothing is cut until it is approved');

    const sponsor = app.adDetect
      .listSegments(show.id)
      .find((entry) => entry.hold_reason === null || entry.hold_reason === undefined)
      ?? app.adDetect.listSegments(show.id)[0];
    app.adDetect.decide(sponsor.id, SEGMENT_STATUS.APPROVED);

    const cuts = app.adDetect.cutListFor(episode.id);
    assert.equal(cuts.length, 1);
    assert.ok(cuts[0].endFrame > cuts[0].startFrame);
  });

  it('merges two approved segments that describe the same audio', async () => {
    // The same stretch can be found twice — once by repetition, once by comparing two
    // downloads. Cutting overlapping ranges one after the other removes more than
    // either of them describes.
    const show = setMode(await makeEpisodes(4), 'review');
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);
    const [episode] = app.episodes.listByShow(show.id);

    for (const entry of app.adDetect.listSegments(show.id)) {
      app.adDetect.decide(entry.id, SEGMENT_STATUS.APPROVED);
    }
    // A diff-sourced segment covering the same frames as an existing one.
    const existing = app.adDetect.cutListFor(episode.id)[0];
    app.adDetect.recordDiffSegments(
      episode,
      [
        {
          start: existing.startFrame + 10,
          end: existing.endFrame + 50,
          startMs: existing.startMs + 200,
          endMs: existing.endMs + 1000,
        },
      ],
      { timing: {} },
    );
    for (const entry of app.adDetect.listSegments(show.id)) {
      app.adDetect.decide(entry.id, SEGMENT_STATUS.APPROVED);
    }

    const cuts = app.adDetect.cutListFor(episode.id);
    for (let i = 1; i < cuts.length; i += 1) {
      assert.ok(
        cuts[i].startFrame > cuts[i - 1].endFrame,
        `overlapping cuts survived: ${JSON.stringify(cuts)}`,
      );
    }
  });

  it('is empty for an episode nothing was found in', async () => {
    const show = setMode(await makeEpisodes(3), 'review');
    await app.adDetect.fingerprintShow(show.id);
    assert.deepEqual(app.adDetect.cutListFor('no-such-episode'), []);
  });
});

describe('what comparing two downloads records', () => {
  it('is approved on sight in automatic mode, wherever it sits', async () => {
    // A theme tune is in both copies, so it can never be what differs between them.
    // Anything that does differ is an advert by construction, and the position guard
    // that protects a theme does not apply.
    const show = setMode(await makeEpisodes(2), 'auto');
    const [episode] = app.episodes.listByShow(show.id);

    app.adDetect.recordDiffSegments(
      episode,
      [{ start: 0, end: 200, startMs: 0, endMs: 5224, durationMs: 5224 }],
      { timing: {} },
    );

    const [recorded] = app.adDetect.listSegments(show.id);
    assert.equal(recorded.source, 'diff');
    assert.equal(recorded.status, SEGMENT_STATUS.APPROVED);
    assert.equal(recorded.hold_reason, null, 'nothing held it back');
  });

  it('waits to be asked about in review mode', async () => {
    const show = setMode(await makeEpisodes(2), 'review');
    const [episode] = app.episodes.listByShow(show.id);

    app.adDetect.recordDiffSegments(
      episode,
      [{ start: 0, end: 200, startMs: 0, endMs: 5224, durationMs: 5224 }],
      { timing: {} },
    );

    assert.equal(app.adDetect.listSegments(show.id)[0].status, SEGMENT_STATUS.CANDIDATE);
  });
});
