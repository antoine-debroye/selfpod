import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normaliseText, normaliseTokens, normaliseWord } from '../../src/lib/text-normalise.js';

describe('normalising words', () => {
  it('drops accents, case and punctuation', () => {
    assert.deepEqual(normaliseWord('Écoutez,'), ['ecoutez']);
    assert.deepEqual(normaliseWord('RMC.'), ['rmc']);
    assert.deepEqual(normaliseWord('réussite'), ['reussite']);
  });

  it('splits elisions and web addresses into their parts', () => {
    assert.deepEqual(normaliseWord("l'épisode"), ['l', 'episode']);
    assert.deepEqual(normaliseWord('l’application'), ['l', 'application']);
    assert.deepEqual(normaliseWord('Vagan.fr,'), ['vagan', 'fr']);
    assert.deepEqual(normaliseWord('rendez-vous'), ['rendez', 'vous']);
  });

  it('spells symbols and number words the same way', () => {
    assert.deepEqual(normaliseText('20% off'), ['20', 'percent', 'off']);
    assert.deepEqual(normaliseText('twenty percent off'), ['20', 'percent', 'off']);
    assert.deepEqual(normaliseText('239 € par mois'), ['239', 'euros', 'par', 'mois']);
    assert.deepEqual(normaliseText('vingt euros'), ['20', 'euros']);
    // The French article is not the number one.
    assert.deepEqual(normaliseText('une décision'), ['une', 'decision']);
  });

  it('yields nothing for pure punctuation', () => {
    assert.deepEqual(normaliseWord('…'), []);
    assert.deepEqual(normaliseWord('–'), []);
  });
});

describe('normalising timed words', () => {
  it('keeps timing, confidence and the word index on every token', () => {
    const tokens = normaliseTokens([
      { w: 'Vous', s: 0, e: 200, p: 0.9 },
      { w: "l'écoutez", s: 200, e: 700, p: 0.5, window: 1 },
    ]);
    assert.deepEqual(tokens, [
      { t: 'vous', startMs: 0, endMs: 200, p: 0.9, word: 0, window: 0 },
      { t: 'l', startMs: 200, endMs: 700, p: 0.5, word: 1, window: 1 },
      { t: 'ecoutez', startMs: 200, endMs: 700, p: 0.5, word: 1, window: 1 },
    ]);
  });
});
