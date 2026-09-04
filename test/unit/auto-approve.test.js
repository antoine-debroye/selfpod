import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CUE_STRONG } from '../../src/constants.js';
import { safeToApproveAutomatically } from '../../src/lib/auto-approve.js';

const durations = { a: 600_000, b: 600_000, c: 600_000 };

function segment({ episodes = ['a', 'b', 'c'], startMs = 120_000, durationMs = 30_000, cueScore = 0 } = {}) {
  return {
    durationMs,
    cueScore,
    episodeCount: episodes.length,
    occurrences: episodes.map((episodeId) => ({ episodeId, startMs, endMs: startMs + durationMs })),
  };
}

describe('a segment found by the words', () => {
  const options = { episodeDurations: durations, minEpisodes: 3, source: 'transcript' };

  it('is never cut on its own when heard once, however it sounds', () => {
    const verdict = safeToApproveAutomatically(segment({ episodes: ['a'], cueScore: 1 }), options);
    assert.deepEqual(verdict, { safe: false, reason: 'only_heard_once' });
  });

  it('is cut after two hearings when the words say sponsor, below the usual threshold', () => {
    const verdict = safeToApproveAutomatically(segment({ episodes: ['a', 'b'], cueScore: CUE_STRONG }), options);
    assert.deepEqual(verdict, { safe: true, reason: null });
  });

  it('waits for the usual number of episodes when the words say nothing', () => {
    const verdict = safeToApproveAutomatically(segment({ episodes: ['a', 'b'], cueScore: 0.2 }), options);
    assert.deepEqual(verdict, { safe: false, reason: 'seen_too_few_times' });
  });

  it('lets sponsor wording at the very start through, and holds a standing intro there', () => {
    const preRoll = segment({ startMs: 0, cueScore: 1 });
    assert.deepEqual(safeToApproveAutomatically(preRoll, options), { safe: true, reason: null });
    const intro = segment({ startMs: 0, cueScore: 0 });
    assert.deepEqual(safeToApproveAutomatically(intro, options), { safe: false, reason: 'always_at_the_start' });
  });

  it('holds a repeated tag at the very end when nothing in it sounds like an advert', () => {
    const outro = segment({ startMs: 590_000, durationMs: 8_000, cueScore: 0 });
    assert.deepEqual(safeToApproveAutomatically(outro, options), { safe: false, reason: 'always_at_the_end' });
  });

  it('keeps the length limits, with a shorter floor than the acoustic branch', () => {
    assert.equal(safeToApproveAutomatically(segment({ durationMs: 4_000, cueScore: 1 }), options).reason, 'too_short_to_be_an_advert');
    assert.equal(safeToApproveAutomatically(segment({ durationMs: 7_000, cueScore: 1 }), options).safe, true);
    assert.equal(safeToApproveAutomatically(segment({ durationMs: 200_000, cueScore: 1 }), options).reason, 'too_long_to_be_an_advert');
  });
});

describe('a segment found by ear, once the words are known', () => {
  const options = { episodeDurations: durations, minEpisodes: 3, source: 'corpus' };

  it('is released from the theme-tune guard by sponsor wording, and only by that', () => {
    const preRoll = segment({ startMs: 0, cueScore: 1 });
    assert.deepEqual(safeToApproveAutomatically(preRoll, options), { safe: true, reason: null });
    const theme = segment({ startMs: 0 });
    assert.deepEqual(safeToApproveAutomatically(theme, options), { safe: false, reason: 'always_at_the_start' });
  });
});
