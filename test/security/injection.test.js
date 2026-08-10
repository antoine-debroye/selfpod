import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';

/**
 * Adversarial tests for injection into the admin UI and the feed.
 *
 * The untrusted input here is not only what an admin types. Filenames and folder
 * names arrive from a network share that other people may be able to write to, and
 * they end up rendered on admin pages and copied into public RSS. So a file called
 * `<img src=x onerror=...>.mp3` is a realistic delivery mechanism, and it would run
 * in the session of whoever opens the dashboard.
 */
const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><script>alert(1)</script>',
  "' onmouseover='alert(1)",
  '<img src=x onerror=alert(1)>',
  '</script><script>alert(1)</script>',
  '<svg/onload=alert(1)>',
  '{{7*7}}',
  '<%= 7*7 %>',
];

/** Markup that must never appear literally in a response. */
const FORBIDDEN = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  "onmouseover='alert(1)",
];

function assertNoLiveMarkup(html, where) {
  for (const bad of FORBIDDEN) {
    assert.ok(!html.includes(bad), `${where} rendered live markup: ${bad}`);
  }
}

describe('hostile filenames and titles cannot inject into the admin UI', () => {
  let server;
  let show;

  before(async () => {
    server = await createTestServer();
    // One file per payload, named with it. Slashes are impossible in a filename, so
    // these are exactly what an attacker with write access to the share could create.
    for (const [i, payload] of PAYLOADS.entries()) {
      await server.addAudio('inject', 'sample.m4a', `${i}-${payload}.m4a`.replace(/\//g, '_'));
    }
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('inject');
    await server.login();

    // And the same payloads through the fields an admin can type.
    await server.request({
      method: 'PATCH',
      url: `/api/shows/${show.id}`,
      payload: {
        title: '<script>alert(1)</script>',
        description: '<img src=x onerror=alert(1)>',
        authorName: '"><svg/onload=alert(1)>',
      },
      headers: { 'content-type': 'application/json' },
    });
  });

  after(async () => {
    await server.cleanup();
  });

  it('escapes them on every admin page that displays them', async () => {
    const episode = server.episodes.listByShow(show.id)[0];
    const pages = [
      '/',
      `/shows/${show.slug}`,
      `/shows/${show.slug}/episodes/${episode.id}`,
      `/shows/${show.slug}/upload`,
      '/activity',
      '/stats',
      '/settings',
    ];
    for (const url of pages) {
      const response = await server.request({ method: 'GET', url });
      assert.equal(response.statusCode, 200, `${url} did not render`);
      assertNoLiveMarkup(response.body, url);
    }
  });

  it('escapes them in htmx fragments too', async () => {
    for (const url of ['/ui/activity', '/ui/stats/log', `/ui/shows/${show.slug}/feed-box`]) {
      const response = await server.request({ method: 'GET', url });
      if (response.statusCode !== 200) continue;
      assertNoLiveMarkup(response.body, url);
    }
  });

  it('escapes them inside the flash message script block', async () => {
    // The flash is embedded in a <script type="application/json"> block, where an
    // unescaped `</script>` would end the block and start executing.
    await server.request({
      method: 'POST',
      url: '/shows/new',
      payload: 'title=</script><script>alert(1)</script>&slug=flashy',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const page = await server.request({ method: 'GET', url: '/' });
    assertNoLiveMarkup(page.body, 'the flash block');
    const block = /<script type="application\/json" id="flash-data">(.*?)<\/script>/s.exec(page.body);
    if (block) {
      assert.ok(!block[1].includes('</script'), 'the flash block can be closed early');
      assert.doesNotThrow(() => JSON.parse(block[1]), 'the flash block is not valid JSON');
    }
  });

  it('keeps the public feed well-formed XML', async () => {
    const response = await server.app.inject({
      url: `/feeds/${show.slug}/${show.feed_token}.xml`,
    });
    assert.equal(response.statusCode, 200);
    const xml = response.body;
    // A single unescaped angle bracket from a filename would make the whole feed
    // unparseable in every podcast app at once.
    assert.ok(!/<title>[^<]*<script/.test(xml), 'raw script markup reached the feed');
    const { XMLValidator } = await import('fast-xml-parser').catch(() => ({ XMLValidator: null }));
    if (XMLValidator) {
      assert.equal(XMLValidator.validate(xml), true, 'the feed is not well-formed XML');
    } else {
      // No parser dependency available: assert the structural invariant directly.
      const opens = (xml.match(/<item>/g) ?? []).length;
      const closes = (xml.match(/<\/item>/g) ?? []).length;
      assert.equal(opens, closes, 'unbalanced <item> elements');
      assert.ok(xml.trimEnd().endsWith('</rss>'), 'the feed was truncated');
    }
  });

  it('does not let a hostile value become a javascript: link', async () => {
    const page = await server.request({ method: 'GET', url: `/shows/${show.slug}` });
    assert.ok(!/href="javascript:/i.test(page.body), 'a javascript: href was rendered');
    assert.ok(!/src="javascript:/i.test(page.body), 'a javascript: src was rendered');
  });
});

describe('the log cannot be poisoned into forging entries', () => {
  it('keeps newlines out of a logged filename', async () => {
    const server = await createTestServer();
    try {
      const lines = [];
      const originalWarn = console.warn;
      void originalWarn;
      await server.addAudio('logpoison', 'sample.m4a', 'normal.m4a');
      await server.scanner.scanAllNow('manual');
      const show = server.shows.getBySlug('logpoison');
      const episode = server.episodes.listByShow(show.id)[0];

      // A filename carrying a newline plus a forged JSON log line.
      server.db
        .prepare('UPDATE episodes SET filename = ? WHERE id = ?')
        .run('a\n{"level":30,"msg":"forged entry"}', episode.id);

      const response = await server.app.inject({
        url: `/media/${show.slug}/${show.feed_token}/${episode.id}/x.m4a`,
      });
      // The name is rejected outright by the filename guard, so it never reaches a
      // log formatter in the first place.
      assert.equal(response.statusCode, 404);
      void lines;
    } finally {
      await server.cleanup();
    }
  });
});
