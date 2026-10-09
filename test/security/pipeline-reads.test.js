import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createTestInstance } from '../helpers/harness.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';
import { cannedWhisper } from '../helpers/whisper.js';

/**
 * The advert pipeline reads episodes off the show folder unattended, every few
 * minutes, for ever — and the show folder is normally an SMB share that other
 * accounts can write to. Every route that *serves* a file proves the path is inside
 * the folder before opening it; the pipeline used to read the raw joined path with
 * no check and no size gate, so a planted link or a pipe would hang or exhaust the
 * heap of a pass nobody was watching.
 *
 * Three things are planted here and each reader — the fingerprinter, the
 * recogniser's decoder and the cutter — is asked to read them. Each must refuse
 * before a byte is read, and say so where the owner looks: the health banner and
 * the pass's activity entry.
 */
const framesFor = (seconds) => Math.round((seconds * 1000) / FRAME_MS);
const SECRET = 'TOP-SECRET-NAS-CONTENT';

let app;
let showDir;
let show;

beforeEach(async () => {
  app = await createTestInstance({ whisper: cannedWhisper({}) });
  showDir = await app.makeShowFolder('shared');
  await writeFile(join(showDir, '.keep'), '');
  await app.scanner.scanAllNow('manual');
  const created = app.shows.getBySlug('shared');
  app.db.prepare("UPDATE shows SET ad_trim_mode = 'auto', ad_auto_min_episodes = 3 WHERE id = ?").run(created.id);
  for (let n = 0; n < 3; n += 1) {
    await writeFile(
      join(showDir, `episode-${n}.mp3`),
      stitch(segment(100_000 + n * 50_000, framesFor(30)), segment(2_000, framesFor(40)), segment(600_000 + n * 50_000, framesFor(30))),
    );
  }
  await app.scanner.scanAllNow('manual');
  show = app.shows.get(created.id);
  // A first pass that reads, finds and cuts, so every reader has real work to do on
  // the planted files afterwards.
  await app.adPipeline.processShow(show.id);
});

afterEach(async () => {
  await app.cleanup();
});

const episodeNamed = (name) => app.episodes.listByShow(show.id).find((row) => row.filename === name);

/** Puts something in place of an episode's file, so the next read meets it. */
async function plant(name, make) {
  const path = join(showDir, name);
  await rm(path);
  await make(path);
  return episodeNamed(name);
}

async function expectRefusal(episode, pattern) {
  const fingerprint = await app.adDetect.fingerprintEpisode(episode, { force: true });
  assert.equal(fingerprint.skipped, 'refused', `the fingerprinter read it: ${JSON.stringify(fingerprint)}`);
  assert.match(fingerprint.message, pattern);

  const transcript = await app.transcriber.transcribeEpisode(episode, show, { force: true });
  assert.equal(transcript.skipped, 'refused', `the recogniser's decoder read it: ${JSON.stringify(transcript)}`);
  assert.match(transcript.message, pattern);

  const trim = await app.trimmer.trimEpisode({ ...episode, trim_status: null });
  assert.equal(trim.trimmed, false, 'the cutter read it');
  assert.notEqual(trim.reason, 'nothing_approved', 'setup: the cutter had nothing to cut, so it never tried to read');
  assert.match(trim.reason, /escapes|not_a_file|too_large/);

  // Said where the owner looks: a banner naming the episode, with the reason.
  const banner = app.health.get(`ad_read_${episode.id}`);
  assert.ok(banner, 'no banner was raised for a file the pipeline refused to read');
  assert.equal(banner.level, 'warn');
  assert.match(banner.detail, pattern);
  const trimBanner = app.health.get(`trim_${episode.id}`);
  assert.ok(trimBanner, 'the cutter refused quietly');
  assert.match(trimBanner.detail, pattern);
}

describe('the pipeline will not read anything but an ordinary file inside the show folder', () => {
  it('refuses a link to a file outside the folder, and says so in the activity log', async () => {
    // Something elsewhere on the host shaped like an episode — so a reader that
    // followed the link would happily fingerprint it — carrying a secret besides.
    const outside = join(app.dataDir, 'not-an-episode.mp3');
    await writeFile(outside, Buffer.concat([stitch(segment(2_000, framesFor(60))), Buffer.from(SECRET)]));
    const episode = await plant('episode-1.mp3', (path) => symlink(outside, path));

    const before = (await readdir(join(app.config.fingerprintDir, show.id))).length;

    // The unattended pass meets the link first, and says so in the entry the owner reads.
    const logged = () => app.activity.list({ showId: show.id }).filter((row) => row.trigger === 'adverts').length;
    const entriesBefore = logged();
    await app.adPipeline.processShow(show.id);
    assert.equal(logged(), entriesBefore + 1, 'the pass recorded nothing about a file it refused');
    const [latest] = app.activity.list({ showId: show.id }).filter((row) => row.trigger === 'adverts');
    const named = latest.warnings.filter((row) => row.file === 'episode-1.mp3');
    assert.equal(named.length, 1, `expected the file named once: ${JSON.stringify(latest.warnings)}`);
    assert.match(named[0].message, /link to somewhere outside the show's folder/);

    // Every reader refuses it, and no fingerprint of it exists.
    await expectRefusal(episode, /is a link to somewhere outside the show's folder/);
    assert.equal((await readdir(join(app.config.fingerprintDir, show.id))).length, before, 'a fingerprint was written for the link');

    // Said once, not on every pass for as long as the link stays: the banner is what
    // persists, and a log that repeats itself every five minutes is a log nobody reads.
    const entriesAfter = logged();
    await app.adPipeline.processShow(show.id);
    await app.adPipeline.processShow(show.id);
    const repeated = app.activity
      .list({ showId: show.id })
      .filter((row) => row.trigger === 'adverts')
      .slice(0, logged() - entriesAfter)
      .flatMap((row) => row.warnings)
      .filter((row) => row.file === 'episode-1.mp3' && /link to somewhere/.test(row.message));
    assert.equal(repeated.length, 0, 'the same refusal was logged again on a later pass');
    assert.ok(app.health.get(`ad_read_${episode.id}`), 'the banner did not stay while the link did');
  });

  it('refuses a pipe without opening it, so the pass cannot hang on it', async () => {
    const episode = await plant('episode-1.mp3', (path) => execFileSync('mkfifo', [path]));
    // Nothing ever writes to the pipe, so a reader that opened it would wait for ever.
    const outcome = await Promise.race([
      expectRefusal(episode, /not an ordinary file/).then(() => 'refused'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 5000)),
    ]);
    assert.equal(outcome, 'refused', 'a reader opened the pipe and blocked on it');
  });

  it('refuses a file larger than it will hold in memory, without reading it', async () => {
    const episode = await plant('episode-1.mp3', async (path) => {
      await writeFile(path, segment(1, 10));
      // Sparse: two gigabytes that cost no disk, so the refusal can only come from
      // the size, and reading it would genuinely be the problem it is on a NAS.
      await truncate(path, 2 * 1024 ** 3);
    });
    await expectRefusal(episode, /2\.0 GB, more than the 768 MB SelfPod will read in one piece/);
  });

  it('reads the same file again once it is an ordinary file in the folder', async () => {
    // The positive control: the refusals above are about the file, not about readers
    // that stopped working.
    const outside = join(app.dataDir, 'elsewhere.mp3');
    await writeFile(outside, stitch(segment(2_000, framesFor(60))));
    const episode = await plant('episode-1.mp3', (path) => symlink(outside, path));
    assert.equal((await app.adDetect.fingerprintEpisode(episode, { force: true })).skipped, 'refused');

    await rm(join(showDir, 'episode-1.mp3'));
    await writeFile(join(showDir, 'episode-1.mp3'), stitch(segment(2_000, framesFor(60))));
    const result = await app.adDetect.fingerprintEpisode(episode, { force: true });
    assert.ok(!result.skipped, `a plain file was refused: ${JSON.stringify(result)}`);
    assert.equal(app.health.get(`ad_read_${episode.id}`), null, 'the banner outlived the problem');
  });
});
