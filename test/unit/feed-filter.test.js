import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  REJECT_REASONS,
  checkDuration,
  evaluateItem,
  fold,
  normaliseKeywords,
} from '../../src/lib/feed-filter.js';

/** A feed item that passes every rule, so each test can spoil exactly one thing. */
function item(overrides = {}) {
  return {
    title: 'Episode 12: a perfectly ordinary title',
    enclosureUrl: 'https://cdn.example.com/ep12.mp3',
    enclosureType: 'audio/mpeg',
    declaredDurationSeconds: 1800,
    ...overrides,
  };
}

describe('normaliseKeywords', () => {
  it('accepts what a form sends and what an API sends', () => {
    assert.deepEqual(normaliseKeywords('Interview, Deep Dive'), ['interview', 'deep dive']);
    assert.deepEqual(normaliseKeywords(['Interview', 'Deep Dive']), ['interview', 'deep dive']);
    assert.deepEqual(normaliseKeywords('one\ntwo\nthree'), ['one', 'two', 'three']);
  });

  it('folds and de-duplicates so the stored rule is the rule that runs', () => {
    assert.deepEqual(normaliseKeywords('  BONUS , bonus,Bônus '), ['bonus']);
  });

  it('drops empties rather than storing a keyword that matches everything', () => {
    // A single empty string in the include list would make `title.includes('')` true
    // for every item, quietly turning a filter into a pass-through.
    assert.deepEqual(normaliseKeywords(',,  ,'), []);
    assert.deepEqual(normaliseKeywords([]), []);
    assert.deepEqual(normaliseKeywords(undefined), []);
  });

  it('bounds one pasted novel', () => {
    const many = normaliseKeywords(Array.from({ length: 200 }, (_, i) => `word${i}`));
    assert.equal(many.length, MAX_KEYWORDS);
    const long = normaliseKeywords('x'.repeat(500));
    assert.equal(long[0].length, MAX_KEYWORD_LENGTH);
  });
});

describe('fold', () => {
  it('makes accents and case irrelevant to a keyword', () => {
    assert.equal(fold('CAFÉ'), 'cafe');
    assert.equal(fold('Ünïcödé'), 'unicode');
    // The same string decomposed and composed must fold identically: SMB shares and
    // RSS feeds disagree about which form they hand over.
    assert.equal(fold('é'), fold('é'));
  });
});

describe('keyword rules', () => {
  it('keeps everything when no positive keyword is set', () => {
    const result = evaluateItem(item({ title: 'Anything at all' }), {});
    assert.equal(result.keep, true);
    assert.equal(result.reason, null);
  });

  it('keeps an item matching any one positive keyword, and says which', () => {
    const result = evaluateItem(item({ title: 'A deep dive into tape' }), {
      includeKeywords: ['interview', 'deep dive'],
    });
    assert.equal(result.keep, true);
    assert.equal(result.matchedKeyword, 'deep dive', 'the user needs to see which rule let it in');
  });

  it('drops an item matching none, and names every keyword it tried', () => {
    const result = evaluateItem(item({ title: 'A news roundup' }), {
      includeKeywords: ['interview', 'deep dive'],
    });
    assert.equal(result.keep, false);
    assert.equal(result.reason, REJECT_REASONS.NO_KEYWORD_MATCH);
    assert.match(result.detail, /interview/);
    assert.match(result.detail, /deep dive/);
  });

  it('lets a negative keyword beat a positive one on the same title', () => {
    // Anything else would make "never give me bonus episodes" depend on how the rest
    // of the rule happened to be written.
    const result = evaluateItem(item({ title: 'Bonus: an interview' }), {
      includeKeywords: ['interview'],
      excludeKeywords: ['bonus'],
    });
    assert.equal(result.keep, false);
    assert.equal(result.reason, REJECT_REASONS.EXCLUDED_KEYWORD);
    assert.match(result.detail, /bonus/, 'the sentence must name the keyword that did it');
  });

  it('ignores case and accents on both sides', () => {
    const result = evaluateItem(item({ title: 'CAFÉ SOCIETY' }), { includeKeywords: ['cafe'] });
    assert.equal(result.keep, true, 'a user typing "cafe" means to catch "Café"');
  });

  it('matches on substrings, not word boundaries — deliberately', () => {
    // Asserted on purpose rather than left to chance. Substring matching means
    // `bonus` also catches `prebonus`, which is the behaviour a user gets and so is
    // the behaviour the tests have to pin down.
    const result = evaluateItem(item({ title: 'The prebonus round' }), {
      excludeKeywords: ['bonus'],
    });
    assert.equal(result.keep, false, 'substring, not whole-word');
  });

  it('never reads the description, only the title', () => {
    const result = evaluateItem(
      item({ title: 'Plain title', description: 'sponsored by a bonus advertiser' }),
      { excludeKeywords: ['bonus'] },
    );
    assert.equal(result.keep, true, 'commercial feeds stuff descriptions with sponsor copy');
  });
});

describe('duration rules', () => {
  it('treats both bounds as inclusive', () => {
    const rules = { minDurationSeconds: 1200, maxDurationSeconds: 3600 };
    assert.equal(evaluateItem(item({ declaredDurationSeconds: 1200 }), rules).keep, true);
    assert.equal(evaluateItem(item({ declaredDurationSeconds: 3600 }), rules).keep, true);
    assert.equal(evaluateItem(item({ declaredDurationSeconds: 1199 }), rules).keep, false);
    assert.equal(evaluateItem(item({ declaredDurationSeconds: 3601 }), rules).keep, false);
  });

  it('names both numbers when it refuses', () => {
    const result = evaluateItem(item({ declaredDurationSeconds: 252 }), {
      minDurationSeconds: 1200,
    });
    assert.equal(result.reason, REJECT_REASONS.TOO_SHORT);
    assert.match(result.detail, /4:12/, 'the length it actually is');
    assert.match(result.detail, /20:00/, 'the bound it failed');
  });

  it('applies only the bound that was set', () => {
    assert.equal(
      evaluateItem(item({ declaredDurationSeconds: 99999 }), { minDurationSeconds: 60 }).keep,
      true,
      'a minimum alone must not imply a maximum',
    );
    assert.equal(
      evaluateItem(item({ declaredDurationSeconds: 1 }), { maxDurationSeconds: 60 }).keep,
      true,
    );
  });

  it('defers rather than guessing when the feed states no length', () => {
    const result = evaluateItem(item({ declaredDurationSeconds: null }), {
      minDurationSeconds: 1200,
    });
    assert.equal(result.keep, true);
    assert.equal(result.durationCheck, 'deferred');
    assert.match(result.detail, /download it and check/);
  });

  it('does not defer when there is no duration rule to apply', () => {
    // Nothing to check later, so the poller must not be told to re-check.
    const result = evaluateItem(item({ declaredDurationSeconds: null }), {});
    assert.equal(result.keep, true);
    assert.equal(result.durationCheck, 'none');
  });

  it('ignores a duration the feed got wrong rather than failing on it', () => {
    for (const nonsense of ['', 'PT30M', -5, NaN, undefined]) {
      const result = evaluateItem(item({ declaredDurationSeconds: nonsense }), {
        minDurationSeconds: 1200,
      });
      assert.equal(result.durationCheck, 'deferred', `"${nonsense}" should defer, not throw`);
    }
  });

  it('is one rule, reusable against the measured length', () => {
    // The poller runs this again on the staged file. Same function, so the feed's
    // claim and the file's reality can never be judged by two drifting copies.
    assert.equal(checkDuration(1800, 1200, 3600), null, 'null means it passed');
    assert.equal(checkDuration(252, 1200, null).reason, REJECT_REASONS.TOO_SHORT);
    assert.equal(checkDuration(9999, null, 3600).reason, REJECT_REASONS.TOO_LONG);
    assert.equal(checkDuration(null, 1200, 3600), null, 'an unmeasurable file is not a refusal');
  });
});

describe('items SelfPod cannot use at all', () => {
  it('refuses an item with no audio attached', () => {
    const result = evaluateItem(item({ enclosureUrl: null }), {});
    assert.equal(result.reason, REJECT_REASONS.NO_ENCLOSURE);
    assert.match(result.detail, /nothing to download/);
  });

  it('refuses a type the feed itself says is not audio SelfPod serves', () => {
    const result = evaluateItem(
      item({ enclosureType: 'video/mp4', supportedType: false }),
      {},
    );
    assert.equal(result.reason, REJECT_REASONS.UNSUPPORTED_TYPE);
    assert.match(result.detail, /video\/mp4/);
  });

  it('checks for audio before spending any rule on it', () => {
    // Ordering matters for the ledger: "no audio attached" is a more useful sentence
    // than "didn't match your keywords" for an item that could never have worked.
    const result = evaluateItem(item({ enclosureUrl: null, title: 'nope' }), {
      includeKeywords: ['interview'],
    });
    assert.equal(result.reason, REJECT_REASONS.NO_ENCLOSURE);
  });
});

describe('every refusal is explainable', () => {
  it('carries a non-empty sentence for each reason code', () => {
    const cases = [
      [item({ enclosureUrl: null }), {}],
      [item({ enclosureType: 'video/mp4', supportedType: false }), {}],
      [item({ title: 'bonus' }), { excludeKeywords: ['bonus'] }],
      [item({ title: 'nope' }), { includeKeywords: ['interview'] }],
      [item({ declaredDurationSeconds: 1 }), { minDurationSeconds: 60 }],
      [item({ declaredDurationSeconds: 99999 }), { maxDurationSeconds: 60 }],
    ];
    const seen = new Set();
    for (const [candidate, rules] of cases) {
      const result = evaluateItem(candidate, rules);
      assert.equal(result.keep, false);
      seen.add(result.reason);
      assert.ok(result.detail.length > 10, `${result.reason} has no wording behind it`);
      assert.match(result.detail, /\.$/, `${result.reason} should read as a sentence`);
    }
    assert.deepEqual(
      [...seen].sort(),
      Object.values(REJECT_REASONS).sort(),
      'every reason code must be reachable, and every reachable refusal must have a code',
    );
  });
});
