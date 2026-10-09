import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { frameProfile, readFrames } from '../../src/lib/mp3-frames.js';
import { createFrameTableCache, frameTable, readFrameRange } from '../../src/lib/mp3-range.js';
import { FIXTURE_DIR } from '../helpers/harness.js';
import { frame, id3v2, segment, stitch } from '../helpers/mp3.js';

/**
 * The catalogue stores cut positions as frame indices measured by `readFrames` over
 * the whole file. The chunked walk that now serves a sample reads the file through a
 * sliding window instead, and the only thing that matters about it is that it finds
 * exactly the same frames at exactly the same offsets — a walk that drifted by one
 * frame would play the wrong ten seconds and nobody would know why.
 */
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'selfpod-mp3-range-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fileOf(name, bytes) {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

/** Every case a real or hostile file can present the walk with. */
const CASES = {
  'a plain stitched file': () => stitch(segment(1, 400), segment(5000, 400)),
  'an ID3 tag in front': () => Buffer.concat([id3v2(3000), segment(1, 300)]),
  'junk before the first frame': () => Buffer.concat([Buffer.alloc(777, 0x41), segment(1, 300)]),
  'garbage in the middle that needs a resync': () =>
    Buffer.concat([segment(1, 200), Buffer.alloc(500, 0x42), segment(300, 200)]),
  'a tail cut off mid-frame': () => segment(1, 300).subarray(0, 300 * 417 - 100),
  'a frame that straddles the one-megabyte chunk boundary': () => segment(1, 2600),
  'a real encode with a Xing header': () => readFileSync(join(FIXTURE_DIR, 'theme-48k.mp3')),
  'a real encode at another bitrate': () => readFileSync(join(FIXTURE_DIR, 'theme-80k.mp3')),
  'real programme audio': () => readFileSync(join(FIXTURE_DIR, 'prog-b.mp3')),
  'a file with no frames at all': () => Buffer.alloc(5000, 0x41),
};

describe('the chunked frame walk', () => {
  for (const [label, make] of Object.entries(CASES)) {
    it(`finds the same frames as readFrames: ${label}`, async () => {
      const bytes = make();
      const path = await fileOf(`${label.replace(/\W+/g, '-')}.mp3`, bytes);
      const whole = frameProfile(bytes);
      const table = await frameTable(path);
      if (!whole) {
        assert.equal(table, null);
        return;
      }
      assert.ok(table, 'the walk found nothing in a file readFrames reads');
      assert.equal(table.frameCount, whole.frameCount, 'a different number of audio frames');
      assert.deepEqual(Array.from(table.offsets), whole.frames.map((f) => f.offset), 'the offsets differ');
      assert.deepEqual(Array.from(table.lengths), whole.frames.map((f) => f.length), 'the lengths differ');
      assert.equal(table.sampleRate, whole.sampleRate);
      assert.equal(table.samplesPerFrame, whole.frames[0].samplesPerFrame);
      assert.equal(table.truncated, whole.truncated);
      // And the control: a plain readFrames over the same bytes, so the test is not
      // comparing two things that could both be wrong in the same way.
      const { frames } = readFrames(bytes);
      assert.equal(frames.length, table.frameCount + (whole.xing ? 1 : 0));
    });
  }

  it('stops at the frame cap, as readFrames does', async () => {
    const bytes = segment(1, 50);
    const path = await fileOf('capped.mp3', bytes);
    const table = await frameTable(path, { maxFrames: 20 });
    assert.equal(table.frameCount, 20);
    assert.equal(table.truncated, true);
    assert.deepEqual(Array.from(table.offsets), readFrames(bytes, { maxFrames: 20 }).frames.map((f) => f.offset));
  });
});

describe('reading a range of frames', () => {
  it('returns exactly the bytes of those frames, and nothing around them', async () => {
    const bytes = Buffer.concat([id3v2(200), segment(1, 300), Buffer.alloc(300, 0x42), segment(900, 300)]);
    const path = await fileOf('ranged.mp3', bytes);
    const table = await frameTable(path);
    const { frames } = frameProfile(bytes);

    // Across the garbage, so the read has to be two pieces joined.
    const clip = await readFrameRange(path, table, 280, 320);
    const expected = Buffer.concat(frames.slice(280, 320).map((f) => bytes.subarray(f.offset, f.offset + f.length)));
    assert.ok(clip.equals(expected), 'the clip is not the frames asked for');
    assert.equal(frameProfile(clip).frameCount, 40, 'the clip does not parse back to the same number of frames');
    // The first frame of the clip is the first frame asked for, byte for byte.
    assert.ok(clip.subarray(0, 417).equals(frame(281)), 'the clip starts on the wrong frame');
  });

  it('clamps to the file and answers an empty range with nothing', async () => {
    const bytes = segment(1, 100);
    const path = await fileOf('clamped.mp3', bytes);
    const table = await frameTable(path);
    assert.equal((await readFrameRange(path, table, 90, 500)).length, 10 * 417);
    assert.equal((await readFrameRange(path, table, 50, 50)).length, 0);
    assert.equal((await readFrameRange(path, table, -5, 2)).length, 2 * 417);
  });
});

describe('the table cache', () => {
  it('walks a file once and forgets it when it changes', async () => {
    const path = await fileOf('cached.mp3', segment(1, 100));
    const cache = createFrameTableCache({ maxEntries: 2 });
    const first = await cache.get(path, { size: 100 * 417, mtimeMs: 1 });
    const again = await cache.get(path, { size: 100 * 417, mtimeMs: 1 });
    assert.equal(again, first, 'the same file was walked twice');

    await writeFile(path, segment(1, 60));
    const changed = await cache.get(path, { size: 60 * 417, mtimeMs: 2 });
    assert.notEqual(changed, first);
    assert.equal(changed.frameCount, 60);
  });

  it('keeps only the newest few', async () => {
    const cache = createFrameTableCache({ maxEntries: 2 });
    for (let n = 0; n < 4; n += 1) {
      const path = await fileOf(`lru-${n}.mp3`, segment(n, 20));
      await cache.get(path, { size: 20 * 417, mtimeMs: n });
    }
    assert.equal(cache.size(), 2);
  });
});
