import { normaliseText } from './text-normalise.js';

/**
 * Whether a stretch of words sounds like a sponsor read (spec §19.6).
 *
 * A short, readable list of things adverts say and programmes mostly do not: who paid,
 * where to go, what code to use, and the phrases the law makes an advertiser say. Each
 * cue has a weight, and the score is their sum against a ceiling, so the page can name
 * exactly which cues fired — "it says 'brought to you by' and gives a promo code" —
 * rather than report a number nobody can argue with.
 *
 * No language model, no classifier. The owner's decision is the classifier; this only
 * decides how much SelfPod is willing to do before asking. Two thresholds are read from
 * it: `CUE_STRONG` (one strong cue, or a web address) lifts the theme-tune guard from a
 * stretch that also repeats across episodes, and `CUE_OFFER_ALONE` (roughly two) is
 * enough to offer a stretch heard once — never to cut it.
 *
 * Every phrase is written in normalised form (see text-normalise.js): no accents, no
 * apostrophes, `dot com` and `point fr` as words because that is how they are spoken.
 */

const STRONG = 3;
const MEDIUM = 2;
const WEAK = 1;

/** [phrase, weight]. Matched as a run of tokens allowing one extra token between any two. */
const PHRASES = [
  // English — who paid
  ['brought to you by', STRONG], ['sponsored by', STRONG], ['sponsor of this', STRONG],
  ['this episode is sponsored', STRONG], ['is supported by', STRONG], ['supported by', MEDIUM],
  ['paid partnership', STRONG], ['our sponsors', MEDIUM], ['our sponsor', MEDIUM],
  ['todays sponsor', MEDIUM], ['today s sponsor', MEDIUM], ['thanks to our', WEAK], ['sponsor', WEAK],
  // English — the offer
  ['promo code', STRONG], ['use code', STRONG], ['use the code', STRONG], ['discount code', STRONG],
  ['offer code', STRONG], ['coupon code', STRONG], ['percent off', STRONG], ['free trial', STRONG],
  ['money back guarantee', STRONG], ['for a limited time', STRONG], ['limited time offer', STRONG],
  ['terms apply', STRONG], ['terms and conditions apply', STRONG], ['exclusions apply', STRONG],
  ['ad free', STRONG], ['sign up today', STRONG], ['download the app', STRONG],
  ['free shipping', MEDIUM], ['available now', WEAK], ['offer', WEAK], ['deal', WEAK], ['save', WEAK],
  ['free', WEAK], ['subscribe', WEAK],
  // English — where to go
  ['dot com slash', STRONG], ['dot co slash', STRONG], ['dot com', MEDIUM], ['dot co', MEDIUM],
  ['dot org', MEDIUM], ['dot net', MEDIUM], ['slash', MEDIUM], ['link in the show notes', MEDIUM],
  ['head to', WEAK], ['go to', WEAK], ['visit', WEAK], ['check out', WEAK],

  // French — who paid
  ['sponsorise par', STRONG], ['en partenariat avec', STRONG], ['vous est presente par', STRONG],
  ['vous est presentee par', STRONG], ['presente par', MEDIUM], ['nos partenaires', MEDIUM],
  ['notre partenaire', MEDIUM], ['publicite', MEDIUM], ['annonceur', MEDIUM], ['partenaire', WEAK],
  ['grace a', WEAK],
  // French — the offer
  ['code promo', STRONG], ['avec le code', STRONG], ['utilisez le code', STRONG],
  ['sans engagement', STRONG], ['premier mois offert', STRONG], ['premier mois gratuit', STRONG],
  ['jours d essai', STRONG], ['livraison offerte', STRONG], ['de reduction', STRONG],
  ['offre speciale', MEDIUM], ['au lieu de', MEDIUM], ['a partir de', MEDIUM], ['par mois', MEDIUM],
  ['premier loyer', MEDIUM], ['acceptation par', MEDIUM], ['rembourse', MEDIUM], ['rembourses', MEDIUM],
  ['remboursee', MEDIUM], ['gratuitement', MEDIUM], ['valable', MEDIUM],
  ['jusqu au', WEAK], ['offert', WEAK], ['offerte', WEAK], ['gratuit', WEAK], ['reduction', WEAK],
  ['offre', WEAK], ['on s engage', MEDIUM],
  // French — the small print the law requires, which only an advert ever says
  ['soumise a condition', STRONG], ['soumise a conditions', STRONG], ['soumis a condition', STRONG],
  ['soumis a conditions', STRONG], ['sous condition', STRONG], ['sous conditions', STRONG],
  ['voir conditions', STRONG], ['conditions sur', STRONG], ['condition sur', STRONG],
  ['pensez a covoiturer', STRONG], ['l abus d alcool', STRONG], ['manger bouger', STRONG],
  ['pour votre sante', STRONG], ['appel gratuit', STRONG], ['service appel gratuit', STRONG],
  ['appel non surtaxe', STRONG],
  // French — where to go
  ['rendez vous sur', STRONG], ['point com slash', STRONG], ['point fr slash', STRONG],
  ['point com', MEDIUM], ['point fr', MEDIUM], ['telechargez l application', STRONG],
  ['telechargez l appli', STRONG], ['appelez le', WEAK],
].map(([phrase, weight]) => ({ id: phrase.replace(/\s+/g, '_'), phrase, tokens: normaliseText(phrase), weight }));

// Longest phrases first, so "dot com slash" is credited before "dot com" and the two
// are not both counted for one utterance.
PHRASES.sort((a, b) => b.tokens.length - a.tokens.length);

/**
 * Patterns over the words as written, for the things normalisation destroys: a web
 * address, a price, a phone number.
 */
const RAW_PATTERNS = [
  {
    id: 'web_address',
    weight: STRONG,
    pattern: /\b[a-z0-9-]{2,}\.(?:com|fr|co|io|org|net|app|be|ch|uk|de|es|it|nl|eu|tv)\b/i,
  },
  { id: 'price', weight: MEDIUM, pattern: /\d[\d\s.,]*\s?(?:%|€|\$|£|euros?|dollars?|pounds?)\b/i },
  { id: 'phone_number', weight: MEDIUM, pattern: /\b0\d(?:[ .-]?\d{2}){4}\b|\b\d{3}[ -]\d{3}[ -]\d{4}\b|\b(?:appelez|call)\s+(?:le\s+)?\d{3,5}\b/i },
];

/** The most a run of cues can add up to; anything above is simply "1". */
const CEILING = 6;

/**
 * Does `tokens` contain `phrase` starting at `at`, allowing one extra token between
 * any two of the phrase's tokens? Returns the index after the match, or -1.
 */
function matchPhraseAt(tokens, at, phrase) {
  let position = at;
  for (let k = 0; k < phrase.length; k += 1) {
    if (position >= tokens.length) return -1;
    if (tokens[position].t === phrase[k]) {
      position += 1;
      continue;
    }
    // One skipped token, but never at the start and never two in a row.
    if (k > 0 && position + 1 < tokens.length && tokens[position + 1].t === phrase[k]) {
      position += 2;
      continue;
    }
    return -1;
  }
  return position;
}

/**
 * @param {Array<{t: string, word?: number}>} tokens normalised tokens
 * @param {{rawText?: string}} [options] the words as written, for the raw patterns
 * @returns {{score: number, raw: number, cues: Array<{id: string, phrase: string, weight: number, at: number|null}>}}
 */
export function scoreAdvertCues(tokens, { rawText = '' } = {}) {
  const cues = [];
  const seen = new Set();
  const taken = new Uint8Array(tokens.length);

  for (const cue of PHRASES) {
    if (seen.has(cue.id)) continue;
    for (let i = 0; i < tokens.length; i += 1) {
      if (taken[i] || tokens[i].t !== cue.tokens[0]) continue;
      const end = matchPhraseAt(tokens, i, cue.tokens);
      if (end < 0) continue;
      for (let k = i; k < end; k += 1) taken[k] = 1;
      seen.add(cue.id);
      cues.push({ id: cue.id, phrase: cue.phrase, weight: cue.weight, at: tokens[i].word ?? i });
      break;
    }
  }

  for (const cue of RAW_PATTERNS) {
    const match = cue.pattern.exec(rawText);
    if (!match) continue;
    cues.push({ id: cue.id, phrase: match[0].trim(), weight: cue.weight, at: null });
  }

  const raw = cues.reduce((sum, cue) => sum + cue.weight, 0);
  return { score: Math.min(1, raw / CEILING), raw, cues };
}

/** Human wording for a list of cues: `it says "brought to you by" and gives a web address`. */
export function describeCues(cues) {
  const parts = [];
  // Heaviest first; a web address beats a phrase of the same weight because it names
  // the advertiser, which is the thing a person recognises fastest.
  const ordered = cues
    .slice()
    .sort((a, b) => b.weight - a.weight || (b.id === 'web_address') - (a.id === 'web_address'));
  for (const cue of ordered.slice(0, 3)) {
    if (cue.id === 'web_address') parts.push(`gives a web address (${cue.phrase})`);
    else if (cue.id === 'price') parts.push('quotes a price');
    else if (cue.id === 'phone_number') parts.push('gives a phone number');
    else parts.push(`says “${cue.phrase}”`);
  }
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
