import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { frameProfile } from '../../src/lib/mp3-frames.js';
import { describeStitchSignals } from '../../src/lib/stitch-signals.js';
import { segment, stitch } from '../helpers/mp3.js';

describe('an episode encoded in one pass', () => {
  it('is not worth downloading again', () => {
    // The ordinary case, and the one that has to be right: a second download costs the
    // publisher a second counted listen for an episode taken once.
    const signals = describeStitchSignals(frameProfile(segment(10_000, 500)));

    assert.equal(signals.likely, false);
    assert.deepEqual(signals.reasons, []);
    assert.equal(signals.detail, null);
  });
});

describe('audio whose format changes part-way through', () => {
  it('is worth a second look, and says where', () => {
    // One encoder given one format keeps it. Two pieces joined after encoding need
    // not agree, and joint-stereo meeting plain stereo is the classic version.
    const joined = stitch(
      segment(10_000, 400, { channelMode: 'joint' }),
      segment(50_000, 200, { channelMode: 'stereo' }),
      segment(90_000, 400, { channelMode: 'joint' }),
    );

    const signals = describeStitchSignals(frameProfile(joined));

    assert.equal(signals.likely, true);
    assert.ok(signals.reasons.includes('format_changes_mid_file'));
    assert.match(signals.detail, /channelMode/);
    // Where it happens, not just that it does — 400 frames is about 10 seconds in.
    assert.match(signals.detail, /at 1[01]s/);
  });
});

describe('a header that disagrees with the file', () => {
  it('is worth a second look', () => {
    // The Xing header is written when the file is encoded. Frames added afterwards
    // make it wrong, and a stitcher working on a response it has begun sending has no
    // way to seek back and fix it.
    const header = Buffer.from(segment(1, 1));
    const at = 4 + 32;
    header.write('Xing', at, 'latin1');
    header.writeUInt32BE(0x01, at + 4);
    header.writeUInt32BE(300, at + 8); // says 300; the file has 500
    const file = stitch(header, segment(10_000, 500));

    const signals = describeStitchSignals(frameProfile(file));

    assert.equal(signals.likely, true);
    assert.ok(signals.reasons.includes('frame_count_disagrees_with_header'));
    assert.match(signals.detail, /300 frames and it has 500/);
  });

  it('proves nothing by being absent', () => {
    // Plenty of encoders write no Xing header at all, and a file without one must not
    // be re-downloaded on the strength of what it does not say.
    const signals = describeStitchSignals(frameProfile(segment(10_000, 500)));
    assert.equal(signals.likely, false);
  });
});

describe('what is not enough on its own', () => {
  it('will not spend a download on a few untidy joins', () => {
    // A resync is the decoder finding rubbish between frames. It happens for dull
    // reasons too, so it corroborates and never decides.
    const signals = describeStitchSignals({
      frameCount: 500,
      resyncs: 9,
      discontinuities: [],
      frameCountMismatch: null,
    });

    assert.equal(signals.likely, false, 'a second download was spent on resyncs alone');
    assert.ok(signals.reasons.includes('gaps_between_frames'), 'but it is still recorded');
    assert.match(signals.detail, /9 places/);
  });

  it('does count them alongside something that is', () => {
    const signals = describeStitchSignals({
      frameCount: 500,
      resyncs: 9,
      discontinuities: [{ frameIndex: 100, atMs: 2600, changes: ['channelMode'] }],
      frameCountMismatch: null,
    });

    assert.equal(signals.likely, true);
    assert.deepEqual(signals.reasons, ['format_changes_mid_file', 'gaps_between_frames']);
  });
});

describe('a file it cannot read', () => {
  it('says no rather than guessing', () => {
    for (const profile of [null, undefined, { frameCount: 0 }]) {
      assert.equal(describeStitchSignals(profile).likely, false, `${JSON.stringify(profile)}`);
    }
  });
});
