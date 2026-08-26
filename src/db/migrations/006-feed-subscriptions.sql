-- Filtered subscriptions to remote podcast feeds (spec §18).
--
-- SelfPod polls a feed it does not own, filters the items against rules the user set,
-- and downloads the ones that match into an ordinary show folder — from which the
-- existing scanner and feed builder republish them. There is deliberately no second
-- episode pipeline: a downloaded file is exactly a file someone dropped in over SMB,
-- and everything §6 and §7.2 guarantee about such a file applies to it unchanged.
--
-- This is also the one place SelfPod writes into a show folder without being handed
-- the bytes, which is a deliberate exception to the rule stated in constants.js and in
-- migration 005 — the user asked for it by subscribing, and the show card says so.
--
-- One migration file rather than three, for the reason 005 gives: migrations are
-- applied by array index, each in its own transaction, forward-only with no way back.
-- Three files would mean three user_version steps for one deployable change, and a
-- boot that applied two and failed on the third would leave a schema no code expects.
--
-- Everything here is additive — new tables only, no column added to an existing one —
-- so an older image run against this schema simply ignores it and keeps working.
-- That is what makes rolling back a bad update non-destructive, and it is a property
-- worth preserving in every later migration rather than rediscovering.

CREATE TABLE feed_subscriptions (
  id                    TEXT PRIMARY KEY,
  show_id               TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,

  -- A credential in its own right. Private and premium feeds carry a per-listener
  -- token in the path or the query string, which is why this is never written to
  -- show.json or config.json and never reaches a log line un-redacted — the same rule
  -- shows.feed_token has, for the same reason.
  feed_url              TEXT NOT NULL,
  remote_title          TEXT,                       -- last <channel><title> seen, for the UI
  enabled               INTEGER NOT NULL DEFAULT 1,

  -- Rules. JSON arrays of already-folded strings, so the matcher never normalises at
  -- match time and what is stored is exactly what is compared — which is also what
  -- lets the UI show the user the rule that actually ran.
  include_keywords      TEXT NOT NULL DEFAULT '[]',
  exclude_keywords      TEXT NOT NULL DEFAULT '[]',
  min_duration_seconds  INTEGER,
  max_duration_seconds  INTEGER,

  -- How many of the newest matching items to take on the first poll. Afterwards
  -- bootstrapped_at is set and every later poll considers only items never seen.
  backfill_count        INTEGER NOT NULL DEFAULT 5,
  bootstrapped_at       TEXT,

  -- What to do about everything published while a subscription was switched off.
  -- Asked rather than assumed: "resume" is almost always what someone means by
  -- re-enabling, but "catch_up" is what they mean if they paused during a holiday,
  -- and silently picking either one can cost gigabytes.
  catch_up_mode         TEXT NOT NULL DEFAULT 'resume'
    CHECK (catch_up_mode IN ('resume', 'catch_up')),

  poll_interval_seconds INTEGER,                    -- NULL = use the instance default

  -- Outbound conditional-GET state, stored exactly as the remote sent it. Never
  -- re-derived or re-formatted: a validator the origin cannot recognise is a validator
  -- that never validates. (lib/http-headers.js makes the same argument for the inbound
  -- direction, and is deliberately *not* reused here — see services/remote-feeds.js.)
  http_etag             TEXT,
  http_last_modified    TEXT,

  last_polled_at        TEXT,
  last_success_at       TEXT,
  last_status           TEXT,
  last_error            TEXT,                       -- a plain sentence, shown verbatim
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,

  -- Persisted rather than held in a timer. A container that restarts hourly would
  -- otherwise re-poll every origin at boot, and several subscriptions would stay in
  -- lockstep for ever instead of being staggered once.
  next_poll_at          TEXT,

  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- One subscription per show, enforced rather than assumed.
--
-- Mixing several feeds into one show is a natural thing to want and is not in this
-- change: it makes the show's own title, description and artwork ambiguous, and there
-- is no good answer to "whose cover art is this?". Relaxing this index later is
-- deliberate work; leaving it out now would mean discovering the ambiguity in
-- production instead.
CREATE UNIQUE INDEX idx_feed_subscriptions_show ON feed_subscriptions(show_id);
CREATE INDEX idx_feed_subscriptions_due ON feed_subscriptions(enabled, next_poll_at);

-- Every remote item SelfPod has decided about, including — especially — the refusals.
--
-- Recording only what was downloaded would make "why is that episode not in my feed?"
-- unanswerable, and unanswerable is the failure class this whole app exists to remove
-- (§13). The reject_detail column carries the sentence shown to the user, so the answer
-- is "because the title contains `bonus`" rather than a code they have to look up.
CREATE TABLE feed_items (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id           TEXT NOT NULL REFERENCES feed_subscriptions(id) ON DELETE CASCADE,

  -- The feed's <guid> when it has one, else the enclosure URL, else a hash of title
  -- and date. guid_source records which, because a synthesised key is fragile in a way
  -- the user has to be able to see: a publisher fixing a typo in a title re-offers that
  -- item as new, and "why did that arrive twice?" needs a better answer than a shrug.
  remote_guid               TEXT NOT NULL,
  guid_source               TEXT NOT NULL
    CHECK (guid_source IN ('guid', 'enclosure', 'synthesised')),

  title                     TEXT NOT NULL DEFAULT '',
  enclosure_url             TEXT,
  pub_date                  TEXT,
  declared_duration_seconds INTEGER,
  declared_length_bytes     INTEGER,

  first_seen_at             TEXT NOT NULL,
  -- Without this there is no way to tell "the publisher removed this item" from "the
  -- feed truncated to its most recent fifty" from "the fetch returned an empty
  -- channel" — and an empty channel is a valid, non-error outcome.
  last_seen_in_feed_at      TEXT,
  decided_at                TEXT,

  -- A state machine, not a loose label. The three refusals are separate because they
  -- cost different amounts to revisit:
  --   rejected_declared  decided from the feed's own metadata, so re-checking it when
  --                      the user loosens a rule is free;
  --   rejected_measured  decided after the file was fetched and measured, so
  --                      re-checking it costs the whole download again;
  --   rejected_blocked   refused by the address guard, and never retried — a hostile
  --                      feed listing enclosures on the LAN would otherwise be a probe
  --                      that re-fires on every poll for ever.
  decision                  TEXT NOT NULL DEFAULT 'pending'
    CHECK (decision IN (
      'pending', 'matched', 'downloading', 'downloaded',
      'rejected_declared', 'rejected_measured', 'rejected_blocked',
      'skipped_backfill', 'duplicate', 'deleted_by_user', 'failed'
    )),
  reject_reason             TEXT,                   -- machine key, from lib/feed-filter.js
  reject_detail             TEXT,                   -- the sentence the UI shows

  attempts                  INTEGER NOT NULL DEFAULT 0,
  next_attempt_at           TEXT,

  filename                  TEXT,                   -- what was written into the show folder
  -- The handoff to the scanner. Computed by lib/identity.js on the staged file, with
  -- the identical function the scanner will use — so the two agree by construction
  -- rather than by convention, and the link survives a later rename.
  identity_key              TEXT,
  episode_id                TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  downloaded_at             TEXT,
  bytes                     INTEGER,

  UNIQUE(subscription_id, remote_guid)
);

CREATE INDEX idx_feed_items_decision ON feed_items(subscription_id, decision, first_seen_at DESC);
CREATE INDEX idx_feed_items_identity ON feed_items(subscription_id, identity_key);
CREATE INDEX idx_feed_items_episode  ON feed_items(episode_id);

-- How many bytes subscriptions have pulled in the current window.
--
-- Global rather than per-subscription, and that is the whole point: twenty
-- subscriptions with five gigabytes each is a hundred gigabytes a day, which is not a
-- limit anybody asked for. A per-subscription counter is also resettable by deleting
-- and re-adding the subscription, so it bounds nothing against someone who is trying.
--
-- Spent by reserve-then-settle rather than by counting each chunk: better-sqlite3 is
-- synchronous, so a write per chunk on a multi-gigabyte download is tens of thousands
-- of transactions blocking the event loop, and the media routes, the feed and the SSE
-- stream all queue behind them.
CREATE TABLE remote_budget (
  id           INTEGER PRIMARY KEY CHECK (id = 1),  -- exactly one row, for ever
  window_start TEXT NOT NULL,
  used_bytes   INTEGER NOT NULL DEFAULT 0
);

INSERT INTO remote_budget (id, window_start, used_bytes) VALUES (1, '1970-01-01T00:00:00.000Z', 0);
