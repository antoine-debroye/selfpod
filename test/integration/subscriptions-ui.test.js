import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FIXTURE_DIR } from '../helpers/harness.js';
import { createTestServer } from '../helpers/http.js';
import { SETTING_KEYS } from '../../src/services/settings.js';

/**
 * The admin pages, rendered for real.
 *
 * Every form here has to work with JavaScript switched off — a plain POST that
 * redirects with a flash — and return an htmx fragment when the header is present.
 * Both paths are exercised, because only one of them is ever clicked during
 * development and it is not the one that breaks.
 */

const AUDIO = readFileSync(join(FIXTURE_DIR, 'sample.mp3'));

let server;
let sentinel;
let origin;
let feedBody;
let show;

beforeEach(async () => {
  sentinel = createServer((req, res) => {
    if (req.url.startsWith('/audio/')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(AUDIO);
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    return res.end(feedBody);
  });
  await new Promise((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${sentinel.address().port}`;
  feedBody = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Tape Club</title>
<item><title>An interview</title><guid>a</guid>
<pubDate>${new Date('2025-03-04T09:00:00Z').toUTCString()}</pubDate>
<itunes:duration>1800</itunes:duration>
<enclosure url="${origin}/audio/a.mp3" type="audio/mpeg" length="5000"/></item>
<item><title>Bonus content</title><guid>b</guid>
<pubDate>${new Date('2025-03-03T09:00:00Z').toUTCString()}</pubDate>
<itunes:duration>600</itunes:duration>
<enclosure url="${origin}/audio/b.mp3" type="audio/mpeg" length="5000"/></item>
</channel></rss>`;

  server = await createTestServer({ env: { ALLOW_PRIVATE_FEED_HOSTS: '127.0.0.1' } });
  await server.login();
  server.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '1' });
  await server.addAudio('tape-club', 'sample.m4a', 'existing.m4a');
  await server.scanner.scanAllNow('manual');
  show = server.shows.getBySlug('tape-club');
});

afterEach(async () => {
  await server.cleanup();
  await new Promise((resolve) => sentinel.close(resolve));
});

const form = { 'content-type': 'application/x-www-form-urlencoded' };
const htmx = { ...form, 'hx-request': 'true' };

/**
 * Posts a real form body.
 *
 * `light-my-request` JSON-stringifies an object payload whatever the content-type
 * says, so passing one alongside a form content-type sends JSON that the formbody
 * parser then finds no fields in — the handler sees an empty body and rejects the
 * form. Encoding it here is what a browser actually puts on the wire.
 */
function post(url, payload, headers = form) {
  return server.request({
    method: 'POST',
    url,
    payload: new URLSearchParams(payload).toString(),
    headers,
  });
}

describe('the subscription page', () => {
  it('renders an empty form before anything is followed', async () => {
    const response = await server.get('/shows/tape-club/subscription', { authed: true });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Follow a feed/);
    assert.match(response.body, /Feed address/);
    assert.match(response.body, /Only episodes whose title contains/);
  });

  it('says the feature is off, and where to turn it on', async () => {
    server.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '0' });
    const response = await server.get('/shows/tape-club/subscription', { authed: true });

    assert.match(response.body, /switched off/i);
    assert.match(response.body, /href="\/settings"/, 'and links to where the switch is');
  });

  it('requires a signed-in admin', async () => {
    const response = await server.app.inject({ url: '/shows/tape-club/subscription' });
    assert.ok([302, 303, 401].includes(response.statusCode), `got ${response.statusCode}`);
  });
});

describe('following a feed without JavaScript', () => {
  it('saves from a plain form post and redirects with a flash', async () => {
    const response = await post(`/ui/shows/tape-club/subscription`, {
      feedUrl: `${origin}/feed.xml`,
      excludeKeywords: 'bonus',
      minDurationMinutes: '20',
      backfillCount: '10',
    });

    assert.equal(response.statusCode, 303, 'a no-JS form must redirect, not return a fragment');
    assert.equal(response.headers.location, '/shows/tape-club/subscription');

    const subscription = server.subscriptions.getForShow(show.id);
    assert.ok(subscription);
    // Minutes in the form, seconds in the database. Storing 20 rather than 1200 would
    // be a filter that matches everything, with nothing to say why.
    assert.equal(subscription.min_duration_seconds, 1200);
    assert.deepEqual(JSON.parse(subscription.exclude_keywords), ['bonus']);
  });

  it('redirects with the problem when the form is wrong', async () => {
    const response = await post('/ui/shows/tape-club/subscription', {
      feedUrl: 'http://192.168.1.1/feed.xml',
    });
    assert.equal(response.statusCode, 303);
    assert.equal(server.subscriptions.getForShow(show.id), null);
  });
});

describe('following a feed with htmx', () => {
  it('returns the re-rendered form rather than a redirect', async () => {
    const response = await post(
      '/ui/shows/tape-club/subscription',
      { feedUrl: `${origin}/feed.xml`, backfillCount: '10' },
      htmx,
    );

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Following a feed/, 'the form now knows it is following one');
    assert.match(response.body, /Saved/);
  });

  it('re-renders with the field error and the user\'s own input', async () => {
    // A rejected form that comes back empty makes the user retype everything, which
    // is how people give up.
    const response = await post(
      '/ui/shows/tape-club/subscription',
      { feedUrl: 'not a url', excludeKeywords: 'bonus, trailer' },
      htmx,
    );

    assert.equal(response.statusCode, 422);
    assert.match(response.body, /field-error/);
    assert.match(response.body, /bonus, trailer/, 'their keywords must still be in the box');
    assert.match(response.body, /not a url/, 'and so must what they typed');
  });

  it('tells the user how many refusals a looser rule will bring back', async () => {
    await post('/ui/shows/tape-club/subscription', {
      feedUrl: `${origin}/feed.xml`,
      excludeKeywords: 'bonus',
      backfillCount: '10',
    });
    const subscription = server.subscriptions.getForShow(show.id);
    await server.remoteFeeds.pollNow(subscription.id);

    const response = await post(
      '/ui/shows/tape-club/subscription',
      { feedUrl: `${origin}/feed.xml`, excludeKeywords: '', backfillCount: '10' },
      htmx,
    );

    assert.match(response.body, /will be re-checked/, 'a setting, not a surprise');
  });
});

describe('previewing before committing', () => {
  it('shows each episode\'s fate without downloading anything', async () => {
    const response = await post(
      '/ui/shows/tape-club/subscription/preview',
      { feedUrl: `${origin}/feed.xml`, excludeKeywords: 'bonus' },
      htmx,
    );

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /An interview/);
    assert.match(response.body, /Will download/);
    assert.match(response.body, /Skipped/);
    assert.match(response.body, /bonus/, 'and says which keyword did it');
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM feed_items').get().n, 0);
  });

  it('shows a readable problem rather than a stack trace', async () => {
    const response = await post(
      '/ui/shows/tape-club/subscription/preview',
      { feedUrl: 'http://192.168.1.1/feed.xml' },
      htmx,
    );
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /private or local network/);
    assert.ok(!response.body.includes('at Object.'), 'no stack traces in user-facing text');
  });
});

describe('the ledger on the page', () => {
  it('lists every decision in words, not enum values', async () => {
    await post('/ui/shows/tape-club/subscription', {
      feedUrl: `${origin}/feed.xml`,
      excludeKeywords: 'bonus',
      backfillCount: '10',
    });
    const subscription = server.subscriptions.getForShow(show.id);
    await server.remoteFeeds.pollNow(subscription.id);

    const response = await server.get('/shows/tape-club/subscription', { authed: true });

    assert.match(response.body, /In your feed/, 'a downloaded episode');
    assert.match(response.body, /Didn&#39;t match your rules|Didn't match your rules/, 'and a refused one');
    assert.ok(
      !response.body.includes('rejected_declared<'),
      'a raw enum must never be what the user reads',
    );
  });

  it('filters the ledger by decision', async () => {
    await post('/ui/shows/tape-club/subscription', {
      feedUrl: `${origin}/feed.xml`,
      excludeKeywords: 'bonus',
      backfillCount: '10',
    });
    const subscription = server.subscriptions.getForShow(show.id);
    await server.remoteFeeds.pollNow(subscription.id);

    const response = await server.get(
      `/ui/subscriptions/${subscription.id}/items?decision=downloaded`,
      { authed: true },
    );
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /An interview/);
    assert.ok(!response.body.includes('Bonus content'), 'the filter must actually filter');
  });

  /**
   * A ledger with more rows than one page.
   *
   * Written straight into the service rather than served from the sentinel feed: the
   * question under test is what the page does with 120 rows, not whether the poller
   * can produce them, and a 120-item feed would make every other assertion in this
   * file slower for nothing.
   */
  function fillLedger(subscriptionId, count) {
    for (let i = 0; i < count; i += 1) {
      const item = server.subscriptions.upsertItem(subscriptionId, {
        guid: `filler-${i}`,
        guidSource: 'guid',
        title: `Filler episode ${i}`,
        pubDate: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
      });
      server.subscriptions.markItem(item.id, {
        decision: 'skipped_backfill',
        reject_reason: 'backfill_limit',
        reject_detail: 'Older than the 5 most recent matching episodes.',
      });
    }
  }

  it('searches the ledger by title', async () => {
    await post('/ui/shows/tape-club/subscription', {
      feedUrl: `${origin}/feed.xml`,
      backfillCount: '10',
    });
    const subscription = server.subscriptions.getForShow(show.id);
    await server.remoteFeeds.pollNow(subscription.id);

    const response = await server.get('/shows/tape-club/subscription?q=bonus', { authed: true });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Bonus content/);
    /* Rows, not a substring of the whole page: "An interview" also appears inside the
       other row's tooltip, which is the ledger explaining itself rather than the
       filter leaking. */
    const rows = response.body.match(/class="ledger-what"/g) ?? [];
    assert.equal(rows.length, 1, 'the search must actually narrow the table');
    // The same filter, submitted the way a browser without JavaScript submits it.
    assert.match(response.body, /name="q"[^>]*value="bonus"/, 'and the box still holds what was typed');
  });

  it('says how much of the ledger it is showing, and can show the rest', async () => {
    await post('/ui/shows/tape-club/subscription', { feedUrl: `${origin}/feed.xml` });
    const subscription = server.subscriptions.getForShow(show.id);
    fillLedger(subscription.id, 120);

    const page = await server.get('/shows/tape-club/subscription', { authed: true });
    assert.match(page.body, /50 of 120 shown/, 'a truncated table must say so');

    const older = await server.get(
      `/ui/subscriptions/${subscription.id}/items/rows?offset=50`,
      { authed: true },
    );
    assert.equal(older.statusCode, 200);
    assert.match(older.body, /100 of 120 shown/);
    assert.ok(older.body.trimStart().startsWith('<tr'), 'a tbody swap may contain nothing but rows');
  });

  it('keeps the filter when one episode is fetched by hand', async () => {
    await post('/ui/shows/tape-club/subscription', {
      feedUrl: `${origin}/feed.xml`,
      excludeKeywords: 'bonus',
      backfillCount: '10',
    });
    const subscription = server.subscriptions.getForShow(show.id);
    await server.remoteFeeds.pollNow(subscription.id);
    const refused = server.subscriptions
      .items({ subscriptionId: subscription.id, decision: 'rejected_declared' })[0];

    const response = await post(
      `/ui/subscriptions/${subscription.id}/items/${refused.id}/redownload?decision=rejected_declared`,
      {},
    );

    assert.equal(response.statusCode, 303);
    assert.equal(
      response.headers.location,
      '/shows/tape-club/subscription?decision=rejected_declared',
      'a no-JS fetch must come back to the view it was started from',
    );
  });

  it('narrows the ledger to what was published in a window', async () => {
    await post('/ui/shows/tape-club/subscription', { feedUrl: `${origin}/feed.xml` });
    const subscription = server.subscriptions.getForShow(show.id);
    /* One item published this morning and one two years ago, so "last 7 days" has
       exactly one right answer whenever this test happens to run. */
    const recent = server.subscriptions.upsertItem(subscription.id, {
      guid: 'fresh',
      guidSource: 'guid',
      title: 'Published today',
      pubDate: new Date().toISOString(),
    });
    server.subscriptions.upsertItem(subscription.id, {
      guid: 'ancient',
      guidSource: 'guid',
      title: 'Published long ago',
      pubDate: new Date(Date.now() - 730 * 24 * 3600 * 1000).toISOString(),
    });
    assert.ok(recent);

    const response = await server.get('/shows/tape-club/subscription?published=7d', { authed: true });

    assert.match(response.body, /Published today/);
    assert.ok(!response.body.includes('Published long ago'), 'the window must exclude what falls outside it');

    // An unknown key must not quietly become the stats default of thirty days.
    const nonsense = await server.get('/shows/tape-club/subscription?published=banana', { authed: true });
    assert.match(nonsense.body, /Published long ago/);
  });

  it('queues everything that was ticked, without JavaScript', async () => {
    await post('/ui/shows/tape-club/subscription', {
      feedUrl: `${origin}/feed.xml`,
      excludeKeywords: 'bonus',
      backfillCount: '10',
    });
    const subscription = server.subscriptions.getForShow(show.id);
    await server.remoteFeeds.pollNow(subscription.id);
    const ledger = server.subscriptions.items({ subscriptionId: subscription.id });
    const ids = ledger.map((row) => row.id);

    const response = await post(
      `/ui/subscriptions/${subscription.id}/items/redownload`,
      // Repeated fields, exactly as a browser posts a column of checkboxes.
      ids.map((id) => ['itemIds', String(id)]),
    );

    assert.equal(response.statusCode, 303);
    for (const id of ids) {
      assert.equal(server.subscriptions.getItem(id).decision, 'matched', `item ${id} is queued`);
    }
  });

  it('says so rather than pretending, when nothing was ticked', async () => {
    await post('/ui/shows/tape-club/subscription', { feedUrl: `${origin}/feed.xml` });
    const subscription = server.subscriptions.getForShow(show.id);

    // Asked the way htmx asks, so the answer is the re-rendered card and the message
    // it carries rather than a redirect whose flash this test cannot read.
    const response = await post(`/ui/subscriptions/${subscription.id}/items/redownload`, {}, htmx);

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Nothing was selected/, 'an empty selection must say so');
    assert.match(response.body, /id="subscription-items"/, 'and the table comes back with it');
  });

  it('refuses a ticked episode whose audio is on a private address', async () => {
    await post('/ui/shows/tape-club/subscription', { feedUrl: `${origin}/feed.xml` });
    const subscription = server.subscriptions.getForShow(show.id);
    const item = server.subscriptions.upsertItem(subscription.id, {
      guid: 'blocked',
      guidSource: 'guid',
      title: 'On the LAN',
      pubDate: new Date().toISOString(),
    });
    server.subscriptions.markItem(item.id, {
      decision: 'rejected_blocked',
      reject_reason: 'private_address',
      reject_detail: 'Its audio is on a private address.',
    });

    await post(`/ui/subscriptions/${subscription.id}/items/redownload`, {
      itemIds: String(item.id),
    });

    assert.equal(
      server.subscriptions.getItem(item.id).decision,
      'rejected_blocked',
      'a bulk action must not reach an address the guard refused',
    );
  });

  it('offers no tick box for an episode it will never fetch', async () => {
    await post('/ui/shows/tape-club/subscription', { feedUrl: `${origin}/feed.xml` });
    const subscription = server.subscriptions.getForShow(show.id);
    const item = server.subscriptions.upsertItem(subscription.id, {
      guid: 'blocked',
      guidSource: 'guid',
      title: 'On the LAN',
      pubDate: new Date().toISOString(),
    });
    server.subscriptions.markItem(item.id, { decision: 'rejected_blocked' });

    const response = await server.get('/shows/tape-club/subscription', { authed: true });

    assert.ok(
      !response.body.includes(`value="${item.id}" data-select-item`),
      'a checkbox for an episode the bulk action would drop is a lie',
    );
    assert.match(response.body, /data-select-all/, 'but the page does offer select-all');
  });

  it('pauses and resumes', async () => {
    await post('/ui/shows/tape-club/subscription', { feedUrl: `${origin}/feed.xml` });
    const subscription = server.subscriptions.getForShow(show.id);

    await post(`/ui/subscriptions/${subscription.id}/toggle`, {});
    assert.equal(server.subscriptions.get(subscription.id).enabled, 0);

    await post(`/ui/subscriptions/${subscription.id}/toggle`, {});
    assert.equal(server.subscriptions.get(subscription.id).enabled, 1);
  });

  it('stops following without touching the episodes', async () => {
    await post('/ui/shows/tape-club/subscription', {
      feedUrl: `${origin}/feed.xml`,
      backfillCount: '10',
    });
    const subscription = server.subscriptions.getForShow(show.id);
    await server.remoteFeeds.pollNow(subscription.id);
    const before = server.episodes.listByShow(show.id).length;

    const response = await post(`/ui/subscriptions/${subscription.id}/delete`, {});

    assert.equal(response.statusCode, 303);
    assert.equal(server.subscriptions.getForShow(show.id), null);
    assert.equal(server.episodes.listByShow(show.id).length, before, 'the episodes stay');
  });
});

describe('a remote feed cannot inject markup into the admin UI', () => {
  it('escapes a hostile episode title', async () => {
    // Titles come from a stranger. The CSP blocks <script> and inline handlers, but an
    // injected hx-get with hx-trigger="load" is not script — htmx would simply obey it.
    feedBody = `<?xml version="1.0"?><rss><channel><title>Tape Club</title>
<item><title>&lt;img src=x onerror=alert(1) hx-get="/api/settings" hx-trigger="load"&gt;</title>
<guid>evil</guid><enclosure url="${origin}/audio/e.mp3" type="audio/mpeg" length="10"/></item>
</channel></rss>`;

    await post('/ui/shows/tape-club/subscription', {
      feedUrl: `${origin}/feed.xml`,
      backfillCount: '10',
    });
    const subscription = server.subscriptions.getForShow(show.id);
    await server.remoteFeeds.pollNow(subscription.id);

    const response = await server.get('/shows/tape-club/subscription', { authed: true });

    // Positive control first: the title really is on the page, so "no raw markup"
    // below is not "nothing rendered".
    assert.match(response.body, /&lt;img src=x/, 'the title is shown, escaped');

    // Asserted on the feed's own markup, not on generic patterns. Two earlier
    // versions of this test were wrong in opposite directions: `onerror=alert` does
    // appear on the page — as escaped text inside `&lt;img …&gt;`, where it is inert —
    // and `<script` also appears, because the app ships its own. Neither says
    // anything about whether the *feed's* markup escaped. These do.
    assert.ok(!response.body.includes('<img src=x'), 'the feed opened a real tag');
    assert.ok(
      !response.body.includes('hx-get="/api/settings"'),
      'the feed contributed an htmx attribute the browser would obey',
    );
    // And the whole hostile string survives intact as one escaped run, rather than
    // being partly escaped and partly not.
    assert.match(
      response.body,
      /&lt;img src=x onerror=alert\(1\) hx-get=&quot;\/api\/settings&quot;/,
      'the title must be escaped as a whole, not in pieces',
    );
  });

  it('escapes a hostile title in the preview too', async () => {
    feedBody = `<?xml version="1.0"?><rss><channel><title>&lt;script&gt;alert(1)&lt;/script&gt;</title>
<item><title>&lt;b&gt;bold&lt;/b&gt;</title><guid>a</guid>
<enclosure url="${origin}/audio/a.mp3" type="audio/mpeg" length="10"/></item></channel></rss>`;

    const response = await post(
      '/ui/shows/tape-club/subscription/preview',
      { feedUrl: `${origin}/feed.xml` },
      htmx,
    );

    assert.ok(!response.body.includes('<script>alert'), 'a script tag reached the preview');
    assert.ok(!response.body.includes('<b>bold</b>'), 'raw markup reached the preview');
    assert.match(response.body, /bold/, 'but the text is still shown');
  });
});

describe('the switch that grants network access', () => {
  it('is on the settings page, and says what it actually does', async () => {
    const response = await server.get('/settings', { authed: true });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Follow podcast feeds/);
    assert.match(
      response.body,
      /only thing that makes SelfPod fetch from the internet/,
      'the operator should know what they are granting, not just that a switch exists',
    );
  });

  it('turns on and off without JavaScript', async () => {
    server.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '0' });

    const on = await post('/ui/settings/subscriptions', { subscriptionsEnabled: '1' });
    assert.equal(on.statusCode, 303);
    assert.equal(server.settings.subscriptionsEnabled(), true);

    // An unchecked checkbox sends nothing at all, which has to mean off.
    const off = await post('/ui/settings/subscriptions', {});
    assert.equal(off.statusCode, 303);
    assert.equal(server.settings.subscriptionsEnabled(), false);
  });

  it('can be turned on even when the environment variable never was', async () => {
    // The upgrade path. SUBSCRIPTIONS_ENABLED only seeds the setting on first run, so
    // an install created before this feature existed has it absent — and would have
    // no way to switch it on without deleting the database if this route did not
    // exist.
    const fresh = await createTestServer();
    try {
      await fresh.login();
      assert.equal(fresh.settings.subscriptionsEnabled(), false, 'off on a fresh install');

      const response = await fresh.request({
        method: 'PATCH',
        url: '/api/settings',
        payload: { subscriptionsEnabled: true },
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(fresh.settings.subscriptionsEnabled(), true);
    } finally {
      await fresh.cleanup();
    }
  });
});
