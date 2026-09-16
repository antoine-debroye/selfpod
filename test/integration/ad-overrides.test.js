import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SEGMENT_STATUS } from '../../src/constants.js';
import { createTestInstance } from '../helpers/harness.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';

/**
 * "Restore here" (spec §19.8): one cut left in one episode, whatever rule makes it.
 *
 * The hazards are the catalogue's own churn. Occurrences are rewritten every pass, rows
 * are folded together, and edges move when a show is read again — a restore keyed on
 * any of those would quietly stop applying, and the advert the owner put back would
 * come back out on the next tick with nothing on the page to say why.
 */
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

async function makeShow(count = 3) {
  for (let n = 0; n < count; n += 1) {
    const file = stitch(
      segment(100_000 + n * 50_000, framesFor(40)),
      segment(2_000, framesFor(30)),
      segment(600_000 + n * 50_000, framesFor(40)),
    );
    await writeFile(join(showDir, `episode-${n}.mp3`), file);
  }
  await app.scanner.scanAllNow('manual');
  const show = app.shows.getBySlug('tape-club');
  app.db.prepare("UPDATE shows SET ad_trim_mode = 'review', ad_auto_min_episodes = 3 WHERE id = ?").run(show.id);
  return app.shows.get(show.id);
}

const byName = (showId) => Object.fromEntries(app.episodes.listByShow(showId).map((row) => [row.filename, row]));

async function approvedRead(show) {
  await app.adPipeline.processShow(show.id);
  const segments = app.adDetect.listSegments(show.id);
  assert.ok(segments.length >= 1, 'setup: the shared read was not found');
  const read = segments.find((row) => row.episode_count === 3) ?? segments[0];
  app.adDetect.decide(read.id, SEGMENT_STATUS.APPROVED);
  await app.adPipeline.processShow(show.id);
  return read;
}

describe('restoring a cut in one episode', () => {
  it('puts the audio back in that episode only, and the rule keeps cutting the others', async () => {
    const show = await makeShow();
    const read = await approvedRead(show);
    const before = byName(show.id);
    for (const episode of Object.values(before)) assert.ok(episode.trimmed_filename, 'setup: not every episode was cut');

    const target = before['episode-1.mp3'];
    app.adDetect.restoreHere({ segmentId: read.id, episodeId: target.id });
    assert.deepEqual(app.adDetect.cutListFor(target.id), [], 'the restored stretch is still in the cut list');
    await app.adPipeline.processShow(show.id);

    const after = byName(show.id);
    assert.equal(after['episode-1.mp3'].trimmed_filename, null, 'the restored episode is still served cut');
    assert.equal(after['episode-0.mp3'].trimmed_filename, before['episode-0.mp3'].trimmed_filename, 'another episode was re-cut');
    assert.equal(after['episode-2.mp3'].trimmed_filename, before['episode-2.mp3'].trimmed_filename, 'another episode was re-cut');
    assert.equal(app.adDetect.getSegment(read.id).status, SEGMENT_STATUS.APPROVED, 'restoring here changed the rule');
    assert.equal(after['episode-1.mp3'].publish_hold, null, 'the restored episode left the feed');
  });

  it('keeps applying through passes that rewrite the occurrences, and through the row going away', async () => {
    const show = await makeShow();
    const read = await approvedRead(show);
    const target = byName(show.id)['episode-2.mp3'];
    const restore = app.adDetect.restoreHere({ segmentId: read.id, episodeId: target.id });

    for (let pass = 0; pass < 2; pass += 1) await app.adPipeline.processShow(show.id);
    assert.deepEqual(app.adDetect.cutListFor(target.id), [], 'a later pass cut the restored stretch again');

    // The row is gone — folded away, or re-found under another signature — but the
    // restore was made against the episode and the time, and outlives it.
    app.db.prepare('UPDATE ad_segments SET signature = ? WHERE id = ?').run('replaced-signature', read.id);
    app.db.prepare('DELETE FROM ad_segments WHERE id = ?').run(read.id);
    const occurrence = { start_ms: restore.start_ms + 40, end_ms: restore.end_ms - 40 };
    assert.ok(app.adDetect.isRestored(target.id, occurrence), 'a stretch whose edges moved a little is no longer restored');
    assert.equal(app.adDetect.restoresIn(target.id)[0].segment_id, null);
  });

  it('can be taken back, and the episode is cut again', async () => {
    const show = await makeShow();
    const read = await approvedRead(show);
    const target = byName(show.id)['episode-0.mp3'];
    const restore = app.adDetect.restoreHere({ segmentId: read.id, episodeId: target.id });
    await app.adPipeline.processShow(show.id);
    assert.equal(byName(show.id)['episode-0.mp3'].trimmed_filename, null);

    app.adDetect.undoRestore(restore.id);
    await app.adPipeline.processShow(show.id);
    assert.ok(byName(show.id)['episode-0.mp3'].trimmed_filename, 'taking the restore back did not cut it again');
    assert.equal(app.adDetect.restoresIn(target.id).length, 0);
  });

  it('asking twice makes one restore, and a cut not in the episode is refused', async () => {
    const show = await makeShow();
    const read = await approvedRead(show);
    const target = byName(show.id)['episode-0.mp3'];
    const first = app.adDetect.restoreHere({ segmentId: read.id, episodeId: target.id });
    const second = app.adDetect.restoreHere({ segmentId: read.id, episodeId: target.id });
    assert.equal(first.id, second.id);
    assert.throws(() => app.adDetect.restoreHere({ segmentId: 'nope', episodeId: target.id }), /no longer exists/);
  });
});

describe('teaching a stretch by time', () => {
  it('cuts that episode only when there are no words to remember it by', async () => {
    const show = await makeShow();
    await app.adPipeline.processShow(show.id);
    const target = byName(show.id)['episode-0.mp3'];

    const taught = await app.adDetect.teachRange({ showId: show.id, episodeId: target.id, startMs: 5_000, endMs: 20_000 });
    assert.equal(taught.kind, 'taught_range');
    assert.equal(taught.status, SEGMENT_STATUS.APPROVED);
    const [cut] = app.adDetect.cutListFor(target.id);
    assert.ok(cut, 'the taught stretch is not in the cut list');
    assert.ok(cut.startMs <= 5_000 && cut.endMs >= 19_900, `the cut ${cut.startMs}–${cut.endMs} does not cover what was taught`);

    await app.adPipeline.processShow(show.id);
    await app.adPipeline.processShow(show.id);
    const after = byName(show.id);
    assert.ok(after['episode-0.mp3'].trimmed_filename, 'the taught stretch was not cut, or a later pass lost it');
    assert.equal(after['episode-1.mp3'].trimmed_filename, null, 'a range taught in one episode cut another');
  });

  it('refuses a range that is backwards, too short, or past the end', async () => {
    const show = await makeShow(1);
    await app.adPipeline.processShow(show.id);
    const target = byName(show.id)['episode-0.mp3'];
    const teach = (startMs, endMs) => app.adDetect.teachRange({ showId: show.id, episodeId: target.id, startMs, endMs });
    await assert.rejects(teach(20_000, 5_000), /in that order/);
    await assert.rejects(teach(5_000, 5_400), /less than a second/);
    await assert.rejects(teach(5_000, 10_000_000), /in that order/);
  });
});

describe('restoring everywhere and stopping', () => {
  it('keeps a found stretch as "not an advert", and forgets a range outright', async () => {
    const show = await makeShow();
    const read = await approvedRead(show);
    const stopped = app.adDetect.stopRule(read.id);
    assert.equal(stopped.removed, 'decision');
    assert.equal(app.adDetect.getSegment(read.id).status, SEGMENT_STATUS.REJECTED);
    await app.adPipeline.processShow(show.id);
    for (const episode of Object.values(byName(show.id))) {
      assert.equal(episode.trimmed_filename, null, `${episode.filename} is still cut after stopping`);
    }

    const target = byName(show.id)['episode-0.mp3'];
    const taught = await app.adDetect.teachRange({ showId: show.id, episodeId: target.id, startMs: 80_000, endMs: 95_000 });
    await app.adPipeline.processShow(show.id);
    assert.ok(byName(show.id)['episode-0.mp3'].trimmed_filename);
    assert.equal(app.adDetect.stopRule(taught.id).removed, 'range');
    assert.equal(app.adDetect.getSegment(taught.id), null, 'a range was kept as a decision that remembers nothing');
    await app.adPipeline.processShow(show.id);
    assert.equal(byName(show.id)['episode-0.mp3'].trimmed_filename, null);
  });

  it('removes a boundary rule rather than leaving it to cut again', async () => {
    const show = await makeShow(1);
    const marker = app.adDetect.addMarker({ showId: show.id, role: 'programme_starts', rawText: 'welcome to the show' });
    const now = '2026-09-16T00:00:00.000Z';
    const [episode] = app.episodes.listByShow(show.id);
    app.db.prepare(
      `INSERT INTO ad_segments (id, show_id, signature, source, kind, marker_id, status, auto_approved, duration_ms,
         episode_count, occurrence_count, first_seen_at, created_at, updated_at)
       VALUES ('b1', ?, ?, 'transcript', 'boundary_words', ?, 'approved', 0, 5000, 1, 1, ?, ?, ?)`,
    ).run(show.id, `marker:${marker.id}`, marker.id, now, now, now);
    app.db.prepare(
      `INSERT INTO ad_segment_occurrences (segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
       VALUES ('b1', ?, 0, 190, 0, 5000)`,
    ).run(episode.id);

    assert.equal(app.adDetect.stopRule('b1').removed, 'boundary');
    assert.equal(app.adDetect.listMarkers(show.id).length, 0, 'the boundary itself is still there');
    assert.equal(app.adDetect.getSegment('b1'), null);
  });
});
