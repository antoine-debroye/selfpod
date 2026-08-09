/**
 * Apple Podcasts category taxonomy — single source of truth.
 *
 * Used by BOTH:
 *   - the web UI, to populate the linked category / subcategory <select> pair
 *   - the API validator, to reject category values that would produce an
 *     invalid <itunes:category> element in the RSS feed
 *
 * The strings below are Apple's exact published strings, including ampersands
 * ("Health & Fitness") and hyphens ("Self-Improvement"). Do not "tidy" them:
 * Apple matches these literally, and a wrong string yields a feed that Apple
 * Podcasts rejects or silently miscategorises.
 *
 * VERIFIED: 2026-08-09 against Apple's official published list at
 *   https://podcasters.apple.com/support/1691-apple-podcasts-categories
 * Cross-checked the same day against a second reading of that page and against
 * third-party mirrors (podcastinsights.com, buzzsprout.com) for the Sports,
 * Science and Religion & Spirituality subcategory lists.
 *
 * 19 top-level categories. Government, History, Technology and True Crime have
 * no subcategories.
 */

/**
 * Ordered map: top-level category name -> array of subcategory names.
 * Insertion order is Apple's alphabetical presentation order and is relied on
 * by the UI, so keep new entries in the right place rather than appending.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const APPLE_CATEGORIES = Object.freeze({
  'Arts': Object.freeze([
    'Books',
    'Design',
    'Fashion & Beauty',
    'Food',
    'Performing Arts',
    'Visual Arts',
  ]),
  'Business': Object.freeze([
    'Careers',
    'Entrepreneurship',
    'Investing',
    'Management',
    'Marketing',
    'Non-Profit',
  ]),
  'Comedy': Object.freeze([
    'Comedy Interviews',
    'Improv',
    'Stand-Up',
  ]),
  'Education': Object.freeze([
    'Courses',
    'How To',
    'Language Learning',
    'Self-Improvement',
  ]),
  'Fiction': Object.freeze([
    'Comedy Fiction',
    'Drama',
    'Science Fiction',
  ]),
  'Government': Object.freeze([]),
  'Health & Fitness': Object.freeze([
    'Alternative Health',
    'Fitness',
    'Medicine',
    'Mental Health',
    'Nutrition',
    'Sexuality',
  ]),
  'History': Object.freeze([]),
  'Kids & Family': Object.freeze([
    'Education for Kids',
    'Parenting',
    'Pets & Animals',
    'Stories for Kids',
  ]),
  'Leisure': Object.freeze([
    'Animation & Manga',
    'Automotive',
    'Aviation',
    'Crafts',
    'Games',
    'Hobbies',
    'Home & Garden',
    'Video Games',
  ]),
  'Music': Object.freeze([
    'Music Commentary',
    'Music History',
    'Music Interviews',
  ]),
  'News': Object.freeze([
    'Business News',
    'Daily News',
    'Entertainment News',
    'News Commentary',
    'Politics',
    'Sports News',
    'Tech News',
  ]),
  'Religion & Spirituality': Object.freeze([
    'Buddhism',
    'Christianity',
    'Hinduism',
    'Islam',
    'Judaism',
    'Religion',
    'Spirituality',
  ]),
  'Science': Object.freeze([
    'Astronomy',
    'Chemistry',
    'Earth Sciences',
    'Life Sciences',
    'Mathematics',
    'Natural Sciences',
    'Nature',
    'Physics',
    'Social Sciences',
  ]),
  'Society & Culture': Object.freeze([
    'Documentary',
    'Personal Journals',
    'Philosophy',
    'Places & Travel',
    'Relationships',
  ]),
  'Sports': Object.freeze([
    'Baseball',
    'Basketball',
    'Cricket',
    'Fantasy Sports',
    'Football',
    'Golf',
    'Hockey',
    'Rugby',
    'Running',
    'Soccer',
    'Swimming',
    'Tennis',
    'Volleyball',
    'Wilderness',
    'Wrestling',
  ]),
  'Technology': Object.freeze([]),
  'True Crime': Object.freeze([]),
  'TV & Film': Object.freeze([
    'After Shows',
    'Film History',
    'Film Interviews',
    'Film Reviews',
    'TV Reviews',
  ]),
});

/**
 * All top-level category names, in Apple's order.
 * @type {readonly string[]}
 */
export const CATEGORY_NAMES = Object.freeze(Object.keys(APPLE_CATEGORIES));

// --- validation -------------------------------------------------------------

/**
 * Exact-match check for a top-level category.
 *
 * Deliberately strict: the value is written verbatim into the feed, so we only
 * accept Apple's exact casing and punctuation. Use matchLegacyCategory() when
 * you need to be forgiving about user-supplied input.
 *
 * @param {unknown} category
 * @returns {boolean}
 */
export function isValidCategory(category) {
  return typeof category === 'string'
    && Object.prototype.hasOwnProperty.call(APPLE_CATEGORIES, category);
}

/**
 * Exact-match check that `subcategory` belongs to `category`.
 *
 * An absent subcategory (null / undefined / '') means "no subcategory" and is
 * valid for every category, including those that have no subcategories at all.
 * The category itself must still be valid — a bogus category is never accepted,
 * even with an empty subcategory.
 *
 * @param {unknown} category
 * @param {unknown} [subcategory]
 * @returns {boolean}
 */
export function isValidSubcategory(category, subcategory) {
  if (!isValidCategory(category)) return false;
  if (subcategory === null || subcategory === undefined || subcategory === '') return true;
  if (typeof subcategory !== 'string') return false;
  return APPLE_CATEGORIES[category].includes(subcategory);
}

// --- lenient matching for imports ------------------------------------------

/**
 * Fold a string into a comparison key: case-insensitive, "&" and "and"
 * equivalent, and all punctuation / whitespace runs collapsed to single
 * spaces. So "Self-Improvement", "self improvement" and "SELF—IMPROVEMENT"
 * all agree, as do "Fashion & Beauty" and "fashion and beauty".
 *
 * @param {string} str
 * @returns {string}
 */
function foldKey(str) {
  return String(str)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Folded top-level name -> canonical top-level name. */
const CATEGORY_INDEX = new Map();
/** Folded "category|subcategory" -> {category, subcategory}. */
const PAIR_INDEX = new Map();
/** Folded bare subcategory name -> {category, subcategory} (first wins). */
const SUBCATEGORY_INDEX = new Map();

for (const [category, subcategories] of Object.entries(APPLE_CATEGORIES)) {
  CATEGORY_INDEX.set(foldKey(category), category);
  for (const subcategory of subcategories) {
    const pair = Object.freeze({ category, subcategory });
    PAIR_INDEX.set(`${foldKey(category)}|${foldKey(subcategory)}`, pair);
    // Apple's subcategory names are globally unique today; if that ever changes,
    // the first declaration order wins so the result stays deterministic.
    if (!SUBCATEGORY_INDEX.has(foldKey(subcategory))) {
      SUBCATEGORY_INDEX.set(foldKey(subcategory), pair);
    }
  }
}

/**
 * Separators people actually use when writing a category path by hand.
 * Note the spaced hyphen: an unspaced "-" must NOT split, or we would break
 * "Self-Improvement", "Stand-Up" and "Non-Profit".
 */
const PATH_SEPARATOR = /\s*(?:->|=>|[←-⇿]|>>|»|[>/\\|:]|\s-\s|\s–\s|\s—\s)\s*/;

/**
 * Best-effort interpretation of an arbitrary, human-written category string —
 * e.g. a hand-edited show.json, or a value carried over from an older release.
 *
 * Accepts, case- and punctuation-insensitively:
 *   "Arts"                     -> { category: 'Arts', subcategory: null }
 *   "Arts → Books"             -> { category: 'Arts', subcategory: 'Books' }
 *   "Arts > Books"             -> same
 *   "Arts/Books"               -> same
 *   "arts | books"             -> same
 *   "Books"                    -> { category: 'Arts', subcategory: 'Books' }
 *   "self improvement"         -> { category: 'Education', subcategory: 'Self-Improvement' }
 *
 * Returns the canonical Apple strings, so the result is always safe to feed
 * straight into isValidCategory() / isValidSubcategory() and into the RSS feed.
 *
 * @param {unknown} str
 * @returns {{ category: string, subcategory: string|null }|null} null if nothing matched
 */
export function matchLegacyCategory(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (trimmed === '') return null;

  // 1. The whole string as a single name (handles "TV & Film", "True Crime",
  //    and any subcategory whose own name contains no separator).
  const whole = foldKey(trimmed);
  if (CATEGORY_INDEX.has(whole)) {
    return { category: CATEGORY_INDEX.get(whole), subcategory: null };
  }
  if (SUBCATEGORY_INDEX.has(whole)) {
    return { ...SUBCATEGORY_INDEX.get(whole) };
  }

  // 2. Treat it as a path: "Category <sep> Subcategory".
  const parts = trimmed.split(PATH_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const head = foldKey(parts[0]);
    const tail = foldKey(parts[parts.length - 1]);

    // Exact category + subcategory belonging to it.
    const pair = PAIR_INDEX.get(`${head}|${tail}`);
    if (pair) return { ...pair };

    // Recognisable subcategory anywhere in the path wins next: it is the more
    // specific piece of information, and it implies its own parent category.
    for (const part of parts) {
      const hit = SUBCATEGORY_INDEX.get(foldKey(part));
      if (hit) return { ...hit };
    }

    // Otherwise fall back to a recognisable top-level anywhere in the path and
    // drop the unrecognised subcategory rather than emitting an invalid one.
    for (const part of parts) {
      const key = foldKey(part);
      if (CATEGORY_INDEX.has(key)) {
        return { category: CATEGORY_INDEX.get(key), subcategory: null };
      }
    }
  }

  return null;
}
