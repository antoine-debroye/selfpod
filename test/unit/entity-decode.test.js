import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeEntities } from '../../src/lib/entity-decode.js';

describe('the two failures this exists to fix', () => {
  it('decodes an ampersand inside an enclosure URL', () => {
    // Left escaped, this fetches the wrong file or 404s. It is the single most
    // common escaped character in a podcast enclosure URL.
    assert.equal(
      decodeEntities('https://cdn.example.com/ep.mp3?token=abc&amp;listener=42'),
      'https://cdn.example.com/ep.mp3?token=abc&listener=42',
    );
  });

  it('decodes an ampersand inside a title, so keywords can match it', () => {
    // Left escaped, a filter keyword of `q&a` never matches the episode.
    assert.equal(decodeEntities('Q&amp;A with the band'), 'Q&A with the band');
  });
});

describe('expansion is impossible, not merely bounded', () => {
  it('decodes in a single pass and does not re-read its own output', () => {
    // This is the whole security argument. A decoder that looped until stable would
    // turn &amp;amp;amp; into a bare & — and, given a DTD, would expand for ever.
    assert.equal(decodeEntities('&amp;amp;'), '&amp;');
    assert.equal(decodeEntities('&amp;amp;amp;'), '&amp;amp;');
    assert.equal(decodeEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
  });

  it('cannot be made to expand by a billion-laughs payload', () => {
    // The classic bomb. Nothing here declares entities, so `&lol9;` is simply an
    // unknown name and is returned verbatim. Asserted with a length bound rather
    // than only an equality check, so a future implementation that started
    // expanding would fail loudly rather than merely differ.
    const bomb =
      '<!DOCTYPE lolz [<!ENTITY lol "lol">' +
      Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${i + 1} "${'&lol' + i + ';'.repeat(1)}">`).join('') +
      ']><lolz>&lol9;</lolz>';

    const before = process.memoryUsage().heapUsed;
    const decoded = decodeEntities(bomb);
    const grew = process.memoryUsage().heapUsed - before;

    assert.ok(decoded.includes('&lol9;'), 'an undeclared name is returned as written');
    assert.ok(
      decoded.length <= bomb.length + 16,
      `decoding must not grow the string (${bomb.length} -> ${decoded.length})`,
    );
    assert.ok(grew < 10 * 1024 * 1024, 'decoding a bomb must not allocate');
  });

  it('stays fast on a long run of entities', () => {
    // Guards against a quadratic scan: every branch of the pattern is length-bounded.
    const long = '&amp;'.repeat(50_000);
    const started = process.hrtime.bigint();
    const decoded = decodeEntities(long);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(decoded, '&'.repeat(50_000));
    assert.ok(ms < 1000, `took ${ms.toFixed(0)}ms, which suggests a non-linear scan`);
  });
});

describe('numeric references', () => {
  it('decodes decimal and hexadecimal, including astral code points', () => {
    assert.equal(decodeEntities('caf&#233;'), 'café');
    assert.equal(decodeEntities('caf&#xE9;'), 'café');
    assert.equal(decodeEntities('&#x1F600;'), '😀');
    assert.equal(decodeEntities('&#128512;'), '😀');
  });

  it('refuses code points that cannot legally appear in XML', () => {
    // A decoded NUL would travel from a title into a filename into a path. Leaving
    // the reference as written is the only safe answer.
    for (const hostile of ['&#0;', '&#x0;', '&#1;', '&#xD800;', '&#xFFFE;', '&#1114112;']) {
      assert.equal(decodeEntities(hostile), hostile, `${hostile} must not become a character`);
    }
  });

  it('keeps the whitespace XML does allow', () => {
    assert.equal(decodeEntities('a&#9;b&#10;c'), 'a\tb\nc');
  });
});

describe('named references', () => {
  it('decodes the five XML predefined entities', () => {
    assert.equal(decodeEntities('&lt;&gt;&amp;&quot;&apos;'), '<>&"\'');
  });

  it('decodes the punctuation publishers actually use', () => {
    assert.equal(decodeEntities('It&rsquo;s here &mdash; finally&hellip;'), 'It’s here — finally…');
    assert.equal(decodeEntities('&nbsp;'), ' ');
    assert.equal(decodeEntities('&copy; 2026'), '© 2026');
  });

  it('passes an unknown name through rather than guessing or dropping it', () => {
    assert.equal(decodeEntities('&unknownthing;'), '&unknownthing;');
    assert.equal(decodeEntities('&lol9;'), '&lol9;');
  });

  it('cannot be tricked into returning an inherited property', () => {
    // Object.hasOwn, not a bare lookup: NAMED['constructor'] is a function, and
    // String(fn) would land inside an episode title.
    for (const hostile of ['&constructor;', '&__proto__;', '&toString;', '&valueOf;']) {
      assert.equal(decodeEntities(hostile), hostile);
    }
  });
});

describe('leaves alone what is not an entity', () => {
  it('ignores a bare ampersand, which real feeds are full of', () => {
    assert.equal(decodeEntities('Rock & Roll'), 'Rock & Roll');
    assert.equal(decodeEntities('a=1&b=2'), 'a=1&b=2');
    assert.equal(decodeEntities('&'), '&');
    assert.equal(decodeEntities('&;'), '&;');
  });

  it('ignores an unterminated reference', () => {
    assert.equal(decodeEntities('&amp no semicolon'), '&amp no semicolon');
    assert.equal(decodeEntities('&#233 no semicolon'), '&#233 no semicolon');
  });

  it('handles empty and non-string input without throwing', () => {
    assert.equal(decodeEntities(''), '');
    assert.equal(decodeEntities(null), '');
    assert.equal(decodeEntities(undefined), '');
    assert.equal(decodeEntities(42), '42');
  });
});
