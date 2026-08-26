import { formatDuration } from './dates.js';

/**
 * Deciding which items of a remote feed SelfPod should take (spec §18.2).
 *
 * Pure on purpose: no clock, no database, no I/O. "Have we seen this already?" and
 * "is it older than the backfill horizon?" are facts about the ledger, not about the
 * item, and they live in the poller. Keeping them out means every rule in here can be
 * tested against a literal object, which matters because these rules are the part of
 * the feature the user will actually tune.
 *
 * Every refusal carries the sentence shown in the UI. That is the whole point of the
 * ledger — "why is that episode not in my feed?" has to be answerable — so a reason
 * code with no wording behind it is not finished work.
 */

export const REJECT_REASONS = Object.freeze({
  NO_ENCLOSURE: 'no_enclosure',
  UNSUPPORTED_TYPE: 'unsupported_type',
  EXCLUDED_KEYWORD: 'excluded_keyword',
  NO_KEYWORD_MATCH: 'no_keyword_match',
  TOO_SHORT: 'too_short',
  TOO_LONG: 'too_long',
});

/** Bounds on a keyword list, so one paste of a novel cannot become a rule. */
export const MAX_KEYWORDS = 50;
export const MAX_KEYWORD_LENGTH = 100;

/**
 * Folds a string to the form keywords are compared in: lowercase, no accents.
 *
 * Accent folding is a deliberate choice, not an accident of using NFD. Someone typing
 * `cafe` into a filter means to catch "Café Society", and a podcast title is as likely
 * to be typed with the accent as without. The cost is that a rule cannot distinguish
 * two words that differ only by a diacritic, which is a trade worth making for a
 * personal keyword filter and would not be for, say, a search index.
 *
 * NFC first so that a title which arrives decomposed and one that arrives composed
 * fold to the same thing — SMB shares and RSS feeds disagree about this routinely.
 */
export function fold(value) {
  return String(value ?? '')
    .normalize('NFC')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Turns whatever the form submitted into the stored keyword list.
 *
 * Accepts an array or a comma/newline separated string, because the JSON API and the
 * HTML form will hand over different things and neither should have to care. The
 * result is already folded, so the matcher never normalises at match time and what is
 * stored is exactly what is compared — which is also what lets the UI show the user
 * the rule that actually ran.
 */
export function normaliseKeywords(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,\n]/);
  const seen = new Set();
  for (const entry of raw) {
    const keyword = fold(entry).slice(0, MAX_KEYWORD_LENGTH).trim();
    if (!keyword) continue;
    seen.add(keyword);
    if (seen.size >= MAX_KEYWORDS) break;
  }
  return [...seen];
}

function describeBound(seconds) {
  return formatDuration(seconds) ?? `${seconds}s`;
}

/**
 * Decides one normalised feed item against one subscription's rules.
 *
 * @param {object} item   the shape lib/rss-parse.js produces
 * @param {object} rules  { includeKeywords, excludeKeywords, minDurationSeconds, maxDurationSeconds }
 * @returns {{
 *   keep: boolean,
 *   reason: string|null,          // a REJECT_REASONS value
 *   detail: string,               // one sentence, shown to the user verbatim
 *   matchedKeyword: string|null,  // which positive keyword let it through
 *   durationCheck: 'declared'|'deferred'|'none',
 * }}
 */
export function evaluateItem(item, rules = {}) {
  const includeKeywords = rules.includeKeywords ?? [];
  const excludeKeywords = rules.excludeKeywords ?? [];
  const min = numericBound(rules.minDurationSeconds);
  const max = numericBound(rules.maxDurationSeconds);

  if (!item?.enclosureUrl) {
    return reject(
      REJECT_REASONS.NO_ENCLOSURE,
      'That item has no audio file attached, so there is nothing to download.',
    );
  }

  // Advisory only. The authoritative extension decision is made against the response's
  // own Content-Type at download time; this just avoids spending a request on an item
  // the feed itself already says is a video or a PDF.
  if (item.enclosureType && item.supportedType === false) {
    return reject(
      REJECT_REASONS.UNSUPPORTED_TYPE,
      `That item's audio is "${item.enclosureType}", which SelfPod doesn't serve.`,
    );
  }

  const title = fold(item.title);

  // Negatives first, and negatives win. A title matching both an include and an
  // exclude keyword is excluded — anything else would make "never give me bonus
  // episodes" conditional on how the rest of the rule happened to be written.
  const excluded = excludeKeywords.find((keyword) => title.includes(keyword));
  if (excluded) {
    return reject(
      REJECT_REASONS.EXCLUDED_KEYWORD,
      `Skipped because the title contains \`${excluded}\`.`,
    );
  }

  // An empty include list is "no positive requirement", not "match nothing".
  let matchedKeyword = null;
  if (includeKeywords.length) {
    matchedKeyword = includeKeywords.find((keyword) => title.includes(keyword)) ?? null;
    if (!matchedKeyword) {
      const list = includeKeywords.map((keyword) => `\`${keyword}\``).join(', ');
      return reject(
        REJECT_REASONS.NO_KEYWORD_MATCH,
        `Skipped because the title contains none of: ${list}.`,
      );
    }
  }

  if (min === null && max === null) {
    return { keep: true, reason: null, detail: '', matchedKeyword, durationCheck: 'none' };
  }

  const declared = numericBound(item.declaredDurationSeconds);
  if (declared === null) {
    // The feed did not say how long it is. Rather than guess, take the file and
    // measure it — the check runs again on the staged bytes before anything is moved
    // into the show folder, so a reject costs a download but never an episode.
    return {
      keep: true,
      reason: null,
      detail: "That feed doesn't state a length, so SelfPod will download it and check.",
      matchedKeyword,
      durationCheck: 'deferred',
    };
  }

  const outcome = checkDuration(declared, min, max);
  if (outcome) return { ...outcome, matchedKeyword, durationCheck: 'declared' };

  return { keep: true, reason: null, detail: '', matchedKeyword, durationCheck: 'declared' };
}

/**
 * The duration rule on its own, so the poller can run it a second time against the
 * length actually measured from the downloaded file. One rule, one implementation —
 * the alternative is two copies that drift, and then an episode that passed the feed's
 * claim and fails the file's for reasons nobody can reconstruct.
 */
export function checkDuration(seconds, minDurationSeconds, maxDurationSeconds) {
  const min = numericBound(minDurationSeconds);
  const max = numericBound(maxDurationSeconds);
  const length = numericBound(seconds);
  if (length === null) return null;

  // Bounds are inclusive: "at least 20 minutes" keeps an episode of exactly 20:00.
  if (min !== null && length < min) {
    return {
      keep: false,
      reason: REJECT_REASONS.TOO_SHORT,
      detail: `Skipped because it runs ${describeBound(length)}, under the ${describeBound(min)} minimum.`,
    };
  }
  if (max !== null && length > max) {
    return {
      keep: false,
      reason: REJECT_REASONS.TOO_LONG,
      detail: `Skipped because it runs ${describeBound(length)}, over the ${describeBound(max)} maximum.`,
    };
  }
  return null;
}

function reject(reason, detail) {
  return { keep: false, reason, detail, matchedKeyword: null, durationCheck: 'none' };
}

function numericBound(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}
