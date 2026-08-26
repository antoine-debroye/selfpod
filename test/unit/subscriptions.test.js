import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ITEM_DECISION, REMOTE_BACKFILL_MAX } from '../../src/constants.js';
import { createTestInstance } from '../helpers/harness.js';

let app;
let show;

beforeEach(async () => {
  app = await createTestInstance();
  await app.makeShowFolder('tape-club');
  await app.scanner.scanAllNow('manual');
  show = app.shows.getBySlug('tape-club');
});

afterEach(async () => {
  await app.cleanup();
});

const FEED = 'https://feeds.example.com/show.xml';

function subscribe(patch = {}) {
  return app.subscriptions.create(show.id, { feedUrl: FEED, ...patch });
}

function addItem(subscriptionId, overrides = {}) {
  return app.subscriptions.upsertItem(subscriptionId, {
    guid: `guid-${Math.random().toString(36).slice(2)}`,
    guidSource: 'guid',
    title: 'An episode',
    enclosureUrl: 'https://cdn.example.com/a.mp3',
    pubDate: '2025-03-04T09:00:00.000Z',
    declaredDurationSeconds: 1800,
    enclosureLengthBytes: 5_000_000,
    ...overrides,
  });
}

describe('migration 006 stays additive, so a downgrade is not destructive', () => {
  it('adds only new tables, never altering an existing one', () => {
    // migrate.js applies by array index and skips anything already applied, so an
    // older image run against this schema simply ignores the new tables and keeps
    // working. That is what makes rolling back a bad update safe — and it holds only
    // while migrations stay additive. Asserted rather than remembered.
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      join(here, '../../src/db/migrations/006-feed-subscriptions.sql'),
      'utf8',
    );
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

    assert.ok(!/ALTER\s+TABLE/i.test(statements), 'altering an existing table breaks downgrade');
    assert.ok(!/DROP\s+/i.test(statements), 'dropping anything breaks downgrade');
    assert.ok(/CREATE\s+TABLE\s+feed_subscriptions/i.test(statements));
  });

  it('is numbered so it sorts after every earlier migration', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(join(here, '../../src/db/migrations')).filter((f) => f.endsWith('.sql')).sort();
    // Version is the array index, so a name that sorts wrongly renumbers every
    // migration after it and re-runs them against a database that already has them.
    assert.equal(files[5], '006-feed-subscriptions.sql', `sorted wrongly: ${files.join(', ')}`);
    assert.equal(app.db.pragma('user_version', { simple: true }), files.length);
  });

  it('cascades a deleted show away, ledger and all', () => {
    const subscription = subscribe();
    addItem(subscription.id);
    assert.equal(app.subscriptions.itemCounts(subscription.id).total, 1);

    app.db.prepare('DELETE FROM shows WHERE id = ?').run(show.id);

    assert.equal(app.subscriptions.get(subscription.id), null);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM feed_items').get().n, 0);
  });
});

describe('creating a subscription', () => {
  it('stores the rules alongside the show', () => {
    const subscription = subscribe({
      includeKeywords: 'Interview, Deep Dive',
      excludeKeywords: ['Bonus'],
      minDurationSeconds: 1200,
      maxDurationSeconds: 7200,
      backfillCount: 3,
    });

    assert.equal(subscription.show_id, show.id);
    assert.deepEqual(JSON.parse(subscription.include_keywords), ['interview', 'deep dive']);
    assert.deepEqual(JSON.parse(subscription.exclude_keywords), ['bonus']);
    assert.equal(subscription.min_duration_seconds, 1200);
    assert.equal(subscription.backfill_count, 3);
    assert.equal(subscription.enabled, 1);
    assert.equal(subscription.next_poll_at, null, 'a new subscription is due immediately');
  });

  it('canonicalises the URL so one origin cannot be subscribed to twice', () => {
    const subscription = subscribe({ feedUrl: 'https://FEEDS.Example.COM./show.xml' });
    assert.equal(subscription.feed_url, 'https://feeds.example.com/show.xml');
  });

  it('refuses a URL SelfPod would never fetch, against the field the user typed in', () => {
    for (const [feedUrl, expected] of [
      ['file:///etc/passwd', /http:\/\/ or https:\/\//],
      ['http://192.168.1.1/feed.xml', /private or local network/],
      ['http://user:pass@feeds.example.com/x', /username and password/],
      ['http://feeds.example.com:9200/x', /standard web ports/],
      ['not a url', /full URL/],
      ['', /Paste the address/],
    ]) {
      assert.throws(
        () => subscribe({ feedUrl }),
        (error) => {
          assert.equal(error.status, 422);
          assert.match(error.fields.feedUrl, expected, `${feedUrl}: ${error.fields.feedUrl}`);
          return true;
        },
        feedUrl,
      );
    }
  });

  it('refuses a second subscription for the same show', () => {
    subscribe();
    assert.throws(() => subscribe({ feedUrl: 'https://other.example.com/f.xml' }), (error) => {
      assert.equal(error.code, 'show_already_subscribed');
      assert.match(error.message, /one feed/);
      return true;
    });
  });

  it('refuses a duration range that could never match', () => {
    assert.throws(
      () => subscribe({ minDurationSeconds: 7200, maxDurationSeconds: 600 }),
      (error) => {
        assert.match(error.fields.minDurationSeconds, /shorter than the longest/);
        return true;
      },
    );
  });

  it('refuses a poll interval that would hammer someone else\'s server', () => {
    assert.throws(() => subscribe({ pollIntervalSeconds: 30 }), (error) => {
      assert.match(error.fields.pollIntervalSeconds, /someone else's server/);
      return true;
    });
  });

  it('refuses a backfill count outside what it will honour', () => {
    assert.throws(() => subscribe({ backfillCount: REMOTE_BACKFILL_MAX + 1 }), (error) => {
      assert.match(error.fields.backfillCount, new RegExp(String(REMOTE_BACKFILL_MAX)));
      return true;
    });
  });

  it('reports every bad field at once, not one at a time', () => {
    assert.throws(() => subscribe({ feedUrl: 'nope', backfillCount: -1, pollIntervalSeconds: 1 }), (error) => {
      assert.deepEqual(
        Object.keys(error.fields).sort(),
        ['backfillCount', 'feedUrl', 'pollIntervalSeconds'],
        'a form that fixes one problem at a time is a form nobody finishes',
      );
      return true;
    });
  });
});

describe('changing the rules', () => {
  it('re-opens previous refusals when a rule gets looser', () => {
    // The failure this prevents: the user removes a negative keyword, waits a week,
    // and the episodes they expected never arrive — with nothing anywhere to say why.
    const subscription = subscribe({ excludeKeywords: ['bonus'] });
    const skipped = addItem(subscription.id, { title: 'Bonus round' });
    app.subscriptions.markItem(skipped.id, {
      decision: ITEM_DECISION.REJECTED_DECLARED,
      reject_reason: 'excluded_keyword',
      reject_detail: 'Skipped because the title contains `bonus`.',
    });

    assert.equal(app.subscriptions.reopenableCount(subscription.id), 1, 'there is something to re-open');

    app.subscriptions.update(subscription.id, { excludeKeywords: [] });

    const after = app.subscriptions.getItem(skipped.id);
    assert.equal(after.decision, ITEM_DECISION.PENDING);
    assert.equal(after.reject_reason, null, 'the old reason must not linger');
    assert.equal(after.reject_detail, null);
  });

  it('re-opens a backfill skip too, since the horizon is a rule', () => {
    const subscription = subscribe();
    const skipped = addItem(subscription.id);
    app.subscriptions.markItem(skipped.id, { decision: ITEM_DECISION.SKIPPED_BACKFILL });

    app.subscriptions.update(subscription.id, { includeKeywords: ['anything'] });
    assert.equal(app.subscriptions.getItem(skipped.id).decision, ITEM_DECISION.PENDING);
  });

  it('never un-downloads something because a rule got tighter', () => {
    // A narrower rule governs what happens next, not what is already on disk and
    // possibly already listened to.
    const subscription = subscribe();
    const downloaded = addItem(subscription.id, { title: 'An interview' });
    app.subscriptions.markItem(downloaded.id, {
      decision: ITEM_DECISION.DOWNLOADED,
      filename: 'an-interview.mp3',
    });

    app.subscriptions.update(subscription.id, { excludeKeywords: ['interview'] });

    const after = app.subscriptions.getItem(downloaded.id);
    assert.equal(after.decision, ITEM_DECISION.DOWNLOADED);
    assert.equal(after.filename, 'an-interview.mp3');
  });

  it('leaves a refusal that cost a download alone', () => {
    // rejected_measured was reached by fetching the whole file and measuring it.
    // Re-opening it on a one-character keyword edit would silently re-fetch gigabytes.
    const subscription = subscribe({ minDurationSeconds: 3600 });
    const measured = addItem(subscription.id, { declaredDurationSeconds: null });
    app.subscriptions.markItem(measured.id, {
      decision: ITEM_DECISION.REJECTED_MEASURED,
      reject_reason: 'too_short',
    });

    app.subscriptions.update(subscription.id, { minDurationSeconds: 60 });
    assert.equal(app.subscriptions.getItem(measured.id).decision, ITEM_DECISION.REJECTED_MEASURED);
  });

  it('leaves a blocked address alone, whatever the rules become', () => {
    const subscription = subscribe();
    const blocked = addItem(subscription.id);
    app.subscriptions.markItem(blocked.id, { decision: ITEM_DECISION.REJECTED_BLOCKED });

    app.subscriptions.update(subscription.id, { includeKeywords: [], excludeKeywords: [] });
    assert.equal(
      app.subscriptions.getItem(blocked.id).decision,
      ITEM_DECISION.REJECTED_BLOCKED,
      'a refused address that became retryable would be a probe firing on every poll',
    );
  });

  it('does not re-open anything when only the schedule changed', () => {
    const subscription = subscribe();
    const skipped = addItem(subscription.id);
    app.subscriptions.markItem(skipped.id, { decision: ITEM_DECISION.REJECTED_DECLARED });

    app.subscriptions.update(subscription.id, { pollIntervalSeconds: 3600 });
    assert.equal(app.subscriptions.getItem(skipped.id).decision, ITEM_DECISION.REJECTED_DECLARED);
  });

  it('checks a new bound against the one already stored', () => {
    // Raising the minimum past an existing maximum has to fail, or the subscription
    // silently matches nothing for ever.
    const subscription = subscribe({ maxDurationSeconds: 600 });
    assert.throws(() => app.subscriptions.update(subscription.id, { minDurationSeconds: 7200 }), (error) => {
      assert.match(error.fields.minDurationSeconds, /shorter than the longest/);
      return true;
    });
  });
});

describe('the decision ledger', () => {
  it('decides a remote guid exactly once', () => {
    const subscription = subscribe();
    const first = addItem(subscription.id, { guid: 'stable' });
    app.subscriptions.markItem(first.id, { decision: ITEM_DECISION.DOWNLOADED });

    const again = addItem(subscription.id, { guid: 'stable' });
    assert.equal(again.id, first.id, 'the same item must not become a second row');
    assert.equal(again.decision, ITEM_DECISION.DOWNLOADED, 're-seeing it must not undo the decision');
  });

  it('refreshes a title while an item is still undecided', () => {
    const subscription = subscribe();
    addItem(subscription.id, { guid: 'g', title: 'Typo in teh title' });
    const fixed = addItem(subscription.id, { guid: 'g', title: 'Typo in the title' });
    assert.equal(fixed.title, 'Typo in the title');
  });

  it('does not rewrite the title of something already on disk', () => {
    // The ledger row names a file. Letting the publisher edit it afterwards would
    // make the record disagree with the filesystem.
    const subscription = subscribe();
    const item = addItem(subscription.id, { guid: 'g', title: 'Original' });
    app.subscriptions.markItem(item.id, { decision: ITEM_DECISION.DOWNLOADED, filename: 'original.mp3' });

    const reseen = addItem(subscription.id, { guid: 'g', title: 'Renamed by the publisher' });
    assert.equal(reseen.title, 'Original');
  });

  it('records when an item was last seen, so a vanished one is distinguishable', () => {
    const subscription = subscribe();
    const item = addItem(subscription.id, { guid: 'g' });
    assert.ok(item.last_seen_in_feed_at, 'without this, a truncated feed looks like a deletion');
  });

  it('counts by decision for the UI', () => {
    const subscription = subscribe();
    const a = addItem(subscription.id);
    const b = addItem(subscription.id);
    app.subscriptions.markItem(a.id, { decision: ITEM_DECISION.DOWNLOADED });
    app.subscriptions.markItem(b.id, { decision: ITEM_DECISION.REJECTED_DECLARED });

    const counts = app.subscriptions.itemCounts(subscription.id);
    assert.equal(counts.total, 2);
    assert.equal(counts[ITEM_DECISION.DOWNLOADED], 1);
    assert.equal(counts[ITEM_DECISION.REJECTED_DECLARED], 1);
    assert.equal(counts[ITEM_DECISION.PENDING], 0, 'every decision is present, even at zero');
  });

  it('refuses to filter by a decision it does not record', () => {
    // Allow-listed rather than interpolated: the same rule every other caller-supplied
    // value in this codebase follows before it reaches SQL.
    const subscription = subscribe();
    assert.throws(
      () => app.subscriptions.items({ subscriptionId: subscription.id, decision: "x' OR '1'='1" }),
      /not a decision/,
    );
  });

  it('requeues a download interrupted by a restart', () => {
    const subscription = subscribe();
    const item = addItem(subscription.id);
    app.subscriptions.markItem(item.id, { decision: ITEM_DECISION.DOWNLOADING });

    assert.equal(app.subscriptions.resetStuckDownloads(), 1);
    const after = app.subscriptions.getItem(item.id);
    assert.equal(after.decision, ITEM_DECISION.MATCHED);
    assert.equal(after.attempts, 1, 'the attempt is counted so a poison item eventually stops');
  });

  it('lists items whose file landed but whose episode is not linked yet', () => {
    const subscription = subscribe();
    const item = addItem(subscription.id);
    app.subscriptions.markItem(item.id, { decision: ITEM_DECISION.DOWNLOADED, filename: 'x.mp3' });
    assert.equal(app.subscriptions.unlinked(subscription.id).length, 1);

    app.subscriptions.markItem(item.id, { episode_id: null, decision: ITEM_DECISION.DOWNLOADED });
    assert.equal(app.subscriptions.unlinked(subscription.id).length, 1, 'still unlinked');
  });
});

describe('polling state', () => {
  it('lists a subscription as due when it has never been polled', () => {
    const subscription = subscribe();
    assert.deepEqual(
      app.subscriptions.listDue().map((row) => row.id),
      [subscription.id],
    );
  });

  it('stops listing it once it is scheduled for later', () => {
    const subscription = subscribe();
    const later = new Date(Date.now() + 3600_000).toISOString();
    app.subscriptions.recordPollResult(subscription.id, { status: 'ok', nextPollAt: later });
    assert.deepEqual(app.subscriptions.listDue(), []);
  });

  it('never lists a disabled subscription', () => {
    const subscription = subscribe();
    app.subscriptions.update(subscription.id, { enabled: false });
    assert.deepEqual(app.subscriptions.listDue(), []);
  });

  it('counts consecutive failures and clears them on success', () => {
    const subscription = subscribe();
    app.subscriptions.recordPollResult(subscription.id, { status: 'network_error', error: 'nope' });
    app.subscriptions.recordPollResult(subscription.id, { status: 'network_error', error: 'nope' });
    assert.equal(app.subscriptions.get(subscription.id).consecutive_failures, 2);

    app.subscriptions.recordPollResult(subscription.id, { status: 'ok' });
    const after = app.subscriptions.get(subscription.id);
    assert.equal(after.consecutive_failures, 0);
    assert.ok(after.last_success_at);
  });

  it('treats a 304 as a success, because nothing was wrong', () => {
    const subscription = subscribe();
    app.subscriptions.recordPollResult(subscription.id, { status: 'network_error' });
    app.subscriptions.recordPollResult(subscription.id, { status: 'not_modified' });
    assert.equal(app.subscriptions.get(subscription.id).consecutive_failures, 0);
  });

  it('keeps the last validators when a poll did not bring new ones', () => {
    const subscription = subscribe();
    app.subscriptions.recordPollResult(subscription.id, { status: 'ok', etag: 'W/"v1"' });
    app.subscriptions.recordPollResult(subscription.id, { status: 'not_modified' });
    assert.equal(app.subscriptions.get(subscription.id).http_etag, 'W/"v1"');
  });
});

describe('the shared byte budget', () => {
  const LIMIT = 1000;
  const WINDOW = 24 * 60 * 60 * 1000;

  it('allows a reservation inside the limit and refuses one past it', () => {
    assert.equal(app.subscriptions.reserveBytes(600, { limit: LIMIT, windowMs: WINDOW }), true);
    assert.equal(app.subscriptions.reserveBytes(600, { limit: LIMIT, windowMs: WINDOW }), false);
    assert.equal(app.subscriptions.budget().used_bytes, 600, 'a refused reservation costs nothing');
  });

  it('is global, so subscriptions cannot each have the whole allowance', () => {
    // Twenty subscriptions at five gigabytes each is a hundred gigabytes a day, which
    // is not a limit anyone asked for.
    assert.equal(app.subscriptions.reserveBytes(900, { limit: LIMIT, windowMs: WINDOW }), true);
    const other = app.shows.getBySlug('tape-club');
    assert.ok(other);
    assert.equal(
      app.subscriptions.reserveBytes(900, { limit: LIMIT, windowMs: WINDOW }),
      false,
      'the budget belongs to the instance, not to a subscription',
    );
  });

  it('corrects the reservation once the real size is known', () => {
    app.subscriptions.reserveBytes(900, { limit: LIMIT, windowMs: WINDOW });
    app.subscriptions.settleBytes(900, 100);
    assert.equal(app.subscriptions.budget().used_bytes, 100);
    assert.equal(app.subscriptions.reserveBytes(800, { limit: LIMIT, windowMs: WINDOW }), true);
  });

  it('keeps a reservation spent when a download dies before settling', () => {
    // The conservative direction, which is the right one for a budget: a crash costs
    // the reservation until the window rolls rather than handing out free bytes.
    app.subscriptions.reserveBytes(900, { limit: LIMIT, windowMs: WINDOW });
    assert.equal(app.subscriptions.budget().used_bytes, 900);
  });

  it('rolls the window and starts again', () => {
    const now = Date.now();
    app.subscriptions.reserveBytes(900, { limit: LIMIT, windowMs: WINDOW, now });
    assert.equal(app.subscriptions.reserveBytes(900, { limit: LIMIT, windowMs: WINDOW, now }), false);

    const tomorrow = now + WINDOW + 1000;
    assert.equal(
      app.subscriptions.reserveBytes(900, { limit: LIMIT, windowMs: WINDOW, now: tomorrow }),
      true,
    );
  });

  it('cannot be reset by deleting and recreating a subscription', () => {
    const subscription = subscribe();
    app.subscriptions.reserveBytes(900, { limit: LIMIT, windowMs: WINDOW });
    app.subscriptions.remove(subscription.id);
    subscribe();
    assert.equal(app.subscriptions.budget().used_bytes, 900);
  });
});
