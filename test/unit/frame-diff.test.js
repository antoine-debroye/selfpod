import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffFrames, runsToRanges } from '../../src/lib/frame-diff.js';
import { frameProfile } from '../../src/lib/mp3-frames.js';
import { segment, stitch } from '../helpers/mp3.js';

/**
 * Every test here builds its files the way a podcast host builds one: by joining
 * segments of frames. "Advert A, then the programme" really is a concatenation, so
 * these fixtures are the real thing rather than a stand-in for it.
 */

const SHOW = () => segment(10_000, 600);
const AD_A = () => segment(1_000, 200);
const AD_B = () => segment(2_000, 120);
const MID = () => segment(3_000, 150);

function hashesOf(buffer) {
  return frameProfile(buffer).hashes;
}

describe('two copies of one episode with different adverts', () => {
  it('finds each advert exactly, and keeps the programme', () => {
    const a = frameProfile(stitch(AD_A(), SHOW()));
    const b = frameProfile(stitch(AD_B(), SHOW()));

    const diff = diffFrames(a.hashes, b.hashes);

    assert.equal(diff.comparable, true);
    assert.equal(diff.identical, false);
    assert.equal(diff.commonFrames, 600, 'the whole programme is common to both');

    assert.equal(diff.onlyInA.length, 1);
    assert.deepEqual(
      { start: diff.onlyInA[0].start, frames: diff.onlyInA[0].frames },
      { start: 0, frames: 200 },
      'advert A, to the frame',
    );
    assert.deepEqual(
      { start: diff.onlyInB[0].start, frames: diff.onlyInB[0].frames },
      { start: 0, frames: 120 },
      'advert B, to the frame',
    );
  });

  it('is not defeated by the two copies being out of step', () => {
    // The reason this is a sequence diff rather than a walk down both files. The
    // adverts differ in *length*, so everything after the first one sits at a
    // different offset in each copy — by 80 frames here, which is not a whole number
    // of anything. A position-based comparison matches nothing past that point and
    // concludes the entire rest of the episode differs. Acted on, that cuts the show.
    const a = frameProfile(stitch(AD_A(), SHOW()));
    const b = frameProfile(stitch(AD_B(), SHOW()));

    assert.notEqual(a.frameCount, b.frameCount, 'the copies really are misaligned');
    const diff = diffFrames(a.hashes, b.hashes);

    assert.equal(diff.commonFrames, 600);
    assert.equal(diff.onlyInA.reduce((n, run) => n + run.frames, 0), 200, 'only the advert');
  });

  it('finds a mid-roll as well as a pre-roll', () => {
    const showStart = segment(10_000, 300);
    const showEnd = segment(20_000, 300);
    const a = frameProfile(stitch(AD_A(), showStart, MID(), showEnd));
    const b = frameProfile(stitch(AD_B(), showStart, showEnd));

    const diff = diffFrames(a.hashes, b.hashes);

    assert.equal(diff.onlyInA.length, 2, 'the pre-roll and the mid-roll');
    assert.deepEqual(diff.onlyInA.map((run) => run.frames), [200, 150]);
    assert.equal(diff.onlyInB.length, 1, 'B has only its own pre-roll');
  });

  it('reports where each run sits, in milliseconds', () => {
    const a = frameProfile(stitch(AD_A(), SHOW()));
    const b = frameProfile(stitch(AD_B(), SHOW()));
    const diff = diffFrames(a.hashes, b.hashes);

    const [range] = runsToRanges(diff.onlyInA, a.frames);
    assert.equal(range.startMs, 0);
    // 200 frames x 1152 samples / 44100 Hz = 5,224 ms.
    assert.ok(Math.abs(range.durationMs - 5224) <= 2, `got ${range.durationMs}ms`);
    assert.equal(range.frames, 200);
  });
});

describe('two copies that are the same file', () => {
  it('says so immediately, without diffing', () => {
    // The common case: most shows bake their adverts in, so two fetches are
    // byte-identical and there is nothing to compare.
    const hashes = hashesOf(stitch(AD_A(), SHOW()));
    const diff = diffFrames(hashes, hashes.slice());

    assert.equal(diff.identical, true);
    assert.equal(diff.onlyInA.length, 0);
    assert.equal(diff.onlyInB.length, 0);
  });
});

describe('what it refuses to answer', () => {
  it('gives up rather than guessing when the two are not the same episode', () => {
    // Two unrelated files differ almost everywhere, which is where an O(N·D) diff
    // becomes O(N²). "These are not comparable" is both true and cheap; a list of
    // differences thousands long would be neither useful nor safe to act on.
    const a = hashesOf(segment(1, 6000));
    const b = hashesOf(segment(500_000, 6000));

    const diff = diffFrames(a, b);

    assert.equal(diff.comparable, false);
    assert.deepEqual(diff.onlyInA, [], 'and offers nothing that could be cut');
    assert.deepEqual(diff.onlyInB, []);
  });

  it('gives up on an empty side rather than calling everything an advert', () => {
    const hashes = hashesOf(SHOW());
    assert.equal(diffFrames(hashes, []).comparable, false);
    assert.equal(diffFrames([], hashes).comparable, false);
    assert.equal(diffFrames(null, hashes).comparable, false);
  });

  it('ignores a difference too short to be an advert', () => {
    // Two encodes of the same audio can differ in a frame or two — a rewritten tag,
    // different padding. A handful of frames is a tenth of a second; nothing anybody
    // would call an advert is that short.
    const show = SHOW();
    const a = frameProfile(show);
    const b = frameProfile(stitch(show.subarray(0, 417 * 300), segment(77_000, 3), show.subarray(417 * 300)));

    const diff = diffFrames(a.hashes, b.hashes);
    assert.equal(diff.onlyInB.length, 0, 'three frames is noise, not an advert');
  });

  it('can be told to care about shorter runs', () => {
    const show = SHOW();
    const a = frameProfile(show);
    const b = frameProfile(stitch(show.subarray(0, 417 * 300), segment(77_000, 3), show.subarray(417 * 300)));

    const diff = diffFrames(a.hashes, b.hashes, { minRunFrames: 1 });
    assert.equal(diff.onlyInB.length, 1);
    assert.equal(diff.onlyInB[0].frames, 3);
  });
});

describe('cost', () => {
  it('stays fast on an episode-sized pair', () => {
    // An hour of audio is about 137,000 frames. The work is proportional to how much
    // differs, not to the length, which is what makes this practical on a NAS.
    const show = segment(10_000, 8000);
    const a = frameProfile(stitch(segment(1, 300), show));
    const b = frameProfile(stitch(segment(2_000, 200), show));

    const started = process.hrtime.bigint();
    const diff = diffFrames(a.hashes, b.hashes);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(diff.commonFrames, 8000);
    assert.ok(ms < 2000, `took ${ms.toFixed(0)}ms for 8,000 frames`);
  });
});
