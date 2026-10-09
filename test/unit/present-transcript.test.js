import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SEGMENT_KINDS } from '../../src/constants.js';
import { describeAdvertStage, formatClock } from '../../src/lib/present-transcript.js';
import { formatClock as theOneClock } from '../../src/lib/dates.js';

/**
 * The sentence on an episode page that says when a read was removed used to take
 * the day from the server's zone — UTC inside the container, whatever `TZ` the
 * owner set — so a decision made at half past midnight in Auckland was dated the
 * day before. Every other date the pages show goes through the instance zone;
 * this one now does too.
 */
describe('the day a remembered cut was decided', () => {
  const stage = (timeZone) =>
    describeAdvertStage({
      episode: { filename: 'episode-1.mp3' },
      show: { ad_trim_mode: 'review', ad_transcribe: 'head' },
      row: { status: 'ok' },
      spoken: [
        {
          id: 'seg-1',
          kind: SEGMENT_KINDS.REMEMBERED_WORDS,
          status: 'approved',
          auto_approved: 0,
          start_ms: 0,
          end_ms: 30_000,
          // 23:30 UTC on 9 August: still the 9th in Los Angeles, already the 10th in Auckland.
          decided_at: '2026-08-09T23:30:00.000Z',
          cues: null,
        },
      ],
      markers: [],
      pending: false,
      engineMissing: false,
      listenLabel: 'the first 5 minutes',
      timeZone,
    });

  it('is the day in the instance zone, not the server zone', () => {
    assert.equal(stage('Pacific/Auckland').stage, 'cut_remembered');
    assert.match(stage('Pacific/Auckland').sentence, /on 10 August\./);
    assert.match(stage('America/Los_Angeles').sentence, /on 9 August\./);
    assert.match(stage('UTC').sentence, /on 9 August\./);
  });

  it('still says "before" when the decision carries no date', () => {
    const result = describeAdvertStage({
      episode: { filename: 'episode-1.mp3' },
      show: { ad_trim_mode: 'review', ad_transcribe: 'head' },
      row: { status: 'ok' },
      spoken: [{ id: 'seg-1', kind: SEGMENT_KINDS.REMEMBERED_WORDS, status: 'approved', auto_approved: 0, start_ms: 0, end_ms: 30_000, decided_at: null }],
      markers: [],
      pending: false,
      engineMissing: false,
      listenLabel: '',
      timeZone: 'Europe/London',
    });
    assert.match(result.sentence, /same read before\./);
  });
});

describe('the clock the transcript sentences use', () => {
  it('is the one in lib/dates.js, not a copy', () => {
    assert.equal(formatClock, theOneClock);
  });
});
