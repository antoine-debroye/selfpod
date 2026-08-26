import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SEGMENT_STATUS, TRIM_STATUS } from '../../src/constants.js';
import { frameProfile } from '../../src/lib/mp3-frames.js';
import { createTrimmer } from '../../src/services/trimmer.js';
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

/** Programme, a sponsor read every episode shares, more programme. */
async function makeShow(count = 3, { sponsorSeconds = 30 } = {}) {
  for (let n = 0; n < count; n += 1) {
    await writeFile(
      join(showDir, `episode-${n}.mp3`),
      stitch(
        segment(100_000 + n * 50_000, framesFor(40)),
        segment(2_000, framesFor(sponsorSeconds)),
        segment(600_000 + n * 50_000, framesFor(40)),
        segment(3_000, framesFor(25)),
      ),
    );
  }
  await app.scanner.scanAllNow('manual');
  const show = app.shows.getBySlug('tape-club');
  app.db.prepare("UPDATE shows SET ad_trim_mode = 'review' WHERE id = ?").run(show.id);
  return app.shows.get(show.id);
}

/** Runs detection and approves everything it found, as a review session would. */
async function detectAndApprove(show) {
  await app.adDetect.fingerprintShow(show.id);
  await app.adDetect.detectForShow(show.id);
  const segments = app.adDetect.listSegments(show.id);
  for (const found of segments) app.adDetect.decide(found.id, SEGMENT_STATUS.APPROVED);
  return segments;
}

describe('producing the trimmed copy', () => {
  it('writes it outside the show folder, leaving the original untouched', async () => {
    // The share is the owner's. Whatever they dropped there is what stays there.
    const show = await makeShow();
    await detectAndApprove(show);
    const [episode] = app.episodes.listByShow(show.id);
    const before = await readFile(join(showDir, episode.filename));

    const result = await app.trimmer.trimEpisode(episode);

    assert.equal(result.trimmed, true);
    assert.deepEqual(await readdir(showDir), ['episode-0.mp3', 'episode-1.mp3', 'episode-2.mp3']);
    assert.equal(
      Buffer.compare(await readFile(join(showDir, episode.filename)), before),
      0,
      'the original was modified',
    );
    const derived = await readdir(join(app.config.trimmedDir, show.id));
    assert.deepEqual(derived, [`${episode.id}.mp3`]);
  });

  it('actually removes the sponsor read, and only that', async () => {
    // Only the sponsor read is approved. The outro repeats just as reliably and is
    // still sitting in the catalogue unapproved, so it must survive the cut — that is
    // the whole difference between "SelfPod found this" and "you decided this".
    const show = await makeShow(3, { sponsorSeconds: 30 });
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);
    const sponsor = app.adDetect
      .listSegments(show.id)
      .find((found) => Math.abs(found.duration_ms - 30_000) < 2000);
    assert.ok(sponsor, 'the 30s sponsor read was not among the segments found');
    app.adDetect.decide(sponsor.id, SEGMENT_STATUS.APPROVED);
    const [episode] = app.episodes.listByShow(show.id);

    await app.trimmer.trimEpisode(episode);

    const trimmed = await readFile(app.trimmer.pathFor(app.episodes.get(episode.id)));
    const original = await readFile(join(showDir, episode.filename));
    const removedSeconds =
      (frameProfile(original).frameCount - frameProfile(trimmed).frameCount) * (FRAME_MS / 1000);

    assert.ok(
      Math.abs(removedSeconds - 30) < 1,
      `expected about 30s of sponsor read gone, ${removedSeconds.toFixed(1)}s went`,
    );
    // The programme either side is byte-identical: nothing was decoded, so nothing
    // could be degraded.
    assert.equal(
      Buffer.compare(trimmed.subarray(0, 20_000), original.subarray(0, 20_000)),
      0,
      'the programme before the cut changed',
    );
  });

  it('records a duration it measured, not one it worked out', async () => {
    // Cutting at frame boundaries adds tens of milliseconds at each join, so
    // "original minus what was cut" would drift from what a player reports.
    const show = await makeShow();
    await detectAndApprove(show);
    const [episode] = app.episodes.listByShow(show.id);

    await app.trimmer.trimEpisode(episode);
    const updated = app.episodes.get(episode.id);

    assert.equal(updated.trim_status, TRIM_STATUS.TRIMMED);
    assert.ok(updated.trimmed_duration_seconds > 0, 'no duration was recorded');
    assert.ok(
      Math.abs(updated.trimmed_duration_seconds - 80) <= 2,
      `80s of programme should survive, recorded ${updated.trimmed_duration_seconds}s`,
    );
    assert.equal(updated.trimmed_bytes, (await stat(app.trimmer.pathFor(updated))).size);
    assert.ok(updated.trimmed_bytes < episode.file_size_bytes, 'the copy is not smaller');
  });

  it('gives the copy a version taken from its own bytes', async () => {
    // The enclosure URL carries this, which is what makes replacing the bytes safe.
    const show = await makeShow();
    await detectAndApprove(show);
    const [one, two] = app.episodes.listByShow(show.id);

    await app.trimmer.trimEpisode(one);
    await app.trimmer.trimEpisode(two);

    const first = app.episodes.get(one.id).trimmed_etag;
    assert.match(first, /^[0-9a-f]{12}$/);
    assert.notEqual(first, app.episodes.get(two.id).trimmed_etag, 'two episodes share a version');

    // Re-running an unchanged cut list must not move the version, or every poll would
    // hand subscribers a new URL for identical audio.
    await app.trimmer.trimEpisode(app.episodes.get(one.id));
    assert.equal(app.episodes.get(one.id).trimmed_etag, first);
  });

  it('changes the version when the audio changes', async () => {
    // This is what the versioned enclosure URL rests on. A version derived from
    // anything but the bytes — the episode id, a timestamp — stays put while the audio
    // underneath it moves, and a client resuming a Range request stitches together two
    // different cuts of the same episode without ever noticing.
    const show = await makeShow();
    await app.adDetect.fingerprintShow(show.id);
    await app.adDetect.detectForShow(show.id);
    const [first, second] = app.adDetect.listSegments(show.id);
    assert.ok(second, 'the fixture should offer two segments to approve separately');

    app.adDetect.decide(first.id, SEGMENT_STATUS.APPROVED);
    const [episode] = app.episodes.listByShow(show.id);
    await app.trimmer.trimEpisode(episode);
    const oneCut = app.episodes.get(episode.id);

    app.adDetect.decide(second.id, SEGMENT_STATUS.APPROVED);
    await app.trimmer.trimEpisode(app.episodes.get(episode.id));
    const twoCuts = app.episodes.get(episode.id);

    assert.ok(twoCuts.trimmed_bytes < oneCut.trimmed_bytes, 'the second cut removed nothing');
    assert.notEqual(twoCuts.trimmed_etag, oneCut.trimmed_etag, 'the audio changed and the version did not');

    // And changing your mind about *which* one was the advert. The cut list is the same
    // length as it was at the first step, so a version derived from how much was cut
    // rather than from what came out would hand back a stale URL for different audio.
    app.adDetect.decide(first.id, SEGMENT_STATUS.REJECTED);
    await app.trimmer.trimEpisode(app.episodes.get(episode.id));
    const swapped = app.episodes.get(episode.id);

    assert.notEqual(swapped.trimmed_etag, oneCut.trimmed_etag, 'a different cut reused a version');
  });

  it('leaves the duration out when nothing could measure it', async () => {
    // The standing rule in this codebase is to omit rather than invent. Arithmetic
    // could always produce a number here — original minus what was cut — and for MP3
    // it would even be close. It would also be the first place a duration in SelfPod
    // came from somewhere other than reading the file, which is exactly how a wrong
    // one gets published with total confidence.
    const show = await makeShow();
    await detectAndApprove(show);
    const [episode] = app.episodes.listByShow(show.id);

    const deaf = createTrimmer({
      db: app.db,
      config: app.config,
      events: app.events,
      health: app.health,
      shows: app.shows,
      episodes: app.episodes,
      adDetect: app.adDetect,
      metadata: { async read() { return { durationSeconds: null, error: null }; } },
    });
    await deaf.trimEpisode(episode);

    assert.equal(app.episodes.get(episode.id).trimmed_duration_seconds, null);
  });

  it('publishes the episode as soon as the copy exists', async () => {
    const show = await makeShow();
    await detectAndApprove(show);
    const [episode] = app.episodes.listByShow(show.id);
    app.episodes.setSystemFields(episode.id, { publish_hold: 'awaiting_review' });

    await app.trimmer.trimEpisode(app.episodes.get(episode.id));

    assert.equal(app.episodes.get(episode.id).publish_hold, null);
  });
});

describe('when the decisions change', () => {
  it('marks an episode for re-trimming when a segment is decided', async () => {
    const show = await makeShow();
    await detectAndApprove(show);
    const [episode] = app.episodes.listByShow(show.id);
    await app.trimmer.trimEpisode(episode);
    assert.equal(app.episodes.get(episode.id).trim_status, TRIM_STATUS.TRIMMED);

    const [found] = app.adDetect.listSegments(show.id);
    app.adDetect.decide(found.id, SEGMENT_STATUS.REJECTED);

    assert.equal(
      app.episodes.get(episode.id).trim_status,
      TRIM_STATUS.PENDING,
      'a decision that did not reach the audio is a decision that did not happen',
    );
  });

  it('takes the copy away when the last approval is withdrawn', async () => {
    // Otherwise rejecting a segment shows as reversed in the UI while subscribers keep
    // downloading the old cut.
    const show = await makeShow();
    await detectAndApprove(show);
    const [episode] = app.episodes.listByShow(show.id);
    await app.trimmer.trimEpisode(episode);
    const path = app.trimmer.pathFor(app.episodes.get(episode.id));

    for (const found of app.adDetect.listSegments(show.id)) {
      app.adDetect.decide(found.id, SEGMENT_STATUS.REJECTED);
    }
    await app.trimmer.trimEpisode(app.episodes.get(episode.id));

    const updated = app.episodes.get(episode.id);
    assert.equal(updated.trimmed_filename, null);
    assert.equal(updated.trim_status, null);
    await assert.rejects(() => stat(path), 'the trimmed copy outlived its approval');
  });

  it('re-trims only what is stale', async () => {
    const show = await makeShow();
    await detectAndApprove(show);
    const first = await app.trimmer.trimShow(show.id);
    assert.equal(first.trimmed, 3);

    // Nothing has changed, so nothing should be rewritten.
    const second = await app.trimmer.trimShow(show.id);
    assert.equal(second.trimmed, 0, 'an unchanged show was rewritten anyway');
    assert.equal(second.considered, 3);
  });
});

describe('when a trim cannot be done', () => {
  it('publishes the original rather than making the episode vanish', async () => {
    // An advert that survives explains itself the moment you hear it. An episode that
    // silently never appears does not.
    const show = await makeShow();
    await detectAndApprove(show);
    const [episode] = app.episodes.listByShow(show.id);
    app.episodes.setSystemFields(episode.id, { publish_hold: 'awaiting_review' });

    // The file the trimmer would read is gone from under it.
    await rm(join(showDir, episode.filename));
    const result = await app.trimmer.trimEpisode(app.episodes.get(episode.id));

    assert.equal(result.trimmed, false);
    const updated = app.episodes.get(episode.id);
    assert.equal(updated.trim_status, TRIM_STATUS.FAILED);
    assert.equal(updated.publish_hold, null, 'the episode was left unpublishable');
    assert.equal(updated.trimmed_filename, null, 'a failure left a copy behind');
  });

  it('says so where the owner will see it', async () => {
    const show = await makeShow();
    await detectAndApprove(show);
    const [episode] = app.episodes.listByShow(show.id);
    await rm(join(showDir, episode.filename));

    await app.trimmer.trimEpisode(app.episodes.get(episode.id));

    const reported = app.health.list().find((row) => row.key === `trim_${episode.id}`);
    assert.ok(reported, 'a failed trim was not reported anywhere');
    assert.match(reported.message, /could not remove/i);
    assert.match(reported.detail, /adverts included/i, 'the message does not say what was published');
  });

  it('refuses a cut list that would leave nothing, and does not write an empty file', async () => {
    const show = await makeShow();
    const [episode] = app.episodes.listByShow(show.id);
    const frames = frameProfile(await readFile(join(showDir, episode.filename))).frameCount;
    app.adDetect.recordDiffSegments(episode, [{ start: 0, end: frames, startMs: 0, endMs: 110_000 }], {
      timing: null,
    });
    for (const found of app.adDetect.listSegments(show.id)) {
      app.adDetect.decide(found.id, SEGMENT_STATUS.APPROVED);
    }

    const result = await app.trimmer.trimEpisode(app.episodes.get(episode.id));

    assert.equal(result.trimmed, false);
    assert.equal(result.reason, 'nothing_left');
    await assert.rejects(() => readdir(join(app.config.trimmedDir, show.id)));
  });

  it('leaves no staging file behind when the write fails', async () => {
    // Orphaned working files on a NAS are a real support burden, and this one would be
    // a whole episode's worth of bytes in a directory nothing else ever looks at.
    const show = await makeShow();
    await detectAndApprove(show);
    const [episode] = app.episodes.listByShow(show.id);
    // A directory sitting exactly where the trimmed file has to go, so the write
    // succeeds and the rename onto it fails — the case that strands staging.
    await mkdir(join(app.config.trimmedDir, show.id, `${episode.id}.mp3`), { recursive: true });

    const result = await app.trimmer.trimEpisode(episode);

    assert.equal(result.trimmed, false);
    assert.equal(result.reason, 'unwritable');
    const left = await readdir(join(app.config.trimmedDir, show.id));
    assert.deepEqual(left, [`${episode.id}.mp3`], `staging was left behind: ${left.join(', ')}`);
  });
});

describe('a format whose frames SelfPod cannot rejoin', () => {
  it('is left alone rather than guessed at', async () => {
    const show = await makeShow();
    const [episode] = app.episodes.listByShow(show.id);
    app.db.prepare('UPDATE episodes SET filename = ? WHERE id = ?').run('talk.m4a', episode.id);

    const result = await app.trimmer.trimEpisode(app.episodes.get(episode.id));

    assert.equal(result.trimmed, false);
    assert.equal(result.reason, 'unsupported_format');
  });
});
