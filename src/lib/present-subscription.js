/**
 * The shapes a subscription and its ledger take on the way out.
 *
 * Shared by the JSON API and the admin pages so the two cannot drift. That matters
 * more here than for most presenters: the ledger is the answer to "where is that
 * episode?", and an API that says one thing while the page says another would leave
 * the operator with two accounts of the same event and no way to tell which is right.
 */

/**
 * The subscription as a caller sees it.
 *
 * The feed URL is returned in full. An admin needs it in order to read and edit it,
 * and it is the same judgement `presentShow` already makes about a show's feed token.
 * It must still never reach a log line — see redactFeedUrl, and note that the two
 * decisions are not in tension: an authenticated admin looking at their own settings
 * page is not the audience a log file has.
 */
export function presentSubscription(subscription, { subscriptions }) {
  if (!subscription) return null;
  return {
    id: subscription.id,
    showId: subscription.show_id,
    feedUrl: subscription.feed_url,
    remoteTitle: subscription.remote_title,
    enabled: Boolean(subscription.enabled),
    includeKeywords: safeArray(subscription.include_keywords),
    excludeKeywords: safeArray(subscription.exclude_keywords),
    minDurationSeconds: subscription.min_duration_seconds,
    maxDurationSeconds: subscription.max_duration_seconds,
    backfillCount: subscription.backfill_count,
    bootstrapped: Boolean(subscription.bootstrapped_at),
    pollIntervalSeconds: subscription.poll_interval_seconds,
    lastPolledAt: subscription.last_polled_at,
    lastSuccessAt: subscription.last_success_at,
    lastStatus: subscription.last_status,
    lastError: subscription.last_error,
    consecutiveFailures: subscription.consecutive_failures,
    nextPollAt: subscription.next_poll_at,
    counts: subscriptions.itemCounts(subscription.id),
  };
}

/**
 * One ledger row, plus the current state of the episode it became.
 *
 * The episode's status is looked up rather than inferred, because "downloaded" on its
 * own becomes misleading the moment a file is deleted from the share or removed from
 * the feed: the ledger would go on saying downloaded while the episode is gone, which
 * is exactly the question this table exists to answer.
 */
export function presentItem(row, { episodes }) {
  const episode = row.episode_id ? episodes.get(row.episode_id) : null;
  return {
    id: row.id,
    guid: row.remote_guid,
    guidSource: row.guid_source,
    title: row.title,
    publishedAt: row.pub_date,
    durationSeconds: row.declared_duration_seconds,
    decision: row.decision,
    /*
     * Whether SelfPod means to fetch this episode a second time, and why.
     *
     * Surfaced because the ledger's whole job is to answer "what happened to that
     * episode", and this is something SelfPod does on the owner's behalf without being
     * asked — it spends their bandwidth and costs the publisher a second counted
     * listen. Doing that silently is the one thing the page is meant not to do.
     */
    lookAgain: row.recheck_after && !row.rechecked_at ? row.recheck_reason : null,
    lookedAgain: row.rechecked_at ? row.recheck_outcome : null,
    reason: row.reject_reason,
    detail: row.reject_detail,
    filename: row.filename,
    bytes: row.bytes,
    downloadedAt: row.downloaded_at,
    episodeId: row.episode_id,
    episodeStatus: episode?.status ?? null,
    lastSeenInFeedAt: row.last_seen_in_feed_at,
  };
}

function safeArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
