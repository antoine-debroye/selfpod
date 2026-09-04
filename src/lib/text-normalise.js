/**
 * Making two transcriptions of the same words comparable (spec §19.6).
 *
 * A speech recogniser writes the same sentence differently on different days: an
 * accent dropped here, a comma there, "vingt" one day and "20" the next, an elision
 * split or not. None of that is a different advert. So before any words are compared
 * they are reduced to the form below, and *only* that form is ever compared — the words
 * as written are kept separately, for people to read.
 *
 * Deliberately crude. Lower-case ASCII letters and digits, nothing else. French loses
 * its accents, which is the point: the recogniser's commonest error in French is the
 * accent, and a normalisation that kept them would keep the errors too.
 */

/**
 * Number words, so a read that says "twenty percent off" one day and is transcribed
 * "20% off" the next still matches. Deliberately without the French articles `un` and
 * `une`: turning every "une décision" into "1 decision" would rewrite half the language
 * for the sake of the number one.
 */
const NUMBER_WORDS = new Map(
  Object.entries({
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
    eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
    fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
    nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60',
    seventy: '70', eighty: '80', ninety: '90', hundred: '100', thousand: '1000',
    deux: '2', trois: '3', quatre: '4', cinq: '5', sept: '7', huit: '8', neuf: '9',
    dix: '10', onze: '11', douze: '12', treize: '13', quatorze: '14', quinze: '15',
    seize: '16', vingt: '20', trente: '30', quarante: '40', cinquante: '50',
    soixante: '60', cent: '100', mille: '1000',
  }),
);

const SYMBOLS = [
  [/%/g, ' percent '],
  [/€/g, ' euros '],
  [/\$/g, ' dollars '],
  [/£/g, ' pounds '],
  [/&/g, ' and '],
];

/**
 * The comparable tokens of one written word — usually one, sometimes none ("...") and
 * sometimes several ("l'épisode" → `l`, `episode`; "vagan.fr" → `vagan`, `fr`).
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function normaliseWord(raw) {
  if (!raw) return [];
  let text = String(raw)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’`´]/g, "'");
  for (const [pattern, replacement] of SYMBOLS) text = text.replace(pattern, replacement);
  return text
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((token) => NUMBER_WORDS.get(token) ?? token);
}

/** The comparable tokens of a whole string, for phrases typed or selected by a person. */
export function normaliseText(text) {
  return String(text ?? '')
    .split(/\s+/)
    .flatMap((word) => normaliseWord(word));
}

/**
 * Timed words → timed tokens.
 *
 * Every token keeps the timing and confidence of the word it came from and the index
 * of that word, so a match found in tokens can be pointed back at the words a person
 * sees and at the milliseconds a cut is made from.
 *
 * @param {Array<{w: string, s: number, e: number, p?: number, window?: number}>} words
 * @returns {Array<{t: string, startMs: number, endMs: number, p: number, word: number, window: number}>}
 */
export function normaliseTokens(words) {
  const tokens = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    for (const t of normaliseWord(word.w)) {
      tokens.push({
        t,
        startMs: word.s,
        endMs: word.e,
        p: word.p ?? 1,
        word: index,
        window: word.window ?? 0,
      });
    }
  }
  return tokens;
}
