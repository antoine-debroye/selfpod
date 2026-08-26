import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeFeedBytes, parseFeed, parseItunesDuration } from '../../src/lib/rss-parse.js';

/** A minimal but valid feed, so each test can spoil exactly one thing. */
function feed(inner, { channel = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel><title>A Show</title>${channel}${inner}</channel></rss>`;
}

function item(inner) {
  return `<item><title>An episode</title>${inner}</item>`;
}

describe('the two failures that made us stop using xmlbuilder2 for reading', () => {
  it('decodes an ampersand inside an enclosure URL', () => {
    // Left escaped, SelfPod fetches a URL with a literal "&amp;" in its query string
    // and gets a 404 or the wrong file.
    const parsed = parseFeed(
      feed(item('<enclosure url="https://cdn.example.com/a.mp3?t=1&amp;u=2" type="audio/mpeg"/>')),
    );
    assert.equal(parsed.items[0].enclosureUrl, 'https://cdn.example.com/a.mp3?t=1&u=2');
  });

  it('decodes an ampersand inside a title, so a keyword can match it', () => {
    const parsed = parseFeed(feed('<item><title>Q&amp;A with the band</title></item>'));
    assert.equal(parsed.items[0].title, 'Q&A with the band');
  });

  it('says a web page is a web page rather than reporting zero episodes', () => {
    // The real scenario: a private feed's token expired and the host now serves a
    // login page. "0 new episodes" would be the worst possible way to report that.
    assert.throws(
      () => parseFeed('<!DOCTYPE html><html><body><h1>Sign in</h1></body></html>'),
      (error) => {
        assert.equal(error.code, 'not_a_feed');
        assert.match(error.message, /web page/i);
        assert.match(error.message, /expired/i, 'the message must suggest the actual cause');
        return true;
      },
    );
  });

  it('refuses XML that is not a feed, naming what was missing', () => {
    assert.throws(
      () => parseFeed('<?xml version="1.0"?><opml><body><outline text="x"/></body></opml>'),
      (error) => {
        assert.equal(error.code, 'not_a_feed');
        assert.match(error.message, /<channel>/);
        return true;
      },
    );
  });
});

describe('a DOCTYPE is refused before any parsing happens', () => {
  it('refuses one that follows an XML declaration', () => {
    // The case a naive "does it start with <?xml" sniff waves through, and the one
    // an attacker would actually send.
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>' +
      '<rss><channel><title>&lol2;</title></channel></rss>';
    assert.throws(
      () => parseFeed(bomb),
      (error) => {
        assert.equal(error.code, 'not_a_feed');
        assert.match(error.message, /DOCTYPE/);
        return true;
      },
    );
  });

  it('refuses one at the very start', () => {
    assert.throws(
      () => parseFeed('<!DOCTYPE rss SYSTEM "http://evil.example/x.dtd"><rss><channel/></rss>'),
      /DOCTYPE/,
    );
  });

  it('refuses whatever the case', () => {
    assert.throws(() => parseFeed('<!doctype rss><rss><channel/></rss>'), /DOCTYPE/);
    assert.throws(() => parseFeed('<!DoCtYpE rss><rss><channel/></rss>'), /DOCTYPE/);
  });

  it('still refuses a bomb that disguises itself with an html doctype', () => {
    // The message differs for an HTML page, so make sure the *refusal* does not.
    // <!DOCTYPE html [<!ENTITY ...>]> is a legal way to declare entities.
    const disguised =
      '<!DOCTYPE html [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]>' +
      '<rss><channel><title>&lol2;</title></channel></rss>';
    assert.throws(() => parseFeed(disguised), (error) => {
      assert.equal(error.code, 'not_a_feed');
      return true;
    });
  });

  it('does not refuse a feed that merely mentions the word in its text', () => {
    // Positive control: the check must look at the prolog, not the whole document,
    // or an episode about XML becomes unparseable.
    const parsed = parseFeed(feed('<item><title>Explaining the DOCTYPE declaration</title></item>'));
    assert.equal(parsed.items[0].title, 'Explaining the DOCTYPE declaration');
  });
});

describe('remote markup never survives into what SelfPod republishes', () => {
  it('strips tags that arrived escaped, not just tags that arrived raw', () => {
    // Regression. Stripping tags before decoding entities sees no tags at all —
    // there are none yet — and the decode afterwards then produces real markup.
    // feed.js emits descriptions inside a CDATA section, where markup is NOT
    // escaped, so this would republish a stranger's script to every subscriber.
    const parsed = parseFeed(
      feed(
        item(
          '<description>&lt;p&gt;Hello&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;</description>',
        ),
      ),
    );
    const { description } = parsed.items[0];
    assert.ok(!description.includes('<'), `markup survived: ${description}`);
    assert.ok(!description.includes('script>'), `a tag survived: ${description}`);
    assert.match(description, /Hello/, 'the actual words must still be there');
  });

  it('strips tags that arrived inside CDATA', () => {
    const parsed = parseFeed(
      feed(item('<description><![CDATA[<p>Notes <img src=x onerror=alert(1)> here</p>]]></description>')),
    );
    const { description } = parsed.items[0];
    assert.ok(!description.includes('<'), `markup survived: ${description}`);
    assert.ok(!description.includes('onerror'), `an attribute survived: ${description}`);
    assert.match(description, /Notes/);
  });

  it('does not decode twice, whatever route the text took', () => {
    // The single-pass guarantee has to hold through the parser too: decode, then
    // transform, then decode again would turn &amp;amp; into a bare ampersand.
    const parsed = parseFeed(feed('<item><title>a &amp;amp; b</title></item>'));
    assert.equal(parsed.items[0].title, 'a &amp; b');
  });

  it('strips control characters that would travel into a filename', () => {
    const title = `Ep${String.fromCharCode(0)}1${String.fromCharCode(127)}`;
    const parsed = parseFeed(feed(`<item><title>${title}</title></item>`));
    assert.equal(parsed.items[0].title, 'Ep1');
  });
});

describe('element names never become object keys', () => {
  it('leaves Object.prototype alone', () => {
    // Tag names come from the remote document. Anything that used one as a key
    // would be prototype pollution with attacker-chosen values.
    parseFeed(
      feed(
        '<item><title>x</title><__proto__><polluted>yes</polluted></__proto__>' +
          '<constructor><prototype><polluted>yes</polluted></prototype></constructor></item>',
      ),
    );
    assert.equal({}.polluted, undefined, 'Object.prototype was polluted by a feed');
    assert.equal([].polluted, undefined);
  });
});

describe('tolerance for the XML real feeds actually ship', () => {
  it('accepts a bare ampersand in text', () => {
    const parsed = parseFeed(feed('<item><title>Rock & Roll</title></item>'));
    assert.equal(parsed.items[0].title, 'Rock & Roll');
  });

  it('accepts a bare ampersand in an attribute', () => {
    const parsed = parseFeed(
      feed(item('<enclosure url="https://cdn.example.com/a.mp3?t=1&u=2" type="audio/mpeg"/>')),
    );
    assert.equal(parsed.items[0].enclosureUrl, 'https://cdn.example.com/a.mp3?t=1&u=2');
  });

  it('accepts an unclosed tag without losing the episode', () => {
    const parsed = parseFeed(
      '<rss><channel><title>A Show</title><item><title>Ep 1</title></channel></rss>',
    );
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].title, 'Ep 1');
  });

  it('reads one item and many items the same way', () => {
    // A parser that collapses a single repeated element into an object rather than a
    // one-element array silently ingests zero episodes from a brand-new show.
    const one = parseFeed(feed('<item><title>Only</title></item>'));
    assert.equal(one.items.length, 1);
    const three = parseFeed(feed('<item><title>a</title></item><item><title>b</title></item><item><title>c</title></item>'));
    assert.equal(three.items.length, 3);
    assert.deepEqual(three.items.map((i) => i.title), ['a', 'b', 'c']);
  });

  it('reads a CDATA title', () => {
    const parsed = parseFeed(feed('<item><title><![CDATA[Ep 1: Caf&eacute; & croissants]]></title></item>'));
    assert.equal(parsed.items[0].title, 'Ep 1: Café & croissants');
  });
});

describe('channel metadata', () => {
  it('reads what a new show needs to be created from', () => {
    const parsed = parseFeed(
      feed('', {
        channel:
          '<language>en-GB</language><itunes:author>A Person</itunes:author>' +
          '<itunes:image href="https://cdn.example.com/art.jpg"/>' +
          '<description>About the show</description>',
      }),
    );
    assert.equal(parsed.title, 'A Show');
    assert.equal(parsed.language, 'en-gb');
    assert.equal(parsed.author, 'A Person');
    assert.equal(parsed.imageUrl, 'https://cdn.example.com/art.jpg');
    assert.equal(parsed.description, 'About the show');
  });

  it('reads the older <image><url> form of artwork', () => {
    const parsed = parseFeed(feed('', { channel: '<image><url>https://cdn.example.com/old.jpg</url></image>' }));
    assert.equal(parsed.imageUrl, 'https://cdn.example.com/old.jpg');
  });

  it('does not mistake an episode title for the show title', () => {
    const parsed = parseFeed(feed('<item><title>Ep 1</title></item>'));
    assert.equal(parsed.title, 'A Show');
  });
});

describe('the dedup key', () => {
  it('prefers the feed\'s own guid', () => {
    const parsed = parseFeed(feed(item('<guid isPermaLink="false">abc-123</guid>')));
    assert.equal(parsed.items[0].guid, 'abc-123');
    assert.equal(parsed.items[0].guidSource, 'guid');
  });

  it('falls back to the enclosure URL, and records that it did', () => {
    const parsed = parseFeed(feed(item('<enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg"/>')));
    assert.equal(parsed.items[0].guid, 'https://cdn.example.com/a.mp3');
    assert.equal(parsed.items[0].guidSource, 'enclosure');
  });

  it('synthesises one only as a last resort, and says so', () => {
    // A synthesised key is fragile: fixing a typo in a title re-offers the item as
    // new. The user has to be able to see that is what happened.
    const parsed = parseFeed(feed('<item><title>No guid, no audio</title></item>'));
    assert.equal(parsed.items[0].guidSource, 'synthesised');
    assert.match(parsed.items[0].guid, /^[0-9a-f]{40}$/);
  });

  it('gives two different episodes two different synthesised keys', () => {
    const parsed = parseFeed(feed('<item><title>One</title></item><item><title>Two</title></item>'));
    assert.notEqual(parsed.items[0].guid, parsed.items[1].guid);
  });
});

describe('durations', () => {
  it('reads every form publishers use', () => {
    assert.equal(parseItunesDuration('1:02:03'), 3723);
    assert.equal(parseItunesDuration('12:30'), 750);
    assert.equal(parseItunesDuration('750'), 750);
    assert.equal(parseItunesDuration('750.4'), 750);
    assert.equal(parseItunesDuration('0:00:45'), 45);
  });

  it('returns nothing rather than a guess for anything else', () => {
    // A wrong duration silently changes which episodes the filter takes, so an
    // unreadable one has to be reported as unknown, not approximated.
    for (const bad of ['PT30M', '', 'about an hour', '1:2:3:4', '-5', 'x:y', null, undefined]) {
      assert.equal(parseItunesDuration(bad), null, `"${bad}" should not parse`);
    }
  });

  it('is read off the item', () => {
    const parsed = parseFeed(feed(item('<itunes:duration>1:02:03</itunes:duration>')));
    assert.equal(parsed.items[0].declaredDurationSeconds, 3723);
  });

  it('is null when the feed does not say', () => {
    const parsed = parseFeed(feed(item('')));
    assert.equal(parsed.items[0].declaredDurationSeconds, null);
  });
});

describe('enclosures', () => {
  it('reads url, type and length', () => {
    const parsed = parseFeed(
      feed(item('<enclosure url="https://cdn.example.com/a.mp3" type="audio/mpeg" length="55000000"/>')),
    );
    const [entry] = parsed.items;
    assert.equal(entry.enclosureUrl, 'https://cdn.example.com/a.mp3');
    assert.equal(entry.enclosureType, 'audio/mpeg');
    assert.equal(entry.enclosureLengthBytes, 55000000);
    assert.equal(entry.supportedType, true);
  });

  it('flags a type SelfPod cannot serve without refusing to parse the feed', () => {
    const parsed = parseFeed(feed(item('<enclosure url="https://cdn.example.com/a.mp4" type="video/mp4"/>')));
    assert.equal(parsed.items[0].supportedType, false);
  });

  it('distinguishes "the feed said nothing" from "the feed said something unsupported"', () => {
    const parsed = parseFeed(feed(item('<enclosure url="https://cdn.example.com/a.mp3"/>')));
    assert.equal(parsed.items[0].supportedType, null, 'null means unstated, not unsupported');
  });

  it('ignores a length that is not a positive number', () => {
    const parsed = parseFeed(feed(item('<enclosure url="https://x/a.mp3" type="audio/mpeg" length="0"/>')));
    assert.equal(parsed.items[0].enclosureLengthBytes, null);
  });
});

describe('Atom feeds', () => {
  it('reads entries, ids, dates and enclosure links', () => {
    const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>An Atom Show</title>
<entry><title>Ep 1</title><id>urn:uuid:abc</id><published>2025-03-04T09:00:00Z</published>
<link rel="enclosure" href="https://cdn.example.com/a.mp3" type="audio/mpeg" length="42"/>
</entry></feed>`;
    const parsed = parseFeed(atom);
    assert.equal(parsed.title, 'An Atom Show');
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].guid, 'urn:uuid:abc');
    assert.equal(parsed.items[0].enclosureUrl, 'https://cdn.example.com/a.mp3');
    assert.equal(parsed.items[0].pubDate, '2025-03-04T09:00:00.000Z');
  });

  it('does not treat a plain alternate link as audio', () => {
    const atom = `<feed><title>x</title><entry><title>Ep</title>
<link rel="alternate" href="https://example.com/page"/></entry></feed>`;
    assert.equal(parseFeed(atom).items[0].enclosureUrl, null);
  });
});

describe('dates', () => {
  it('normalises RFC-822 to ISO', () => {
    const parsed = parseFeed(feed(item('<pubDate>Tue, 04 Mar 2025 09:00:00 GMT</pubDate>')));
    assert.equal(parsed.items[0].pubDate, '2025-03-04T09:00:00.000Z');
  });

  it('is null when the date cannot be read, rather than today', () => {
    // Defaulting to now would silently reorder a whole backfill.
    const parsed = parseFeed(feed(item('<pubDate>sometime last spring</pubDate>')));
    assert.equal(parsed.items[0].pubDate, null);
  });
});

describe('character encodings', () => {
  it('decodes windows-1252 when the document declares it', () => {
    // Response.text() would assume UTF-8 and fill this with replacement characters,
    // which then travel into the title and into the filename.
    const xml = `<?xml version="1.0" encoding="windows-1252"?><rss><channel><title>Caf\xe9 Society</title></channel></rss>`;
    const bytes = Buffer.from(xml, 'latin1');
    assert.equal(parseFeed(bytes).title, 'Café Society');
  });

  it('prefers the charset the server sent', () => {
    const bytes = Buffer.from('<rss><channel><title>Caf\xe9</title></channel></rss>', 'latin1');
    assert.equal(parseFeed(bytes, { contentType: 'application/rss+xml; charset=windows-1252' }).title, 'Café');
  });

  it('strips a byte-order mark rather than leaving it in the first element', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<rss><channel><title>Fine</title></channel></rss>', 'utf8'),
    ]);
    assert.equal(parseFeed(bytes).title, 'Fine');
  });

  it('falls back to UTF-8 for an encoding label Node does not know', () => {
    const bytes = Buffer.from('<?xml version="1.0" encoding="x-made-up"?><rss><channel><title>Fine</title></channel></rss>');
    assert.equal(decodeFeedBytes(bytes, null).includes('Fine'), true);
  });
});

describe('feeds at the scale real shows actually reach', () => {
  it('parses a back catalogue of thousands of episodes without a document tree', () => {
    // Sized from real measurements: The Daily ships 2,959 items in a 19 MB document,
    // and The Vergecast 1,061 in 5.75 MB. An earlier 5 MB cap would have refused both.
    // This guards the parser side of that: a SAX state machine keeps only the fields
    // it extracts, so cost stays proportional to what is kept, not to the document.
    const items = Array.from({ length: 3000 }, (_, i) =>
      `<item><title>Episode ${i}: something happened</title>` +
      `<guid isPermaLink="false">ep-${i}</guid>` +
      `<pubDate>Tue, 04 Mar 2025 09:00:00 GMT</pubDate>` +
      `<itunes:duration>${1200 + i}</itunes:duration>` +
      `<description>&lt;p&gt;Notes for episode ${i}, with &lt;b&gt;markup&lt;/b&gt;.&lt;/p&gt;</description>` +
      `<enclosure url="https://cdn.example.com/${i}.mp3?t=1&amp;u=2" type="audio/mpeg" length="5000000"/>` +
      `</item>`,
    ).join('');

    const started = process.hrtime.bigint();
    const parsed = parseFeed(feed(items));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(parsed.items.length, 3000);
    assert.equal(parsed.items[2999].declaredDurationSeconds, 4199);
    assert.equal(parsed.items[0].enclosureUrl, 'https://cdn.example.com/0.mp3?t=1&u=2');
    assert.ok(
      parsed.items.every((entry) => !entry.description.includes('<')),
      'escaped markup must be stripped at every item, not just the first',
    );
    assert.ok(ms < 5000, `took ${ms.toFixed(0)}ms for 3000 items, which suggests a non-linear parse`);
  });
});
