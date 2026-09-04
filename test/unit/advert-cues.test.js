import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CUE_OFFER_ALONE, CUE_STRONG } from '../../src/constants.js';
import { describeCues, scoreAdvertCues } from '../../src/lib/advert-cues.js';
import { normaliseTokens } from '../../src/lib/text-normalise.js';

function score(text) {
  const words = text.split(/\s+/).map((w, i) => ({ w, s: i * 300, e: i * 300 + 250 }));
  return scoreAdvertCues(normaliseTokens(words), { rawText: text });
}

describe('sponsor cues in English', () => {
  it('scores a classic host read as an advert on its own', () => {
    const result = score(
      'This episode is brought to you by Acme. Go to acme.com slash podcast and use code PODCAST for twenty percent off. Terms apply.',
    );
    const ids = result.cues.map((cue) => cue.id);
    assert.ok(ids.includes('brought_to_you_by'), ids.join());
    assert.ok(ids.includes('use_code'));
    assert.ok(ids.includes('web_address'));
    assert.ok(ids.includes('percent_off'));
    assert.ok(result.score >= CUE_OFFER_ALONE, `score ${result.score}`);
  });

  it('does not mistake a news item that mentions a website for an advert', () => {
    const result = score(
      'The company said on its website that the outage began at nine and that customers should check back later.',
    );
    assert.ok(result.score < CUE_STRONG, `score ${result.score}: ${result.cues.map((c) => c.id)}`);
  });

  it('does not mistake thanking listeners for thanking a sponsor', () => {
    const result = score('Thanks to everyone who wrote in this week, we read every single one, it was a great deal of fun.');
    assert.ok(result.score < CUE_STRONG, `score ${result.score}`);
  });

  it('allows one word between the words of a phrase', () => {
    const result = score('This show is proudly brought to you today by Acme');
    // "brought to you by" with "today" inside is still the phrase.
    assert.ok(result.cues.some((cue) => cue.id === 'brought_to_you_by'));
  });
});

describe('sponsor cues in French', () => {
  it('scores the small print the law requires', () => {
    const result = score(
      'Avec le pack ado Smart, profitez du Samsung Galaxy à 199 euros au lieu de 449 euros avec un forfait 40 gigas sans engagement. Appelez le 1090, service appel gratuit. Offre soumise à condition jusqu’au 14 septembre.',
    );
    const ids = result.cues.map((cue) => cue.id);
    assert.ok(ids.includes('sans_engagement'), ids.join());
    assert.ok(ids.includes('service_appel_gratuit'));
    assert.ok(ids.includes('soumise_a_condition'));
    assert.ok(ids.includes('au_lieu_de'));
    assert.ok(ids.includes('price'));
    assert.ok(result.score >= CUE_OFFER_ALONE);
  });

  it('recognises a car advert even through recognition errors', () => {
    // What whisper actually wrote for a Volkswagen read: "volkswagen.fr" became
    // "Valle Vagan.fr" and "pensez à covoiturer" was lost, but the price and the
    // address survive.
    const result = score(
      'Pendant les instants Volkswagen, le nouveau tireau qui est à partir de 2.30 euros par mois. premier loyer les 4 000 euros, puis 30 s’il oillait de 239 euros, si acceptation par Volkswagen Bank. en condition sur Valle Vagan.fr, pensé à que vous aurez.',
    );
    const ids = result.cues.map((cue) => cue.id);
    assert.ok(ids.includes('web_address'), ids.join());
    assert.ok(ids.includes('a_partir_de'));
    assert.ok(result.score >= CUE_OFFER_ALONE, `score ${result.score}`);
  });

  it('does not hear an advert in the programme', () => {
    const result = score(
      'Et bonjour Apolline, bonjour à tous les amis, comme vous êtes beaux ce matin. Allez, parlons sport, on va parler de Lionel Messi.',
    );
    assert.ok(result.score < CUE_STRONG, `score ${result.score}: ${result.cues.map((c) => c.id)}`);
  });

  it('does not hear an advert in a jingle', () => {
    const result = score('Vous écoutez RMC. RMC, Apolline Matin.');
    assert.equal(result.raw, 0);
  });

  it('gives money talk in the programme only a little weight', () => {
    const result = score("Il a gagné 4 000 euros au loto et il a tout dépensé en un mois, c'est fou.");
    assert.ok(result.score < CUE_STRONG, `score ${result.score}: ${result.cues.map((c) => c.id)}`);
  });
});

describe('describing cues', () => {
  it('names the strongest cues in plain words', () => {
    const result = score('brought to you by Acme, go to acme.com, use code SHOW, twenty percent off');
    const sentence = describeCues(result.cues);
    assert.match(sentence, /says “brought to you by”/);
    assert.match(sentence, /web address/);
  });
});
