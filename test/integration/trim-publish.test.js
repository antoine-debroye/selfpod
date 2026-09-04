import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SEGMENT_STATUS, TRIM_STATUS } from '../../src/constants.js';
import { formatDurationFeed } from '../../src/lib/dates.js';
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

/** Three episodes sharing a sponsor read and an outro, scanned in, in review mode. */
async function makeShow() {
  for (let n = 0; n < 3; n += 1) {
    await writeFile(
      join(showDir, `episode-${n}.mp3`),
      stitch(
        segment(100_000 + n * 50_000, framesFor(40)),
        segment(2_000, framesFor(30)),
        segment(600_000 + n * 50_000, framesFor(40)),
        segment(3_000, framesFor(25)),
      ),
    );
  }
  await server.scanner.scanAllNow('manual');
  const show = server.shows.getBySlug('tape-club');
  server.db.prepare("UPDATE shows SET ad_trim_mode = 'review' WHERE id = ?").run(show.id);
  return server.shows.get(show.id);
}

async function approveEverything(show) {
  await server.adDetect.fingerprintShow(show.id);
  await server.adDetect.detectForShow(show.id);
  for (const found of server.adDetect.listSegments(show.id)) {
    server.adDetect.decide(found.id, SEGMENT_STATUS.APPROVED);
  }
}

const feed = (show) =>
  server.app.inject({ method: 'GET', url: `/feeds/${show.slug}/${show.feed_token}.xml` });

/**
 * Fetches an episode the way a podcast app would: at the URL the feed is currently
 * advertising, version and all. Pass `query` to ask for something else on purpose.
 */
const media = (show, episode, { query = null, range } = {}) => {
  const version = server.episodes.get(episode.id)?.trimmed_etag;
  const search = query ?? (version ? `?v=${version}` : '');
  return server.app.inject({
    method: 'GET',
    url: `/media/${show.slug}/${show.feed_token}/${episode.id}/${encodeURIComponent(episode.filename)}${search}`,
    headers: range ? { range } : {},
  });
};

describe('holding an episode back until its trim is decided', () => {
  it('keeps a held episode out of the feed entirely', async () => {
    const show = await makeShow();
    const [episode] = server.episodes.listByShow(show.id);
    server.episodes.setSystemFields(episode.id, { publish_hold: 'awaiting_review' });

    const body = (await feed(show)).body;

    assert.ok(!body.includes(episode.id), 'a held episode was published anyway');
    // The positive control: the other two are there, so this is a gate and not a
    // feed that failed to build.
    for (const other of server.episodes.listByShow(show.id).filter((row) => row.id !== episode.id)) {
      assert.ok(body.includes(other.id), `${other.filename} went missing too`);
    }
  });

  it('counts it as held rather than quietly losing it', async () => {
    // An episode that is on disk, not in the feed, and not in any count is the kind
    // of disappearance nobody can debug.
    const show = await makeShow();
    const [episode] = server.episodes.listByShow(show.id);
    server.episodes.setSystemFields(episode.id, { publish_hold: 'awaiting_review' });

    const counts = server.episodes.counts(show.id);

    assert.equal(counts.held, 1);
    assert.equal(counts.active, 3, 'the file is still there and still active');
    assert.equal(counts.inFeed, 2);
    assert.equal(
      counts.inFeed,
      server.episodes.listForFeed(show.id).length,
      'inFeed and listForFeed disagree, so one of them is lying',
    );
  });

  it('publishes it the moment the trim lands', async () => {
    const show = await makeShow();
    await approveEverything(show);
    const [episode] = server.episodes.listByShow(show.id);
    server.episodes.setSystemFields(episode.id, { publish_hold: 'awaiting_review' });
    assert.ok(!(await feed(show)).body.includes(episode.id));

    // Through the pipeline, because settling the holds is its job and not the
    // trimmer's — cutting one episode does not mean the show is decided.
    await server.adPipeline.processShow(show.id);

    assert.ok((await feed(show)).body.includes(episode.id), 'the trim did not release the episode');
  });
});

describe('what the feed says about a trimmed episode', () => {
  it('states the trimmed length and duration, not the original', async () => {
    // A feed advertising the untrimmed length shows every listener a progress bar
    // that ends before the episode does.
    const show = await makeShow();
    await approveEverything(show);
    const [episode] = server.episodes.listByShow(show.id);
    await server.trimmer.trimEpisode(episode);
    const trimmed = server.episodes.get(episode.id);

    const body = (await feed(show)).body;
    const mine = itemFor(body, episode.id);

    assert.ok(trimmed.trimmed_bytes < episode.file_size_bytes, 'nothing was actually cut');
    assert.ok(mine.includes(`length="${trimmed.trimmed_bytes}"`), 'the original length was published');
    assert.ok(
      mine.includes(`<itunes:duration>${formatDurationFeed(trimmed.trimmed_duration_seconds)}</itunes:duration>`),
      `the duration published was not the trimmed one (${trimmed.trimmed_duration_seconds}s)`,
    );

    // The untrimmed siblings still advertise their own, larger, original — so this is
    // a per-episode substitution and not a feed that lost track of every length.
    for (const other of server.episodes.listByShow(show.id).filter((row) => row.id !== episode.id)) {
      assert.ok(
        itemFor(body, other.id).includes(`length="${other.file_size_bytes}"`),
        `${other.filename} was published with the wrong length`,
      );
    }
  });

  it('puts the content version in the enclosure URL', async () => {
    const show = await makeShow();
    await approveEverything(show);
    const [episode] = server.episodes.listByShow(show.id);
    await server.trimmer.trimEpisode(episode);
    const trimmed = server.episodes.get(episode.id);

    const body = (await feed(show)).body;

    assert.ok(
      body.includes(`${encodeURIComponent(episode.filename)}?v=${trimmed.trimmed_etag}`),
      'the enclosure URL carries no version, so replacing the bytes would corrupt a resumed download',
    );
  });

  it("leaves an untrimmed episode URL exactly as it was", async () => {
    // Adding a version to audio that never changed would hand every existing
    // subscriber a "new" enclosure, and some apps re-download on that alone.
    const show = await makeShow();

    const body = (await feed(show)).body;

    assert.ok(!body.includes('?v='), 'a version appeared on an episode that was never trimmed');
  });
});

describe('serving the trimmed bytes', () => {
  it('sends the copy, not the original', async () => {
    const show = await makeShow();
    await approveEverything(show);
    const [episode] = server.episodes.listByShow(show.id);
    await server.trimmer.trimEpisode(episode);
    const trimmed = server.episodes.get(episode.id);

    const response = await media(show, episode, { query: `?v=${trimmed.trimmed_etag}` });

    assert.equal(response.statusCode, 200);
    const served = response.rawPayload;
    assert.equal(Number(response.headers['content-length']), trimmed.trimmed_bytes);
    assert.ok(
      frameProfile(served).frameCount < frameProfile(await originalBytes(episode)).frameCount,
      'the untrimmed file was served',
    );
    // Content type and download name still come from the episode, not from SelfPod's
    // internal name for the copy.
    assert.equal(response.headers['content-type'], episode.mime_type);
    assert.ok(response.headers['content-disposition'].includes(episode.filename));
  });

  it('advertises a length the range requests actually agree with', async () => {
    // The failure this is here for: a client holding the first half of one file and
    // asking for the rest gets the second half of a different one, and stitches them
    // together without any error to notice.
    const show = await makeShow();
    await approveEverything(show);
    const [episode] = server.episodes.listByShow(show.id);
    await server.trimmer.trimEpisode(episode);
    const trimmed = server.episodes.get(episode.id);

    const whole = await media(show, episode);
    const tail = await media(show, episode, { range: `bytes=1000-` });

    assert.equal(tail.statusCode, 206);
    assert.equal(
      tail.headers['content-range'],
      `bytes 1000-${trimmed.trimmed_bytes - 1}/${trimmed.trimmed_bytes}`,
    );
    assert.equal(
      Buffer.compare(tail.rawPayload, whole.rawPayload.subarray(1000)),
      0,
      'a ranged read and a whole read returned different audio',
    );
  });

  it('keeps serving the cut it already made while a re-trim is outstanding', async () => {
    // Falling back to the original here would change the published audio twice for one
    // decision — back to the untrimmed file, then forward to the new cut — and the
    // first of those two changes hands every subscriber the adverts back.
    const show = await makeShow();
    await approveEverything(show);
    const [episode] = server.episodes.listByShow(show.id);
    await server.trimmer.trimEpisode(episode);
    const settled = server.episodes.get(episode.id);

    // A decision elsewhere in the show marks this episode's copy stale, but does not
    // make it wrong: it is still a real cut of this episode.
    server.episodes.setSystemFields(episode.id, { trim_status: TRIM_STATUS.PENDING });

    const body = (await feed(show)).body;
    assert.ok(
      itemFor(body, episode.id).includes(`length="${settled.trimmed_bytes}"`),
      'the feed reverted to the untrimmed length',
    );
    assert.ok(body.includes(`?v=${settled.trimmed_etag}`), 'the enclosure URL moved');
    assert.equal(
      Number((await media(show, episode)).headers['content-length']),
      settled.trimmed_bytes,
    );
  });

  it('never advertises a length it does not serve', async () => {
    // The invariant the whole design rests on. It holds across a re-cut because the
    // file is named after its own content: the previous cut stays readable at its own
    // name until the row has moved to the new one.
    const show = await makeShow();
    await server.adDetect.fingerprintShow(show.id);
    await server.adDetect.detectForShow(show.id);
    const [first, second] = server.adDetect.listSegments(show.id);
    const [episode] = server.episodes.listByShow(show.id);

    for (const decision of [first, second].filter(Boolean)) {
      server.adDetect.decide(decision.id, SEGMENT_STATUS.APPROVED);
      await server.trimmer.trimEpisode(server.episodes.get(episode.id));

      const body = (await feed(show)).body;
      const advertised = Number(itemFor(body, episode.id).match(/length="(\d+)"/)[1]);
      const response = await media(show, episode);

      assert.equal(response.statusCode, 200);
      assert.equal(Number(response.headers['content-length']), advertised);
      assert.equal(response.rawPayload.length, advertised);
    }
  });

  it('does not lose the copy it already had when a re-cut fails', async () => {
    // The previous cut has to outlive the attempt to replace it. Clearing it first and
    // then failing would leave the row naming a file that is not there, so every
    // subscriber gets a 404 for an episode that was working a moment ago.
    const show = await makeShow();
    await server.adDetect.fingerprintShow(show.id);
    await server.adDetect.detectForShow(show.id);
    const [first, second] = server.adDetect.listSegments(show.id);
    const [episode] = server.episodes.listByShow(show.id);
    server.adDetect.decide(first.id, SEGMENT_STATUS.APPROVED);
    await server.trimmer.trimEpisode(server.episodes.get(episode.id));
    const settled = server.episodes.get(episode.id);

    // The next cut cannot be written: a directory is sitting where its file must go.
    server.adDetect.decide(second.id, SEGMENT_STATUS.APPROVED);
    const next = server.trimmer;
    const { mkdir } = await import('node:fs/promises');
    const nextName = await nameOfNextCut(show, episode);
    await mkdir(join(server.config.trimmedDir, show.id, nextName), { recursive: true });

    const outcome = await next.trimEpisode(server.episodes.get(episode.id));
    assert.equal(outcome.trimmed, false, 'the write was supposed to fail');

    const response = await media(show, episode);
    assert.equal(response.statusCode, 200, 'a failed re-cut took the working copy with it');
    assert.equal(Number(response.headers['content-length']), settled.trimmed_bytes);
  });

  it('keeps one cut per episode on disk, not one per decision', async () => {
    const show = await makeShow();
    await server.adDetect.fingerprintShow(show.id);
    await server.adDetect.detectForShow(show.id);
    const [first, second] = server.adDetect.listSegments(show.id);
    const [episode] = server.episodes.listByShow(show.id);

    for (const decision of [first, second].filter(Boolean)) {
      server.adDetect.decide(decision.id, SEGMENT_STATUS.APPROVED);
      await server.trimmer.trimEpisode(server.episodes.get(episode.id));
    }

    const { readdir } = await import('node:fs/promises');
    const onDisk = await readdir(join(server.config.trimmedDir, show.id));
    assert.deepEqual(
      onDisk,
      [server.episodes.get(episode.id).trimmed_filename],
      'superseded cuts are piling up on the share',
    );
  });

  it('never hands a fragment of new audio to a client resuming an old cut', async () => {
    /*
     * The failure this exists for: a client holding the first half of one cut asks for
     * the rest after the audio has been replaced, and joins the second half of a
     * different file onto it — right total length, no error, nothing to notice.
     *
     * Until 1.8.6 the answer was to refuse, and the refusal turned out to have its own
     * silent failure: an app whose download failed holds a hundred-odd bytes of the
     * refusal itself, believes it has part of the episode, and resumes from there — so
     * it was refused again, for ever, with no request it could make that would work.
     * The answer now is the whole current file with a 200, which is what HTTP does for
     * a validator that no longer matches. What must never happen is unchanged, and is
     * what this asserts: no *fragment* of the new audio, ever.
    const show = await makeShow();
    await server.adDetect.fingerprintShow(show.id);
    await server.adDetect.detectForShow(show.id);
    const [one, two] = server.adDetect.listSegments(show.id);
    assert.ok(two, 'the fixture should offer two segments');
    server.adDetect.decide(one.id, SEGMENT_STATUS.APPROVED);

    const [episode] = server.episodes.listByShow(show.id);
    await server.trimmer.trimEpisode(episode);
    const first = server.episodes.get(episode.id).trimmed_etag;

    // The version is real while it is current.
    assert.equal((await media(show, episode, { query: `?v=${first}` })).statusCode, 200);

    // Re-cut: same URL path, different audio, different version.
    server.adDetect.decide(two.id, SEGMENT_STATUS.APPROVED);
    await server.trimmer.trimEpisode(server.episodes.get(episode.id));
    const second = server.episodes.get(episode.id).trimmed_etag;
    assert.notEqual(second, first, 'the fixture did not actually re-cut');

    const current = await media(show, episode, { query: `?v=${second}` });
    assert.equal(current.statusCode, 200);

    const stale = await media(show, episode, { query: `?v=${first}`, range: 'bytes=1000-' });
    assert.notEqual(stale.statusCode, 206, 'a superseded version was served a fragment of the new audio');
    assert.equal(stale.statusCode, 200);
    assert.equal(stale.headers['content-range'], undefined, 'it was answered as a range');
    assert.equal(
      Buffer.compare(stale.rawPayload, current.rawPayload),
      0,
      'a resuming client got something other than the whole current episode',
    );
  });

  it('gives the whole cut to a client resuming an address from before it was cut', async () => {
    // The first trim is the case a version alone cannot describe: the URL a client
    // already has carries no version at all, because the episode had never been cut.
    // Resuming against it must not splice untrimmed bytes into trimmed ones — so it
    // gets the whole trimmed file and starts again.
    const show = await makeShow();
    const [episode] = server.episodes.listByShow(show.id);
    assert.equal((await media(show, episode, { query: '' })).statusCode, 200, 'untrimmed is fine');

    await approveEverything(show);
    await server.trimmer.trimEpisode(server.episodes.get(episode.id));

    const resumed = await media(show, episode, { query: '', range: 'bytes=1000-' });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.headers['content-range'], undefined, 'it was answered as a range');
    const current = await media(show, episode);
    assert.equal(Buffer.compare(resumed.rawPayload, current.rawPayload), 0);
  });

  it('stops telling clients to cache while a re-trim is outstanding', async () => {
    const show = await makeShow();
    await approveEverything(show);
    const [episode] = server.episodes.listByShow(show.id);
    await server.trimmer.trimEpisode(episode);
    assert.match((await media(show, episode)).headers['cache-control'], /max-age=86400/);

    server.episodes.setSystemFields(episode.id, { trim_status: TRIM_STATUS.PENDING });

    assert.match(
      (await media(show, episode)).headers['cache-control'],
      /no-cache/,
      'a day of caching for adverts the owner already asked to have removed',
    );
  });

  it('serves the original when the episode has no trimmed copy', async () => {
    const show = await makeShow();
    const [episode] = server.episodes.listByShow(show.id);

    const response = await media(show, episode);

    assert.equal(response.statusCode, 200);
    assert.equal(Buffer.compare(response.rawPayload, await originalBytes(episode)), 0);
  });

  it('still plays an enclosure address from an earlier cut, and still refuses a resume', async () => {
    /*
     * The failure this prevents, seen on a real instance: an enclosure URL lives in a
     * subscriber's app for as long as that app keeps the episode, and every re-cut —
     * a decision changed, an edge moved, two spellings of one read folded together —
     * minted a new address and killed every old one. The app showed "Download Failed"
     * over a hundred-byte error body and could never recover, because retrying fetched
     * the same dead address.
     *
     * Only a client assembling a file out of parts can join two different cuts
     * together. One starting at the beginning gets a whole, consistent episode
     * whichever cut it is, so for it an address that has moved on is merely old.
     */
    const show = await makeShow();
    await approveEverything(show);
    const [episode] = server.episodes.listByShow(show.id);
    await server.trimmer.trimEpisode(episode);
    const current = server.episodes.get(episode.id).trimmed_etag;
    assert.ok(current, 'nothing was cut to make an old address from');
    const old = { query: '?v=1a2b3c4d5e6f' };

    const fresh = await media(show, episode, old);
    assert.equal(fresh.statusCode, 200, 'an address from an earlier cut no longer plays');
    assert.equal(fresh.headers['content-type'], 'audio/mpeg');
    // It is the audio being published now, whole — not the cut the address named.
    const now = await media(show, episode);
    assert.equal(Buffer.compare(fresh.rawPayload, now.rawPayload), 0);

    // A range that starts at the beginning is the same client, asking for it in pieces.
    const start = await media(show, episode, { ...old, range: 'bytes=0-999' });
    assert.equal(start.statusCode, 206);

    /*
     * A client resuming against an old address is holding bytes of something else —
     * in the wild, bytes of the refusal it was sent last time. It gets the whole
     * current file with a 200, never a fragment to append, and never a refusal it
     * could only meet by asking again the same way.
     */
    for (const header of ['bytes=1000-', 'bytes=-500']) {
      const resumed = await media(show, episode, { ...old, range: header });
      assert.equal(resumed.statusCode, 200, `resuming with ${header} was refused`);
      assert.equal(Buffer.compare(resumed.rawPayload, now.rawPayload), 0, `${header} got a fragment`);
      assert.equal(resumed.headers['content-range'], undefined, `${header} was answered as a range`);
    }

    // And an address with no version at all, which is what an app that saw this
    // episode before it was ever cut still holds.
    assert.equal((await media(show, episode, { query: '' })).statusCode, 200);
  });

  it('serves the original, loudly and uncached, when the cut copy is missing', async () => {
    /*
     * This used to refuse, on the grounds that falling back publishes the adverts
     * under a URL whose version says they are gone, and that caches would keep that
     * answer. The first half is true and is the reason for the warning and the log
     * line; the second is answered by refusing to let anything store it.
     *
     * What decided it is that `/data/.trimmed` holds nothing that cannot be made
     * again — which is what makes it safe to clear, and made clearing it take the
     * whole feed down, every episode answering 404 until each had been cut afresh.
     * §19.5 already settles the same trade the same way for a trim that fails: an
     * advert that survives explains itself the moment it is heard, and an episode
     * that silently never appears does not.
     */
    const show = await makeShow();
    await approveEverything(show);
    const [episode] = server.episodes.listByShow(show.id);
    await server.trimmer.trimEpisode(episode);
    const { rm } = await import('node:fs/promises');
    await rm(server.trimmer.pathFor(server.episodes.get(episode.id)));

    const response = await media(show, episode);

    assert.equal(response.statusCode, 200);
    assert.equal(Buffer.compare(response.rawPayload, await originalBytes(episode)), 0);
    assert.match(response.headers['cache-control'], /no-store/, 'a fallback was left cacheable');
    const warning = server.health.list().find((issue) => issue.key.startsWith('trimmed_missing_'));
    assert.ok(warning, 'nothing told the owner their subscribers are getting the adverts back');
    assert.equal(warning.level, 'warn');
  });

  it('hands a resuming client the whole original when the cut copy is missing', async () => {
    // It holds bytes of the cut, which the original's would not join onto — so it is
    // given the whole file rather than a fragment, and starts again.
    const show = await makeShow();
    await approveEverything(show);
    const [episode] = server.episodes.listByShow(show.id);
    await server.trimmer.trimEpisode(episode);
    const { rm } = await import('node:fs/promises');
    await rm(server.trimmer.pathFor(server.episodes.get(episode.id)));

    const response = await media(show, episode, { range: 'bytes=5000-' });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-range'], undefined);
    assert.equal(Buffer.compare(response.rawPayload, await originalBytes(episode)), 0);
  });
});

/** One `<item>` out of the feed, so an assertion cannot pass on a neighbour's value. */
function itemFor(body, episodeId) {
  const at = body.indexOf(episodeId);
  assert.ok(at > 0, `${episodeId} is not in the feed at all`);
  return body.slice(body.lastIndexOf('<item>', at), body.indexOf('</item>', at));
}

/**
 * The name the next cut will land under, worked out by doing it and undoing it.
 *
 * Roundabout, but the alternative is for the test to reimplement the naming rule, and
 * a test that computes the answer the same way the code does agrees with it even when
 * both are wrong.
 */
async function nameOfNextCut(show, episode) {
  const { readFile, rm, writeFile: write } = await import('node:fs/promises');
  const before = server.episodes.get(episode.id);
  const previousPath = join(server.config.trimmedDir, show.id, before.trimmed_filename);
  // The probe is a real trim, so it supersedes and deletes the cut already there.
  // Putting it back is what makes this a probe rather than the thing being tested.
  const kept = await readFile(previousPath);

  const outcome = await server.trimmer.trimEpisode(before);
  assert.equal(outcome.trimmed, true, 'the probe cut failed');
  const name = server.episodes.get(episode.id).trimmed_filename;

  await rm(join(server.config.trimmedDir, show.id, name));
  await write(previousPath, kept);
  server.episodes.setSystemFields(episode.id, {
    trimmed_filename: before.trimmed_filename,
    trimmed_etag: before.trimmed_etag,
    trimmed_bytes: before.trimmed_bytes,
    trimmed_duration_seconds: before.trimmed_duration_seconds,
    trim_status: before.trim_status,
  });
  return name;
}

async function originalBytes(episode) {
  const { readFile } = await import('node:fs/promises');
  return readFile(join(showDir, episode.filename));
}
