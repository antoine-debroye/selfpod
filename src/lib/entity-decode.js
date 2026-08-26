/**
 * XML/HTML entity decoding for text that came from a feed we do not own.
 *
 * Hand-written rather than delegated, and the reason is the whole design.
 *
 * Every XML library that expands entities carries a counter to stop the "billion
 * laughs" attack — a DTD where each entity expands into ten of the previous one, so a
 * kilobyte of input becomes gigabytes of output. Those counters have a long history of
 * being bypassed: the same widely-used parser has had several distinct CVEs that are
 * each a way around its own expansion limit, and a unit test asserting "the bomb is
 * bounded" only ever proves the bound held for the one payload someone thought of.
 *
 * This decoder has no counter, because it cannot expand at all. `String.replace` scans
 * its input once and never re-reads what it wrote, so `&amp;amp;` becomes `&amp;` and
 * stops there. Exponential expansion is not merely bounded, it is unrepresentable —
 * a property no dependency upgrade can quietly take away.
 *
 * The other half of the defence is in rss-parse.js, which refuses any document
 * carrying a DOCTYPE at all. Between them there is no path by which a declared entity
 * reaches this function.
 *
 * Getting this right matters for two very ordinary reasons, not just hostile ones:
 * an undecoded `&amp;` in an enclosure URL fetches the wrong file, and a title of
 * `Q&amp;A` never matches the keyword `q&a`.
 */

/**
 * The named entities that appear in podcast feeds.
 *
 * Not the full HTML5 set of ~2,200. That list exists for rendering arbitrary web
 * pages; a feed's title and description use a couple of dozen, and every name absent
 * from this table is passed through untouched rather than guessed at — which is the
 * correct handling for a genuine XML entity reference we have decided not to expand.
 */
const NAMED = Object.freeze({
  // The five XML predefined entities. These are the ones that actually matter.
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  // Punctuation publishers reach for constantly.
  nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', dagger: '†', Dagger: '‡',
  bull: '•', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›',
  // Symbols common in show names and credits.
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·',
  pound: '£', euro: '€', yen: '¥', cent: '¢', sect: '§',
  para: '¶', plusmn: '±', times: '×', divide: '÷', frac12: '½',
  laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿', shy: '­',
  // Accented letters. Not decoration: podcast titles in French, Spanish, German,
  // Portuguese and the Nordic languages carry these constantly, and a title left as
  // `Caf&eacute;` fails to match the keyword `cafe` and lands on disk with the
  // literal entity in its filename.
  aacute: 'á', Aacute: 'Á', agrave: 'à', Agrave: 'À', acirc: 'â', Acirc: 'Â',
  atilde: 'ã', Atilde: 'Ã', auml: 'ä', Auml: 'Ä', aring: 'å', Aring: 'Å',
  aelig: 'æ', AElig: 'Æ', ccedil: 'ç', Ccedil: 'Ç',
  eacute: 'é', Eacute: 'É', egrave: 'è', Egrave: 'È', ecirc: 'ê', Ecirc: 'Ê',
  euml: 'ë', Euml: 'Ë',
  iacute: 'í', Iacute: 'Í', igrave: 'ì', Igrave: 'Ì', icirc: 'î', Icirc: 'Î',
  iuml: 'ï', Iuml: 'Ï',
  ntilde: 'ñ', Ntilde: 'Ñ',
  oacute: 'ó', Oacute: 'Ó', ograve: 'ò', Ograve: 'Ò', ocirc: 'ô', Ocirc: 'Ô',
  otilde: 'õ', Otilde: 'Õ', ouml: 'ö', Ouml: 'Ö', oslash: 'ø', Oslash: 'Ø',
  oelig: 'œ', OElig: 'Œ',
  uacute: 'ú', Uacute: 'Ú', ugrave: 'ù', Ugrave: 'Ù', ucirc: 'û', Ucirc: 'Û',
  uuml: 'ü', Uuml: 'Ü',
  yacute: 'ý', Yacute: 'Ý', yuml: 'ÿ', Yuml: 'Ÿ',
  szlig: 'ß', eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ',
});

/**
 * Characters XML 1.0 forbids, plus the surrogate range.
 *
 * A numeric reference is allowed to name any code point at all, including ones that
 * cannot legally appear in an XML document. Decoding `&#0;` into a real NUL would put
 * it into a title, then into a filename, then into a path — so out-of-range references
 * are left as written rather than turned into a character no downstream consumer can
 * handle. feed.js's xmlSafe would strip them on the way back out, but the filename is
 * derived long before that.
 */
function isAllowedCodePoint(code) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return false;
  if (code === 0x9 || code === 0xa || code === 0xd) return true;
  if (code < 0x20) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false; // lone surrogates
  if (code === 0xfffe || code === 0xffff) return false;
  return true;
}

/**
 * Refuse to spend time on an implausibly large string.
 *
 * The feed document is already capped before it reaches the parser, so this is a
 * second line rather than the control — but a single title of many megabytes is not a
 * title, and the regex below would happily walk all of it.
 */
const MAX_DECODE_LENGTH = 1_000_000;

// Bounded on every branch: at most 7 digits, 6 hex digits, or a 1–31 character name.
// An unbounded `\d+` here would be a way to make the scan quadratic on hostile input.
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{0,31}));/g;

/**
 * Decodes entity references in one pass.
 *
 * Unknown names and out-of-range numeric references are returned exactly as they were
 * written. That is deliberate: silently dropping `&unknownthing;` would corrupt a title
 * in a way nobody could explain later, and turning it into something plausible would be
 * a guess.
 */
export function decodeEntities(value) {
  const text = String(value ?? '');
  if (!text.includes('&')) return text;
  if (text.length > MAX_DECODE_LENGTH) return text;

  return text.replace(ENTITY, (match, decimal, hex, name) => {
    if (decimal !== undefined) {
      const code = Number.parseInt(decimal, 10);
      return isAllowedCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      return isAllowedCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    return Object.hasOwn(NAMED, name) ? NAMED[name] : match;
  });
}
