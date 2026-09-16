import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MIN_MARK_WIDTH, barMarks, markStyle, parseClock, restoreCovers } from '../../src/lib/cut-bar.js';

describe('where a stretch sits on the bar', () => {
  it('is its start and length as a share of the episode', () => {
    const [mark] = barMarks([{ startMs: 30_000, endMs: 60_000 }], 120_000);
    assert.equal(mark.left, 25);
    assert.equal(mark.width, 25);
    assert.equal(markStyle(mark), 'left:25%;width:25%');
  });

  it('keeps everything else about the stretch', () => {
    const [mark] = barMarks([{ startMs: 0, endMs: 10_000, state: 'cut', segmentId: 's1' }], 100_000);
    assert.equal(mark.state, 'cut');
    assert.equal(mark.segmentId, 's1');
  });

  it('draws a very short cut wide enough to see and tap', () => {
    // Three seconds of a two-hour episode is 0.04%: nothing at all on a phone.
    const [mark] = barMarks([{ startMs: 3_600_000, endMs: 3_603_000 }], 7_200_000);
    assert.equal(mark.width, MIN_MARK_WIDTH);
    assert.equal(mark.left, 50);
  });

  it('never draws past the end of the bar', () => {
    // Cut edges are biased outwards, so a closing cut can end a breath after the
    // measured duration; and a minimum-width mark at the very end would overhang.
    const [overhang, tiny] = barMarks(
      [
        { startMs: 110_000, endMs: 121_500 },
        { startMs: 119_900, endMs: 120_000 },
      ],
      120_000,
    );
    assert.ok(overhang.left + overhang.width <= 100, JSON.stringify(overhang));
    assert.ok(tiny.left + tiny.width <= 100.001, JSON.stringify(tiny));
    assert.equal(tiny.width, MIN_MARK_WIDTH);
  });

  it('clamps a stretch that starts before zero', () => {
    const [mark] = barMarks([{ startMs: -500, endMs: 12_000 }], 120_000);
    assert.equal(mark.left, 0);
    assert.equal(mark.width, 10);
  });

  it('still draws something when the episode length is unknown', () => {
    const marks = barMarks([{ startMs: 0, endMs: 5_000 }, { startMs: 5_000, endMs: 10_000 }], null);
    assert.deepEqual(marks.map((mark) => [mark.left, mark.width]), [[0, 50], [50, 50]]);
  });
});

describe('whether a restore covers a cut', () => {
  const cut = { start_ms: 10_000, end_ms: 20_000 };

  it('does when most of the cut lies inside the restored stretch', () => {
    assert.equal(restoreCovers({ start_ms: 10_500, end_ms: 20_200 }, cut), true);
  });

  it('does not for a stretch that merely touches it', () => {
    assert.equal(restoreCovers({ start_ms: 18_000, end_ms: 30_000 }, cut), false);
  });

  it('does not for an empty cut', () => {
    assert.equal(restoreCovers({ start_ms: 0, end_ms: 1_000 }, { start_ms: 500, end_ms: 500 }), false);
  });
});

describe('reading a time typed by a person', () => {
  it('reads m:ss, h:mm:ss and plain seconds', () => {
    assert.equal(parseClock('0:42'), 42_000);
    assert.equal(parseClock('12:05'), 725_000);
    assert.equal(parseClock('1:02:03'), 3_723_000);
    assert.equal(parseClock('90'), 90_000);
    assert.equal(parseClock(' 1:30.5 '), 90_500);
  });

  it('refuses anything else rather than guessing', () => {
    for (const value of ['', null, undefined, 'soon', '1:xx', '1::2', '-3', '1:2:3:4']) {
      assert.equal(parseClock(value), null, String(value));
    }
  });
});
