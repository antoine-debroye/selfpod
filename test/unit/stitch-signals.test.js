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

describe('a file longer than the feed says it is', () => {
  it('is worth a second look, even when nothing about the file itself looks odd', () => {
    // The case that found this. Five episodes of a real show, each declared 1:14 to
    // 4:11 by the feed and each arriving 21 to 23 seconds longer, with an advert on the
    // end. Not one of the other signals fired on any of them — the host serves cleanly
    // encoded audio with no format change, no Xing header and no untidy joins — so read
    // on its own the file looks innocent. Only the publisher's own claim gives it away.
    const clean = frameProfile(segment(10_000, 900)); // ~23.5s, no internal oddities
    const declared = Math.round(clean.durationMs / 1000) - 22;

    const blind = describeStitchSignals(clean);
    assert.equal(blind.likely, false, 'the fixture should look innocent on its own');

    const told = describeStitchSignals(clean, { declaredDurationSeconds: declared });

    assert.equal(told.likely, true);
    assert.ok(told.reasons.includes('longer_than_the_feed_says'));
    assert.match(told.detail, /22s longer/);
  });

  it('ignores a difference small enough to be rounding', () => {
    // A feed states whole seconds and an encoder pads. Neither is an advert, and
    // treating them as one would spend a second download on every episode ever taken.
    const profile = frameProfile(segment(10_000, 900));
    const declared = Math.round(profile.durationMs / 1000) - 2;

    assert.equal(describeStitchSignals(profile, { declaredDurationSeconds: declared }).likely, false);
  });

  it('is unbothered by a file shorter than the feed claims', () => {
    // Publishers overstate lengths for dull reasons. Missing audio is not inserted
    // audio, and there is nothing here for a second download to find.
    const profile = frameProfile(segment(10_000, 900));
    const declared = Math.round(profile.durationMs / 1000) + 120;

    assert.equal(describeStitchSignals(profile, { declaredDurationSeconds: declared }).likely, false);
  });

  it('says nothing when the feed states no length at all', () => {
    const profile = frameProfile(segment(10_000, 900));
    assert.equal(describeStitchSignals(profile, { declaredDurationSeconds: null }).likely, false);
  });
});

describe('a file it cannot read', () => {
  it('says no rather than guessing', () => {
    for (const profile of [null, undefined, { frameCount: 0 }]) {
      assert.equal(describeStitchSignals(profile).likely, false, `${JSON.stringify(profile)}`);
    }
  });
});
