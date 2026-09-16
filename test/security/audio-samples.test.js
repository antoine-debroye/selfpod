import assert from 'node:assert/strict';
import { copyFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';

/**
 * The two admin routes that read an episode straight off the show folder: the original
 * copy (`?copy=original`) and a stretch of it (`sample.mp3`).
 *
 * The show folder is normally a writable SMB share. Anyone who can write there can put
 * a symlink where an episode was, and both routes return what they open — the original
 * route byte for byte. They are behind the admin session, but a session is not a
 * licence to read the NAS: a planted link must not turn "can write to a share" into
 * "can read the host through the owner's browser".
 */
const framesFor = (seconds) => Math.round((seconds * 1000) / FRAME_MS);
const SECRET = 'TOP-SECRET-NAS-CONTENT';

describe('reading an episode off the share cannot be pointed outside it', () => {
  let server;
  let show;
  let episode;
  let segmentId;
  let outside;
  let dir;

  before(async () => {
    server = await createTestServer();
    await server.login();
    dir = await server.makeShowFolder('shared');
    await writeFile(join(dir, '.keep'), '');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('shared');
    server.db.prepare("UPDATE shows SET ad_trim_mode = 'review' WHERE id = ?").run(show.id);
    for (let n = 0; n < 3; n += 1) {
      await writeFile(
        join(dir, `episode-${n}.mp3`),
        stitch(segment(100_000 + n * 50_000, framesFor(20)), segment(2_000, framesFor(20)), segment(600_000 + n * 50_000, framesFor(20))),
      );
    }
    await server.scanner.scanAllNow('manual');
    await server.adPipeline.processShow(show.id);
    [{ id: segmentId }] = server.adDetect.listSegments(show.id);
    // The episode the sample route plays the stretch from, so both routes read the same file.
    const { episode_id: sampled } = server.db
      .prepare('SELECT episode_id FROM ad_segment_occurrences WHERE segment_id = ? ORDER BY start_frame LIMIT 1')
      .get(segmentId);
    episode = server.episodes.get(sampled);

    // Something elsewhere on the host that is shaped like an episode — so a route that
    // followed the link would happily play it — and carries a secret besides.
    outside = join(server.dataDir, 'not-an-episode.mp3');
    await writeFile(outside, Buffer.concat([stitch(segment(2_000, framesFor(60))), Buffer.from(SECRET)]));
  });

  after(async () => {
    await server.cleanup();
  });

  const original = () => server.get(`/api/episodes/${episode.id}/audio?copy=original`);
  const sample = () => server.get(`/api/ad-segments/${segmentId}/sample.mp3?context=3`);

  it('serves the real file while it is a real file', async () => {
    // The positive control: both routes do read this episode, so the refusals below
    // are about the link and not about a route that never worked.
    assert.equal((await original()).statusCode, 200);
    assert.equal((await sample()).statusCode, 200);
  });

  it('serves the file a real file would be, and nothing from outside, once it is a link out', async () => {
    // The same bytes copied into the folder are served: the refusal is about where the
    // link points, not about what the file contains.
    const path = join(dir, episode.filename);
    await rm(path);
    await copyFile(outside, path);
    const copied = await original();
    assert.equal(copied.statusCode, 200);
    assert.ok(copied.rawPayload.includes(Buffer.from(SECRET)), 'setup: the copy inside the folder was not served whole');

    await rm(path);
    await symlink(outside, path);

    const viaOriginal = await original();
    assert.equal(viaOriginal.statusCode, 404, 'the original route followed a link out of the show folder');
    assert.ok(!viaOriginal.rawPayload.includes(Buffer.from(SECRET)), 'the original route leaked the file outside the folder');

    const viaSample = await sample();
    assert.equal(viaSample.statusCode, 404, 'the sample route followed a link out of the show folder');
    assert.ok(!viaSample.rawPayload.includes(Buffer.from(SECRET)));

    const ranged = await server.request({ url: `/api/episodes/${episode.id}/audio?copy=original`, headers: { range: 'bytes=0-' } });
    assert.equal(ranged.statusCode, 404, 'a range request took a different path round the check');
  });

  it('will not serve a traversal filename written straight into the database', async () => {
    server.db.prepare('UPDATE episodes SET filename = ? WHERE id = ?').run('../../not-an-episode.mp3', episode.id);
    try {
      const response = await original();
      assert.equal(response.statusCode, 404);
      assert.ok(!response.rawPayload.includes(Buffer.from(SECRET)));
    } finally {
      server.db.prepare('UPDATE episodes SET filename = ? WHERE id = ?').run(episode.filename, episode.id);
    }
  });

  it('is not available without the admin session', async () => {
    const response = await server.request({ url: `/api/episodes/${episode.id}/audio?copy=original`, authed: false });
    assert.equal(response.statusCode, 401);
  });
});
