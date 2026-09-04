import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { filterHallucinations, flattenWords, wordsFromWhisper } from '../../src/lib/transcript.js';

function piece(text, from, to, p = 0.9) {
  return { text, offsets: { from, to }, p, t_dtw: -1 };
}

describe('rebuilding words from whisper pieces', () => {
  it('joins pieces into words, keeps punctuation with the word and drops special tokens', () => {
    const json = {
      result: { language: 'fr' },
      transcription: [
        {
          offsets: { from: 27800, to: 30320 },
          text: ' en condition sur Valle Vagan.fr,',
          tokens: [
            piece('[_BEG_]', 27800, 27800, 1),
            piece(' en', 27890, 27890, 0.19),
            piece(' condition', 27900, 28230, 0.73),
            piece(' sur', 28330, 28460, 0.78),
            piece(' V', 28460, 28500, 0.28),
            piece('alle', 28500, 28690, 0.75),
            piece(' V', 28690, 28690, 0.56),
            piece('agan', 28730, 28920, 0.33),
            piece('.', 28920, 29060, 0.54),
            piece('fr', 29060, 29150, 0.87),
            piece(',', 29150, 29240, 0.75),
            piece('[_TT_126]', 30320, 30320, 0.07),
          ],
        },
      ],
    };
    const { language, sentences } = wordsFromWhisper(json);
    assert.equal(language, 'fr');
    assert.equal(sentences.length, 1);
    assert.deepEqual(
      sentences[0].words.map((word) => word.w),
      ['en', 'condition', 'sur', 'Valle', 'Vagan.fr,'],
    );
    const address = sentences[0].words[4];
    assert.equal(address.s, 28690);
    assert.equal(address.e, 29240);
    assert.ok(address.p > 0.5 && address.p < 0.7, `mean confidence ${address.p}`);
  });

  it('offsets every timing into the episode when a window was transcribed on its own', () => {
    const json = {
      transcription: [
        { offsets: { from: 0, to: 1000 }, text: ' Hello there', tokens: [piece(' Hello', 0, 400), piece(' there', 500, 1000)] },
      ],
    };
    const { sentences } = wordsFromWhisper(json, { offsetMs: 60000, window: 1 });
    assert.equal(sentences[0].startMs, 60000);
    assert.equal(sentences[0].words[1].s, 60500);
    assert.equal(sentences[0].words[1].window, 1);
  });

  it('attaches a lone punctuation piece to the previous word rather than making a word of it', () => {
    const json = {
      transcription: [
        { offsets: { from: 0, to: 900 }, text: ' Oui ...', tokens: [piece(' Oui', 0, 300), piece(' ...', 400, 900)] },
      ],
    };
    const { sentences } = wordsFromWhisper(json);
    assert.deepEqual(sentences[0].words.map((word) => word.w), ['Oui...']);
  });
});

describe('filtering what the recogniser made up', () => {
  const word = (w, s) => ({ w, s, e: s + 200, p: 0.5, window: 0 });
  const sentence = (text, s) => ({
    startMs: s,
    endMs: s + 1000,
    text,
    words: text.split(' ').map((w, i) => word(w, s + i * 100)),
  });

  it('cuts a stuck word down to its first occurrence', () => {
    const [kept] = filterHallucinations([sentence('je pousse pousse pousse pousse pousse pousse fin', 0)]);
    assert.deepEqual(kept.words.map((w) => w.w), ['je', 'pousse', 'pousse', 'pousse', 'fin']);
    assert.equal(kept.looped, true);
  });

  it('drops the strings whisper writes over music', () => {
    const kept = filterHallucinations([
      sentence('Sous-titres réalisés par la communauté d’Amara.org', 0),
      sentence('Thanks for watching!', 2000),
      sentence('Vous écoutez RMC', 4000),
    ]);
    assert.deepEqual(kept.map((s) => s.text), ['Vous écoutez RMC']);
  });

  it('keeps a sentence repeated twice and drops it from the third time on', () => {
    const kept = filterHallucinations([
      sentence('C’est qui, elle va le dire', 0),
      sentence('C’est qui, elle va le dire', 1000),
      sentence('C’est qui, elle va le dire', 2000),
      sentence('C’est qui, elle va le dire', 3000),
      sentence('Alors, dans cette primaire', 4000),
    ]);
    assert.equal(kept.length, 3);
    assert.equal(flattenWords(kept).length, 6 * 2 + 4);
  });
});
