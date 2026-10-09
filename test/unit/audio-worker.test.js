import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createFingerprinter } from '../../src/lib/acoustic-fingerprint.js';
import { createAudioWorker } from '../../src/lib/audio-search.js';
import { decodeToMono } from '../../src/lib/decode-audio.js';
import { frameProfile, id3v2Size } from '../../src/lib/mp3-frames.js';
import { gateEpisodeFile } from '../../src/lib/pipeline-file.js';
import { FIXTURE_DIR } from '../helpers/harness.js';

/**
 * Reading and decoding an episode used to happen on the thread that serves listeners
 * and answers the container's health check: an hour of MP3 was twelve seconds in
 * which nothing else ran. These prove that the worker produces exactly the bytes the
 * main thread produced, that the main thread stays free while it does, and that a
 * worker in trouble is reported rather than waited for.
 */
const THEME = readFileSync(join(FIXTURE_DIR, 'theme-80k.mp3'));

/** About five minutes of real encoded audio: the theme, tag stripped, fifty times over. */
function fiveMinutes() {
  const body = THEME.subarray(id3v2Size(THEME));
  return Buffer.concat(Array.from({ length: 50 }, () => body));
}

/**
 * The most a 10 ms timer was late by while `work` ran. A timer that fires on time
 * means the event loop was free to run it; one that fires seconds late was blocked.
 */
async function worstLateness(work) {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  last = performance.now();
  worst = 0;
  await work();
  await new Promise((resolve) => setTimeout(resolve, 30));
  clearInterval(timer);
  return worst;
}

let dir;
let longPath;
const worker = createAudioWorker();
const inline = createAudioWorker({ inline: true });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'selfpod-audio-worker-'));
  longPath = join(dir, 'five-minutes.mp3');
  await writeFile(longPath, fiveMinutes());
});

after(async () => {
  await worker.close();
  await inline.close();
  await rm(dir, { recursive: true, force: true });
});

describe('fingerprinting a file in the worker', () => {
  it('produces exactly the fingerprint the main thread produces', async () => {
    const path = join(FIXTURE_DIR, 'theme-80k.mp3');
    // The reference: the decoder and fingerprinter called directly, as the service
    // did before any of this moved.
    const profile = frameProfile(THEME);
    const fingerprinter = createFingerprinter();
    await decodeToMono(THEME, profile.frames, (samples) => fingerprinter.push(samples));
    const reference = fingerprinter.finish();
    assert.ok(reference.length > 200, 'setup: the fixture is too short to fingerprint');

    const fromWorker = await worker.fingerprintFile({ path, maxBytes: 10 * 1024 * 1024 });
    assert.ok(fromWorker.hashes instanceof Uint32Array, 'the hashes did not arrive as a typed array');
    assert.deepEqual(Array.from(fromWorker.hashes), Array.from(reference));
    assert.equal(fromWorker.frameCount, profile.frameCount);
    assert.equal(fromWorker.durationMs, profile.durationMs);
    assert.equal(fromWorker.sampleRate, profile.sampleRate);
    assert.equal(fromWorker.samplesPerFrame, profile.frames[0].samplesPerFrame);

    const fromInline = await inline.fingerprintFile({ path, maxBytes: 10 * 1024 * 1024 });
    assert.deepEqual(Array.from(fromInline.hashes), Array.from(reference), 'the inline fallback drifted from the reference');
  });

  it('skips the decode when the digest still matches, and says so', async () => {
    const path = join(FIXTURE_DIR, 'theme-80k.mp3');
    const first = await worker.fingerprintFile({ path, maxBytes: 10 * 1024 * 1024 });
    const again = await worker.fingerprintFile({ path, maxBytes: 10 * 1024 * 1024, expectSha256: first.sha256 });
    assert.equal(again.unchanged, true);
    assert.equal(again.sha256, first.sha256);
    assert.equal(again.hashes, undefined, 'an unchanged file was decoded anyway');
  });

  it('leaves the main thread free while a five-minute episode is fingerprinted', async () => {
    const payload = { path: longPath, maxBytes: 10 * 1024 * 1024 };

    // The control: on the main thread the same work blocks the loop. Without this
    // the next assertion would prove nothing — the work has to be heavy enough that
    // the old path visibly fails the same test.
    const blocked = await worstLateness(() => inline.fingerprintFile(payload));
    assert.ok(blocked > 200, `setup: fingerprinting inline only held the loop for ${Math.round(blocked)} ms`);

    const free = await worstLateness(() => worker.fingerprintFile(payload));
    assert.ok(
      free <= 50,
      `a 10 ms timer fired ${Math.round(free)} ms late while the worker fingerprinted (${Math.round(blocked)} ms inline)`,
    );
  });
});

describe('decoding a window for the recogniser in the worker', () => {
  it('writes the same WAV and envelope the main thread would', async () => {
    const path = join(FIXTURE_DIR, 'theme-80k.mp3');
    const profile = frameProfile(THEME);
    const slice = profile.frames.slice(10, 120);
    const start = slice[0].offset;
    const end = slice[slice.length - 1].offset + slice[slice.length - 1].length;
    const payload = (wavPath) => ({
      path,
      maxBytes: 10 * 1024 * 1024,
      start,
      end,
      frames: slice.map((frame) => ({ offset: frame.offset - start, length: frame.length })),
      skipSamples: 1234,
      wavPath,
      targetRate: 16_000,
    });

    const viaWorker = await worker.decodeWindow(payload(join(dir, 'worker.wav')));
    const viaInline = await inline.decodeWindow(payload(join(dir, 'inline.wav')));

    assert.ok(viaWorker.samples > 16_000, 'setup: the window decoded to under a second');
    assert.equal(viaWorker.samples, viaInline.samples);
    assert.ok(viaWorker.envelope instanceof Uint8Array);
    assert.deepEqual(Array.from(viaWorker.envelope), Array.from(viaInline.envelope));
    assert.equal(viaWorker.hopMs, viaInline.hopMs);
    const a = await readFile(join(dir, 'worker.wav'));
    const b = await readFile(join(dir, 'inline.wav'));
    assert.equal(a.length, 44 + viaWorker.samples * 2, 'the WAV is not the samples it claims');
    assert.ok(a.equals(b), 'the worker wrote different WAV bytes from the main thread');
  });
});

describe('when the worker cannot do the work', () => {
  it('reports a file that is not there, and recovers on the next call', async () => {
    await assert.rejects(worker.fingerprintFile({ path: join(dir, 'missing.mp3'), maxBytes: 1024 }), (error) => {
      assert.equal(error.code, 'ENOENT');
      return true;
    });
    const again = await worker.fingerprintFile({ path: join(FIXTURE_DIR, 'theme-80k.mp3'), maxBytes: 10 * 1024 * 1024 });
    assert.ok(again.hashes.length > 0);
  });

  it('refuses a pipe rather than waiting on it for ever', async () => {
    const fifo = join(dir, 'episode.mp3');
    execFileSync('mkfifo', [fifo]);
    // Nothing ever writes to it. A plain open for reading would block here until
    // something did — which is the hang this exists to prevent.
    const outcome = await Promise.race([
      worker.fingerprintFile({ path: fifo, maxBytes: 1024 }).then(() => 'read it', (error) => error),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);
    assert.notEqual(outcome, 'hung', 'opening the pipe blocked the worker');
    assert.notEqual(outcome, 'read it', 'the pipe was read as though it were a file');
    assert.equal(outcome.code, 'refused');
    assert.match(outcome.message, /not an ordinary file/);
  });

  it('refuses a file larger than the cap without reading it', async () => {
    const huge = join(dir, 'huge.mp3');
    await writeFile(huge, THEME);
    // Sparse: a 2 GB file that costs no disk, so the refusal has to come from the
    // size and not from running out of anything.
    await truncate(huge, 2 * 1024 ** 3);
    await assert.rejects(worker.fingerprintFile({ path: huge, maxBytes: 768 * 1024 * 1024 }), (error) => {
      assert.equal(error.code, 'refused');
      assert.match(error.message, /2\.0 GB, more than the 768 MB/);
      return true;
    });
    // And the pipeline's own check, which runs before the worker is asked at all.
    const gate = await gateEpisodeFile(dir, 'huge.mp3', { maxBytes: 768 * 1024 * 1024 });
    assert.equal(gate.refused, 'too_large');
    assert.match(gate.message, /“huge\.mp3” is 2\.0 GB/);
  });

  it('stops a task that outlives its timeout and reports it, instead of hanging', async () => {
    const impatient = createAudioWorker({ fileTimeoutMs: 30 });
    try {
      await assert.rejects(impatient.fingerprintFile({ path: longPath, maxBytes: 10 * 1024 * 1024 }), /took longer than/);
      // The wedged worker was replaced: the next call is answered.
      const result = await impatient.repeatedAudio([], { minEpisodes: 2 });
      assert.ok(Array.isArray(result));
    } finally {
      await impatient.close();
    }
  });
});
