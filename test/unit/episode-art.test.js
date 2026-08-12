import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sharp from 'sharp';

import { SCAN_TRIGGER } from '../../src/constants.js';
import { createTestInstance, mp3WithEmbeddedArtwork } from '../helpers/harness.js';

let app;

beforeEach(async () => {
  app = await createTestInstance();
});

afterEach(async () => {
  await app.cleanup();
});

async function scanAll() {
  return app.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
}

function square(size, background) {
  return sharp({ create: { width: size, height: size, channels: 3, background } }).jpeg().toBuffer();
}

/** Writes raw bytes into a show folder as if the owner had dropped the file there. */
async function drop(slug, name, bytes) {
  const dir = await app.makeShowFolder(slug);
  await writeFile(join(dir, name), bytes);
  return join(dir, name);
}

function onlyEpisode(slug) {
  const show = app.shows.getBySlug(slug);
  const [episode] = app.episodes.listByShow(show.id);
  return { show, episode };
}

/** Every warning the sweep produced, flattened to strings for easy matching. */
function warningsFor(record, file) {
  return (record?.warnings ?? []).filter((warning) => warning.file === file).map((w) => w.message);
}

describe('per-episode artwork: sources', () => {
  it('extracts embedded artwork on first sight and never writes into the show folder', async () => {
    await drop('tape-club', 'ep-one.mp3', await mp3WithEmbeddedArtwork(await square(1500, '#204020')));
    await scanAll();

    const { show, episode } = onlyEpisode('tape-club');
    assert.equal(episode.art_source, 'embedded');
    assert.equal(episode.art_filename, `${episode.id}.jpg`);
    assert.equal(episode.art_width, 1500);
    assert.equal(episode.art_height, 1500);
    assert.match(episode.art_etag, /^[0-9a-f]{64}$/, 'a bare sha256 hex, ready to be an ETag and a ?v=');
    assert.equal(episode.art_sidecar_name, null);

    // The bytes live in the cache, keyed by show and episode.
    const cached = join(app.config.episodeArtDir, show.id, episode.art_filename);
    assert.equal((await stat(cached)).size > 0, true, 'the image should be under /data/.art');

    // And the user's folder holds exactly what the user put there. This is the whole
    // reason the cache is not in the show folder: it is their file share.
    const folder = await readdir(join(app.config.showsDir, 'tape-club'));
    assert.deepEqual(folder.sort(), ['ep-one.mp3'], 'the show folder must be untouched');
  });

  it('prefers a sidecar image over the artwork inside the file', async () => {
    await drop('tape-club', 'ep-one.mp3', await mp3WithEmbeddedArtwork(await square(1500, '#204020')));
    await drop('tape-club', 'ep-one.jpg', await square(2000, '#A03050'));
    await scanAll();

    const { show, episode } = onlyEpisode('tape-club');
    assert.equal(episode.art_source, 'sidecar', 'the file an owner can change without re-tagging wins');
    assert.equal(episode.art_sidecar_name, 'ep-one.jpg');
    assert.equal(episode.art_width, 2000, 'the sidecar is 2000px; the embedded picture is 1500px');

    const cached = await readFile(join(app.config.episodeArtDir, show.id, episode.art_filename));
    const original = await readFile(join(app.config.showsDir, 'tape-club', 'ep-one.jpg'));
    assert.deepEqual(cached, original, 'a JPEG is stored byte for byte, not re-encoded');
  });

  it('matches a sidecar case-insensitively, as the shares these files arrive over do', async () => {
    await app.addAudio('tape-club', 'sample.mp3', 'Ep-One.mp3');
    await drop('tape-club', 'EP-ONE.JPG', await square(1500, '#204020'));
    await scanAll();

    const { episode } = onlyEpisode('tape-club');
    assert.equal(episode.art_source, 'sidecar');
    assert.equal(episode.art_sidecar_name, 'EP-ONE.JPG', 'stored as it really is on disk');
  });

  it('leaves the art columns null, and says nothing, for a file with no artwork at all', async () => {
    await app.addAudio('quiet', 'sample.m4a', 'ep-one.m4a');
    const record = await scanAll();

    const { episode } = onlyEpisode('quiet');
    assert.equal(episode.art_source, null);
    assert.equal(episode.art_filename, null);
    assert.equal(episode.art_etag, null);
    // Having no artwork of its own is the ordinary case — the episode simply uses the
    // show cover, exactly as before this feature existed — so it earns no line in the log.
    assert.deepEqual(warningsFor(record, 'ep-one.m4a'), []);
  });

  it('falls back to the show cover when a sidecar is deleted and nothing is embedded', async () => {
    await app.addAudio('tape-club', 'sample.mp3', 'ep-one.mp3');
    await drop('tape-club', 'ep-one.png', await sharp({
      create: { width: 1500, height: 1500, channels: 3, background: '#204020' },
    }).png().toBuffer());
    await scanAll();
    assert.equal(onlyEpisode('tape-club').episode.art_source, 'sidecar');

    await rm(join(app.config.showsDir, 'tape-club', 'ep-one.png'));
    await scanAll();

    const { episode } = onlyEpisode('tape-club');
    assert.equal(episode.art_source, null, 'the columns are cleared, not left pointing at a ghost');
    assert.equal(episode.art_filename, null);
    assert.equal(episode.art_etag, null);
  });
});

describe('per-episode artwork: noticing changes without re-dating episodes', () => {
  it('notices a replaced sidecar although the audio file is byte-for-byte untouched', async () => {
    await app.addAudio('tape-club', 'sample.mp3', 'ep-one.mp3');
    await drop('tape-club', 'ep-one.jpg', await square(1500, '#204020'));
    await scanAll();

    const first = onlyEpisode('tape-club').episode;
    const audioBefore = await stat(join(app.config.showsDir, 'tape-club', 'ep-one.mp3'));

    // A sidecar is a *different file*: swapping it moves nothing the scanner's fast
    // path looks at, which is precisely why that path has to check artwork too.
    const sidecar = join(app.config.showsDir, 'tape-club', 'ep-one.jpg');
    await writeFile(sidecar, await square(2400, '#A03050'));
    const later = new Date(Date.now() + 60_000);
    await utimes(sidecar, later, later);

    await scanAll();

    const audioAfter = await stat(join(app.config.showsDir, 'tape-club', 'ep-one.mp3'));
    assert.equal(audioAfter.size, audioBefore.size);
    assert.equal(audioAfter.mtime.toISOString(), audioBefore.mtime.toISOString());

    const second = onlyEpisode('tape-club').episode;
    assert.equal(second.id, first.id, 'the same episode, not a new one');
    assert.equal(second.art_width, 2400, 'the new sidecar is what is stored');
    assert.notEqual(second.art_etag, first.art_etag, 'different bytes, different hash');
  });

  it('re-extracts after the art cache is deleted and leaves updated_at exactly where it was', async () => {
    await drop('tape-club', 'ep-one.mp3', await mp3WithEmbeddedArtwork(await square(1500, '#204020')));
    await scanAll();

    const before = onlyEpisode('tape-club').episode;
    assert.equal(before.art_source, 'embedded');
    const updatedAtBefore = before.updated_at;

    // Someone restored db.sqlite from a backup without /data/.art. Every row still
    // names an image that is not there.
    await rm(app.config.episodeArtDir, { recursive: true, force: true });
    await scanAll();

    const { show, episode: after } = onlyEpisode('tape-club');
    const cached = join(app.config.episodeArtDir, show.id, after.art_filename);
    assert.equal((await stat(cached)).size > 0, true, 'the cache should have been rebuilt');
    assert.equal(after.art_etag, before.art_etag, 'identical bytes hash identically');

    // The one that matters. setSystemFields bumps updated_at, updated_at moves
    // lastBuildDate, lastBuildDate changes the feed ETag — so writing an unchanged
    // column here would re-date every episode and make every subscriber's app
    // re-download the entire library for a change that did not happen.
    assert.equal(
      after.updated_at,
      updatedAtBefore,
      'rebuilding identical artwork must not re-date the episode',
    );
  });

  it('writes nothing at all on an ordinary rescan of an unchanged library', async () => {
    await drop('tape-club', 'ep-one.mp3', await mp3WithEmbeddedArtwork(await square(1500, '#204020')));
    await drop('tape-club', 'ep-two.mp3', await mp3WithEmbeddedArtwork(await square(1500, '#503010')));
    await scanAll();
    const before = app.episodes.listByShow(app.shows.getBySlug('tape-club').id);

    await scanAll();
    await scanAll();

    const after = app.episodes.listByShow(app.shows.getBySlug('tape-club').id);
    assert.deepEqual(
      after.map((e) => e.updated_at),
      before.map((e) => e.updated_at),
    );
  });
});

describe('per-episode artwork: artwork SelfPod will not use as-is', () => {
  it('stores and serves art smaller than 1400px, with a warning rather than a rejection', async () => {
    await drop('tape-club', 'ep-one.mp3', await mp3WithEmbeddedArtwork(await square(600, '#204020')));
    const record = await scanAll();

    const { episode } = onlyEpisode('tape-club');
    // Refusing it would leave the episode silently on the show cover, which is the
    // invisible failure this whole app exists to remove. Same rule as a show cover.
    assert.equal(episode.art_source, 'embedded', 'undersized artwork is still used');
    assert.equal(episode.art_width, 600);

    const messages = warningsFor(record, 'ep-one.mp3');
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Episode artwork is 600×600px/);
    assert.match(messages[0], /smaller than 1400px/);
  });

  it('converts a WebP sidecar to JPEG, because Apple accepts JPEG and PNG only', async () => {
    await app.addAudio('tape-club', 'sample.mp3', 'ep-one.mp3');
    await drop('tape-club', 'ep-one.webp', await sharp({
      create: { width: 1500, height: 1500, channels: 3, background: '#204020' },
    }).webp().toBuffer());
    await scanAll();

    const { show, episode } = onlyEpisode('tape-club');
    assert.equal(episode.art_source, 'sidecar');
    assert.equal(episode.art_filename, `${episode.id}.jpg`, 'stored as JPEG, not as .webp');
    const stored = await sharp(join(app.config.episodeArtDir, show.id, episode.art_filename)).metadata();
    assert.equal(stored.format, 'jpeg');
    assert.equal(stored.width, 1500);
  });

  it('ignores embedded art past the size cap and names the file in the activity log', async () => {
    // 13 MB — over the 12 MB cap. Deliberately not a real image: the cap is checked
    // on the byte length before anything tries to decode it, which is the entire
    // point of having a cap.
    const huge = Buffer.alloc(13 * 1024 * 1024, 0x41);
    await drop('tape-club', 'ep-one.mp3', await mp3WithEmbeddedArtwork(huge));
    const record = await scanAll();

    const { episode } = onlyEpisode('tape-club');
    assert.equal(episode.art_source, null, 'nothing is stored');
    assert.equal(episode.art_filename, null);

    const messages = warningsFor(record, 'ep-one.mp3');
    assert.equal(messages.length, 1, 'the owner is told why this episode has no artwork');
    assert.match(messages[0], /larger than 12 MB/);
    assert.match(messages[0], /ep-one\.jpg/, 'and what to do about it, in their own file’s terms');
  });

  it('warns and carries on when a sidecar is not a readable image', async () => {
    await app.addAudio('tape-club', 'sample.mp3', 'ep-one.mp3');
    await app.addAudio('tape-club', 'sample.m4a', 'ep-two.m4a');
    await drop('tape-club', 'ep-one.jpg', Buffer.from('this is not a JPEG'));
    const record = await scanAll();

    const show = app.shows.getBySlug('tape-club');
    assert.equal(app.episodes.listByShow(show.id).length, 2, 'one bad image must not abort the scan');
    assert.equal(record.errors.length, 0, 'and it is a warning, never an error');
    assert.equal(warningsFor(record, 'ep-one.jpg').length, 1);
  });
});

describe('per-episode artwork: cleanup', () => {
  it('drops the cached image when the episode and its file are deleted', async () => {
    await drop('tape-club', 'ep-one.mp3', await mp3WithEmbeddedArtwork(await square(1500, '#204020')));
    await scanAll();

    const { show, episode } = onlyEpisode('tape-club');
    const cached = join(app.config.episodeArtDir, show.id, episode.art_filename);
    assert.ok(await stat(cached));

    await app.episodes.deleteWithFile(episode.id);
    await assert.rejects(() => stat(cached), 'the cached artwork should go with the episode');
  });

  it('drops the whole show folder of cached art when every episode is forgotten', async () => {
    await drop('tape-club', 'ep-one.mp3', await mp3WithEmbeddedArtwork(await square(1500, '#204020')));
    await scanAll();
    const show = app.shows.getBySlug('tape-club');

    // A rebuild re-imports under new episode ids, so anything left here could never
    // be reached by any row again.
    app.episodes.forgetAllForShow(show.id);
    await assert.rejects(() => stat(join(app.config.episodeArtDir, show.id)));

    await scanAll();
    const { episode } = onlyEpisode('tape-club');
    assert.equal(episode.art_source, 'embedded', 'and the next scan puts it back');
    assert.ok(await stat(join(app.config.episodeArtDir, show.id, episode.art_filename)));
  });
});
