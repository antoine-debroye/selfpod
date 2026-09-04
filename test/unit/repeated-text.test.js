import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findRepeatedText, locatePhrase, tokenSimilarity } from '../../src/lib/repeated-text.js';
import { normaliseText, normaliseTokens } from '../../src/lib/text-normalise.js';

/** A transcript from prose, one word every 400 ms starting at `startMs`. */
function episode(id, parts, { wordMs = 400 } = {}) {
  const words = [];
  let at = 0;
  let window = 0;
  for (const part of parts) {
    if (part === '|') {
      window += 1;
      at += 60_000;
      continue;
    }
    for (const w of part.split(/\s+/).filter(Boolean)) {
      words.push({ w, s: at, e: at + wordMs - 50, p: 0.8, window });
      at += wordMs;
    }
  }
  return { id, tokens: normaliseTokens(words) };
}

const READ =
  'This episode is brought to you by Acme Storage. Go to acme dot com slash podcast and use code PODCAST for twenty percent off your first order. Terms and conditions apply.';
const READ_MISHEARD =
  'This episode is brought to you by Acme Storage. Go to acne dot com slash podcasts and use the code PODCAST for 20 percent of your first order. Terms and conditions apply.';
const READ_FR =
  'Chez SFR, on s’engage à équiper votre ado pour la rentrée. Avec le pack ado Smart, profitez du Samsung Galaxy à 199 euros au lieu de 449 euros avec un forfait 40 gigas sans engagement.';
const READ_FR_MISHEARD =
  'Chez SFR, on s’engage à équiper votre ado pour la rentrée. Avec le pack à dos smart, profitez du Samsung Galaxy A37 à 199 euros au lieu de 449 euros avec un forfait 40 giga sans engagement.';

describe('finding the words a show repeats', () => {
  it('finds a sponsor read shared by three episodes despite recognition errors', () => {
    const found = findRepeatedText([
      episode('a', ['Welcome back everybody, today we talk about pensions.', READ, 'So, pensions.']),
      episode('b', ['Hello and thanks for joining us on a rainy Tuesday.', READ_MISHEARD, 'Right then.']),
      episode('c', ['Good morning, a packed show today with three guests.', READ, 'First guest.']),
    ]);
    assert.equal(found.length, 1, JSON.stringify(found.map((f) => f.canonicalText)));
    const [segment] = found;
    assert.equal(segment.episodeCount, 3);
    assert.equal(segment.occurrenceCount, 3);
    assert.match(segment.canonicalText, /^this episode is brought to you by acme storage/);
    assert.match(segment.canonicalText, /terms and conditions apply$/);
    assert.match(segment.signature, /^tx:[0-9a-f]{24}$/);
    for (const occurrence of segment.occurrences) {
      assert.ok(occurrence.endMs - occurrence.startMs > 10_000, `${occurrence.episodeId} ${occurrence.endMs - occurrence.startMs}`);
      assert.ok(occurrence.similarity >= 0.8, `${occurrence.episodeId} similarity ${occurrence.similarity}`);
    }
    // Timing comes from the words: episode b's read starts after its ten-word intro.
    const b = segment.occurrences.find((occurrence) => occurrence.episodeId === 'b');
    assert.equal(b.startMs, 10 * 400);
  });

  it('finds a French read in two episodes', () => {
    const found = findRepeatedText([
      episode('a', ['Bonjour à tous, il est huit heures et quart, voici les titres.', READ_FR, 'Vous écoutez RMC.']),
      episode('b', ['Bonsoir, une soirée très chargée nous attend ce soir.', READ_FR_MISHEARD, 'Vous écoutez RMC.']),
    ]);
    assert.equal(found.length, 1, JSON.stringify(found.map((f) => f.canonicalText)));
    assert.match(found[0].canonicalText, /^chez sfr on s engage/);
    assert.equal(found[0].episodeCount, 2);
  });

  it('keeps two campaigns apart', () => {
    const found = findRepeatedText([
      episode('a', ['Some opening words about the weather and the news.', READ, 'Back after this.', READ_FR]),
      episode('b', ['Different opening words about a different day entirely.', READ_MISHEARD, 'And now, something else.', READ_FR_MISHEARD]),
    ]);
    assert.equal(found.length, 2, JSON.stringify(found.map((f) => f.canonicalText)));
    const texts = found.map((f) => f.canonicalText).sort();
    assert.match(texts[0], /^chez sfr/);
    assert.match(texts[1], /^this episode/);
  });

  it('ignores short catchphrases and finds nothing in unrelated talk', () => {
    const found = findRepeatedText([
      episode('a', ['Vous écoutez RMC, Apolline Matin. Alors ce matin nous parlons de la rentrée scolaire et des téléphones.']),
      episode('b', ['Vous écoutez RMC, Apolline Matin. Un tout autre sujet aujourd’hui avec le budget et les retraites.']),
      episode('c', ['Something in English about an entirely different programme with different words.']),
    ]);
    assert.deepEqual(found, []);
  });

  it('does not let a run cross from one window into another', () => {
    // The shared read straddles the head/tail boundary in episode a: the first half is
    // in the opening window, the second half in the closing one. They are minutes
    // apart in the audio, so they cannot be one cut.
    const half = READ.split(' ');
    const first = half.slice(0, 16).join(' ');
    const second = half.slice(16).join(' ');
    const found = findRepeatedText([
      episode('a', ['Intro words here for a bit.', first, '|', second, 'Outro words.']),
      episode('b', ['Other intro words entirely.', READ, 'Other outro.']),
    ]);
    for (const segment of found) {
      const a = segment.occurrences.find((occurrence) => occurrence.episodeId === 'a');
      if (!a) continue;
      assert.ok(a.endMs - a.startMs < 30_000, `a run spanned the windows: ${a.endMs - a.startMs} ms`);
    }
  });

  it('never offers ground that is already claimed, on either side of a match', () => {
    const shared = [
      episode('a', ['Intro one two three four five six seven eight.', READ, 'Vous écoutez RMC.', 'Programme talk here.']),
      episode('b', ['Different words open this one, nine ten eleven.', READ, 'Vous écoutez RMC.', 'Other programme talk.']),
    ];
    // The whole of episode b's read is spoken for (say, by a marker cut). Then it must
    // not be recruited as the first partner either.
    const bStart = 7;
    const bEnd = bStart + READ.split(' ').length + 3;
    const found = findRepeatedText(shared, { claimed: new Map([['b', [[bStart, bEnd]]]]) });
    assert.deepEqual(found, []);
  });

  it('is fast enough for a large show', () => {
    const vocabulary = Array.from({ length: 600 }, (_, k) => `w${k}`);
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const episodes = [];
    for (let e = 0; e < 50; e += 1) {
      const words = [];
      for (let w = 0; w < 2000; w += 1) {
        words.push({ w: vocabulary[Math.floor(random() * vocabulary.length)], s: w * 300, e: w * 300 + 250, window: w < 1000 ? 0 : 1 });
      }
      // Every episode opens with the same read.
      READ.split(' ').forEach((w, i) => (words[i + 5] = { ...words[i + 5], w }));
      episodes.push({ id: `e${e}`, tokens: normaliseTokens(words) });
    }
    const started = process.hrtime.bigint();
    const found = findRepeatedText(episodes);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 2000, `took ${ms} ms`);
    assert.equal(found.length, 1);
    assert.equal(found[0].episodeCount, 50);
  });
});

describe('finding known words again', () => {
  const jingle = normaliseTokens(
    'Vous vous écoutez ? RMC. RMC à Pauline Matin. C’est tous les jours Demanche.'
      .split(' ')
      .map((w, i) => ({ w, s: 30_320 + i * 300, e: 30_320 + i * 300 + 250 })),
  );

  it('finds a short marker past a doubled word, exactly where it was said', () => {
    // The recogniser wrote "Vous vous écoutez"; the marker is the second "vous" on.
    const hit = locatePhrase(jingle, normaliseText('Vous écoutez RMC'));
    assert.ok(hit, 'not found');
    assert.equal(hit.start, 1);
    assert.equal(hit.end, 3);
    assert.equal(hit.startMs, 30_320 + 300);
    assert.equal(hit.errors, 0);
  });

  it('tolerates a dropped word in a marker of three or more', () => {
    const hit = locatePhrase(jingle, normaliseText('Vous écoutez bien RMC'));
    assert.ok(hit, 'not found');
    assert.equal(hit.errors, 1);
    assert.equal(hit.end, 3);
  });

  it('returns the earliest occurrence', () => {
    const hit = locatePhrase(jingle, normaliseText('RMC'));
    assert.equal(hit.start, 3);
    assert.equal(hit.errors, 0);
  });

  it('finds a remembered read despite recognition errors, and refuses a different one', () => {
    const transcript = normaliseTokens(
      ['Bonjour à tous.', READ_FR_MISHEARD, 'Vous écoutez RMC.'].join(' ').split(' ').map((w, i) => ({ w, s: i * 300, e: i * 300 + 250 })),
    );
    const hit = locatePhrase(transcript, normaliseText(READ_FR));
    assert.ok(hit, 'not found');
    assert.ok(hit.similarity >= 0.75, `similarity ${hit.similarity}`);
    assert.equal(hit.start, 3);
    assert.equal(locatePhrase(transcript, normaliseText(READ)), null);
  });

  it('measures how alike two transcriptions are', () => {
    assert.ok(tokenSimilarity(normaliseText(READ), normaliseText(READ_MISHEARD)) >= 0.8);
    assert.ok(tokenSimilarity(normaliseText(READ), normaliseText(READ_FR)) < 0.3);
    assert.equal(tokenSimilarity([], []), 1);
  });
});
