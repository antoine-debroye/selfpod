import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { cutFrames } from '../../src/lib/mp3-cut.js';
import { frameProfile, readFrames, readXing } from '../../src/lib/mp3-frames.js';
import { FIXTURE_DIR } from '../helpers/harness.js';
import { FRAME_MS, frame, id3v2, segment, stitch } from '../helpers/mp3.js';

const framesFor = (seconds) => Math.round((seconds * 1000) / FRAME_MS);

/** Programme, advert, programme — and the cut list that removes the advert. */
function episodeWithAdvert({ beforeSeconds = 30, advertSeconds = 20, afterSeconds = 30 } = {}) {
  const before = segment(10_000, framesFor(beforeSeconds));
  const advert = segment(50_000, framesFor(advertSeconds));
  const after = segment(90_000, framesFor(afterSeconds));
  return {
    buffer: stitch(before, advert, after),
    cut: [{ startFrame: framesFor(beforeSeconds), endFrame: framesFor(beforeSeconds + advertSeconds) }],
    beforeBytes: before,
    afterBytes: after,
  };
}

describe('removing a stretch of audio', () => {
  it('removes exactly the frames named, and keeps the rest', () => {
    const { buffer, cut } = episodeWithAdvert();
    const total = frameProfile(buffer).frameCount;

    const result = cutFrames(buffer, cut);

    assert.equal(result.framesRemoved, framesFor(20));
    assert.equal(result.framesKept, total - framesFor(20));
    assert.equal(frameProfile(result.buffer).frameCount, result.framesKept);
  });

  it('leaves what it keeps byte-for-byte identical', () => {
    // Not "transparent" or "visually lossless" — the same bytes. Nothing is decoded,
    // so nothing can be degraded.
    const { buffer, cut, beforeBytes, afterBytes } = episodeWithAdvert();

    const result = cutFrames(buffer, cut);
    const expected = Buffer.concat([beforeBytes, afterBytes]);

    assert.equal(Buffer.compare(result.buffer, expected), 0);
  });

  it('reports the duration the result actually has', () => {
    const { buffer, cut } = episodeWithAdvert({ beforeSeconds: 30, advertSeconds: 20, afterSeconds: 30 });
    const result = cutFrames(buffer, cut);

    assert.ok(
      Math.abs(result.durationMs / 1000 - 60) < 0.1,
      `reported ${(result.durationMs / 1000).toFixed(2)}s for what should be 60s`,
    );
  });

  it('removes several stretches at once', () => {
    const buffer = stitch(
      segment(10_000, 200),
      segment(50_000, 100), // advert one
      segment(90_000, 200),
      segment(70_000, 150), // advert two
      segment(30_000, 200),
    );

    const result = cutFrames(buffer, [
      { startFrame: 200, endFrame: 300 },
      { startFrame: 500, endFrame: 650 },
    ]);

    assert.equal(result.framesRemoved, 250);
    assert.equal(result.framesKept, 600);
  });

  it('cannot be made to remove more than the ranges name', () => {
    // Overlapping ranges arrive in real life: the same audio found once by repetition
    // across episodes and once by comparing two downloads. Applying them one after the
    // other would take out more than either describes.
    const buffer = segment(10_000, 1000);

    const result = cutFrames(buffer, [
      { startFrame: 100, endFrame: 300 },
      { startFrame: 250, endFrame: 400 },
      { startFrame: 120, endFrame: 200 },
    ]);

    assert.equal(result.framesRemoved, 300, 'frames 100–400, counted once');
    assert.equal(result.framesKept, 700);
  });

  it('is not confused by ranges given out of order', () => {
    const buffer = segment(10_000, 1000);
    const result = cutFrames(buffer, [
      { startFrame: 700, endFrame: 800 },
      { startFrame: 100, endFrame: 200 },
    ]);
    assert.equal(result.framesRemoved, 200);
  });

  it('clamps a range that runs off the end', () => {
    const buffer = segment(10_000, 500);
    const result = cutFrames(buffer, [{ startFrame: 400, endFrame: 99_999 }]);
    assert.equal(result.framesKept, 400);
  });

  it('refuses to leave nothing behind', () => {
    // A cut list covering the whole episode is a bug upstream, and producing a
    // zero-length file rather than saying so would publish silence.
    const buffer = segment(10_000, 500);
    assert.equal(cutFrames(buffer, [{ startFrame: 0, endFrame: 500 }]), null);
  });

  it('returns nothing for an empty cut list, rather than a copy', () => {
    assert.equal(cutFrames(segment(10_000, 100), []), null);
    assert.equal(cutFrames(segment(10_000, 100), null), null);
  });

  it('returns nothing for a file with no frames in it', () => {
    assert.equal(cutFrames(Buffer.alloc(4000, 0x41), [{ startFrame: 0, endFrame: 1 }]), null);
  });
});

describe('what travels with the audio', () => {
  it('keeps the episode\'s own ID3 tag', () => {
    // Title, artwork, chapters. They belong to the file rather than to the audio, so
    // a cut must not cost the episode its metadata.
    const tag = id3v2(400);
    const buffer = stitch(tag, segment(10_000, 500));

    const result = cutFrames(buffer, [{ startFrame: 100, endFrame: 200 }]);

    assert.equal(Buffer.compare(result.buffer.subarray(0, tag.length), tag), 0);
    assert.equal(frameProfile(result.buffer).frameCount, 400);
  });
});

describe('the Xing header', () => {
  /** A file whose first frame carries a Xing header with counts and a seek table. */
  function withXing(audioFrames) {
    const header = Buffer.from(frame(1));
    // "Xing" + flags(frames|bytes|toc) + frame count + byte count + 100-byte table,
    // written at the documented offset for MPEG-1 joint stereo.
    const at = 4 + 32;
    header.write('Xing', at, 'latin1');
    header.writeUInt32BE(0x07, at + 4);
    header.writeUInt32BE(999_999, at + 8); // a frame count that is wrong on purpose
    header.writeUInt32BE(123_456, at + 12); // and a byte count
    for (let i = 0; i < 100; i += 1) header[at + 16 + i] = i;
    return stitch(header, segment(10_000, audioFrames));
  }

  it('is rewritten so the length is right, not left saying the old one', () => {
    // Without this a variable-bitrate file reports the original's duration for a file
    // that is minutes shorter — every podcast app would show the wrong length.
    const buffer = withXing(1000);
    const result = cutFrames(buffer, [{ startFrame: 100, endFrame: 400 }]);

    const { frames } = readFrames(result.buffer);
    const xing = readXing(result.buffer, frames[0]);

    assert.ok(xing, 'the header survived');
    assert.equal(xing.frameCount, 700, 'and now counts the frames that are actually there');
  });

  it('is not counted as audio, and is never cut away', () => {
    // It is a header wearing a frame's clothing. Treating it as frame zero would
    // shift every cut by one frame and let a cut starting at zero delete it.
    const buffer = withXing(500);
    const result = cutFrames(buffer, [{ startFrame: 0, endFrame: 100 }]);

    const { frames } = readFrames(result.buffer);
    assert.ok(readXing(result.buffer, frames[0]), 'the header is still the first frame');
    assert.equal(result.framesKept, 400, 'and the cut took audio frames, not the header');
  });

  it('has its seek table recomputed', () => {
    // The table maps a percentage through the file to a byte offset. After frames are
    // removed, every entry in the original points somewhere that no longer means what
    // it did — which is the fault people describe as "the scrubber is broken".
    const buffer = withXing(1000);
    const result = cutFrames(buffer, [{ startFrame: 0, endFrame: 500 }]);

    const { frames } = readFrames(result.buffer);
    const at = frames[0].offset + 4 + 32 + 16;
    const table = [...result.buffer.subarray(at, at + 100)];

    assert.notDeepEqual(table, Array.from({ length: 100 }, (_, i) => i), 'the old table survived');
    for (let i = 1; i < table.length; i += 1) {
      assert.ok(table[i] >= table[i - 1], `the table must not go backwards at ${i}`);
    }
    assert.ok(table[99] > table[0], 'and must actually span the file');
  });
});

describe('cost', () => {
  it('cuts an episode-sized file in well under a second', () => {
    // The reason this is not a subprocess. An hour of audio is about 137,000 frames;
    // decoding and re-encoding it would be minutes on NAS-class hardware.
    const buffer = segment(10_000, 20_000);

    const started = process.hrtime.bigint();
    const result = cutFrames(buffer, [
      { startFrame: 2000, endFrame: 3000 },
      { startFrame: 12_000, endFrame: 13_000 },
    ]);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(result.framesKept, 18_000);
    assert.ok(ms < 3000, `took ${ms.toFixed(0)}ms`);
  });
});

describe('a real decoder agrees with the result', () => {
  it('reads a cut of a real recording without complaint', async () => {
    // The strongest claim this module makes, checked against something that is not
    // this module. During development the same check was run against a real NPR
    // episode: 50 seconds cut from 875, and music-metadata, ffprobe and a full ffmpeg
    // decode all reported 825 seconds with no errors, while the audio before the first
    // cut stayed byte-identical.
    const { createMetadata } = await import('../../src/services/metadata.js');
    const original = readFileSync(join(FIXTURE_DIR, 'sample.mp3'));
    const total = frameProfile(original).frameCount;
    assert.ok(total > 10, 'the fixture has frames to cut');

    const result = cutFrames(original, [{ startFrame: 2, endFrame: 6 }]);
    assert.equal(result.framesRemoved, 4);

    const dir = await mkdtemp(join(tmpdir(), 'selfpod-cut-'));
    try {
      const path = join(dir, 'cut.mp3');
      await writeFile(path, result.buffer);
      const meta = await createMetadata({ logger: null }).read(path);

      assert.equal(meta.error, null, `the decoder rejected the cut file: ${meta.error}`);
      assert.ok(meta.durationSeconds !== null, 'and could tell how long it is');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
