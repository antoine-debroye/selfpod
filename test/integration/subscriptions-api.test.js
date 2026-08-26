import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { FIXTURE_DIR } from '../helpers/harness.js';
import { createTestServer } from '../helpers/http.js';
import { SETTING_KEYS } from '../../src/services/settings.js';

const AUDIO = readFileSync(join(FIXTURE_DIR, 'sample.mp3'));

let server;
let sentinel;
let origin;
let feedBody;
let respond;
let show;

function rss(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Tape Club</title><language>en-gb</language>${items.join('')}
</channel></rss>`;
}

function item({ guid, title, minutes = 30 }) {
  return `<item><title>${title}</title><guid>${guid}</guid>
<pubDate>${new Date('2025-03-04T09:00:00Z').toUTCString()}</pubDate>
<itunes:duration>${minutes * 60}</itunes:duration>
<enclosure url="${origin}/audio/${guid}.mp3" type="audio/mpeg" length="5000"/></item>`;
}

beforeEach(async () => {
  respond = null;

  sentinel = createServer((req, res) => {
    if (respond) return respond(req, res);
    if (req.url.startsWith('/audio/')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(AUDIO);
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    return res.end(feedBody);
  });
  await new Promise((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${sentinel.address().port}`;
  // Built after `origin` exists: item() bakes the enclosure URL in, so constructing
  // the feed first pointed every episode at the previous test's port.
  feedBody = rss([item({ guid: 'a', title: 'An interview' })]);

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

const json = { 'content-type': 'application/json' };

function create(payload = {}) {
  return server.request({
    method: 'POST',
    url: `/api/shows/${show.id}/subscriptions`,
    payload: { feedUrl: `${origin}/feed.xml`, ...payload },
    headers: json,
  });
}

describe('creating and reading a subscription over the API', () => {
  it('creates one and reports what it will do', async () => {
    const response = await create({ includeKeywords: 'interview', backfillCount: 3 });

    assert.equal(response.statusCode, 201);
    const { subscription } = response.json();
    assert.equal(subscription.showId, show.id);
    assert.deepEqual(subscription.includeKeywords, ['interview']);
    assert.equal(subscription.backfillCount, 3);
    assert.equal(subscription.enabled, true);
    assert.equal(subscription.bootstrapped, false);
  });

  it('rejects a bad URL with the field the user typed into', async () => {
    const response = await create({ feedUrl: 'http://192.168.1.1/feed.xml' });

    assert.equal(response.statusCode, 422);
    const body = response.json();
    assert.equal(body.error.code, 'validation_failed');
    assert.match(body.error.fields.feedUrl, /private or local network/);
  });

  it('reads back the subscription for a show', async () => {
    await create();
    const response = await server.get(`/api/shows/${show.id}/subscriptions`, { authed: true });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().subscription);
  });

  it('reports how many refusals a rule change would bring back', async () => {
    const { subscription } = (await create({ excludeKeywords: 'interview' })).json();
    await server.request({ method: 'POST', url: `/api/subscriptions/${subscription.id}/poll` });

    const response = await server.request({
      method: 'PATCH',
      url: `/api/subscriptions/${subscription.id}`,
      payload: { excludeKeywords: '' },
      headers: json,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reopened, 1, 'the UI has to be able to say "1 will be re-checked"');
  });

  it('says plainly that deleting the subscription keeps the episodes', async () => {
    const { subscription } = (await create()).json();
    const response = await server.request({ method: 'DELETE', url: `/api/subscriptions/${subscription.id}` });

    assert.equal(response.statusCode, 200);
    assert.match(response.json().note, /untouched/);
    assert.equal(server.subscriptions.get(subscription.id), null);
    // Removal and file deletion are separate acts here, as everywhere else.
    assert.equal(server.episodes.listByShow(show.id).length, 1, 'the existing episode is still there');
  });
});

describe('polling and previewing over the API', () => {
  it('polls on demand and reports what happened', async () => {
    const { subscription } = (await create({ backfillCount: 10 })).json();

    const response = await server.request({
      method: 'POST',
      url: `/api/subscriptions/${subscription.id}/poll`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().result.downloaded, 1);
  });

  it('refuses a second manual poll within the minute', async () => {
    // Checked against the persisted timestamp, so a restart does not hand out a
    // fresh allowance against someone else's server.
    const { subscription } = (await create()).json();
    await server.request({ method: 'POST', url: `/api/subscriptions/${subscription.id}/poll` });
    const again = await server.request({ method: 'POST', url: `/api/subscriptions/${subscription.id}/poll` });

    assert.equal(again.statusCode, 400);
    assert.match(again.json().error.message, /someone else's server/);
  });

  it('previews without recording or downloading anything', async () => {
    feedBody = rss([
      item({ guid: 'a', title: 'An interview' }),
      item({ guid: 'b', title: 'Bonus content' }),
    ]);

    const response = await server.request({
      method: 'POST',
      url: '/api/subscriptions/preview',
      payload: { feedUrl: `${origin}/feed.xml`, excludeKeywords: 'bonus' },
      headers: json,
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.matchCount, 1);
    assert.equal(body.items[1].keep, false);
    assert.match(body.items[1].detail, /bonus/);
    assert.equal(server.db.prepare('SELECT COUNT(*) AS n FROM feed_items').get().n, 0);
  });

  it('rate limits previews', async () => {
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await server.request({
        method: 'POST',
        url: '/api/subscriptions/preview',
        payload: { feedUrl: `${origin}/feed.xml` },
        headers: json,
      });
      statuses.push(response.statusCode);
    }
    assert.ok(statuses.includes(429), `never limited: ${statuses.join(',')}`);
  });
});

describe('the ledger over the API', () => {
  it('lists every decision with a sentence for each refusal', async () => {
    feedBody = rss([
      item({ guid: 'a', title: 'An interview' }),
      item({ guid: 'b', title: 'Bonus content' }),
    ]);
    const { subscription } = (await create({ excludeKeywords: 'bonus', backfillCount: 10 })).json();
    await server.request({ method: 'POST', url: `/api/subscriptions/${subscription.id}/poll` });

    const response = await server.get(`/api/subscriptions/${subscription.id}/items`, { authed: true });
    assert.equal(response.statusCode, 200);

    const { items, counts } = response.json();
    assert.equal(counts.total, 2);
    const refused = items.find((row) => row.decision === 'rejected_declared');
    assert.match(refused.detail, /bonus/);
    const kept = items.find((row) => row.decision === 'downloaded');
    assert.ok(kept.episodeId, 'a downloaded item knows which episode it became');
    assert.equal(kept.episodeStatus, 'active', 'and the episode\'s real state, not an assumption');
  });

  it('filters by decision, and refuses a decision it does not record', async () => {
    const { subscription } = (await create({ backfillCount: 10 })).json();
    await server.request({ method: 'POST', url: `/api/subscriptions/${subscription.id}/poll` });

    const ok = await server.get(`/api/subscriptions/${subscription.id}/items?decision=downloaded`, { authed: true });
    assert.equal(ok.json().items.length, 1);

    const bad = await server.get(
      `/api/subscriptions/${subscription.id}/items?decision=${encodeURIComponent("x' OR '1'='1")}`,
      { authed: true },
    );
    assert.ok(bad.statusCode >= 400);
  });

  it('offers a way back from a deletion', async () => {
    const { subscription } = (await create({ backfillCount: 10 })).json();
    await server.request({ method: 'POST', url: `/api/subscriptions/${subscription.id}/poll` });

    const [row] = server.subscriptions.items({ subscriptionId: subscription.id });
    const episode = server.episodes.get(row.episode_id);
    await server.episodes.deleteWithFile(episode.id);
    await server.remoteFeeds.reconcile(subscription.id);
    assert.equal(server.subscriptions.getItem(row.id).decision, 'deleted_by_user');

    const response = await server.request({
      method: 'POST',
      url: `/api/subscriptions/${subscription.id}/items/${row.id}/redownload`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().item.decision, 'matched');
  });

  it('will not re-queue an episode whose audio is on a private address', async () => {
    // A button that overrode the address guard would be a button that reaches the LAN.
    feedBody = rss([
      `<item><title>One</title><guid>a</guid>
<enclosure url="http://192.168.1.50/x.mp3" type="audio/mpeg" length="10"/></item>`,
    ]);
    const { subscription } = (await create({ backfillCount: 10 })).json();
    await server.request({ method: 'POST', url: `/api/subscriptions/${subscription.id}/poll` });

    const [row] = server.subscriptions.items({ subscriptionId: subscription.id });
    assert.equal(row.decision, 'rejected_blocked');

    const response = await server.request({
      method: 'POST',
      url: `/api/subscriptions/${subscription.id}/items/${row.id}/redownload`,
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /private or local address/);
  });
});

describe('the whole surface is admin-only and same-origin', () => {
  const routes = [
    ['GET', () => `/api/shows/${show.id}/subscriptions`],
    ['POST', () => `/api/shows/${show.id}/subscriptions`],
    ['POST', () => '/api/subscriptions/preview'],
  ];

  it('refuses an anonymous request', async () => {
    for (const [method, url] of routes) {
      const response = await server.app.inject({
        method,
        url: url(),
        headers: { 'sec-fetch-site': 'same-origin', ...json },
        payload: method === 'POST' ? { feedUrl: `${origin}/feed.xml` } : undefined,
      });
      assert.equal(response.statusCode, 401, `${method} ${url()} was answered ${response.statusCode}`);
    }
  });

  it('refuses a cross-site request carrying the admin cookie', async () => {
    // A malicious page must not be able to make the admin's browser subscribe SelfPod
    // to an address of its choosing.
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/subscriptions/preview',
      headers: {
        cookie: server.cookie,
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.example',
        ...json,
      },
      payload: { feedUrl: `${origin}/feed.xml` },
    });
    assert.ok(response.statusCode >= 400, `cross-site POST returned ${response.statusCode}`);
  });

  it('refuses everything while the feature is switched off', async () => {
    server.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '0' });

    const created = await create();
    assert.equal(created.statusCode, 400);
    assert.match(created.json().error.message, /switched off/);

    const preview = await server.request({
      method: 'POST',
      url: '/api/subscriptions/preview',
      payload: { feedUrl: `${origin}/feed.xml` },
      headers: json,
    });
    assert.equal(preview.statusCode, 400);
  });
});
