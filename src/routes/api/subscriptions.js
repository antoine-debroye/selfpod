import { ITEM_DECISION, REMOTE_MAX_SUBSCRIPTIONS } from '../../constants.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { normaliseKeywords } from '../../lib/feed-filter.js';
import { presentItem, presentSubscription } from '../../lib/present-subscription.js';

/**
 * The JSON API for feed subscriptions (spec §18.6).
 *
 * Every route here is admin-only, and the two that cause SelfPod to call out to an
 * address someone supplied — `preview` and `poll` — are also rate limited. Note the
 * order the limiter is applied in: **after** authentication, never as route
 * `config.rateLimit`. Declared the obvious way round it runs on `onRequest`, before
 * the auth hook, so an anonymous flood would spend the operator's budget and be told
 * "too many requests" instead of "sign in" — a denial of service on the feature,
 * mounted by someone who never signed in.
 */

const PREVIEW_LIMIT = { max: 5, timeWindow: '5 minutes' };
const POLL_LIMIT = { max: 10, timeWindow: '1 hour' };

export default async function subscriptionRoutes(fastify, services) {
  const { subscriptions, remoteFeeds, shows, episodes, settings, logger } = services;

  fastify.addHook('onRequest', fastify.requireAdminApi);

  const guarded = (limit) => ({ preHandler: [fastify.rateLimit(limit)] });

  function requireEnabled() {
    if (!settings.subscriptionsEnabled()) {
      throw badRequest(
        'Feed subscriptions are switched off. Turn them on in Settings first — it is off by default because it is the only thing that makes SelfPod fetch from the internet.',
        'subscriptions_disabled',
      );
    }
  }

  fastify.get('/shows/:id/subscriptions', async (request) => {
    const show = shows.getOrThrow(request.params.id);
    const subscription = subscriptions.getForShow(show.id);
    return {
      subscription: subscription ? presentSubscription(subscription, { subscriptions }) : null,
      max: REMOTE_MAX_SUBSCRIPTIONS,
      enabled: settings.subscriptionsEnabled(),
    };
  });

  fastify.post('/shows/:id/subscriptions', guarded(PREVIEW_LIMIT), async (request, reply) => {
    requireEnabled();
    const show = shows.getOrThrow(request.params.id);
    const created = subscriptions.create(show.id, request.body ?? {});
    reply.status(201);
    return { subscription: presentSubscription(created, { subscriptions }) };
  });

  fastify.get('/subscriptions/:id', async (request) => ({
    subscription: presentSubscription(subscriptions.getOrThrow(request.params.id), { subscriptions }),
  }));

  fastify.patch('/subscriptions/:id', async (request) => {
    const existing = subscriptions.getOrThrow(request.params.id);
    // Counted before the change, because afterwards the rows have already moved.
    const reopening = willReopen(existing, request.body ?? {})
      ? subscriptions.reopenableCount(existing.id)
      : 0;
    const updated = subscriptions.update(existing.id, request.body ?? {});
    return {
      subscription: presentSubscription(updated, { subscriptions }),
      // "12 episodes you skipped will be re-checked" is the difference between a
      // setting and a surprise.
      reopened: reopening,
    };
  });

  fastify.delete('/subscriptions/:id', async (request) => {
    const { showId } = subscriptions.remove(request.params.id);
    return {
      removed: true,
      showId,
      // Said plainly, because the two are genuinely separate acts here and everywhere
      // else in SelfPod. The episodes stay in the feed and on the share.
      note: 'The episodes SelfPod already downloaded are untouched — they stay in your feed and on your share. Only the following stops.',
    };
  });

  fastify.get('/subscriptions/:id/items', async (request) => {
    const subscription = subscriptions.getOrThrow(request.params.id);
    const { decision = null, limit = '50', offset = '0' } = request.query ?? {};
    const items = subscriptions.items({
      subscriptionId: subscription.id,
      decision: decision || null,
      limit: clampInt(limit, 1, 200, 50),
      offset: clampInt(offset, 0, 100000, 0),
    });
    return {
      items: items.map((row) => presentItem(row, { episodes })),
      counts: subscriptions.itemCounts(subscription.id),
    };
  });

  fastify.post('/subscriptions/:id/poll', guarded(POLL_LIMIT), async (request) => {
    requireEnabled();
    const subscription = subscriptions.getOrThrow(request.params.id);
    // One check per subscription per minute, on top of the shared limit. Checked
    // against the persisted timestamp rather than an in-memory counter, so a restart
    // does not hand out a fresh allowance.
    if (subscription.last_polled_at) {
      const since = Date.now() - new Date(subscription.last_polled_at).getTime();
      if (since < 60_000) {
        throw badRequest(
          `That feed was checked ${Math.round(since / 1000)} seconds ago. Give it a minute — this is someone else's server.`,
          'rate_limited',
        );
      }
    }
    const result = await remoteFeeds.pollNow(subscription.id);
    return { result, subscription: presentSubscription(subscriptions.get(subscription.id), { subscriptions }) };
  });

  fastify.post('/subscriptions/preview', guarded(PREVIEW_LIMIT), async (request) => {
    requireEnabled();
    const { feedUrl, includeKeywords, excludeKeywords, minDurationSeconds, maxDurationSeconds } =
      request.body ?? {};
    if (!feedUrl) throw badRequest('Paste the address of the feed you want to check.', 'feed_url_required');

    logger?.info({ host: safeHost(feedUrl) }, 'feed preview requested');
    return remoteFeeds.preview(String(feedUrl), {
      includeKeywords: normaliseKeywords(includeKeywords),
      excludeKeywords: normaliseKeywords(excludeKeywords),
      minDurationSeconds: toOptionalInt(minDurationSeconds),
      maxDurationSeconds: toOptionalInt(maxDurationSeconds),
    });
  });

  /**
   * Puts a decided item back in the queue.
   *
   * The way out of every terminal decision. Without it, deleting a downloaded episode
   * from the share is irreversible — the ledger says `downloaded`, the poller skips
   * it, and nothing anywhere offers a way back.
   */
  fastify.post('/subscriptions/:id/items/:itemId/redownload', async (request) => {
    const subscription = subscriptions.getOrThrow(request.params.id);
    const item = subscriptions.getItem(Number(request.params.itemId));
    if (!item || item.subscription_id !== subscription.id) {
      throw notFound('That episode is not in this subscription.', 'item_not_found');
    }
    if (item.decision === ITEM_DECISION.REJECTED_BLOCKED) {
      // The one refusal that is never undone from here: it was refused because its
      // address is one SelfPod must not reach, and a button that overrides that would
      // be a button that reaches it.
      throw badRequest(
        "That episode's audio is hosted on a private or local address, which SelfPod will not fetch from.",
        'blocked_address',
      );
    }
    subscriptions.markItem(item.id, {
      decision: ITEM_DECISION.MATCHED,
      reject_reason: null,
      reject_detail: null,
      episode_id: null,
      filename: null,
      identity_key: null,
      attempts: 0,
      next_attempt_at: null,
    });
    return { item: presentItem(subscriptions.getItem(item.id), { episodes }), queued: true };
  });
}

/** Which patches change a rule, and so re-open previous refusals. */
function willReopen(existing, patch) {
  if (patch.includeKeywords !== undefined || patch.excludeKeywords !== undefined) return true;
  if (patch.minDurationSeconds !== undefined || patch.maxDurationSeconds !== undefined) return true;
  return false;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toOptionalInt(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Host only, for the log — never the path, which is where a feed's token lives. */
function safeHost(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return 'unparseable';
  }
}
