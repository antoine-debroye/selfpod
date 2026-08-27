import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { bitErrorRate, createFingerprinter, popcount } from '../../src/lib/acoustic-fingerprint.js';
import { decodeToMono } from '../../src/lib/decode-audio.js';
import { readFrames } from '../../src/lib/mp3-frames.js';
import { FIXTURE_DIR } from '../helpers/harness.js';

/** Decodes a fixture and fingerprints it, the way the service does. */
async function fingerprintOf(name) {
  const buffer = readFileSync(join(FIXTURE_DIR, name));
  const { frames } = readFrames(buffer);
  const fingerprinter = createFingerprinter();
  const info = await decodeToMono(buffer, frames, (samples) => fingerprinter.push(samples));
  return { fingerprint: fingerprinter.finish(), info };
}

describe('the same audio encoded twice, differently', () => {
  it('fingerprints almost identically, though the files share almost no bytes', async () => {
    // This is the whole reason this module exists. SelfPod's first attempt compared MP3
    // frames exactly, on the belief that repeated audio arrives as repeated bytes. It
    // does not: a programme is mastered and encoded in one pass, so its theme tune is
    // encoded afresh every episode. On three real Planet Money episodes that meant nine
    // matching frames out of ninety thousand — nothing found, for ever.
    //
    // These two fixtures are the same six seconds at 48 and 80 kbit/s.
    const a = readFileSync(join(FIXTURE_DIR, 'theme-48k.mp3'));
    const b = readFileSync(join(FIXTURE_DIR, 'theme-80k.mp3'));
    let sameBytes = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] === b[i]) sameBytes += 1;
    assert.ok(sameBytes / a.length < 0.05, 'the fixtures are too alike to prove anything');

    const first = await fingerprintOf('theme-48k.mp3');
    const second = await fingerprintOf('theme-80k.mp3');
    const length = Math.min(first.fingerprint.length, second.fingerprint.length) - 40;
    assert.ok(length > 200, 'the fixture is too short to fingerprint');

    const error = bitErrorRate(first.fingerprint, second.fingerprint, 20, 20, length);
    assert.ok(error < 0.2, `the same audio at two bitrates scored ${error.toFixed(3)}`);
  });

  it('scores far worse against different audio at the same bitrate', async () => {
    // The control. Without it the assertion above could be satisfied by a fingerprint
    // that says everything matches everything.
    const theme = await fingerprintOf('theme-48k.mp3');
    const other = await fingerprintOf('prog-a.mp3');
    const length = Math.min(theme.fingerprint.length, other.fingerprint.length) - 40;

    const error = bitErrorRate(theme.fingerprint, other.fingerprint, 20, 20, length);
    assert.ok(error > 0.3, `different audio scored ${error.toFixed(3)}, too close to a match`);
  });
});

describe('what a fingerprint is made of', () => {
  it('is unmoved by turning the volume up', async () => {
    // The property the whole scheme is chosen for. A bit is the sign of a difference of
    // differences, so multiplying every band by the same number moves nothing. Hashing
    // band energies directly would be defeated by the first thing an advert network
    // does to a piece of audio.
    const buffer = readFileSync(join(FIXTURE_DIR, 'theme-48k.mp3'));
    const { frames } = readFrames(buffer);

    const plain = createFingerprinter();
    const loud = createFingerprinter();
    await decodeToMono(buffer, frames, (samples) => {
      plain.push(samples);
      loud.push(Float64Array.from(samples, (v) => v * 4));
    });

    assert.deepEqual(
      Array.from(loud.finish()),
      Array.from(plain.finish()),
      'a gain change moved the fingerprint',
    );
  });

  it('produces one sub-fingerprint every 11.6ms of audio', async () => {
    // 5512 samples a second, one every 64: 86.1 a second in the steady state. The
    // first analysis window has no predecessor to be compared against, so a file is
    // short by exactly one window's worth — which for six seconds is a third of a
    // second and worth stating rather than absorbing into a loose tolerance.
    const { fingerprint, info } = await fingerprintOf('theme-48k.mp3');
    const expected = Math.floor((info.samples - 2048) / 64);

    assert.equal(fingerprint.length, expected);
    assert.ok(info.samples / 5512 > 5, 'the fixture should be about six seconds');
  });

  it('gives the same answer whatever size the chunks arrive in', async () => {
    // The decoder hands over whatever a batch of frames produced, so a fingerprint that
    // depended on chunk boundaries would differ between two runs on the same file.
    const buffer = readFileSync(join(FIXTURE_DIR, 'theme-48k.mp3'));
    const { frames } = readFrames(buffer);
    const whole = [];
    await decodeToMono(buffer, frames, (samples) => whole.push(...samples));

    const oneGo = createFingerprinter();
    oneGo.push(Float64Array.from(whole));

    const dribbled = createFingerprinter();
    for (let at = 0; at < whole.length; at += 701) {
      dribbled.push(Float64Array.from(whole.slice(at, at + 701)));
    }

    assert.deepEqual(Array.from(dribbled.finish()), Array.from(oneGo.finish()));
  });
});

describe('counting the bits that differ', () => {
  it('counts them', () => {
    assert.equal(popcount(0), 0);
    assert.equal(popcount(0xffffffff), 32);
    assert.equal(popcount(0b1011), 3);
    assert.equal(popcount(0x80000000), 1, 'the top bit is a bit like any other');
  });

  it('reports nothing wrong between a fingerprint and itself', () => {
    const fingerprint = Uint32Array.from([1, 0xdeadbeef, 0, 0xffffffff]);
    assert.equal(bitErrorRate(fingerprint, fingerprint, 0, 0, 4), 0);
  });

  it('reports everything wrong between opposites', () => {
    const a = Uint32Array.from([0, 0]);
    const b = Uint32Array.from([0xffffffff, 0xffffffff]);
    assert.equal(bitErrorRate(a, b, 0, 0, 2), 1);
  });
});

describe('audio that decodes to nothing sensible', () => {
  it('does not turn into a fingerprint that matches everything', async () => {
    // A damaged or hostile file can decode to not-a-number. Every comparison with NaN
    // is false, so an unguarded fingerprint of it comes out as a run of zero bits — and
    // two unrelated damaged files then agree perfectly, which SelfPod would offer to
    // cut out of both.
    const clean = createFingerprinter();
    const broken = createFingerprinter();
    const samples = new Float64Array(6000);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 7) * 0.4;
    clean.push(samples);

    const poisoned = Float64Array.from(samples);
    for (let i = 0; i < poisoned.length; i += 3) poisoned[i] = Number.NaN;
    broken.push(poisoned);

    const a = clean.finish();
    const b = broken.finish();
    assert.ok(a.length > 10 && b.length > 10);
    assert.ok(
      !Array.from(b).every((value) => value === 0),
      'NaN audio collapsed to an all-zero fingerprint, which matches any other',
    );
  });
});
