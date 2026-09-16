import { scoreAdvertCues } from './advert-cues.js';

/**
 * Stretches of one episode that sound like a sponsor read (spec §19.6).
 *
 * Pure: an episode's sentences and tokens in, candidate blocks out. It used to be the
 * fourth stage of detection and wrote a row for every block it found — one per episode,
 * each asking to be decided, none ever cut on its own. That was most of what made the
 * Adverts page noisy. Now the blocks are worked out when the episode's words are shown,
 * highlighted there, and taught from there; nothing is stored until the owner says so.
 *
 * A block starts at a sentence with any cue, runs while cues keep arriving, and ends
 * after three quiet sentences, a gap of more than six seconds, two minutes of length or
 * a change of listening window. It is kept only if the cues add up (`raw >= 4`) over at
 * least ten seconds — and it ends at the last sentence that sounded like an advert, since
 * the quiet ones after it were only ever kept in case another cue came along.
 *
 * @param {{sentences: Array, tokens: Array, tokenRange: Map}} entry
 * @param {{isClaimed?: (tokenStart: number, tokenEnd: number) => boolean}} options
 */
export function findSponsorBlocks(entry, { isClaimed = () => false } = {}) {
  let block = null;
  const blocks = [];
  const flush = () => {
    if (block && block.raw >= 4 && block.cueEndMs - block.startMs >= 10_000) {
      blocks.push({ startMs: block.startMs, endMs: block.cueEndMs, tokenStart: block.tokenStart, tokenEnd: block.cueTokenEnd });
    }
    block = null;
  };
  for (const sentence of entry.sentences) {
    const [tokenStart] = entry.tokenRange.get(sentence.wordStart) ?? [];
    const tokenEnd = entry.tokenRange.get(sentence.wordEnd)?.[1];
    if (tokenStart === undefined || tokenEnd === undefined) continue;
    if (isClaimed(tokenStart, tokenEnd)) {
      flush();
      continue;
    }
    const scored = scoreAdvertCues(entry.tokens.slice(tokenStart, tokenEnd + 1), { rawText: sentence.text });
    if (block && (sentence.startMs - block.endMs > 6000 || sentence.endMs - block.startMs > 120_000 || sentence.window !== block.window)) flush();
    if (!block) {
      if (!scored.raw) continue;
      block = {
        startMs: sentence.startMs, endMs: sentence.endMs, tokenStart, tokenEnd,
        cueEndMs: sentence.endMs, cueTokenEnd: tokenEnd, raw: 0, quiet: 0, window: sentence.window,
      };
    }
    block.endMs = sentence.endMs;
    block.tokenEnd = tokenEnd;
    if (scored.raw) {
      block.raw += scored.raw;
      block.quiet = 0;
      block.cueEndMs = sentence.endMs;
      block.cueTokenEnd = tokenEnd;
    } else {
      block.quiet += 1;
      if (block.quiet >= 3) flush();
    }
  }
  flush();
  return blocks;
}
