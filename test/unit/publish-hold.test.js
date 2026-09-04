import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PUBLISH_HOLDS, TRIM_STATUS } from '../../src/constants.js';
import { initialPublishHold, resolvePublishHold } from '../../src/lib/publish-hold.js';

/** The settled case: enough episodes, everything decided, nothing being cut. */
const settled = { corpusSize: 10, minEpisodes: 3, undecidedSegments: 0, trimStatus: null };

describe('a show that is not using the feature', () => {
  it('never holds anything', () => {
    for (const mode of ['off', null, undefined, 'nonsense']) {
      assert.equal(resolvePublishHold({ mode, ...settled }), null, `mode ${mode}`);
      assert.equal(
        resolvePublishHold({ mode, corpusSize: 0, minEpisodes: 3, undecidedSegments: 5 }),
        null,
        `mode ${mode} with everything outstanding`,
      );
    }
  });
});

describe('waiting for enough episodes to compare', () => {
  it('holds until the corpus is big enough, in both modes', () => {
    for (const mode of ['review', 'auto']) {
      assert.equal(
        resolvePublishHold({ mode, corpusSize: 2, minEpisodes: 3, undecidedSegments: 0 }),
        PUBLISH_HOLDS.AWAITING_CORPUS,
        mode,
      );
      assert.equal(
        resolvePublishHold({ mode, corpusSize: 3, minEpisodes: 3, undecidedSegments: 0 }),
        null,
        `${mode} was still holding once it had what it asked for`,
      );
    }
  });

  it('will not compare an episode with itself, whatever the setting says', () => {
    // Repetition across one episode is a chorus, not an advert. A minimum of one would
    // publish whatever a single file happens to repeat, cut out of it, unattended.
    assert.equal(
      resolvePublishHold({ mode: 'auto', corpusSize: 1, minEpisodes: 1, undecidedSegments: 0 }),
      PUBLISH_HOLDS.AWAITING_CORPUS,
    );
  });
});

describe('review mode', () => {
  it('holds an episode while anything about it is undecided', () => {
    assert.equal(
      resolvePublishHold({ mode: 'review', ...settled, undecidedSegments: 1 }),
      PUBLISH_HOLDS.AWAITING_REVIEW,
    );
  });

  it('lets it out as soon as there is nothing left to decide', () => {
    assert.equal(resolvePublishHold({ mode: 'review', ...settled }), null);
  });
});

describe('auto mode', () => {
  it('does not let an undecided segment stop the feed', () => {
    // The guard declines to approve some things unattended — a theme tune's signature,
    // anything under fifteen seconds. Those are surfaced to look at. If they held the
    // episode as well, "automatic" would mean "publishing stops until you log in", and
    // it would stop invisibly: episodes would simply cease to arrive.
    assert.equal(resolvePublishHold({ mode: 'auto', ...settled, undecidedSegments: 4 }), null);
  });

  it('still waits for the cut itself', () => {
    // Publishing between a decision and the copy that carries it out would send the
    // episode with the adverts still in.
    for (const trimStatus of [TRIM_STATUS.PENDING, TRIM_STATUS.TRIMMING]) {
      assert.equal(
        resolvePublishHold({ mode: 'auto', ...settled, trimStatus }),
        PUBLISH_HOLDS.TRIMMING,
        trimStatus,
      );
    }
  });

  it('does not wait on a trim that already finished or already failed', () => {
    for (const trimStatus of [TRIM_STATUS.TRIMMED, TRIM_STATUS.FAILED, null]) {
      assert.equal(resolvePublishHold({ mode: 'auto', ...settled, trimStatus }), null, `${trimStatus}`);
    }
  });
});

describe('the hold a new episode arrives with', () => {
  it('is a wait for the corpus whenever the feature is on', () => {
    assert.equal(initialPublishHold({ ad_trim_mode: 'review' }), PUBLISH_HOLDS.AWAITING_CORPUS);
    assert.equal(initialPublishHold({ ad_trim_mode: 'auto' }), PUBLISH_HOLDS.AWAITING_CORPUS);
  });

  it('is nothing at all for a show not using the feature', () => {
    assert.equal(initialPublishHold({ ad_trim_mode: 'off' }), null);
    assert.equal(initialPublishHold({}), null);
    assert.equal(initialPublishHold(null), null);
  });
});

describe('waiting for the words', () => {
  it('holds an episode whose transcript is still to come, in both modes', () => {
    for (const mode of ['review', 'auto']) {
      assert.equal(
        resolvePublishHold({ mode, ...settled, transcriptPending: true }),
        PUBLISH_HOLDS.AWAITING_CORPUS,
        mode,
      );
    }
  });

  it('never holds a format it could not cut anyway', () => {
    assert.equal(resolvePublishHold({ mode: 'review', ...settled, transcriptPending: true, canBeTrimmed: false }), null);
  });

  it('is not the concern of a show with the feature off', () => {
    assert.equal(resolvePublishHold({ mode: 'off', ...settled, transcriptPending: true }), null);
  });
});
