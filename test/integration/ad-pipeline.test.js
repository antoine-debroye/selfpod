import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { PUBLISH_HOLDS, SEGMENT_STATUS } from '../../src/constants.js';
import { frameProfile } from '../../src/lib/mp3-frames.js';
import { createTestServer } from '../helpers/http.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';

const framesFor = (seconds) => Math.round((seconds * 1000) / FRAME_MS);

let server;
let showDir;

beforeEach(async () => {
  server = await createTestServer();
  showDir = await server.makeShowFolder('tape-club');
});

afterEach(async () => {
  await server.cleanup();
});

/** Programme, a 40s sponsor read every episode carries, more programme. */
function episodeBytes(n) {
  return stitch(
    segment(100_000 + n * 50_000, framesFor(45)),
    segment(2_000, framesFor(40)),
    segment(600_000 + n * 50_000, framesFor(45)),
  );
}

async function addEpisode(n) {
  await writeFile(join(showDir, `episode-${n}.mp3`), episodeBytes(n));
  await server.scanner.scanAllNow('manual');
}

async function makeShow({ mode, count = 3, minEpisodes = 3 } = {}) {
  // The mode is set before any file arrives, which is the case that matters: an
  // episode must never be inserted publishable and held a moment later.
  await writeFile(join(showDir, '.keep'), '');
  await server.scanner.scanAllNow('manual');
  const created = server.shows.getBySlug('tape-club');
  server.db
    .prepare('UPDATE shows SET ad_trim_mode = ?, ad_auto_min_episodes = ? WHERE id = ?')
    .run(mode, minEpisodes, created.id);
  for (let n = 0; n < count; n += 1) await addEpisode(n);
  return server.shows.get(created.id);
}

const feedBody = async (show) =>
  (await server.app.inject({ method: 'GET', url: `/feeds/${show.slug}/${show.feed_token}.xml` })).body;

const holds = (show) =>
  server.episodes.listByShow(show.id).map((row) => row.publish_hold);

describe('an episode arriving in a show that trims adverts', () => {
  it('is held from the moment it is inserted, not a moment later', async () => {
    // The window this closes is between the scanner inserting the row and anything
    // else noticing. It is small enough that it would never be reproduced, and would
    // be reported as "sometimes an episode goes out with the ads still in".
    const show = await makeShow({ mode: 'review', count: 1 });

    assert.deepEqual(holds(show), [PUBLISH_HOLDS.AWAITING_CORPUS]);
    assert.equal((await feedBody(show)).includes('<item>'), false, 'it was published anyway');
  });

  it('is published straight away when the show is not using the feature', async () => {
    const show = await makeShow({ mode: 'off', count: 1 });

    assert.deepEqual(holds(show), [null]);
    assert.ok((await feedBody(show)).includes('<item>'));
  });
});

describe('review mode, end to end', () => {
  it('waits for you, then publishes the cut you approved', async () => {
    const show = await makeShow({ mode: 'review', count: 3 });

    await server.adPipeline.processShow(show.id);

    // Detection has run and found the sponsor read, but nothing is decided, so nothing
    // is published. This is the point of the mode.
    assert.deepEqual(holds(show), Array(3).fill(PUBLISH_HOLDS.AWAITING_REVIEW));
    const found = server.adDetect.listSegments(show.id);
    assert.ok(found.length > 0, 'nothing was found to review');
    assert.ok(
      found.every((row) => row.status === SEGMENT_STATUS.CANDIDATE),
      'review mode decided something on its own',
    );
    assert.equal((await feedBody(show)).includes('<item>'), false);

    for (const row of found) server.adDetect.decide(row.id, SEGMENT_STATUS.APPROVED);
    await server.adPipeline.processShow(show.id);

    assert.deepEqual(holds(show), [null, null, null]);
    const body = await feedBody(show);
    assert.equal(body.match(/<item>/g).length, 3);

    // And what came out is genuinely shorter than what went in.
    for (const episode of server.episodes.listByShow(show.id)) {
      assert.ok(
        episode.trimmed_duration_seconds < episode.duration_seconds,
        `${episode.filename} was published at its original length`,
      );
    }
  });

  it('publishes an episode it found nothing to ask about', async () => {
    // Otherwise turning the feature on would silently stop a show that has no
    // repeated audio in it at all.
    const show = await makeShow({ mode: 'review', count: 0 });
    for (let n = 0; n < 3; n += 1) {
      await writeFile(
        join(showDir, `unique-${n}.mp3`),
        stitch(segment(100_000 + n * 400_000, framesFor(90))),
      );
    }
    await server.scanner.scanAllNow('manual');

    await server.adPipeline.processShow(show.id);

    assert.deepEqual(holds(show), [null, null, null]);
    assert.equal((await feedBody(show)).match(/<item>/g).length, 3);
  });
});

describe('auto mode, end to end', () => {
  it('cuts and publishes without being asked', async () => {
    const show = await makeShow({ mode: 'auto', count: 3 });

    await server.adPipeline.processShow(show.id);

    assert.deepEqual(holds(show), [null, null, null], 'automatic mode was waiting for someone');
    const episodes = server.episodes.listByShow(show.id);
    for (const episode of episodes) {
      assert.ok(episode.trimmed_filename, `${episode.filename} was published untrimmed`);
    }

    // The 40s sponsor read went; the 90s of programme stayed.
    const first = episodes[0];
    const body = await feedBody(show);
    assert.ok(body.includes(`?v=${first.trimmed_etag}`));
    assert.ok(
      Math.abs(first.trimmed_duration_seconds - 90) <= 2,
      `expected about 90s of programme, published ${first.trimmed_duration_seconds}s`,
    );
  });

  it('holds the first episodes rather than publishing them and re-cutting', async () => {
    // Publishing episode one and swapping its audio on episode three is the case the
    // whole hold exists for: apps that already downloaded it keep the adverts.
    const show = await makeShow({ mode: 'auto', count: 2, minEpisodes: 3 });

    await server.adPipeline.processShow(show.id);

    assert.deepEqual(holds(show), Array(2).fill(PUBLISH_HOLDS.AWAITING_CORPUS));
    assert.equal((await feedBody(show)).includes('<item>'), false);

    await addEpisode(2);
    await server.adPipeline.processShow(show.id);

    assert.deepEqual(holds(show), [null, null, null], 'the corpus arrived and nothing was released');
  });
});

describe('while the work is still running', () => {
  it('never publishes a show it has not asked about yet', async () => {
    // Between fingerprinting and detection there are no segments, so every episode
    // looks like it has nothing outstanding. Settling the holds on that reading would
    // release the entire show, untrimmed, for as long as detection takes — the exact
    // thing the hold is for. "Nothing to decide" is not "not yet asked".
    const show = await makeShow({ mode: 'review', count: 3 });
    let midRun = null;
    const detect = server.adDetect.detectForShow.bind(server.adDetect);
    server.adDetect.detectForShow = async (id) => {
      midRun = await feedBody(show);
      return detect(id);
    };

    await server.adPipeline.processShow(show.id);

    assert.ok(midRun !== null, 'detection never ran, so this proved nothing');
    assert.equal(midRun.includes('<item>'), false, 'the show was published mid-run');
  });

  it('never publishes an episode with an undecided segment still in it', async () => {
    // The hazard, stated exactly: while the trimmer works through a show, a listener's
    // app is polling. If an episode is released the moment its own audio is cut, it
    // goes out while other segments that belong in it are still undecided — and once
    // the app has downloaded it, the hold has bought nothing at all.
    const show = await makeShow({ mode: 'review', count: 3 });
    await writeFile(
      join(showDir, 'extra.mp3'),
      stitch(
        segment(400_000, framesFor(30)),
        segment(2_000, framesFor(40)),   // the read every episode shares
        segment(500_000, framesFor(30)),
        segment(9_000, framesFor(35)),   // a second one, in this episode and one other
      ),
    );
    await writeFile(
      join(showDir, 'extra-2.mp3'),
      stitch(segment(410_000, framesFor(30)), segment(9_000, framesFor(35)), segment(510_000, framesFor(30))),
    );
    await server.scanner.scanAllNow('manual');
    await server.adPipeline.processShow(show.id);

    // Approve only the segment every episode shares; the other stays undecided.
    const shared = server.adDetect
      .listSegments(show.id)
      .find((row) => row.episode_count >= 4);
    assert.ok(shared, 'the fixture did not produce a segment shared by every episode');
    server.adDetect.decide(shared.id, SEGMENT_STATUS.APPROVED);

    // A listener polling throughout the run, as an app on a schedule would be.
    const seen = [];
    const trimEpisode = server.trimmer.trimEpisode.bind(server.trimmer);
    server.trimmer.trimEpisode = async (episode) => {
      seen.push((await feedBody(show)).match(/<item>/g)?.length ?? 0);
      return trimEpisode(episode);
    };

    await server.adPipeline.processShow(show.id);

    assert.ok(seen.length >= 2, 'the run did not trim enough episodes to prove anything');
    const undecided = server.adDetect.listSegments(show.id).filter((row) => row.status === 'candidate');
    assert.ok(undecided.length > 0, 'the fixture left nothing undecided');
    assert.deepEqual(
      [...new Set(seen)],
      [0],
      `an episode was published mid-run with an undecided segment still in it: ${seen.join(', ')}`,
    );
  });

  it('publishes an episode that needs nothing without waiting for the ones that do', async () => {
    // On a long backfill the cutting queue can be minutes deep. An episode with
    // nothing to remove should not sit behind it.
    const show = await makeShow({ mode: 'auto', count: 3 });
    await writeFile(join(showDir, 'one-off.mp3'), stitch(segment(999_000, framesFor(90))));
    await server.scanner.scanAllNow('manual');

    let midRun = null;
    const trimShow = server.trimmer.trimShow.bind(server.trimmer);
    server.trimmer.trimShow = async (id, options) => {
      midRun = server.episodes.listByShow(show.id).map((row) => [row.filename, row.publish_hold]);
      return trimShow(id, options);
    };

    await server.adPipeline.processShow(show.id);

    assert.ok(midRun !== null, 'trimming never ran, so this proved nothing');
    const oneOff = midRun.find(([name]) => name === 'one-off.mp3');
    assert.deepEqual(oneOff, ['one-off.mp3', null], 'an episode with nothing to cut was made to wait');
    assert.ok(
      midRun.filter(([name]) => name !== 'one-off.mp3').every(([, hold]) => hold !== null),
      'the episodes that do need cutting were released before their cut existed',
    );
  });
});

describe('a show SelfPod cannot read', () => {
  it('publishes it rather than waiting for something that cannot happen', async () => {
    // Turning the feature on for a show of .m4a files must not empty its feed. Only
    // MP3 frames can be walked and rejoined today, so no number of further episodes
    // would ever let SelfPod compare them — and "waiting for more episodes" would not
    // merely be unhelpful, it would be false.
    const show = await makeShow({ mode: 'review', count: 0 });
    // Distinct files, because SelfPod identifies an episode by its content: three
    // byte-identical copies are one episode, and the test would prove nothing.
    const { readFile, writeFile: write } = await import('node:fs/promises');
    const { FIXTURE_DIR } = await import('../helpers/harness.js');
    const base = await readFile(join(FIXTURE_DIR, 'sample.m4a'));
    for (let n = 0; n < 3; n += 1) {
      await write(join(showDir, `talk-${n}.m4a`), Buffer.concat([base, Buffer.alloc(64 + n, n + 1)]));
    }
    await server.scanner.scanAllNow('manual');

    await server.adPipeline.processShow(show.id);

    assert.deepEqual(holds(show), [null, null, null], 'a show it cannot read was held for ever');
    assert.equal((await feedBody(show)).match(/<item>/g).length, 3);
  });

  it('says so, rather than doing nothing quietly', async () => {
    // The owner has switched on a feature that is doing nothing. Nothing else on the
    // page would tell them, and silence here is how "I turned on advert removal and no
    // adverts were removed" becomes unanswerable.
    const show = await makeShow({ mode: 'review', count: 0 });
    const { copyFile } = await import('node:fs/promises');
    const { FIXTURE_DIR } = await import('../helpers/harness.js');
    await copyFile(join(FIXTURE_DIR, 'sample.m4a'), join(showDir, 'talk.m4a'));
    await server.scanner.scanAllNow('manual');

    await server.adPipeline.processShow(show.id);

    const said = server.health.list().find((row) => row.key === `ad_trim_unsupported_${show.id}`);
    assert.ok(said, 'a show it cannot read was passed over in silence');
    assert.match(said.detail, /MP3/);
    // Informational, not a fault: nothing is broken, it simply does not apply.
    assert.equal(said.level, 'info');
  });
});

describe('turning the feature off', () => {
  it('lets the held episodes out rather than stranding them', async () => {
    // A feed that stopped because a setting changed, and says nothing about it, is
    // exactly the failure this codebase exists against.
    const show = await makeShow({ mode: 'review', count: 3 });
    await server.adPipeline.processShow(show.id);
    assert.equal((await feedBody(show)).includes('<item>'), false);

    server.db.prepare("UPDATE shows SET ad_trim_mode = 'off' WHERE id = ?").run(show.id);
    await server.adPipeline.processShow(show.id);

    assert.deepEqual(holds(show), [null, null, null]);
    assert.equal((await feedBody(show)).match(/<item>/g).length, 3);
  });
});

describe('running it more than once', () => {
  it('changes nothing the second time', async () => {
    const show = await makeShow({ mode: 'auto', count: 3 });
    await server.adPipeline.processShow(show.id);
    const before = server.episodes.listByShow(show.id).map((row) => ({
      etag: row.trimmed_etag,
      name: row.trimmed_filename,
      updated: row.updated_at,
    }));

    const again = await server.adPipeline.processShow(show.id);

    assert.equal(again.trimmed.trimmed, 0, 'audio was rewritten for no reason');
    assert.deepEqual(
      server.episodes.listByShow(show.id).map((row) => ({
        etag: row.trimmed_etag,
        name: row.trimmed_filename,
        updated: row.updated_at,
      })),
      before,
      'a second run moved something, so every scheduler tick would too',
    );
  });

  it('does not run two shows over the disk at the same time', async () => {
    // One chain for the whole application. The hardware is a two-core NAS that is also
    // serving the audio, and the failure is not slowness — it is a scan, a download and
    // three shows' fingerprinting all deciding at once that they may use the disk.
    const a = await makeShow({ mode: 'auto', count: 3 });

    const seen = [];
    const original = server.adDetect.fingerprintShow.bind(server.adDetect);
    server.adDetect.fingerprintShow = async (showId) => {
      seen.push(`start:${showId}`);
      const result = await original(showId);
      seen.push(`end:${showId}`);
      return result;
    };

    await Promise.all([server.adPipeline.processShow(a.id), server.adPipeline.processShow(a.id)]);

    // The positive control first: an empty list would satisfy the loop below without
    // either run having happened at all.
    assert.equal(seen.length, 4, `both runs should have done the work: ${seen.join(' ')}`);
    // Then: never two starts in a row, so the second waited for the first to finish.
    for (let i = 1; i < seen.length; i += 2) {
      assert.ok(seen[i].startsWith('end:'), `overlapping work: ${seen.join(' ')}`);
    }
  });
});

describe('when an approved segment moves', () => {
  it('re-cuts the episodes whose cut list changed, and only those', async () => {
    // The trimmer skips what it has already done, so an episode that gains an
    // occurrence of an already-approved segment would keep its old cut for good — one
    // episode in a library still carrying an advert, which is close to unfindable. The
    // opposite mistake is re-cutting everything on every tick, which on a NAS means the
    // disk never goes idle. Both directions are exercised here.
    const show = await makeShow({ mode: 'auto', count: 3 });
    await server.adPipeline.processShow(show.id);
    const before = server.episodes.listByShow(show.id);
    assert.ok(before.every((row) => row.trim_status === 'trimmed'), 'the first pass did not settle');

    const [segment] = server.adDetect.listSegments(show.id);
    const [gains, loses, untouched] = before;

    // `gains` is missing an occurrence detection will find again.
    server.db
      .prepare('DELETE FROM ad_segment_occurrences WHERE segment_id = ? AND episode_id = ?')
      .run(segment.id, gains.id);
    // `loses` carries one detection will not.
    server.db
      .prepare(
        `INSERT INTO ad_segment_occurrences
           (segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(segment.id, loses.id, 2000, 2400, 52_000, 62_000);

    const again = await server.adPipeline.processShow(show.id);

    assert.equal(again.trimmed.trimmed, 2, 'the wrong number of episodes were re-cut');
    const after = server.episodes.listByShow(show.id);
    const at = (id) => after.find((row) => row.id === id);
    assert.equal(at(untouched.id).updated_at, untouched.updated_at, 'an unchanged episode was touched');
    for (const row of [gains, loses]) {
      assert.notEqual(at(row.id).updated_at, row.updated_at, `${row.filename} was left behind`);
    }
  });
});

describe('what the activity log says about it', () => {
  it('records a check that actually did something, in episodes not files', async () => {
    const show = await makeShow({ mode: 'auto', count: 3 });

    await server.adPipeline.processShow(show.id);

    const [entry] = server.activity.list({ showId: show.id }).filter((row) => row.trigger === 'adverts');
    assert.ok(entry, 'an advert check that trimmed three episodes was not recorded');
    assert.equal(entry.updated, 3, 'the episodes whose audio changed');
    assert.equal(entry.added, 0, 'nothing was added');
    // `removed` renders as "dropped", a word this app already uses for an episode
    // leaving a feed. A healthy advert check must never produce that sentence.
    assert.equal(entry.removed, 0);
    assert.match(entry.note, /trimmed/);
    assert.deepEqual(entry.warnings, [], 'a healthy check was filed under Problems');
  });

  it('says nothing at all when there was nothing to say', async () => {
    // This runs on every scheduled tick for every show that has the feature on, and
    // nearly every run finds what it found last time. Recording those would put
    // hundreds of rows a day into the log people open when something is wrong.
    const show = await makeShow({ mode: 'auto', count: 3 });
    await server.adPipeline.processShow(show.id);
    const before = server.activity.list({ showId: show.id }).length;

    await server.adPipeline.processShow(show.id);
    await server.adPipeline.processShow(show.id);

    assert.equal(server.activity.list({ showId: show.id }).length, before, 'two idle runs filled the log');
  });

  it('reads as an advert check rather than a scan', async () => {
    // Sharing the scan row's wording would render "adverts scan — 3 files found,
    // 3 added": three wrong words in one line.
    const show = await makeShow({ mode: 'auto', count: 3 });
    await server.adPipeline.processShow(show.id);
    await server.login();

    const response = await server.get('/activity');
    assert.equal(response.statusCode, 200, 'the activity page did not render');
    const body = response.body;

    assert.match(body, /advert check — 3 episodes examined, 3 trimmed/);
    assert.ok(!/adverts scan/.test(body), 'it called itself a scan');
  });
});

describe('what the trimmed audio actually is', () => {
  it('is the programme, with the sponsor read gone from the middle', async () => {
    const show = await makeShow({ mode: 'auto', count: 3 });
    await server.adPipeline.processShow(show.id);
    const episode = server.episodes.listByShow(show.id).at(-1);

    // At the URL the feed is advertising, version and all — the media route refuses a
    // version that is not the one being published.
    const response = await server.app.inject({
      method: 'GET',
      url: `/media/${show.slug}/${show.feed_token}/${episode.id}/${encodeURIComponent(episode.filename)}?v=${episode.trimmed_etag}`,
    });
    const served = response.rawPayload;
    const original = episodeBytes(0);

    assert.equal(response.statusCode, 200);
    assert.equal(
      frameProfile(served).frameCount,
      frameProfile(original).frameCount - framesFor(40),
      'the wrong amount of audio came out',
    );
    // The programme before the advert is untouched, byte for byte.
    assert.equal(
      Buffer.compare(served.subarray(0, 30_000), original.subarray(0, 30_000)),
      0,
      'the programme was altered',
    );
  });
});
