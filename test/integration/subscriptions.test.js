import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ITEM_DECISION } from '../../src/constants.js';
import { SETTING_KEYS } from '../../src/services/settings.js';
import { FIXTURE_DIR, createTestInstance } from '../helpers/harness.js';

/**
 * The poller, driven against a real HTTP server rather than a mock.
 *
 * The harness builds the whole service graph with the **real** guarded fetcher — no
 * injected classifier, no relaxed rules — so everything these tests exercise is what
 * would run on a NAS. The sentinel is reachable only because 127.0.0.1 is named in
 * ALLOW_PRIVATE_FEED_HOSTS, which is an exemption for exactly one address and leaves
 * the scheme, credential, redirect, self-reference and size rules fully in force.
 *
 * Downloading is not wired up yet, so a keeper stops at `matched`. That is worth
 * testing in its own right: it is the only moment at which "polling writes nothing at
 * all into a show folder" can be proven rather than asserted.
 */

let app;
let server;
let requests;
let feedBody;
let respond;
let origin;

const AUDIO = readFileSync(join(FIXTURE_DIR, 'sample.mp3'));

/**
 * Trailing bytes that differ per episode.
 *
 * Derived from the whole URL rather than its length: `/audio/b.mp3` and
 * `/audio/c.mp3` are the same length, so padding by length produced identical files
 * and the duplicate check refused them — correctly, and confusingly.
 */
function distinctPadding(url) {
  const seed = [...url].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 251, 7);
  return Buffer.alloc(32 + seed, seed);
}

function rss(items, { channel = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Tape Club</title><language>en-gb</language>${channel}
${items.join('\n')}
</channel></rss>`;
}

function item({ guid, title, minutes = 30, date = '2025-03-04', url = null }) {
  return `<item><title>${title}</title><guid isPermaLink="false">${guid}</guid>
<pubDate>${new Date(`${date}T09:00:00Z`).toUTCString()}</pubDate>
<itunes:duration>${minutes * 60}</itunes:duration>
<enclosure url="${url ?? `${origin}/audio/${guid}.mp3`}" type="audio/mpeg" length="5000000"/></item>`;
}

beforeEach(async () => {
  requests = [];
  respond = null;
  feedBody = rss([]);

  server = createServer((req, res) => {
    requests.push({ url: req.url, headers: { ...req.headers } });
    if (respond) return respond(req, res);
    if (req.url.startsWith('/audio/')) {
      // Real audio, not a placeholder: the download stage reads the file with
      // music-metadata to measure it and to decide whether it is audio at all, so a
      // stub body would be refused — correctly — and prove nothing.
      //
      // And *distinct* audio per episode, because SelfPod identifies episodes by
      // content: serving one file for every item makes them byte-identical, and the
      // duplicate check rejects the second and third exactly as it should. Padding
      // each one differently is the smallest way to make them genuinely different
      // recordings, which is what a real feed has.
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(Buffer.concat([AUDIO, distinctPadding(req.url)]));
    }
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { etag: '"v1"' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"' });
    return res.end(feedBody);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  app = await createTestInstance({ env: { ALLOW_PRIVATE_FEED_HOSTS: '127.0.0.1' } });
  app.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '1' });
  await app.makeShowFolder('tape-club');
  await app.scanner.scanAllNow('manual');
});

afterEach(async () => {
  await app.cleanup();
  await new Promise((resolve) => server.close(resolve));
});

function subscribe(patch = {}) {
  const show = app.shows.getBySlug('tape-club');
  return app.subscriptions.create(show.id, { feedUrl: `${origin}/feed.xml`, ...patch });
}

async function showFolderContents() {
  return readdir(join(app.config.showsDir, 'tape-club'));
}

describe('an episode queued by hand', () => {
  it('is fetched even when the feed itself has not changed', async () => {
    // "Download again" queues an item and the next poll is meant to collect it. But a
    // feed that has not changed answers 304, and the poller used to stop right there —
    // so the queued item sat waiting for the publisher to post something else, which
    // on a quiet show is days. The button appeared to do nothing and said nothing.
    //
    // A 304 means "no new items". It does not mean "nothing to do".
    feedBody = rss([item({ guid: 'a', title: 'An interview with someone', minutes: 40 })]);
    const subscription = subscribe({ backfillCount: 10 });

    await app.remoteFeeds.pollNow(subscription.id);
    const [downloaded] = app.subscriptions.items({ subscriptionId: subscription.id });
    assert.equal(downloaded.decision, ITEM_DECISION.DOWNLOADED, 'the fixture never downloaded');

    // Delete it the way an owner would, then ask for it back.
    const episode = app.episodes.get(downloaded.episode_id);
    await app.episodes.deleteWithFile(episode.id);
    app.subscriptions.markItem(downloaded.id, {
      decision: ITEM_DECISION.MATCHED,
      episode_id: null,
      filename: null,
      identity_key: null,
    });

    // The feed is unchanged, so this poll is answered 304.
    const result = await app.remoteFeeds.pollNow(subscription.id);
    assert.equal(result.status, 'not_modified', 'the fixture should have been answered 304');

    const after = app.subscriptions.getItem(downloaded.id);
    assert.equal(
      after.decision,
      ITEM_DECISION.DOWNLOADED,
      'an episode asked for by hand was left queued because the feed had not changed',
    );
    assert.ok((await showFolderContents()).some((name) => name.endsWith('.mp3')), 'no audio came back');
  });
});

describe('polling records a decision for every item', () => {
  it('matches what passes the rules and refuses the rest, with a reason', async () => {
    feedBody = rss([
      item({ guid: 'a', title: 'An interview with someone', minutes: 40 }),
      item({ guid: 'b', title: 'Bonus: an interview extra', minutes: 40 }),
      item({ guid: 'c', title: 'A short interview', minutes: 4 }),
      item({ guid: 'd', title: 'Unrelated news roundup', minutes: 40 }),
    ]);
    const subscription = subscribe({
      includeKeywords: ['interview'],
      excludeKeywords: ['bonus'],
      minDurationSeconds: 1200,
      backfillCount: 10,
    });

    const result = await app.remoteFeeds.pollNow(subscription.id);
    assert.equal(result.status, 'ok');
    assert.equal(result.matched, 1);
    assert.equal(result.rejected, 3);

    const byGuid = Object.fromEntries(
      app.subscriptions.items({ subscriptionId: subscription.id, limit: 100 }).map((row) => [row.remote_guid, row]),
    );
    assert.equal(byGuid.a.decision, ITEM_DECISION.DOWNLOADED, 'matched is transient; it ends downloaded');
    assert.equal(byGuid.b.decision, ITEM_DECISION.REJECTED_DECLARED);
    assert.match(byGuid.b.reject_detail, /bonus/, 'the sentence must name the keyword');
    assert.equal(byGuid.c.decision, ITEM_DECISION.REJECTED_DECLARED);
    assert.match(byGuid.c.reject_detail, /20:00/, 'and the numbers for a duration refusal');
    assert.equal(byGuid.d.decision, ITEM_DECISION.REJECTED_DECLARED);
  });

  it('downloads what matched and leaves nothing behind for what did not', async () => {
    feedBody = rss([
      item({ guid: 'keep', title: 'An interview' }),
      item({ guid: 'drop', title: 'Bonus round' }),
    ]);
    const subscription = subscribe({ excludeKeywords: ['bonus'], backfillCount: 10 });

    const result = await app.remoteFeeds.pollNow(subscription.id);
    assert.equal(result.downloaded, 1);

    const files = await showFolderContents();
    assert.equal(files.length, 1, `expected one file, got ${files.join(', ')}`);
    assert.match(files[0], /interview/i, 'named from the publisher\'s title');
    assert.ok(
      !files.some((name) => name.startsWith('.selfpod-download-')),
      'no staging file may survive a successful run',
    );
  });

  it('never requests the audio of an item it refused', async () => {
    feedBody = rss([item({ guid: 'skipme', title: 'Bonus round' })]);
    const subscription = subscribe({ excludeKeywords: ['bonus'], backfillCount: 10 });

    await app.remoteFeeds.pollNow(subscription.id);

    assert.ok(
      !requests.some((request) => request.url.includes('skipme')),
      `the enclosure of a refused item was fetched: ${requests.map((r) => r.url).join(', ')}`,
    );
    assert.ok(requests.some((request) => request.url === '/feed.xml'), 'the feed itself was fetched');
  });
});

describe('the backfill horizon', () => {
  it('takes the newest N that match, not the newest N overall', async () => {
    feedBody = rss([
      item({ guid: 'n1', title: 'News', date: '2025-03-09' }),
      item({ guid: 'n2', title: 'News', date: '2025-03-08' }),
      item({ guid: 'i1', title: 'Interview one', date: '2025-03-07' }),
      item({ guid: 'i2', title: 'Interview two', date: '2025-03-06' }),
      item({ guid: 'i3', title: 'Interview three', date: '2025-03-05' }),
    ]);
    const subscription = subscribe({ includeKeywords: ['interview'], backfillCount: 2 });

    await app.remoteFeeds.pollNow(subscription.id);

    const rows = Object.fromEntries(
      app.subscriptions.items({ subscriptionId: subscription.id, limit: 100 }).map((r) => [r.remote_guid, r.decision]),
    );
    assert.equal(rows.i1, ITEM_DECISION.DOWNLOADED, 'the newest matching');
    assert.equal(rows.i2, ITEM_DECISION.DOWNLOADED);
    assert.equal(rows.i3, ITEM_DECISION.SKIPPED_BACKFILL, 'older than the horizon');
    assert.equal(rows.n1, ITEM_DECISION.REJECTED_DECLARED, 'refused by the rules, not by the horizon');
  });

  it('sorts by date rather than trusting the feed order', async () => {
    // Some serials publish oldest-first. Taking "the first N in the document" would
    // hand those users their oldest episodes and call them the newest.
    feedBody = rss([
      item({ guid: 'old', title: 'Episode one', date: '2020-01-01' }),
      item({ guid: 'new', title: 'Episode two', date: '2025-03-09' }),
    ]);
    const subscription = subscribe({ backfillCount: 1 });

    await app.remoteFeeds.pollNow(subscription.id);

    const rows = Object.fromEntries(
      app.subscriptions.items({ subscriptionId: subscription.id, limit: 100 }).map((r) => [r.remote_guid, r.decision]),
    );
    assert.equal(rows.new, ITEM_DECISION.DOWNLOADED);
    assert.equal(rows.old, ITEM_DECISION.SKIPPED_BACKFILL);
  });

  it('applies only on the first poll, so later episodes all arrive', async () => {
    feedBody = rss([item({ guid: 'a', title: 'One', date: '2025-03-01' })]);
    const subscription = subscribe({ backfillCount: 1 });
    await app.remoteFeeds.pollNow(subscription.id);

    feedBody = rss([
      item({ guid: 'b', title: 'Two', date: '2025-03-02' }),
      item({ guid: 'c', title: 'Three', date: '2025-03-03' }),
      item({ guid: 'a', title: 'One', date: '2025-03-01' }),
    ]);
    // A changed feed needs a changed validator, or the origin answers 304.
    app.db.prepare('UPDATE feed_subscriptions SET http_etag = NULL WHERE id = ?').run(subscription.id);
    await app.remoteFeeds.pollNow(subscription.id);

    const counts = app.subscriptions.itemCounts(subscription.id);
    assert.equal(counts.downloaded, 3, 'the horizon must not keep applying for ever');
  });

  it('does not file a warning for everything the horizon left behind', async () => {
    // An eight-hundred-item feed would otherwise report fifty warnings and "…and 745
    // more" on the very first poll, which reads as a failure when nothing failed.
    feedBody = rss(
      Array.from({ length: 40 }, (_, i) =>
        item({ guid: `g${i}`, title: `Episode ${i}`, date: `2025-02-${String((i % 27) + 1).padStart(2, '0')}` }),
      ),
    );
    const subscription = subscribe({ backfillCount: 2 });

    await app.remoteFeeds.pollNow(subscription.id);

    // The scanner also files rows under this trigger — it is run by the download
    // stage — so pick the poll's own row rather than whichever came first.
    const entry = app.activity
      .list({ limit: 20 })
      .find((row) => row.trigger === 'subscription' && row.note?.startsWith('Checked'));
    assert.ok(entry, 'the poll was logged');
    assert.equal(entry.warnings?.length ?? 0, 0, 'a backfill skip is not a warning');
    assert.match(entry.note, /left behind/, 'but the summary still says it happened');
  });
});

describe('polling twice', () => {
  it('sends the validator it was given and treats 304 as success', async () => {
    feedBody = rss([item({ guid: 'a', title: 'One' })]);
    const subscription = subscribe({ backfillCount: 10 });
    await app.remoteFeeds.pollNow(subscription.id);

    requests.length = 0;
    const second = await app.remoteFeeds.pollNow(subscription.id);

    assert.equal(second.status, 'not_modified');
    assert.equal(requests[0].headers['if-none-match'], '"v1"', 'the stored validator, sent verbatim');
    assert.equal(app.subscriptions.get(subscription.id).consecutive_failures, 0);
  });

  it('decides a remote guid exactly once', async () => {
    feedBody = rss([item({ guid: 'a', title: 'One' })]);
    const subscription = subscribe({ backfillCount: 10 });
    await app.remoteFeeds.pollNow(subscription.id);
    app.db.prepare('UPDATE feed_subscriptions SET http_etag = NULL WHERE id = ?').run(subscription.id);
    await app.remoteFeeds.pollNow(subscription.id);

    assert.equal(app.subscriptions.itemCounts(subscription.id).total, 1);
  });

  it('costs no activity row when nothing changed', async () => {
    feedBody = rss([item({ guid: 'a', title: 'One' })]);
    const subscription = subscribe({ backfillCount: 10 });
    await app.remoteFeeds.pollNow(subscription.id);
    const before = app.activity.list({ limit: 50 }).length;

    await app.remoteFeeds.pollNow(subscription.id);

    assert.equal(app.activity.list({ limit: 50 }).length, before, 'an hourly poll must not bury the log');
  });
});

describe('when a feed misbehaves', () => {
  it('records a readable reason and backs off rather than giving up', async () => {
    respond = (req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('ROUTER-SECRET-BANNER');
    };
    const subscription = subscribe();

    const result = await app.remoteFeeds.pollNow(subscription.id);
    // A 500 is deliberately indistinguishable from a refused connection: telling the
    // two apart is the oracle that turns a blocked-address refusal into a port scan.
    assert.equal(result.status, 'network_error');

    const after = app.subscriptions.get(subscription.id);
    assert.equal(after.consecutive_failures, 1);
    assert.ok(after.next_poll_at, 'it must be scheduled to try again, never silently abandoned');
    assert.equal(after.enabled, 1, 'a failing feed is surfaced, not switched off behind the user');
    assert.ok(!after.last_error.includes('ROUTER-SECRET-BANNER'), 'no upstream body in the message');
    assert.ok(!/500/.test(after.last_error), 'and no status code either');
  });

  it('says a web page is a web page rather than reporting nothing new', async () => {
    respond = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>Sign in</body></html>');
    };
    const subscription = subscribe();

    const result = await app.remoteFeeds.pollNow(subscription.id);
    assert.equal(result.status, 'parse_error');
    assert.match(app.subscriptions.get(subscription.id).last_error, /web page|expired/i);
  });

  it('warns only once a failure has repeated', async () => {
    respond = (req, res) => {
      res.writeHead(503);
      res.end();
    };
    const subscription = subscribe();

    await app.remoteFeeds.pollNow(subscription.id);
    assert.equal(app.health.list().length, 0, 'one blip must not raise a banner');

    await app.remoteFeeds.pollNow(subscription.id);
    await app.remoteFeeds.pollNow(subscription.id);
    const issues = app.health.list();
    assert.equal(issues.length, 1, 'three in a row is a real problem');
    assert.match(issues[0].message, /could not be reached/);
  });

  it('clears the warning when the feed comes back', async () => {
    respond = (req, res) => {
      res.writeHead(503);
      res.end();
    };
    const subscription = subscribe();
    for (let i = 0; i < 3; i += 1) await app.remoteFeeds.pollNow(subscription.id);
    assert.equal(app.health.list().length, 1);

    respond = null;
    feedBody = rss([item({ guid: 'a', title: 'One' })]);
    await app.remoteFeeds.pollNow(subscription.id);

    assert.equal(app.health.list().length, 0);
  });
});

describe('the feature is off until it is turned on', () => {
  it('makes no outbound request at all while disabled', async () => {
    const subscription = subscribe();
    app.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '0' });
    requests.length = 0;

    const due = await app.remoteFeeds.pollDue();

    assert.equal(due.polled, 0);
    assert.equal(requests.length, 0, 'a disabled feature must be silent on the network');
    await assert.rejects(() => app.remoteFeeds.pollNow(subscription.id), /switched off/);
  });
});

describe('preview', () => {
  it('shows what would happen without recording or fetching anything', async () => {
    feedBody = rss([
      item({ guid: 'a', title: 'An interview', minutes: 40 }),
      item({ guid: 'b', title: 'Bonus content', minutes: 40 }),
    ]);

    const preview = await app.remoteFeeds.preview(`${origin}/feed.xml`, {
      includeKeywords: ['interview'],
      excludeKeywords: ['bonus'],
    });

    assert.equal(preview.feed.title, 'Tape Club');
    assert.equal(preview.matchCount, 1);
    assert.equal(preview.items[0].keep, true);
    assert.equal(preview.items[1].keep, false);
    assert.match(preview.items[1].detail, /bonus/);
    // Nothing was recorded: a preview is a question, not a commitment.
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM feed_items').get().n, 0);
  });

  it('hands back only the projection, never the response itself', async () => {
    respond = (req, res) => {
      res.writeHead(200, {
        'content-type': 'application/rss+xml',
        server: 'LANbox/1.2',
        'set-cookie': 'session=SECRET',
      });
      res.end(rss([item({ guid: 'a', title: 'One' })]));
    };

    const preview = await app.remoteFeeds.preview(`${origin}/feed.xml`, {});
    const raw = JSON.stringify(preview);

    assert.ok(!raw.includes('LANbox'), 'a response header leaked');
    assert.ok(!raw.includes('SECRET'), 'a cookie leaked');
    assert.ok(!raw.includes('<rss'), 'the raw body leaked');
    // Positive control: the projection really was built from that response.
    assert.equal(preview.items.length, 1);
  });

  it('shows the host of the audio but never its full URL', async () => {
    // A private feed's enclosure URL carries the token identifying the listener.
    feedBody = rss([
      item({ guid: 'a', title: 'One', url: 'https://cdn.example.com/ep.mp3?listener=SECRET-TOKEN' }),
    ]);

    const preview = await app.remoteFeeds.preview(`${origin}/feed.xml`, {});
    const raw = JSON.stringify(preview);

    assert.equal(preview.items[0].enclosure.host, 'cdn.example.com');
    assert.ok(!raw.includes('SECRET-TOKEN'), 'the enclosure URL leaked into the preview');
  });

  it('refuses to preview while the feature is off', async () => {
    app.settings.update({ [SETTING_KEYS.SUBSCRIPTIONS_ENABLED]: '0' });
    await assert.rejects(() => app.remoteFeeds.preview(`${origin}/feed.xml`, {}), /switched off/);
  });
});

describe('addresses are re-checked on every poll, not just at subscribe time', () => {
  it('refuses a feed that redirects into private address space', async () => {
    // The single most likely real bug in this feature: validating the URL when it is
    // saved and trusting the row for ever afterwards.
    respond = (req, res) => {
      res.writeHead(302, { location: 'http://192.168.1.1/secret.xml' });
      res.end();
    };
    const subscription = subscribe();

    const result = await app.remoteFeeds.pollNow(subscription.id);

    assert.equal(result.status, 'blocked');
    assert.equal(result.terminal, true);
    assert.match(app.subscriptions.get(subscription.id).last_error, /private or local network/);
  });

  it('stops following a feed whose address is refused, rather than retrying for ever', async () => {
    // A refused address retried every fifteen minutes is a probe that keeps firing.
    // It is also a subscription that can never work, so quietly retrying it hides the
    // problem instead of reporting it.
    respond = (req, res) => {
      res.writeHead(302, { location: 'http://10.1.2.3/secret.xml' });
      res.end();
    };
    const subscription = subscribe();

    await app.remoteFeeds.pollNow(subscription.id);

    const after = app.subscriptions.get(subscription.id);
    assert.equal(after.enabled, 0, 'it must stop');
    assert.equal(after.next_poll_at, null, 'and not be scheduled again');
    assert.deepEqual(app.subscriptions.listDue(), [], 'so pollDue never picks it up');

    const issue = app.health.list().find((row) => row.message.includes('stopped following'));
    assert.ok(issue, 'and the operator is told, rather than left to notice');
    assert.equal(issue.level, 'error');
  });

  it('refuses a feed that redirects to a scheme it does not speak', async () => {
    respond = (req, res) => {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
    };
    const subscription = subscribe();
    const result = await app.remoteFeeds.pollNow(subscription.id);
    assert.notEqual(result.status, 'ok');
  });
});

describe('a downloaded episode becomes an ordinary episode', () => {
  it('lands on disk, is scanned, linked, and appears in the show\'s own feed', async () => {
    feedBody = rss([item({ guid: 'a', title: 'The one about tape', date: '2025-03-04' })]);
    const subscription = subscribe({ backfillCount: 10 });

    await app.remoteFeeds.pollNow(subscription.id);

    const show = app.shows.getBySlug('tape-club');
    const [episode] = app.episodes.listByShow(show.id);
    assert.ok(episode, 'the scanner turned the file into an episode');

    const [row] = app.subscriptions.items({ subscriptionId: subscription.id });
    assert.equal(row.episode_id, episode.id, 'the ledger row knows which episode it became');
    assert.equal(row.filename, episode.filename);

    // The publisher's own title, not one guessed from the filename.
    assert.equal(episode.title, 'The one about tape');
    // ...and taken without marking the episode as hand-edited, which would make any
    // future "reset to the file's tags" wrong for every subscribed episode.
    assert.equal(episode.title_is_custom, 0);

    // Dated from the publication date, because the staged file's mtime was set before
    // it was moved in — so the feed is in the right order from the very first scan.
    assert.match(episode.pub_date, /^2025-03-04/);
    assert.equal(episode.pub_date_is_custom, 0);

    const feed = await app.feeds.build(show.id, { baseUrl: 'https://podcast.example.com' });
    assert.match(feed.xml, /The one about tape/);
  });

  it('names the file from the publisher\'s title, with the date in front', async () => {
    feedBody = rss([item({ guid: 'a', title: 'Q&amp;A: cafés and croissants', date: '2025-03-04' })]);
    const subscription = subscribe({ backfillCount: 10 });

    await app.remoteFeeds.pollNow(subscription.id);

    const [file] = await showFolderContents();
    assert.match(file, /^2025-03-04-/, 'dated, so the folder sorts sensibly on the share');
    assert.match(file, /Q&A/, 'the ampersand is decoded, not left as an entity');
    assert.match(file, /cafés/, 'accents survive');
    assert.match(file, /\.mp3$/);
  });

  it('leaves nothing behind when the audio turns out not to be audio', async () => {
    // A paywall page served as audio/mpeg. The junk gate is what stops it becoming an
    // episode and then warning the user about a file they never put there.
    respond = (req, res) => {
      if (req.url.startsWith('/audio/')) {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end('<html><body>Subscribe to listen</body></html>');
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(feedBody);
    };
    feedBody = rss([item({ guid: 'a', title: 'Paywalled' })]);
    const subscription = subscribe({ backfillCount: 10 });

    const result = await app.remoteFeeds.pollNow(subscription.id);

    assert.equal(result.downloaded, 0);
    assert.deepEqual(await showFolderContents(), [], 'not even a staging file may remain');
    const [row] = app.subscriptions.items({ subscriptionId: subscription.id });
    assert.equal(row.reject_reason, 'not_audio');
    assert.match(row.reject_detail, /isn't audio/);
  });

  it('measures an episode whose feed never stated a length, and discards it if it misses', async () => {
    feedBody = rss([
      `<item><title>Unstated length</title><guid>a</guid>` +
        `<pubDate>${new Date('2025-03-04T09:00:00Z').toUTCString()}</pubDate>` +
        `<enclosure url="${origin}/audio/a.mp3" type="audio/mpeg" length="5000"/></item>`,
    ]);
    // The fixture is about a second long, so a one-hour minimum cannot be met.
    const subscription = subscribe({ minDurationSeconds: 3600, backfillCount: 10 });

    const result = await app.remoteFeeds.pollNow(subscription.id);

    assert.equal(result.downloaded, 0);
    assert.deepEqual(await showFolderContents(), [], 'a measured refusal leaves no file');
    const [row] = app.subscriptions.items({ subscriptionId: subscription.id });
    assert.equal(row.decision, ITEM_DECISION.REJECTED_MEASURED);
    assert.match(row.reject_detail, /doesn't state episode lengths/, 'says why it was fetched at all');
  });

  it('trusts a duration the feed did state, rather than second-guessing it', async () => {
    // The fixture is ~1 second, but the feed says 30 minutes and that value passed the
    // filter. Re-checking it against the file would silently discard episodes over a
    // metadata discrepancy the user cannot see and could not fix.
    feedBody = rss([item({ guid: 'a', title: 'Stated length', minutes: 30 })]);
    const subscription = subscribe({ minDurationSeconds: 600, backfillCount: 10 });

    const result = await app.remoteFeeds.pollNow(subscription.id);
    assert.equal(result.downloaded, 1);
  });

  it('refuses a second copy of audio it already has, without disturbing the first', async () => {
    respond = (req, res) => {
      if (req.url.startsWith('/audio/')) {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(AUDIO);
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(feedBody);
    };
    feedBody = rss([
      item({ guid: 'a', title: 'Original' }),
      item({ guid: 'b', title: 'Reposted under a new id' }),
    ]);
    const subscription = subscribe({ backfillCount: 10 });

    await app.remoteFeeds.pollNow(subscription.id);

    const files = await showFolderContents();
    assert.equal(files.length, 1, `byte-identical audio must not be kept twice: ${files.join(', ')}`);
    const decisions = app.subscriptions
      .items({ subscriptionId: subscription.id })
      .map((row) => row.decision)
      .sort();
    assert.deepEqual(decisions, [ITEM_DECISION.DOWNLOADED, ITEM_DECISION.DUPLICATE]);
  });

  it('never fetches an enclosure on a private address, and stops asking', async () => {
    feedBody = rss([item({ guid: 'a', title: 'One', url: 'http://192.168.1.50/secret.mp3' })]);
    const subscription = subscribe({ backfillCount: 10 });

    await app.remoteFeeds.pollNow(subscription.id);

    const [row] = app.subscriptions.items({ subscriptionId: subscription.id });
    assert.equal(row.decision, ITEM_DECISION.REJECTED_BLOCKED);
    assert.deepEqual(await showFolderContents(), []);

    // And a second poll must not try again: a hostile feed listing LAN enclosures
    // would otherwise be a probe that re-fires for ever.
    app.db.prepare('UPDATE feed_subscriptions SET http_etag = NULL WHERE id = ?').run(subscription.id);
    await app.remoteFeeds.pollNow(subscription.id);
    assert.equal(
      app.subscriptions.getItem(row.id).decision,
      ITEM_DECISION.REJECTED_BLOCKED,
      'a blocked enclosure must stay blocked',
    );
  });
});

describe('recovering from interruptions', () => {
  it('requeues a download the process died in the middle of', async () => {
    feedBody = rss([item({ guid: 'a', title: 'One' })]);
    const subscription = subscribe({ backfillCount: 10 });
    await app.remoteFeeds.pollNow(subscription.id);

    const [row] = app.subscriptions.items({ subscriptionId: subscription.id });
    app.subscriptions.markItem(row.id, { decision: ITEM_DECISION.DOWNLOADING });

    const swept = await app.remoteFeeds.sweepStaging();
    assert.equal(swept.requeued, 1);
    assert.equal(app.subscriptions.getItem(row.id).decision, ITEM_DECISION.MATCHED);
  });

  it('treats a deleted episode as final, rather than downloading it again', async () => {
    // Without this, deleting an episode you did not want would bring it straight back
    // on the next poll, for ever.
    feedBody = rss([item({ guid: 'a', title: 'One' })]);
    const subscription = subscribe({ backfillCount: 10 });
    await app.remoteFeeds.pollNow(subscription.id);

    const show = app.shows.getBySlug('tape-club');
    const [episode] = app.episodes.listByShow(show.id);
    await app.episodes.deleteWithFile(episode.id);

    const { released } = await app.remoteFeeds.reconcile(subscription.id);
    assert.equal(released, 1);

    const [row] = app.subscriptions.items({ subscriptionId: subscription.id });
    assert.equal(row.decision, ITEM_DECISION.DELETED_BY_USER);
    assert.match(row.reject_detail, /Download again/, 'and says how to undo it');

    // Two more polls must not resurrect it.
    for (let i = 0; i < 2; i += 1) {
      app.db.prepare('UPDATE feed_subscriptions SET http_etag = NULL WHERE id = ?').run(subscription.id);
      await app.remoteFeeds.pollNow(subscription.id);
    }
    assert.deepEqual(await showFolderContents(), [], 'the file must stay gone');
  });
});
