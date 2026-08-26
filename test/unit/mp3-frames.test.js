import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  frameIndexToMs,
  frameProfile,
  id3v2Size,
  readFrameHeader,
  readFrames,
} from '../../src/lib/mp3-frames.js';
import { FIXTURE_DIR } from '../helpers/harness.js';
import { frame, id3v2, segment, stitch } from '../helpers/mp3.js';

describe('reading frame headers', () => {
  it('reads the fields that decide a frame\'s length and duration', () => {
    const header = readFrameHeader(frame(1), 0);

    assert.equal(header.version, 1);
    assert.equal(header.layer, 3);
    assert.equal(header.bitrate, 128);
    assert.equal(header.sampleRate, 44100);
    assert.equal(header.channelMode, 'joint');
    assert.equal(header.samplesPerFrame, 1152);
    // 144 * 128000 / 44100 = 417.9 → 417 bytes, which is what makes the next frame
    // findable without searching for it.
    assert.equal(header.length, 417);
  });

  it('returns null rather than throwing for bytes that only look like a sync', () => {
    // 0xFF followed by a high byte happens constantly inside audio data. Treating it
    // as an error rather than as ordinary would make the reader stop mid-file.
    assert.equal(readFrameHeader(Buffer.from([0xff, 0xff, 0xff, 0xff]), 0), null);
    assert.equal(readFrameHeader(Buffer.from([0x00, 0x00, 0x00, 0x00]), 0), null);
    assert.equal(readFrameHeader(Buffer.alloc(2), 0), null, 'a truncated header');
  });

  it('adds the padding byte when the padding bit is set', () => {
    // At 128 kbit/s and 44.1 kHz a frame is 417.96 bytes, so encoders alternate
    // between 417 and 418 to keep the average right. Ignoring the bit puts every
    // subsequent read one byte out, and the reader then resynchronises its way
    // through the whole file finding nothing — which a diff reads as "this entire
    // episode is an advert".
    const header = Buffer.from(frame(1));
    header[2] |= 0x02; // the padding bit
    // The extra byte has to actually be there: a frame that claims 418 bytes in a
    // 417-byte buffer is correctly refused, which would make this test pass for the
    // wrong reason.
    const padded = Buffer.concat([header, Buffer.alloc(1, 0x11)]);

    assert.equal(readFrameHeader(frame(1), 0).length, 417, 'unpadded');
    assert.equal(readFrameHeader(padded, 0).length, 418, 'padded');
  });

  it('follows a padded frame to exactly the next one', () => {
    // The consequence of the bit, rather than the bit itself: a file that mixes
    // padded and unpadded frames must still read as one clean run.
    const a = Buffer.from(frame(1));
    a[2] |= 0x02;
    const padded = Buffer.concat([a, Buffer.alloc(1, 0x11)]); // the extra byte
    const file = Buffer.concat([padded, frame(2), frame(3)]);

    const { frames, resyncs } = readFrames(file);
    assert.equal(frames.length, 3);
    assert.equal(resyncs, 0, 'a padded frame must not need a resync to get past');
    assert.equal(frames[0].length, 418);
    assert.equal(frames[1].offset, 418, 'the next frame starts after the padding byte');
  });

  it('refuses the reserved and free-format encodings rather than guessing a length', () => {
    const reserved = Buffer.from(frame(1));
    reserved[2] = (0x0f << 4) | (0 << 2); // bitrate index 15 is invalid
    assert.equal(readFrameHeader(reserved, 0), null);

    const free = Buffer.from(frame(1));
    free[2] = (0 << 4) | (0 << 2); // bitrate index 0 is free-format: length is not derivable
    assert.equal(readFrameHeader(free, 0), null);
  });
});

describe('ID3v2 tags', () => {
  it('reads the length as synchsafe, not as a plain integer', () => {
    // Each byte carries seven bits. Read as big-endian the value below would be far
    // too large and the reader would start hunting for audio inside the audio.
    const tag = id3v2(1000);
    assert.equal(id3v2Size(tag), 1010);
  });

  it('is zero when there is no tag', () => {
    assert.equal(id3v2Size(frame(1)), 0);
    assert.equal(id3v2Size(Buffer.alloc(4)), 0);
  });

  it('skips the tag to find the first frame', () => {
    const file = stitch(id3v2(500), segment(1, 10));
    const { frames } = readFrames(file);
    assert.equal(frames.length, 10);
    assert.equal(frames[0].offset, 510, 'the first frame is after the tag, not inside it');
  });
});

describe('walking a whole file', () => {
  it('finds every frame, in order', () => {
    const { frames, hashes, resyncs } = readFrames(segment(1, 500));

    assert.equal(frames.length, 500);
    assert.equal(hashes.length, 500);
    assert.equal(resyncs, 0);
    for (let i = 1; i < frames.length; i += 1) {
      assert.equal(
        frames[i].offset,
        frames[i - 1].offset + frames[i - 1].length,
        `frame ${i} does not follow frame ${i - 1}`,
      );
    }
  });

  it('gives distinct frames distinct hashes', () => {
    // The whole of the diff rests on this. Two different frames hashing alike would
    // silently make an advert look like programme.
    const { hashes } = readFrames(segment(1, 2000));
    assert.equal(new Set(hashes).size, 2000, 'a hash collision between distinct frames');
  });

  it('gives identical frames identical hashes', () => {
    const a = readFrames(segment(100, 50)).hashes;
    const b = readFrames(segment(100, 50)).hashes;
    assert.deepEqual(a, b, 'the same audio must hash the same way twice');
  });

  it('recovers from junk between frames rather than stopping', () => {
    // Real podcast MP3s carry ID3v1 footers, APE tags and occasional padding. A
    // reader that gave up at the first surprise would report half a file as the whole
    // of it — which, to a diff, reads as "everything after here is an advert".
    const file = stitch(segment(1, 100), Buffer.alloc(300, 0x41), segment(200, 100));
    const { frames, resyncs } = readFrames(file);

    assert.equal(frames.length, 200, 'both halves were read');
    assert.equal(resyncs, 1, 'and the junk was noticed rather than ignored');
  });

  it('stops at a truncated tail without inventing a frame', () => {
    const file = stitch(segment(1, 50), frame(999).subarray(0, 100));
    const { frames } = readFrames(file);
    assert.equal(frames.length, 50, 'a partial frame is not a frame');
  });
});

describe('duration from frames', () => {
  it('derives it from the frame count, with no decoding', () => {
    const { frames } = readFrames(segment(1, 1000));
    // 1000 frames x 1152 samples / 44100 Hz = 26.122 seconds.
    assert.equal(Math.round(frameIndexToMs(frames, frames.length) / 10), 2612);
  });

  it('agrees with the decoder on a real file', async () => {
    // The claim the whole approach rests on: reading headers gives the same answer as
    // decoding the audio, thousands of times faster. Checked against SelfPod's own
    // fixture and, during development, against a real NPR episode where 33,495 frames
    // gave 875.0s — the same second music-metadata reports.
    const { createMetadata } = await import('../../src/services/metadata.js');
    const path = join(FIXTURE_DIR, 'sample.mp3');
    const profile = frameProfile(readFileSync(path));
    const meta = await createMetadata({ logger: null }).read(path);

    assert.ok(profile, 'the fixture parsed');
    assert.ok(
      Math.abs(profile.durationMs / 1000 - meta.durationSeconds) < 0.75,
      `frames say ${(profile.durationMs / 1000).toFixed(2)}s, the decoder says ${meta.durationSeconds}s`,
    );
  });
});

describe('signals that a file was assembled from parts', () => {
  it('notices a channel-mode change mid-file', () => {
    // Adverts are encoded separately from the show. A stitcher that does not
    // re-encode leaves the seam visible, and joint-stereo giving way to plain stereo
    // is the classic tell.
    const file = stitch(
      segment(1, 200, { channelMode: 'joint' }),
      segment(500, 200, { channelMode: 'stereo' }),
    );
    const profile = frameProfile(file);

    assert.equal(profile.discontinuities.length, 1);
    assert.deepEqual(profile.discontinuities[0].changes, ['channelMode']);
    assert.equal(profile.discontinuities[0].frameIndex, 200);
    assert.ok(profile.discontinuities[0].atMs > 5000, 'and says where, in milliseconds');
  });

  it('says nothing about a file that is all one encode', () => {
    // The positive control for the test above: a signal that fired on ordinary files
    // would be a signal nobody could act on.
    const profile = frameProfile(segment(1, 500));
    assert.equal(profile.discontinuities.length, 0);
  });

  it('ignores bitrate changes in a variable-bitrate file', () => {
    // A VBR encode changes bitrate constantly and legitimately. Reporting each one as
    // a seam would bury the signal that matters under hundreds that do not.
    const parts = [];
    for (let i = 0; i < 40; i += 1) {
      parts.push(segment(i * 10, 10, { bitrateIndex: 5 + (i % 6) }));
    }
    const profile = frameProfile(stitch(...parts));

    assert.equal(profile.variableBitrate, true);
    assert.equal(
      profile.discontinuities.length,
      0,
      'every difference here is a bitrate change, which means nothing in a VBR file',
    );
  });

  it('still reports a channel change inside a variable-bitrate file', () => {
    const parts = [];
    for (let i = 0; i < 20; i += 1) parts.push(segment(i * 10, 10, { bitrateIndex: 5 + (i % 6) }));
    parts.push(segment(900, 100, { bitrateIndex: 9, channelMode: 'mono' }));
    const profile = frameProfile(stitch(...parts));

    assert.equal(profile.variableBitrate, true);
    assert.ok(
      profile.discontinuities.some((entry) => entry.changes.includes('channelMode')),
      'a channel change is meaningful whatever the bitrate is doing',
    );
  });

  it('returns nothing at all for a file with no frames', () => {
    assert.equal(frameProfile(Buffer.alloc(5000, 0x41)), null);
    assert.equal(frameProfile(Buffer.alloc(0)), null);
  });
});
