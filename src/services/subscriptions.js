import {
  DEFAULT_BACKFILL_COUNT,
  ITEM_DECISION,
  REMOTE_BACKFILL_MAX,
  REMOTE_MAX_SUBSCRIPTIONS,
  REMOTE_POLL_MAX_SECONDS,
  REMOTE_POLL_MIN_SECONDS,
  TERMINAL_DECISIONS,
} from '../constants.js';
import { normaliseSubscriptionUrl } from '../lib/address-rules.js';
import { nowIso } from '../lib/dates.js';
import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { EVENTS } from '../lib/events.js';
import { normaliseKeywords } from '../lib/feed-filter.js';
import { newId } from '../lib/tokens.js';

/**
 * Storage for feed subscriptions and their decision ledger (spec §18).
 *
 * Deliberately has no idea how to fetch anything. Everything here is rows and rules;
 * the polling, parsing and downloading live in services/remote-feeds.js. Keeping the
 * split means the validation below — which is the part a user actually interacts with,
 * through three different surfaces — can be tested without a network at all.
 *
 * Validation lives here rather than in the routes for the same reason `shows.update`
 * does it: the JSON API, the full-page form and the htmx fragment must all reject the
 * same things with the same wording, and three copies of that is three chances to
 * disagree.
 */

/** Why a rule change re-opens some refusals and not others. See `update`. */
const REOPENABLE_ON_RULE_CHANGE = [
  ITEM_DECISION.REJECTED_DECLARED,
  ITEM_DECISION.SKIPPED_BACKFILL,
];

const RULE_FIELDS = [
  'include_keywords',
  'exclude_keywords',
  'min_duration_seconds',
  'max_duration_seconds',
];

export function createSubscriptions({ db, config, events, logger }) {
  // The same exemption the fetcher honours, so a URL the operator has explicitly
  // allowed is accepted by the form as well as by the poller. Without this the two
  // disagree: the address would be refused when typed and permitted when fetched.
  const allowedHosts = config?.allowedPrivateFeedHosts ?? new Set();

  const selectById = db.prepare('SELECT * FROM feed_subscriptions WHERE id = ?');
  const selectByShow = db.prepare('SELECT * FROM feed_subscriptions WHERE show_id = ?');
  const selectAll = db.prepare('SELECT * FROM feed_subscriptions ORDER BY created_at ASC');
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM feed_subscriptions');
  const deleteById = db.prepare('DELETE FROM feed_subscriptions WHERE id = ?');

  const insert = db.prepare(
    `INSERT INTO feed_subscriptions
       (id, show_id, feed_url, remote_title, enabled, include_keywords, exclude_keywords,
        min_duration_seconds, max_duration_seconds, backfill_count, catch_up_mode,
        poll_interval_seconds, next_poll_at, created_at, updated_at)
     VALUES
       (@id, @show_id, @feed_url, @remote_title, @enabled, @include_keywords, @exclude_keywords,
        @min_duration_seconds, @max_duration_seconds, @backfill_count, @catch_up_mode,
        @poll_interval_seconds, @next_poll_at, @created_at, @updated_at)`,
  );

  const selectDue = db.prepare(
    `SELECT * FROM feed_subscriptions
      WHERE enabled = 1 AND (next_poll_at IS NULL OR next_poll_at <= @now)
      ORDER BY next_poll_at IS NOT NULL, next_poll_at ASC`,
  );

  const insertItem = db.prepare(
    `INSERT INTO feed_items
       (subscription_id, remote_guid, guid_source, title, enclosure_url, pub_date,
        declared_duration_seconds, declared_length_bytes, first_seen_at, last_seen_in_feed_at, decision)
     VALUES
       (@subscription_id, @remote_guid, @guid_source, @title, @enclosure_url, @pub_date,
        @declared_duration_seconds, @declared_length_bytes, @first_seen_at, @last_seen_in_feed_at, @decision)
     ON CONFLICT(subscription_id, remote_guid) DO UPDATE SET
        last_seen_in_feed_at = excluded.last_seen_in_feed_at,
        -- A publisher fixing a typo or correcting a date should be reflected, but only
        -- while the item is still undecided. Rewriting the title of something already
        -- downloaded would make the ledger disagree with the file on disk.
        title = CASE WHEN feed_items.decision IN ('pending', 'matched')
                     THEN excluded.title ELSE feed_items.title END,
        pub_date = CASE WHEN feed_items.decision IN ('pending', 'matched')
                        THEN excluded.pub_date ELSE feed_items.pub_date END,
        enclosure_url = CASE WHEN feed_items.decision IN ('pending', 'matched')
                             THEN excluded.enclosure_url ELSE feed_items.enclosure_url END,
        declared_duration_seconds = CASE WHEN feed_items.decision IN ('pending', 'matched')
                                         THEN excluded.declared_duration_seconds
                                         ELSE feed_items.declared_duration_seconds END`,
  );

  const selectItem = db.prepare(
    'SELECT * FROM feed_items WHERE subscription_id = ? AND remote_guid = ?',
  );
  const selectItemById = db.prepare('SELECT * FROM feed_items WHERE id = ?');

  const budgetRow = db.prepare('SELECT * FROM remote_budget WHERE id = 1');
  const rollWindow = db.prepare(
    'UPDATE remote_budget SET window_start = @now, used_bytes = 0 WHERE id = 1 AND window_start <= @cutoff',
  );
  const reserve = db.prepare(
    `UPDATE remote_budget SET used_bytes = used_bytes + @bytes
      WHERE id = 1 AND used_bytes + @bytes <= @limit`,
  );
  const settle = db.prepare(
    `UPDATE remote_budget
        SET used_bytes = MAX(0, used_bytes - @reserved + @actual)
      WHERE id = 1`,
  );

  function parseOptionalSeconds(value, { field, invalid, label }) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      invalid[field] = `${label} must be a whole number of seconds, or left blank.`;
      return null;
    }
    // 24 hours. Longer than any podcast episode, and a bound stops a typo becoming a
    // rule that silently matches nothing.
    if (parsed > 86400) {
      invalid[field] = `${label} must be under 24 hours.`;
      return null;
    }
    return parsed;
  }

  /**
   * Turns a patch into database columns, or throws the 422 the whole app uses.
   *
   * `partial` distinguishes create from update: on create a feed URL is required, on
   * update an absent field means "leave it alone" rather than "clear it".
   */
  function validate(patch, { partial = false, existing = null } = {}) {
    const fields = {};
    const invalid = {};

    if (patch.feedUrl !== undefined || !partial) {
      const raw = String(patch.feedUrl ?? '').trim();
      if (!raw) {
        invalid.feedUrl = 'Paste the address of the feed you want to subscribe to.';
      } else {
        const normalised = normaliseSubscriptionUrl(raw, { allowedHosts });
        if (normalised.reason) {
          invalid.feedUrl = urlProblem(normalised.reason);
        } else {
          // Stored canonicalised — lowercased host, no trailing dot — so the same
          // origin cannot be subscribed to twice under two spellings.
          fields.feed_url = normalised.url.href;
        }
      }
    }

    if (patch.includeKeywords !== undefined) {
      fields.include_keywords = JSON.stringify(normaliseKeywords(patch.includeKeywords));
    }
    if (patch.excludeKeywords !== undefined) {
      fields.exclude_keywords = JSON.stringify(normaliseKeywords(patch.excludeKeywords));
    }

    if (patch.minDurationSeconds !== undefined) {
      fields.min_duration_seconds = parseOptionalSeconds(patch.minDurationSeconds, {
        field: 'minDurationSeconds',
        invalid,
        label: 'The shortest episode',
      });
    }
    if (patch.maxDurationSeconds !== undefined) {
      fields.max_duration_seconds = parseOptionalSeconds(patch.maxDurationSeconds, {
        field: 'maxDurationSeconds',
        invalid,
        label: 'The longest episode',
      });
    }

    // Checked against whichever value will actually be in force, not just against what
    // this patch happens to carry — otherwise raising the minimum past an existing
    // maximum is accepted and then silently matches nothing for ever.
    const effectiveMin =
      fields.min_duration_seconds !== undefined
        ? fields.min_duration_seconds
        : (existing?.min_duration_seconds ?? null);
    const effectiveMax =
      fields.max_duration_seconds !== undefined
        ? fields.max_duration_seconds
        : (existing?.max_duration_seconds ?? null);
    if (
      effectiveMin !== null &&
      effectiveMax !== null &&
      effectiveMin > effectiveMax &&
      !invalid.minDurationSeconds &&
      !invalid.maxDurationSeconds
    ) {
      invalid.minDurationSeconds =
        'The shortest episode has to be shorter than the longest, or nothing will ever match.';
    }

    if (patch.backfillCount !== undefined) {
      const parsed = Number(patch.backfillCount);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > REMOTE_BACKFILL_MAX) {
        invalid.backfillCount = `Fetch between 0 and ${REMOTE_BACKFILL_MAX} existing episodes on the first check.`;
      } else {
        fields.backfill_count = parsed;
      }
    }

    if (patch.pollIntervalSeconds !== undefined) {
      const raw = String(patch.pollIntervalSeconds ?? '').trim();
      if (!raw) {
        fields.poll_interval_seconds = null;
      } else {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed)) {
          invalid.pollIntervalSeconds = 'How often to check must be a whole number of seconds.';
        } else if (parsed < REMOTE_POLL_MIN_SECONDS || parsed > REMOTE_POLL_MAX_SECONDS) {
          invalid.pollIntervalSeconds = `Check between every ${REMOTE_POLL_MIN_SECONDS / 60} minutes and every ${REMOTE_POLL_MAX_SECONDS / 3600} hours. This is someone else's server.`;
        } else {
          fields.poll_interval_seconds = parsed;
        }
      }
    }

    if (patch.enabled !== undefined) {
      fields.enabled = isTrue(patch.enabled) ? 1 : 0;
    }

    if (patch.catchUpMode !== undefined) {
      const mode = String(patch.catchUpMode);
      if (!['resume', 'catch_up'].includes(mode)) {
        invalid.catchUpMode = 'Choose whether to catch up on missed episodes or start from now.';
      } else {
        fields.catch_up_mode = mode;
      }
    }

    if (patch.remoteTitle !== undefined) {
      fields.remote_title = String(patch.remoteTitle ?? '').slice(0, 300) || null;
    }

    if (Object.keys(invalid).length) {
      throw unprocessable('Some of those values need fixing.', 'validation_failed', invalid);
    }
    return fields;
  }

  const api = {
    get(id) {
      return selectById.get(id) ?? null;
    },

    getOrThrow(id) {
      const row = api.get(id);
      if (!row) throw notFound('That subscription no longer exists.', 'subscription_not_found');
      return row;
    },

    getForShow(showId) {
      return selectByShow.get(showId) ?? null;
    },

    list() {
      return selectAll.all();
    },

    count() {
      return countAll.get().n;
    },

    create(showId, patch = {}) {
      if (api.count() >= REMOTE_MAX_SUBSCRIPTIONS) {
        throw conflict(
          `SelfPod will manage up to ${REMOTE_MAX_SUBSCRIPTIONS} subscriptions. Remove one before adding another.`,
          'too_many_subscriptions',
        );
      }
      if (api.getForShow(showId)) {
        throw conflict(
          'That show already follows a feed. A show mirrors one feed, so its title and artwork have one source.',
          'show_already_subscribed',
        );
      }

      const fields = validate(patch, { partial: false });
      const row = {
        id: newId(),
        show_id: showId,
        feed_url: fields.feed_url,
        remote_title: fields.remote_title ?? null,
        enabled: fields.enabled ?? 1,
        include_keywords: fields.include_keywords ?? '[]',
        exclude_keywords: fields.exclude_keywords ?? '[]',
        min_duration_seconds: fields.min_duration_seconds ?? null,
        max_duration_seconds: fields.max_duration_seconds ?? null,
        backfill_count: fields.backfill_count ?? DEFAULT_BACKFILL_COUNT,
        catch_up_mode: fields.catch_up_mode ?? 'resume',
        poll_interval_seconds: fields.poll_interval_seconds ?? null,
        // Due immediately: someone who has just pasted a URL wants to see it work.
        next_poll_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };

      insert.run(row);
      logger?.info({ showId, subscriptionId: row.id }, 'subscription created');
      events?.emit(EVENTS.SHOWS_CHANGED, {});
      return api.get(row.id);
    },

    /**
     * Applies a patch, and re-opens refusals when the rules got looser.
     *
     * The asymmetry is the important part, and it is not symmetric because the costs
     * are not. Loosening a rule *must* re-evaluate what was previously refused, or the
     * user removes a keyword, waits a week, and the episodes they were expecting never
     * arrive with nothing anywhere to explain why. Tightening one must **not** delete
     * anything already downloaded — a narrower rule governs what happens next, not
     * what is already on disk and possibly already listened to.
     *
     * `rejected_measured` is deliberately not re-opened either way: that refusal cost a
     * complete download to reach, and re-opening it on a one-character keyword edit
     * would silently re-fetch gigabytes. The UI offers it as an explicit action instead.
     */
    update(id, patch = {}) {
      const existing = api.getOrThrow(id);
      const fields = validate(patch, { partial: true, existing });
      if (!Object.keys(fields).length) return existing;

      const rulesChanged = RULE_FIELDS.some(
        (field) => fields[field] !== undefined && fields[field] !== existing[field],
      );

      fields.updated_at = nowIso();
      const assignments = Object.keys(fields)
        .map((key) => `${key} = @${key}`)
        .join(', ');

      const apply = db.transaction(() => {
        db.prepare(`UPDATE feed_subscriptions SET ${assignments} WHERE id = @id`).run({
          ...fields,
          id,
        });
        if (rulesChanged) {
          const placeholders = REOPENABLE_ON_RULE_CHANGE.map(() => '?').join(', ');
          db.prepare(
            `UPDATE feed_items
                SET decision = 'pending', reject_reason = NULL, reject_detail = NULL, decided_at = NULL
              WHERE subscription_id = ? AND decision IN (${placeholders})`,
          ).run(id, ...REOPENABLE_ON_RULE_CHANGE);
        }
      });
      apply();

      if (rulesChanged) logger?.info({ subscriptionId: id }, 'rules changed; refusals re-opened');
      events?.emit(EVENTS.SHOWS_CHANGED, {});
      return api.get(id);
    },

    /**
     * How many previously-refused items a rule change would bring back.
     *
     * Used to tell the user *before* they save, because "12 episodes you skipped will
     * be re-checked" is the difference between a setting and a surprise.
     */
    reopenableCount(id) {
      const placeholders = REOPENABLE_ON_RULE_CHANGE.map(() => '?').join(', ');
      return db
        .prepare(
          `SELECT COUNT(*) AS n FROM feed_items WHERE subscription_id = ? AND decision IN (${placeholders})`,
        )
        .get(id, ...REOPENABLE_ON_RULE_CHANGE).n;
    },

    remove(id) {
      const existing = api.getOrThrow(id);
      deleteById.run(id);
      logger?.info({ subscriptionId: id }, 'subscription removed');
      events?.emit(EVENTS.SHOWS_CHANGED, {});
      return { showId: existing.show_id };
    },

    listDue(now = nowIso()) {
      return selectDue.all({ now });
    },

    /** Records the outcome of a poll and when to try next. */
    recordPollResult(id, { status, error = null, etag, lastModified, remoteTitle, nextPollAt }) {
      const failed = status !== 'ok' && status !== 'not_modified';
      db.prepare(
        `UPDATE feed_subscriptions SET
            last_polled_at = @now,
            last_status = @status,
            last_error = @error,
            last_success_at = CASE WHEN @failed = 0 THEN @now ELSE last_success_at END,
            consecutive_failures = CASE WHEN @failed = 1 THEN consecutive_failures + 1 ELSE 0 END,
            http_etag = COALESCE(@etag, http_etag),
            http_last_modified = COALESCE(@lastModified, http_last_modified),
            remote_title = COALESCE(@remoteTitle, remote_title),
            next_poll_at = @nextPollAt,
            updated_at = @now
          WHERE id = @id`,
      ).run({
        id,
        now: nowIso(),
        status,
        error,
        failed: failed ? 1 : 0,
        etag: etag ?? null,
        lastModified: lastModified ?? null,
        remoteTitle: remoteTitle ?? null,
        nextPollAt: nextPollAt ?? null,
      });
      return api.get(id);
    },

    markBootstrapped(id) {
      db.prepare(
        'UPDATE feed_subscriptions SET bootstrapped_at = @now, updated_at = @now WHERE id = @id AND bootstrapped_at IS NULL',
      ).run({ id, now: nowIso() });
      return api.get(id);
    },

    /* ---- the decision ledger ------------------------------------------------ */

    upsertItem(subscriptionId, item) {
      insertItem.run({
        subscription_id: subscriptionId,
        remote_guid: item.guid,
        guid_source: item.guidSource,
        title: item.title ?? '',
        enclosure_url: item.enclosureUrl ?? null,
        pub_date: item.pubDate ?? null,
        declared_duration_seconds: item.declaredDurationSeconds ?? null,
        declared_length_bytes: item.enclosureLengthBytes ?? null,
        first_seen_at: nowIso(),
        last_seen_in_feed_at: nowIso(),
        decision: ITEM_DECISION.PENDING,
      });
      return selectItem.get(subscriptionId, item.guid);
    },

    findItem(subscriptionId, remoteGuid) {
      return selectItem.get(subscriptionId, remoteGuid) ?? null;
    },

    getItem(itemId) {
      return selectItemById.get(itemId) ?? null;
    },

    markItem(itemId, fields) {
      const allowed = [
        'decision',
        'reject_reason',
        'reject_detail',
        'filename',
        'identity_key',
        'episode_id',
        'downloaded_at',
        'bytes',
        'attempts',
        'next_attempt_at',
      ];
      const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
      if (!entries.length) return api.getItem(itemId);
      const payload = Object.fromEntries(entries);
      payload.decided_at = nowIso();
      payload.id = itemId;
      const assignments = Object.keys(payload)
        .filter((key) => key !== 'id')
        .map((key) => `${key} = @${key}`)
        .join(', ');
      db.prepare(`UPDATE feed_items SET ${assignments} WHERE id = @id`).run(payload);
      return api.getItem(itemId);
    },

    items({ subscriptionId, decision = null, limit = 50, offset = 0 } = {}) {
      const clauses = ['subscription_id = @subscriptionId'];
      const params = { subscriptionId, limit, offset };
      if (decision) {
        // Allow-listed, never interpolated: the same rule stats.js and activity.js
        // follow for every caller-supplied value that reaches SQL.
        if (!Object.values(ITEM_DECISION).includes(decision)) {
          throw unprocessable('That is not a decision SelfPod records.', 'unknown_decision');
        }
        clauses.push('decision = @decision');
        params.decision = decision;
      }
      return db
        .prepare(
          `SELECT * FROM feed_items WHERE ${clauses.join(' AND ')}
            ORDER BY COALESCE(pub_date, first_seen_at) DESC, id DESC
            LIMIT @limit OFFSET @offset`,
        )
        .all(params);
    },

    itemCounts(subscriptionId) {
      const rows = db
        .prepare('SELECT decision, COUNT(*) AS n FROM feed_items WHERE subscription_id = ? GROUP BY decision')
        .all(subscriptionId);
      const counts = Object.fromEntries(Object.values(ITEM_DECISION).map((d) => [d, 0]));
      for (const row of rows) counts[row.decision] = row.n;
      counts.total = rows.reduce((sum, row) => sum + row.n, 0);
      return counts;
    },

    /** Items whose file landed but whose episode row has not been linked yet. */
    unlinked(subscriptionId = null) {
      const where = subscriptionId ? 'AND subscription_id = @subscriptionId' : '';
      return db
        .prepare(
          `SELECT * FROM feed_items
            WHERE decision = '${ITEM_DECISION.DOWNLOADED}' AND episode_id IS NULL ${where}`,
        )
        .all(subscriptionId ? { subscriptionId } : {});
    },

    /**
     * Returns anything left mid-download by a kill to the retry queue.
     *
     * Restarting rather than resuming is deliberate: resuming needs `If-Range`, a
     * stored strong validator, and a guarantee that the staged bytes were flushed
     * before the process died — none of which is knowable after a SIGKILL. Getting it
     * wrong publishes a corrupt episode to subscribers; getting it right costs a
     * re-fetch.
     */
    resetStuckDownloads() {
      const result = db
        .prepare(
          `UPDATE feed_items
              SET decision = '${ITEM_DECISION.MATCHED}', attempts = attempts + 1
            WHERE decision = '${ITEM_DECISION.DOWNLOADING}'`,
        )
        .run();
      if (result.changes) logger?.info({ count: result.changes }, 'requeued interrupted downloads');
      return result.changes;
    },

    /** True when this decision must never be revisited, whatever the user changes. */
    isTerminal(decision) {
      return TERMINAL_DECISIONS.includes(decision);
    },

    /* ---- the shared byte budget --------------------------------------------- */

    /**
     * Claims `bytes` against the rolling window, or returns false.
     *
     * Reserve-then-settle rather than counting each chunk: a write per chunk on a
     * multi-gigabyte download is tens of thousands of synchronous transactions
     * blocking the event loop, and every media request queues behind them. Reserving
     * the whole expected size up front and correcting it afterwards costs two writes.
     * A crash in between leaves the reservation spent until the window rolls, which is
     * the conservative direction and so the right one for a budget.
     */
    reserveBytes(bytes, { limit, windowMs, now = Date.now() }) {
      const cutoff = new Date(now - windowMs).toISOString();
      rollWindow.run({ now: new Date(now).toISOString(), cutoff });
      const result = reserve.run({ bytes: Math.max(0, Math.round(bytes)), limit });
      return result.changes === 1;
    },

    settleBytes(reserved, actual) {
      settle.run({ reserved: Math.max(0, Math.round(reserved)), actual: Math.max(0, Math.round(actual)) });
    },

    budget() {
      return budgetRow.get();
    },
  };

  return api;
}

/**
 * The sentence shown against the feed-URL field for each way a URL can be refused.
 *
 * Deliberately more specific than what `guarded-fetch.js` reports at poll time. Here
 * the operator is looking at the field they just typed into and there is nothing to
 * leak — the address has not been contacted, and telling them "that is a private
 * address" is the whole point. At poll time the same distinctions become an oracle,
 * which is why that path collapses them.
 */
function urlProblem(reason) {
  switch (reason) {
    case 'bad_scheme':
      return 'Feed addresses have to start with http:// or https://.';
    case 'credentials_in_url':
      return 'Remove the username and password from that address — a private feed carries its token in the path, not in a login.';
    case 'blocked_port':
      return 'SelfPod only fetches feeds on the standard web ports (80 and 443).';
    case 'blocked_address':
      return 'That address is on a private or local network. SelfPod only follows feeds on public addresses, so it can never be used to reach the rest of your network.';
    default:
      return "That doesn't look like a feed address. It should be a full URL, like https://example.com/feed.xml.";
  }
}

function isTrue(value) {
  return value === true || value === 'true' || value === '1' || value === 'on' || value === 'yes';
}
