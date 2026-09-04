import { normaliseWord } from './text-normalise.js';

/**
 * Turning whisper's output into words a person can read and a matcher can use
 * (spec §19.6).
 *
 * whisper-cli's full JSON is a list of segments, each a list of *pieces* — sub-word
 * tokens with their own timing and confidence, where a piece beginning with a space
 * begins a word and anything else continues the one before it. Words are rebuilt here,
 * once, and everything downstream sees words.
 */

/** whisper's own tokens — `[_BEG_]`, `[_TT_94]` — carry no words. */
function isSpecial(piece) {
  return piece.text.startsWith('[') && piece.text.endsWith(']');
}

/**
 * @param {object} json the parsed `--output-json-full` file
 * @param {{offsetMs?: number, window?: number}} [options] added to every timing, so a
 *   window transcribed on its own lands at its place in the episode
 * @returns {{language: string|null, sentences: Array<{startMs: number, endMs: number, text: string, words: Array<{w: string, s: number, e: number, p: number, window: number}>}>}}
 */
export function wordsFromWhisper(json, { offsetMs = 0, window = 0 } = {}) {
  const language = json?.result?.language ?? null;
  const sentences = [];
  for (const segment of json?.transcription ?? []) {
    const words = [];
    let current = null;
    for (const piece of segment.tokens ?? []) {
      if (isSpecial(piece)) continue;
      const text = piece.text ?? '';
      const startsWord = text.startsWith(' ') || current === null;
      const from = (piece.offsets?.from ?? 0) + offsetMs;
      const to = (piece.offsets?.to ?? from) + offsetMs;
      if (startsWord) {
        if (current) words.push(current);
        current = { w: text.trim(), s: from, e: to, p: [piece.p ?? 1], window };
      } else {
        current.w += text;
        current.e = Math.max(current.e, to);
        current.p.push(piece.p ?? 1);
      }
    }
    if (current) words.push(current);

    const kept = [];
    for (const word of words) {
      // A stray "." or "…" is not a word; attach it to the previous one for reading.
      if (!/[\p{L}\p{N}]/u.test(word.w)) {
        if (kept.length) kept[kept.length - 1].w += word.w;
        continue;
      }
      kept.push({
        w: word.w,
        s: word.s,
        e: Math.max(word.e, word.s),
        p: Math.round((word.p.reduce((a, b) => a + b, 0) / word.p.length) * 100) / 100,
        window,
      });
    }
    if (!kept.length) continue;
    sentences.push({
      startMs: (segment.offsets?.from ?? kept[0].s - offsetMs) + offsetMs,
      endMs: (segment.offsets?.to ?? kept[kept.length - 1].e - offsetMs) + offsetMs,
      text: (segment.text ?? kept.map((word) => word.w).join(' ')).trim(),
      words: kept,
    });
  }
  return { language, sentences };
}

/**
 * Strings whisper writes when it hears music, silence or applause. They are the same
 * every time, so across a show's episodes they look exactly like a campaign — and the
 * French one even contains a web address.
 */
const HALLUCINATIONS = new Set(
  [
    'sous titres realises par la communaute d amara org',
    'sous titres realises para la communaute d amara org',
    'sous titrage st 501',
    'sous titrage societe radio canada',
    'merci d avoir regarde cette video',
    'merci d avoir regarde',
    'abonnez vous',
    'thank you for watching',
    'thanks for watching',
    'thank you',
    'subtitles by the amara org community',
    'subscribe to my channel',
    'you',
    'bye',
    'music',
    'musique',
    'free',
  ].map((text) => text),
);

/** How many identical words in a row is a loop rather than a sentence. */
const LOOP_WORDS = 4;
/** How many identical sentences in a row is a loop. */
const LOOP_SENTENCES = 3;

function key(words) {
  return words.flatMap((word) => normaliseWord(word.w)).join(' ');
}

/**
 * Drops what the recogniser made up.
 *
 * Three shapes: a known string it writes over music; a word repeated many times in a
 * row ("pousse pousse pousse pousse…"), which is the decoder stuck; and the same
 * sentence repeated across several segments, which is the same fault at a larger
 * scale. A loop is cut to its first occurrence rather than dropped outright, because
 * the first occurrence was usually really said.
 */
export function filterHallucinations(sentences) {
  const out = [];
  let previousKey = null;
  let repeats = 0;
  for (const sentence of sentences) {
    const words = [];
    let run = 0;
    let runKey = null;
    for (const word of sentence.words) {
      const k = normaliseWord(word.w).join(' ');
      if (k && k === runKey) {
        run += 1;
        if (run >= LOOP_WORDS) continue;
      } else {
        run = 1;
        runKey = k;
      }
      words.push(word);
    }
    if (!words.length) continue;

    const k = key(words);
    if (HALLUCINATIONS.has(k)) continue;

    if (k === previousKey) {
      repeats += 1;
      if (repeats >= LOOP_SENTENCES) continue;
    } else {
      repeats = 1;
      previousKey = k;
    }
    out.push({ ...sentence, words, looped: words.length !== sentence.words.length });
  }
  return out;
}

/** Every word of every sentence, in order. */
export function flattenWords(sentences) {
  return sentences.flatMap((sentence) => sentence.words);
}

/** The words as written, joined for reading. */
export function rawTextOf(words) {
  return words.map((word) => word.w).join(' ');
}

/** Mean confidence of a run of words, 0..1. */
export function meanConfidence(words) {
  if (!words.length) return 0;
  return words.reduce((sum, word) => sum + (word.p ?? 1), 0) / words.length;
}
