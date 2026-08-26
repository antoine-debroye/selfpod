import { createHash } from 'node:crypto';

import { Parser } from 'htmlparser2';

import { contentTypeEssence, remoteAudioExtension } from '../constants.js';
import { toIso } from './dates.js';
import { decodeEntities } from './entity-decode.js';
import { badRequest } from './errors.js';

/**
 * Reading a podcast feed we do not own (spec §18.1).
 *
 * SelfPod already depends on xmlbuilder2, and the obvious move was to reuse it for
 * reading. It parses safely — it expands no entities and resolves no external ones —
 * but it parses *wrongly* for this purpose, in two ways that both matter here:
 *
 *  1. It returns predefined entities still escaped. `&amp;` comes back as `&amp;`,
 *     while `&#233;` comes back decoded. So an enclosure URL round-trips with a
 *     literal `&amp;` in its query string and fetches the wrong file, and a title of
 *     `Q&amp;A` never matches the keyword `q&a`. Undoing it afterwards is ambiguous:
 *     text that genuinely contained `&amp;` is now indistinguishable from an escape.
 *  2. It accepts almost anything. An expired private feed answers with an HTML login
 *     page, which parses happily into an object with no channel — and "0 new episodes"
 *     is the worst possible way to report "your subscription link has expired".
 *
 * So: htmlparser2 in XML mode for the tokens, our own decoder for the entities, and
 * the structural checks below for everything a tokeniser has no opinion about.
 * htmlparser2 was chosen over a conformant XML parser by measurement, not taste — a
 * strict parser rejects a bare `&` in a URL, an unescaped `<` in a title and an
 * unclosed tag, all of which appear in feeds people actually subscribe to.
 *
 * Note what this file never does: it never uses a tag name as an object key. Element
 * names come from the remote document, so a `<__proto__>` element indexing into an
 * accumulator would be prototype pollution with attacker-chosen values. The switch
 * statements below make that unrepresentable rather than guarded against.
 */

/** Anything past this is not a feed, and what the parser accumulates is memory. */
const MAX_ITEMS = 5000;
const MAX_TITLE_LENGTH = 500;
const MAX_TEXT_LENGTH = 8000;

/** C0 and C1 control characters, which must never reach a title or a filename. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Refuses a document that declares a DOCTYPE, before a parser ever sees it.
 *
 * RSS and Atom have no legitimate use for one. Every entity-expansion attack — and
 * every CVE in this class, of which the popular XML parsers have many — needs a DTD to
 * declare the entities it expands. Refusing the DOCTYPE outright removes the whole
 * category in a way no dependency upgrade can undo, and unlike "is the bomb bounded?"
 * it is a property that can actually be tested.
 *
 * Deliberately scanned across the prolog rather than only the first bytes: a document
 * beginning `<?xml version="1.0"?><!DOCTYPE rss [ ... ]>` passes a naive "starts with
 * <?xml" sniff.
 */
function assertNoDoctype(text) {
  const firstElement = text.search(/<[a-zA-Z]/);
  const prolog = firstElement === -1 ? text : text.slice(0, firstElement);
  if (!/<!doctype/i.test(prolog)) return;

  // An HTML page is refused either way, but it deserves the sentence that names the
  // likely cause. A private feed whose token has expired answers with a login page,
  // and "that feed declares a DOCTYPE" — true, and useless — would send the operator
  // looking for a problem with their feed rather than with their subscription link.
  // Both branches refuse, so distinguishing them costs nothing in strictness.
  if (/<!doctype\s+html/i.test(prolog)) {
    throw badRequest(
      'That address returned a web page, not a podcast feed. If this is a private feed, the subscription link has probably expired — get a fresh one from the publisher.',
      'not_a_feed',
    );
  }

  throw badRequest(
    'That feed declares a DOCTYPE. Podcast feeds never need one, and SelfPod refuses them because they are how XML parsers are made to expand a small file into a very large one.',
    'not_a_feed',
  );
}

/**
 * Decodes the bytes using the charset the server or the document declares.
 *
 * `Response.text()` would assume UTF-8 unconditionally, which fills a windows-1252
 * feed — still common, particularly from older publishing tools — with replacement
 * characters. Those then travel into titles and into filenames.
 */
export function decodeFeedBytes(bytes, contentTypeHeader) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  let charset = null;
  const declared = /charset=["']?([\w-]+)/i.exec(String(contentTypeHeader ?? ''));
  if (declared) charset = declared[1];

  if (!charset) {
    // The XML declaration is ASCII-compatible in every encoding we might meet here,
    // so reading it out of the raw bytes is safe before we know the encoding.
    const head = buffer.subarray(0, 200).toString('latin1');
    const inDocument = /encoding=["']([\w-]+)["']/i.exec(head);
    if (inDocument) charset = inDocument[1];
  }

  let text;
  try {
    text = new TextDecoder(charset ?? 'utf-8').decode(buffer);
  } catch {
    // An encoding label Node's ICU does not know. UTF-8 is a better guess than
    // failing outright, and the sniff below rejects it if it turned to mush.
    text = new TextDecoder('utf-8').decode(buffer);
  }

  // A BOM left in place becomes an invisible leading character in the first element.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Confirms the bytes are XML-shaped before handing them to a tolerant parser.
 *
 * The Content-Type header comes from the same untrusted party as the body, so it can
 * narrow what we accept but can never authorise it. Real podcast hosts serve feeds as
 * `text/html` and `application/octet-stream`, so the header is nearly useless as a
 * signal and the bytes have to be asked instead.
 */
function assertLooksLikeXml(text, { contentType } = {}) {
  const head = text.slice(0, 512).trimStart();
  if (
    /^<\?xml/i.test(head) ||
    /^<rss/i.test(head) ||
    /^<feed/i.test(head) ||
    /^<rdf:RDF/i.test(head)
  ) {
    return;
  }
  const essence = contentTypeEssence(contentType);
  const looksLikeHtml = /^<(!doctype html|html)/i.test(head);
  throw badRequest(
    looksLikeHtml || essence === 'text/html'
      ? 'That address returned a web page, not a podcast feed. If this is a private feed, the subscription link has probably expired — get a fresh one from the publisher.'
      : 'That address did not return a podcast feed. Check the URL points at the feed itself rather than the show’s home page.',
    'not_a_feed',
  );
}

/**
 * `<itunes:duration>` in every form publishers actually use.
 *
 * `HH:MM:SS`, `MM:SS`, a bare number of seconds, and a number with a fractional part
 * (some tools emit the raw float from a decoder). Returns null rather than a guess for
 * anything else — a wrong duration silently changes which episodes a filter takes.
 */
export function parseItunesDuration(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Math.round(Number(raw));
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+(\.\d+)?$/.test(part.trim()))) return null;

  const numbers = parts.map((part) => Number(part.trim()));
  const seconds =
    numbers.length === 3
      ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
      : numbers[0] * 60 + numbers[1];
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null;
}

/**
 * Tidies already-decoded text. Deliberately does **not** decode.
 *
 * Splitting this from `clean` is what keeps the single-pass guarantee in
 * entity-decode.js intact. Decoding, then transforming, then decoding again is two
 * passes over the same string, which turns `&amp;amp;` into a bare `&` — precisely
 * the recursive expansion that decoder exists to make impossible. Every path below
 * decodes exactly once and then tidies.
 */
function tidy(value, limit = MAX_TEXT_LENGTH) {
  return String(value ?? '')
    .replace(CONTROL_CHARACTERS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function clean(value, limit = MAX_TEXT_LENGTH) {
  return tidy(decodeEntities(String(value ?? '')), limit);
}

/**
 * Strips markup from a remote description and keeps only the words.
 *
 * SelfPod republishes this text into its own feed, and feed.js emits `content:encoded`
 * inside a CDATA section — where markup is deliberately *not* escaped, because that is
 * the element podcast HTML descriptions live in. That is correct while the description
 * comes from the operator or their own ID3 tags. The moment it can come from a remote
 * feed, keeping the markup would republish a stranger's `<script>` and tracking pixels
 * to every subscriber, under the operator's own domain.
 *
 * Storing plain text at ingest is a smaller and stricter fix than sanitising HTML: no
 * allow-list to get wrong, no sanitiser dependency, and nothing downstream has to
 * remember that this one field is special. The cost is losing the publisher's
 * paragraphs and links, which is a fair trade for not being someone's distribution
 * channel.
 */
function toPlainText(value, limit = MAX_TEXT_LENGTH) {
  // Decode BEFORE stripping tags, and only once.
  //
  // The other order looks equivalent and is not. Publishers routinely escape their
  // HTML rather than wrapping it in CDATA, so a description arrives as
  // `&lt;p&gt;text&lt;/p&gt;`. Stripping tags first sees no tags at all — there are
  // none yet — and the decode afterwards then produces real `<p>` markup, which is
  // exactly the remote HTML this function exists to remove. With `<script>` in place
  // of `<p>`, that markup would be republished inside feed.js's `content:encoded`
  // CDATA section, unescaped, to every subscriber of the operator's feed.
  const decoded = decodeEntities(String(value ?? ''));
  const withoutTags = decoded
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return tidy(withoutTags, limit);
}

function attr(attributes, name) {
  return Object.hasOwn(attributes, name) ? String(attributes[name]) : null;
}

function toPositiveInt(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function emptyItem() {
  return {
    title: '',
    guid: '',
    pubDate: null,
    description: '',
    declaredDurationSeconds: null,
    enclosureUrl: null,
    enclosureType: null,
    enclosureLengthBytes: null,
  };
}

/**
 * Settles the dedup key and the advisory type check.
 *
 * `guidSource` is recorded rather than inferred later because a synthesised key is
 * fragile in a way the user has to be able to see: if a publisher fixes a typo in a
 * title, an item keyed on that title is offered again as new, and "why did that
 * episode arrive twice?" needs a better answer than a shrug.
 */
function finaliseItem(item) {
  let guid = item.guid;
  let guidSource = 'guid';
  if (!guid) {
    guid = item.enclosureUrl ?? '';
    guidSource = 'enclosure';
  }
  if (!guid) {
    guid = createHash('sha256')
      .update(`${item.title} ${item.pubDate ?? ''}`)
      .digest('hex')
      .slice(0, 40);
    guidSource = 'synthesised';
  }

  return {
    ...item,
    guid,
    guidSource,
    // Advisory only — the authoritative decision is made against the response's own
    // Content-Type at download time. Null means the feed did not say, which is not
    // the same as saying something unsupported.
    supportedType: item.enclosureType ? remoteAudioExtension(item.enclosureType) !== null : null,
  };
}

/**
 * Reads a feed document into the flat shape the filter and downloader work on.
 *
 * Nothing else is retained — no raw nodes, no markup, no unrecognised elements. The
 * two consumers need exactly these fields, and anything kept beyond them is another
 * remote-controlled string with a path into the app.
 */
export function parseFeed(input, { contentType } = {}) {
  const text = typeof input === 'string' ? input : decodeFeedBytes(input, contentType);

  assertNoDoctype(text);
  assertLooksLikeXml(text, { contentType });

  const channel = { title: '', description: '', language: '', author: '', imageUrl: null };
  const items = [];

  // Explicit state rather than a generic tree: every element this cares about is
  // named below, so nothing a remote document invents can reach an object key.
  const stack = [];
  let current = null; // the item being built, when inside one
  let capture = null; // which field the text between tags belongs to
  let buffer = '';
  let truncated = false;
  let sawFeedRoot = false;
  let sawChannel = false;
  let inChannelImage = false;

  const flush = () => {
    if (!capture) return;
    const value = buffer;
    buffer = '';
    const field = capture;
    capture = null;

    if (current) {
      switch (field) {
        case 'title':
          current.title = clean(value, MAX_TITLE_LENGTH);
          break;
        case 'guid':
          current.guid = clean(value, 300);
          break;
        case 'pubDate':
          current.pubDate = toIso(clean(value, 100));
          break;
        case 'duration':
          current.declaredDurationSeconds = parseItunesDuration(clean(value, 50));
          break;
        case 'description':
          if (!current.description) current.description = toPlainText(value, 2000);
          break;
        default:
          break;
      }
      return;
    }

    switch (field) {
      case 'title':
        if (!channel.title) channel.title = clean(value, MAX_TITLE_LENGTH);
        break;
      case 'description':
        if (!channel.description) channel.description = toPlainText(value, 2000);
        break;
      case 'language':
        if (!channel.language) channel.language = clean(value, 20).toLowerCase();
        break;
      case 'author':
        if (!channel.author) channel.author = clean(value, 200);
        break;
      case 'imageUrl':
        if (!channel.imageUrl) channel.imageUrl = clean(value, 2000);
        break;
      default:
        break;
    }
  };

  const parser = new Parser(
    {
      onopentag(rawName, attributes) {
        const name = rawName.toLowerCase();
        stack.push(name);
        flush();

        switch (name) {
          case 'rss':
          case 'rdf:rdf':
            sawFeedRoot = true;
            return;
          case 'feed': // Atom
            sawFeedRoot = true;
            sawChannel = true;
            return;
          case 'channel':
            sawChannel = true;
            return;
          case 'item':
          case 'entry':
            if (items.length >= MAX_ITEMS) {
              truncated = true;
              return;
            }
            current = emptyItem();
            return;
          case 'image':
            if (!current) inChannelImage = true;
            return;
          case 'enclosure':
            if (current && !current.enclosureUrl) {
              current.enclosureUrl = clean(attr(attributes, 'url'), 2000);
              current.enclosureType = clean(attr(attributes, 'type'), 100).toLowerCase() || null;
              current.enclosureLengthBytes = toPositiveInt(attr(attributes, 'length'));
            }
            return;
          case 'link':
            // Atom carries the audio on <link rel="enclosure">.
            if (current && attr(attributes, 'rel') === 'enclosure' && !current.enclosureUrl) {
              current.enclosureUrl = clean(attr(attributes, 'href'), 2000);
              current.enclosureType = clean(attr(attributes, 'type'), 100).toLowerCase() || null;
              current.enclosureLengthBytes = toPositiveInt(attr(attributes, 'length'));
            }
            return;
          case 'itunes:image':
            if (!current && !channel.imageUrl) {
              channel.imageUrl = clean(attr(attributes, 'href'), 2000);
            }
            return;
          case 'title':
            capture = 'title';
            return;
          case 'guid':
          case 'id':
            if (current) capture = 'guid';
            return;
          case 'pubdate':
          case 'published':
            if (current) capture = 'pubDate';
            return;
          case 'updated':
            // Atom's only date on many feeds. Never overwrites a real published date.
            if (current && !current.pubDate) capture = 'pubDate';
            return;
          case 'itunes:duration':
            if (current) capture = 'duration';
            return;
          case 'description':
          case 'itunes:summary':
          case 'summary':
          case 'content:encoded':
            capture = 'description';
            return;
          case 'language':
          case 'dc:language':
            if (!current) capture = 'language';
            return;
          case 'itunes:author':
          case 'managingeditor':
          case 'dc:creator':
            if (!current) capture = 'author';
            return;
          case 'url':
            if (inChannelImage && !current) capture = 'imageUrl';
            return;
          default:
            return;
        }
      },

      ontext(value) {
        if (capture && buffer.length < MAX_TEXT_LENGTH * 2) buffer += value;
      },

      // CDATA is where publishers put HTML descriptions and awkward titles.
      oncdata(value) {
        if (capture && buffer.length < MAX_TEXT_LENGTH * 2) buffer += value;
      },

      onclosetag(rawName) {
        const name = rawName.toLowerCase();
        flush();
        while (stack.length && stack.pop() !== name) {
          // A tolerant parser lets tags close out of order; keep the stack honest
          // rather than trusting the document to be well-formed.
        }
        if (name === 'image') inChannelImage = false;
        if ((name === 'item' || name === 'entry') && current) {
          items.push(finaliseItem(current));
          current = null;
        }
      },
    },
    { xmlMode: true, decodeEntities: false, recognizeCDATA: true, lowerCaseTags: false },
  );

  parser.write(text);
  parser.end();

  // A tolerant parser will not tell us the document was nonsense, so ask afterwards.
  if (!sawFeedRoot || !sawChannel) {
    throw badRequest(
      'That address returned XML, but not a podcast feed — there is no <channel> in it. Check the URL points at the feed rather than at a page about it.',
      'not_a_feed',
    );
  }

  return { ...channel, items, truncated };
}
