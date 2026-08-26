import { createWriteStream } from 'node:fs';
import { readdir, stat, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  ITEM_DECISION,
  REMOTE_FEED_CONTENT_TYPES,
  REMOTE_FEED_MAX_BYTES,
  REMOTE_MAX_ITEMS_PER_POLL,
  AUDIO_MIME_TYPES,
  REMOTE_POLL_MAX_SECONDS,
  SCAN_TRIGGER,
} from '../constants.js';
import { nowIso } from '../lib/dates.js';
import { badRequest, describeFsError } from '../lib/errors.js';
import { checkDuration, evaluateItem } from '../lib/feed-filter.js';
import { computeIdentityKey } from '../lib/identity.js';
import { moveIntoPlace } from '../lib/move.js';
import { remoteEpisodeFilename } from '../lib/remote-filename.js';
import { uniqueTarget } from '../lib/unique-filename.js';
import { newId } from '../lib/tokens.js';
import { projectFeed } from '../lib/feed-projection.js';
import { TERMINAL_FETCH_FAILURES, createGuardedFetch } from '../lib/guarded-fetch.js';
import { signPing } from '../lib/instance-proof.js';
import { redactFeedUrl } from '../plugins/log-redaction.js';
import { parseFeed } from '../lib/rss-parse.js';

/**
 * Polling remote feeds, deciding what to take, and recording why (spec §18).
 *
 * The one place in SelfPod that reaches out to an address a person supplied. Everything
 * about *whether* it may is in lib/address-rules.js and lib/guarded-fetch.js; this file
 * is about what to do with what comes back.
 *
 * Two rules shape the whole thing:
 *
 *  1. **Nothing is decided twice.** A remote GUID gets exactly one decision, recorded
 *     in feed_items, and a poll consults that ledger before doing anything. Restarts,
 *     rescans and re-polls are therefore free.
 *  2. **A refusal is as important as an acceptance.** "Why is that episode not in my
 *     feed?" has to be answerable, and the answer has to be a sentence rather than a
 *     code, or the feature is a black box with a filter box on the front.
 */

const ALLOWED_FEED_TYPES = new Set(REMOTE_FEED_CONTENT_TYPES);

/** Never let one poll's work grow without bound, however large the feed is. */
const MAX_ITEMS_RECORDED_PER_POLL = 500;

export function createRemoteFeeds({
  config,
  settings,
  subscriptions,
  shows,
  episodes,
  scanner,
  metadata,
  activity,
  health,
  events,
  logger,
  // Injected so tests can drive a loopback server without a bypass inside the guard
  // itself. Production never passes this.
  guardedFetch = null,
} = {}) {
  let stopped = false;
  let polling = false;
  const inFlight = new Set();

  const fetcher =
    guardedFetch ??
    createGuardedFetch({
      allowedPrivateHosts: config.allowedPrivateFeedHosts,
      selfOrigin: () => settings.publicBaseUrl(),
      // Every SelfPod echoes a nonce; only this one can sign it. Reused verbatim from
      // the reachability check, which needed exactly this distinction first.
      signProbe: (nonce, proof) => {
        try {
          return signPing(settings.sessionSecret(), nonce) === proof;
        } catch {
          return false;
        }
      },
      logger,
    });

  function enabled() {
    return settings.subscriptionsEnabled();
  }

  /**
   * When to look again.
   *
   * Jittered so several subscriptions do not settle into lockstep and arrive at one
   * publisher together, and persisted rather than held in a timer so a container that
   * restarts hourly does not re-poll everything at boot.
   */
  function nextPollAt(subscription, { failures = 0 } = {}) {
    const base = subscription.poll_interval_seconds ?? settings.remotePollIntervalSeconds();
    // Exponential backoff, but never so long that a subscription looks abandoned.
    const backoff = Math.min(base * 2 ** Math.min(failures, 10), REMOTE_POLL_MAX_SECONDS);
    const jittered = backoff * (0.85 + Math.random() * 0.3);
    return new Date(Date.now() + jittered * 1000).toISOString();
  }

  /**
   * Surfaces a feed that has stopped working — but not on the first stumble.
   *
   * Third failure, not first, for the reason the watcher waits for two strikes: a
   * banner on every page for one network blip trains people to ignore banners, and an
   * ignored banner is worse than none.
   */
  function reportHealth(subscription, { status, message }) {
    const key = `remote_feed_${subscription.id}`;
    if (status === 'ok' || status === 'not_modified') {
      health?.clear?.(key);
      return;
    }
    if ((subscription.consecutive_failures ?? 0) + 1 < 3) return;
    health?.set?.(key, { level: 'warn', message });
  }

  /**
   * Applies the backfill horizon on the very first poll.
   *
   * "Newest N matching" needs a definition of newest, and a feed cannot be trusted to
   * be in order — some serials publish oldest-first. So: sort by parsed date, with
   * items whose date could not be read falling back to the order the document listed
   * them in, which is the near-universal convention.
   */
  function applyBackfillHorizon(matching, limit) {
    const sorted = [...matching].sort((a, b) => {
      if (a.item.pubDate && b.item.pubDate) return b.item.pubDate.localeCompare(a.item.pubDate);
      if (a.item.pubDate) return -1;
      if (b.item.pubDate) return 1;
      return a.index - b.index;
    });
    return { take: sorted.slice(0, limit), skip: sorted.slice(limit) };
  }

  async function fetchFeed(subscription) {
    const requestHeaders = {};
    // Sent exactly as the origin gave them. A validator we re-derived or re-formatted
    // is a validator the origin cannot recognise, which is a validator that never
    // validates — the same argument lib/http-headers.js makes for the inbound
    // direction. That module is deliberately *not* reused here: it answers "is the
    // client's copy current?", and outbound SelfPod is the client and compares nothing.
    if (subscription.http_etag) requestHeaders['if-none-match'] = subscription.http_etag;
    if (subscription.http_last_modified) {
      requestHeaders['if-modified-since'] = subscription.http_last_modified;
    }

    return fetcher(subscription.feed_url, {
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
      allowedTypes: ALLOWED_FEED_TYPES,
      maxBytes: REMOTE_FEED_MAX_BYTES,
      requestHeaders,
    });
  }

  /**
   * One poll: fetch, parse, record every item, decide the undecided ones.
   *
   * Downloading is a separate stage and deliberately not part of this function. Until
   * it exists, a keeper stops at `matched` — which is also what makes it possible to
   * prove that polling alone writes nothing at all into a show folder.
   */
  async function pollOne(subscription, { trigger = SCAN_TRIGGER.SCHEDULED } = {}) {
    const show = shows.get(subscription.show_id);
    if (!show) return { status: 'gone' };

    const host = redactFeedUrl(subscription.feed_url);
    let response;
    try {
      response = await fetchFeed(subscription);
    } catch (error) {
      // Two kinds of failure, and only one of them is worth retrying.
      //
      // A refused address, scheme, port or credential is not a bad day on the
      // network — it is a subscription that can never work as written, and retrying
      // it every fifteen minutes for ever is both pointless and, for a blocked
      // address, a probe that keeps firing. Those are stopped and surfaced. Anything
      // else backs off and keeps trying, because a feed that is briefly down must
      // never be silently abandoned.
      const terminal = TERMINAL_FETCH_FAILURES.includes(error.code);
      const status = terminal ? 'blocked' : 'network_error';
      logger?.warn({ feed: host, code: error.code, detail: error.detail }, 'feed poll failed');

      subscriptions.recordPollResult(subscription.id, {
        status,
        error: error.message,
        nextPollAt: terminal
          ? null
          : nextPollAt(subscription, { failures: (subscription.consecutive_failures ?? 0) + 1 }),
      });

      if (terminal) {
        subscriptions.update(subscription.id, { enabled: false });
        health?.set?.(`remote_feed_${subscription.id}`, {
          level: 'error',
          message: `SelfPod stopped following ${host}: ${error.message}`,
        });
      } else {
        reportHealth(subscription, {
          status,
          message: expiredOrUnreachable(subscription, error, host),
        });
      }
      return { status, error: error.message, terminal };
    }

    if (response.notModified) {
      // Nothing changed, so nothing is logged to the activity feed: a subscription
      // polled hourly would otherwise file twenty-four "nothing happened" rows a day
      // and bury the log the trim keeps at five hundred.
      subscriptions.recordPollResult(subscription.id, {
        status: 'not_modified',
        etag: response.etag,
        lastModified: response.lastModified,
        nextPollAt: nextPollAt(subscription),
      });
      reportHealth(subscription, { status: 'not_modified' });
      return { status: 'not_modified', added: 0, rejected: 0 };
    }

    let feed;
    try {
      feed = parseFeed(response.body, { contentType: response.contentType });
    } catch (error) {
      logger?.warn({ feed: host, code: error.code }, 'feed could not be parsed');
      subscriptions.recordPollResult(subscription.id, {
        status: 'parse_error',
        error: error.message,
        etag: response.etag,
        lastModified: response.lastModified,
        nextPollAt: nextPollAt(subscription, { failures: (subscription.consecutive_failures ?? 0) + 1 }),
      });
      reportHealth(subscription, { status: 'parse_error', message: `${host}: ${error.message}` });
      return { status: 'parse_error', error: error.message };
    }

    const rules = rulesFor(subscription);
    const firstPoll = !subscription.bootstrapped_at;

    const record = activity.start({
      showId: show.id,
      trigger: SCAN_TRIGGER.SUBSCRIPTION,
      note: `checking ${host}`,
    });

    let matched = 0;
    let rejected = 0;
    let skipped = 0;
    const warnings = [];

    try {
      // Everything the feed lists is recorded, decided or not. That is what makes
      // "the publisher removed this episode" distinguishable from "the feed only
      // carries the most recent fifty".
      const candidates = [];
      feed.items.slice(0, MAX_ITEMS_RECORDED_PER_POLL).forEach((item, index) => {
        const row = subscriptions.upsertItem(subscription.id, item);
        if (row.decision === ITEM_DECISION.PENDING) candidates.push({ row, item, index });
      });

      const keepers = [];
      for (const candidate of candidates) {
        const verdict = evaluateItem(candidate.item, rules);
        if (!verdict.keep) {
          subscriptions.markItem(candidate.row.id, {
            decision: ITEM_DECISION.REJECTED_DECLARED,
            reject_reason: verdict.reason,
            reject_detail: verdict.detail,
          });
          rejected += 1;
          continue;
        }
        keepers.push(candidate);
      }

      let toTake = keepers;
      if (firstPoll) {
        // The horizon applies to what *matched*, not to what the feed listed — "the
        // five most recent episodes I actually want", not "of the five most recent
        // episodes, whichever match".
        const { take, skip } = applyBackfillHorizon(keepers, subscription.backfill_count);
        toTake = take;
        for (const candidate of skip) {
          // No warning, deliberately. An eight-hundred-item feed would otherwise file
          // fifty warnings and "…and 745 more" on the very first poll, which reads as
          // something having gone wrong when nothing has.
          subscriptions.markItem(candidate.row.id, {
            decision: ITEM_DECISION.SKIPPED_BACKFILL,
            reject_detail: `Older than the ${subscription.backfill_count} most recent matching episodes, so it was left behind on the first check.`,
          });
          skipped += 1;
        }
      }

      for (const candidate of toTake.slice(0, REMOTE_MAX_ITEMS_PER_POLL)) {
        subscriptions.markItem(candidate.row.id, { decision: ITEM_DECISION.MATCHED });
        matched += 1;
      }

      if (firstPoll) subscriptions.markBootstrapped(subscription.id);

      subscriptions.recordPollResult(subscription.id, {
        status: 'ok',
        error: null,
        etag: response.etag,
        lastModified: response.lastModified,
        remoteTitle: feed.title,
        nextPollAt: nextPollAt(subscription),
      });
      reportHealth(subscription, { status: 'ok' });


      logger?.info({ feed: host, matched, rejected, skipped, trigger }, 'feed polled');
      const { downloaded, refused } = await downloadMatched(subscriptions.get(subscription.id), show);

      activity.finish(record, {
        // Counters chosen so the activity log reads as English rather than as scan
        // arithmetic. `removed` renders as "N dropped", which in this app already
        // means "left your feed" — using it for episodes that never entered the feed
        // would be a lie in the one place people go to find out what happened. The
        // sentence carries the real story instead.
        filesFound: downloaded,
        added: downloaded,
        note: summary({ title: feed.title || host, downloaded, rejected, skipped, refused }),
        warnings,
      });

      return { status: 'ok', matched, rejected, skipped, downloaded, refused, title: feed.title };
    } catch (error) {
      activity.finish(record, { errors: [{ message: error.message }] });
      throw error;
    }
  }

  function rulesFor(subscription) {
    return {
      includeKeywords: safeJsonArray(subscription.include_keywords),
      excludeKeywords: safeJsonArray(subscription.exclude_keywords),
      minDurationSeconds: subscription.min_duration_seconds,
      maxDurationSeconds: subscription.max_duration_seconds,
    };
  }

  /** Resolves once a write stream has actually released its file descriptor. */
  function closeStream(sink) {
    return new Promise((resolve) => {
      if (sink.destroyed && sink.closed) return resolve();
      sink.once('close', resolve);
      sink.destroy();
      // Never hang the poll on a stream that will not close.
      setTimeout(resolve, 2000).unref?.();
      return undefined;
    });
  }

  /** Staging lives in the show folder, dot-prefixed. See downloadOne for why. */
  const STAGING_PREFIX = '.selfpod-download-';

  const AUDIO_TYPES = new Set([...Object.values(AUDIO_MIME_TYPES), 'application/octet-stream']);

  /**
   * Fetches one matched item and leaves it staged, or records why it was refused.
   *
   * Staged **inside the show folder**, not in /data/.tmp, and that is deliberate. On
   * the layout this app is built for, /data is the small app dataset and the shows are
   * a separate share — so staging in /data/.tmp means every download crosses a
   * filesystem boundary and `moveIntoPlace` copies eighty megabytes twice. It also
   * means the likeliest way to run out of space is /data filling with staged audio and
   * taking db.sqlite down with it. Staging beside the destination makes the move a
   * real atomic rename, puts the bytes on the volume that has room, and — because both
   * the scanner and the watcher skip dot-prefixed entries — keeps the file invisible
   * until it is finished.
   *
   * @returns {{ staged: string, filename: string, item: object } | null}
   */
  async function downloadOne(subscription, show, row, stagedKeys = new Map()) {
    const showDir = shows.dirFor(show);
    const staged = join(showDir, `${STAGING_PREFIX}${newId()}`);
    const limit = settings.remoteMaxDownloadBytes();

    // Reserve the whole expected size up front and correct it afterwards. Counting
    // each chunk would be tens of thousands of synchronous SQLite writes on a large
    // file, with every media request queueing behind them.
    const expected = Math.min(row.declared_length_bytes || limit, limit);
    if (!subscriptions.reserveBytes(expected, { limit: dailyByteLimit(), windowMs: 86_400_000 })) {
      subscriptions.markItem(row.id, {
        decision: ITEM_DECISION.FAILED,
        reject_reason: 'budget_exhausted',
        reject_detail:
          "SelfPod has downloaded as much as it is allowed to in one day. It will pick this up tomorrow.",
        next_attempt_at: new Date(Date.now() + 3600_000).toISOString(),
      });
      return null;
    }

    let actualBytes = 0;
    try {
      subscriptions.markItem(row.id, { decision: ITEM_DECISION.DOWNLOADING });

      const sink = createWriteStream(staged);
      let response;
      try {
        response = await fetcher(row.enclosure_url, {
          accept: 'audio/*',
          allowedTypes: AUDIO_TYPES,
          maxBytes: limit,
          sink,
        });
        await new Promise((resolve, rejectStream) => {
          sink.end(() => resolve());
          sink.on('error', rejectStream);
        });
      } catch (error) {
        // Awaited, not fire-and-forget. `createWriteStream` opens its file descriptor
        // lazily, so a `destroy()` that has not finished can still create the file
        // *after* the unlink below has run — leaving a staging file behind for every
        // refused download, in the user's own show folder, which is exactly what the
        // cleanup exists to prevent.
        await closeStream(sink);
        throw error;
      }
      actualBytes = response.bytes;

      const extension = remoteEpisodeFilename({
        title: row.title,
        url: row.enclosure_url,
        contentType: response.contentType,
        pubDate: row.pub_date,
        guid: row.remote_guid,
      });
      if (!extension.filename) {
        return reject(row, staged, {
          decision: ITEM_DECISION.REJECTED_MEASURED,
          reason: extension.reason,
          detail: `That episode's audio is a type SelfPod doesn't serve, so it wasn't kept.`,
        });
      }

      // The junk gate. A paywall page served as audio/mpeg parses as nothing, and
      // this is where that is caught — before the file has a chance to become an
      // episode and warn the user about a file they never put there.
      const meta = await metadata.read(staged);
      if (meta.error && meta.durationSeconds === null) {
        return reject(row, staged, {
          decision: ITEM_DECISION.REJECTED_MEASURED,
          reason: 'not_audio',
          detail: "What that address returned isn't audio SelfPod can read, so it wasn't kept.",
        });
      }

      // The duration rule, run a second time — but **only for an episode whose feed
      // never stated a length**.
      //
      // Re-checking one the publisher did declare would be a different feature, and a
      // bad one: a feed whose stated duration is a few seconds out from the file's own
      // header would have episodes silently downloaded and then discarded, over a
      // discrepancy the user cannot see and could not fix. The declared value already
      // passed the filter; the measured pass exists to answer the question the feed
      // declined to answer, not to second-guess the answer it gave.
      const failed =
        row.declared_duration_seconds === null
          ? checkDuration(
              meta.durationSeconds,
              subscription.min_duration_seconds,
              subscription.max_duration_seconds,
            )
          : null;
      if (failed) {
        return reject(row, staged, {
          decision: ITEM_DECISION.REJECTED_MEASURED,
          reason: failed.reason,
          // Says the feed did not state a length, because that is why it was fetched
          // at all — otherwise this reads as SelfPod wasting bandwidth for no reason.
          detail: `${failed.detail} (That feed doesn't state episode lengths, so SelfPod had to download it to find out.)`,
        });
      }

      // Content-addressed, computed with the identical function the scanner will use,
      // so the two agree by construction. Checked *here*, while the file is still
      // staged, so byte-identical audio costs an unlink rather than an episode the
      // scanner has already adopted and warned about.
      const stats = await stat(staged);
      const identityKey = await computeIdentityKey(staged, { size: stats.size });
      // Checked against episodes that already exist **and** against what this same
      // run has already staged. The scanner has not run yet, so two byte-identical
      // items in one batch are invisible to findByIdentity — and a publisher
      // re-issuing the same audio under a new id in the same feed is the ordinary way
      // that happens.
      const twin = episodes.findByIdentity(show.id, identityKey);
      const stagedTwin = stagedKeys.get(identityKey);
      if (twin || stagedTwin) {
        return reject(row, staged, {
          decision: ITEM_DECISION.DUPLICATE,
          reason: 'duplicate',
          detail: `That episode is byte-for-byte identical to "${twin?.title ?? stagedTwin}", which SelfPod already has.`,
          episodeId: twin?.id ?? null,
        });
      }
      stagedKeys.set(identityKey, row.title || extension.filename);

      const filename = await uniqueTarget(showDir, extension.filename);

      // One utimes call, and it replaces a whole enrichment step: the scanner takes
      // pub_date from the file's mtime, so setting it here means the episode is dated
      // and ordered correctly from the moment it is first seen — with no window in
      // which subscribers are served a backfill in download order.
      if (row.pub_date) {
        const when = new Date(row.pub_date);
        if (!Number.isNaN(when.getTime())) await utimes(staged, when, when);
      }

      subscriptions.markItem(row.id, { identity_key: identityKey, bytes: actualBytes });
      return { staged, filename, row, identityKey, bytes: actualBytes };
    } catch (error) {
      await unlink(staged).catch(() => {});
      return handleDownloadError(row, error, show);
    } finally {
      subscriptions.settleBytes(expected, actualBytes);
    }
  }

  async function reject(row, staged, { decision, reason, detail, episodeId = null }) {
    // Nothing ever reached the show folder, so there is nothing to undo: the file is
    // still under its dot-prefixed staging name, invisible to the scanner.
    await unlink(staged).catch(() => {});
    subscriptions.markItem(row.id, {
      decision,
      reject_reason: reason,
      reject_detail: detail,
      episode_id: episodeId,
    });
    return null;
  }

  function handleDownloadError(row, error, show) {
    const terminal = TERMINAL_FETCH_FAILURES.includes(error.code);
    if (terminal) {
      // A refused address on an enclosure must never be retried, for the same reason
      // a refused feed address is not: a hostile feed listing twenty-five enclosures
      // on the LAN would otherwise be a probe firing on every poll for ever.
      subscriptions.markItem(row.id, {
        decision: ITEM_DECISION.REJECTED_BLOCKED,
        reject_reason: error.code,
        reject_detail: error.message,
      });
      return null;
    }
    if (error.code === 'ENOSPC' || error.code === 'EROFS' || error.code === 'EACCES') {
      subscriptions.markItem(row.id, {
        decision: ITEM_DECISION.FAILED,
        reject_reason: error.code,
        reject_detail: describeFsError(error, {
          path: shows.dirFor(show),
          uid: config.puid,
          gid: config.pgid,
        }),
      });
      const outOfSpace = new Error(error.code);
      outOfSpace.fatalForRun = true;
      throw outOfSpace;
    }
    subscriptions.markItem(row.id, {
      decision: ITEM_DECISION.FAILED,
      reject_reason: error.code ?? 'download_failed',
      reject_detail: error.message,
      attempts: (row.attempts ?? 0) + 1,
      next_attempt_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    return null;
  }

  function dailyByteLimit() {
    // Twenty subscriptions with their own allowance would be a hundred gigabytes a
    // day; the budget belongs to the instance.
    return 5 * 1024 * 1024 * 1024;
  }

  /**
   * Downloads everything matched for one subscription, then moves the batch in at once.
   *
   * Moved together rather than one at a time because the watcher debounces at three
   * seconds and fires on the *first* file that appears. Trickling files in would give
   * a backfill roughly one scan per file, each one emitting SHOW_CHANGED, invalidating
   * the feed cache and handing a polling subscriber a half-finished feed — and would
   * move lastBuildDate and the ETag every time, so every subscriber re-downloads the
   * feed repeatedly during a backfill.
   */
  async function downloadMatched(subscription, show) {
    const matched = subscriptions
      .items({ subscriptionId: subscription.id, decision: ITEM_DECISION.MATCHED, limit: REMOTE_MAX_ITEMS_PER_POLL })
      .filter((row) => row.enclosure_url)
      .filter((row) => !row.next_attempt_at || row.next_attempt_at <= nowIso());

    if (!matched.length) return { downloaded: 0, refused: 0 };

    const staged = [];
    const stagedKeys = new Map();
    let refused = 0;
    try {
      for (const row of matched) {
        if (stopped || !enabled()) break;
        const result = await downloadOne(subscription, show, row, stagedKeys);
        if (result) staged.push(result);
        else refused += 1;
      }
    } catch (error) {
      if (!error.fatalForRun) throw error;
      // Out of space: finish placing what already downloaded rather than throwing it
      // away, and stop asking for more.
      logger?.error({ code: error.message }, 'stopped downloading: no space left');
      health?.set?.('remote_download_space', {
        level: 'error',
        message: `SelfPod ran out of space while downloading episodes into \`${shows.dirFor(show)}\`. It has stopped fetching until there is room.`,
      });
    }

    if (!staged.length) return { downloaded: 0, refused };

    const showDir = shows.dirFor(show);
    const placed = [];
    for (const entry of staged) {
      try {
        await moveIntoPlace(entry.staged, join(showDir, entry.filename));
        subscriptions.markItem(entry.row.id, {
          decision: ITEM_DECISION.DOWNLOADED,
          filename: entry.filename,
          downloaded_at: nowIso(),
        });
        placed.push(entry);
      } catch (error) {
        await unlink(entry.staged).catch(() => {});
        subscriptions.markItem(entry.row.id, {
          decision: ITEM_DECISION.FAILED,
          reject_reason: error.code ?? 'move_failed',
          reject_detail: describeFsError(error, { path: showDir, uid: config.puid, gid: config.pgid }),
        });
        refused += 1;
      }
    }

    if (placed.length) {
      health?.clear?.('remote_download_space');
      await scanner.scanShowNow(show.id, SCAN_TRIGGER.SUBSCRIPTION);
      await api.reconcile(subscription.id);
    }

    return { downloaded: placed.length, refused };
  }

  /**
   * Puts the publisher's own title, description and date onto the episode.
   *
   * `episodes.setSystemFields`, never `episodes.update`. The latter sets
   * `title_is_custom` whenever the new title differs from the file's ID3 title — which
   * for a downloaded episode is almost always — so every subscribed episode would be
   * permanently flagged as hand-edited by the user, and any future "reset to the
   * file's tags" affordance would be wrong for the entire library. It also emits
   * SHOW_CHANGED per call, which for a backfill of twenty is twenty feed-cache
   * invalidations and twenty SSE events.
   *
   * The date is already right, because the staged file's mtime was set to the
   * publication date before it was moved in and the scanner reads pub_date from that.
   */
  function enrich(episode, row) {
    const fields = {};
    if (row.title && row.title !== episode.title) fields.title = row.title.slice(0, 400);
    if (!episode.description && row.pub_date) fields.pub_date = row.pub_date;
    if (!Object.keys(fields).length) return;
    episodes.setSystemFields(episode.id, fields);
  }

  const api = {
    /** Polls everything that is due, one at a time. */
    async pollDue() {
      if (stopped || polling || !enabled()) return { polled: 0 };
      polling = true;
      let polled = 0;
      try {
        for (const subscription of subscriptions.listDue()) {
          if (stopped || !enabled()) break;
          try {
            await pollOne(subscription);
            polled += 1;
          } catch (error) {
            logger?.error({ err: error, subscriptionId: subscription.id }, 'poll threw');
          }
        }
      } finally {
        polling = false;
      }
      return { polled };
    },

    /** Polls one subscription now, for the "check now" button. */
    async pollNow(subscriptionId, { trigger = SCAN_TRIGGER.MANUAL } = {}) {
      if (!enabled()) {
        throw badRequest(
          'Feed subscriptions are switched off. Turn them on in Settings first.',
          'subscriptions_disabled',
        );
      }
      const subscription = subscriptions.getOrThrow(subscriptionId);
      if (inFlight.has(subscriptionId)) {
        return { status: 'already_running' };
      }
      inFlight.add(subscriptionId);
      try {
        return await pollOne(subscription, { trigger });
      } finally {
        inFlight.delete(subscriptionId);
      }
    },

    /**
     * Fetches and filters a feed without recording or downloading anything.
     *
     * The feature that makes the rest usable: paste a URL, set the rules, and see
     * which episodes would be taken and exactly why the others would not — before a
     * single byte is fetched on purpose.
     */
    async preview(feedUrl, rules = {}) {
      if (!enabled()) {
        throw badRequest(
          'Feed subscriptions are switched off. Turn them on in Settings first.',
          'subscriptions_disabled',
        );
      }
      const response = await fetcher(feedUrl, {
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
        allowedTypes: ALLOWED_FEED_TYPES,
        maxBytes: REMOTE_FEED_MAX_BYTES,
      });
      const feed = parseFeed(response.body, { contentType: response.contentType });
      return projectFeed(feed, rules);
    },

    /**
     * Links downloaded files to the episode rows the scanner created.
     *
     * Tri-state, and the third case is the one that matters. A row that says
     * `downloaded` with no episode has three possible explanations, and treating them
     * alike is how this becomes an infinite loop:
     *
     *   the episode exists          → link it, done;
     *   the file is there, no row   → the scanner has not run yet; leave it alone;
     *   the file is gone            → the user deleted the episode. Terminal. Never
     *                                 download it again, or every deletion turns into
     *                                 a re-download on the next poll and the file the
     *                                 user removed keeps coming back.
     */
    async reconcile(subscriptionId = null) {
      let linked = 0;
      let released = 0;
      for (const row of subscriptions.unlinked(subscriptionId)) {
        const subscription = subscriptions.get(row.subscription_id);
        const show = subscription && shows.get(subscription.show_id);
        if (!show) continue;

        const episode = row.identity_key
          ? episodes.findByIdentity(show.id, row.identity_key)
          : null;
        if (episode) {
          subscriptions.markItem(row.id, { episode_id: episode.id });
          enrich(episode, row);
          linked += 1;
          continue;
        }

        if (!row.filename) continue;
        const onDisk = await stat(join(shows.dirFor(show), row.filename)).catch(() => null);
        if (onDisk) continue; // waiting for the next scan

        subscriptions.markItem(row.id, {
          decision: ITEM_DECISION.DELETED_BY_USER,
          reject_detail:
            'You deleted this episode, so SelfPod will not download it again. Use "Download again" if you change your mind.',
        });
        released += 1;
      }
      if (linked || released) logger?.debug({ linked, released }, 'reconciled subscription items');
      return { linked, released };
    },

    /**
     * Removes staging files left behind by a kill, and requeues their rows.
     *
     * Restarting a download rather than resuming it is deliberate: resuming needs
     * If-Range, a stored strong validator, and a guarantee the staged bytes were
     * flushed before the process died — none of which is knowable after a SIGKILL.
     * Getting it wrong publishes a corrupt episode to subscribers.
     */
    async sweepStaging() {
      let removed = 0;
      const cutoff = Date.now() - 6 * 60 * 60 * 1000;
      for (const show of shows.list()) {
        const dir = shows.dirFor(show);
        const entries = await readdir(dir).catch(() => []);
        for (const name of entries) {
          if (!name.startsWith(STAGING_PREFIX)) continue;
          const path = join(dir, name);
          const info = await stat(path).catch(() => null);
          if (info && info.mtimeMs > cutoff) continue;
          await unlink(path).catch(() => {});
          removed += 1;
        }
      }
      const requeued = subscriptions.resetStuckDownloads();
      if (removed || requeued) logger?.info({ removed, requeued }, 'cleaned up interrupted downloads');
      return { removed, requeued };
    },

    status() {
      return { enabled: enabled(), polling, inFlight: inFlight.size };
    },

    stop() {
      stopped = true;
    },
  };

  return api;
}

/**
 * The one place a distinct failure sentence is allowed, and only once a feed has
 * worked before.
 *
 * A 401 or 403 almost always means a private feed's token has expired, and saying so
 * saves an operator a long afternoon. But "that host answered 401" is also exactly the
 * oracle guarded-fetch.js collapses on purpose — it distinguishes "an admin panel
 * lives here" from "nothing is listening". The compromise costs nothing: if the
 * subscription has ever succeeded, we already know that address serves a feed, so
 * naming the reason reveals nothing new. If it never has, it stays indistinguishable.
 */
function expiredOrUnreachable(subscription, error, host) {
  if (subscription.last_success_at && error.detail && /http 40[13]/.test(error.detail)) {
    return `${host} refused SelfPod's request. Private feed links usually expire — get a fresh one from the publisher and paste it in.`;
  }
  return `${host} could not be reached. SelfPod will keep trying, less often each time.`;
}

function summary({ title, downloaded, rejected, skipped, refused }) {
  const parts = [];
  parts.push(downloaded === 1 ? '1 new episode downloaded' : `${downloaded} new episodes downloaded`);
  if (rejected) parts.push(`${rejected} didn't match your rules`);
  if (skipped) parts.push(`${skipped} left behind by the backfill limit`);
  if (refused) parts.push(`${refused} couldn't be kept`);
  return `Checked ${title} — ${parts.join(', ')}.`;
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}
