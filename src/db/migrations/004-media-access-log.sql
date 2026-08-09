-- Play and download statistics.
--
-- Every request for an episode's audio is recorded here. The point is to answer two
-- questions the app previously could not: "is anyone actually listening to this?"
-- and "did that episode fail to download?" — the second one mattering because a
-- failure was previously invisible to SelfPod, discoverable only from a screenshot
-- of a phone.
--
-- Deliberately not recorded: the feed token (it is a credential, and it appears in
-- every one of these URLs), and the client's full IP address. A self-hosted podcast
-- for a handful of people does not need to become a surveillance log to tell its
-- owner whether an episode downloaded.

CREATE TABLE media_access (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id     TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  show_id        TEXT REFERENCES shows(id) ON DELETE CASCADE,
  requested_at   TEXT NOT NULL,
  -- download = whole file, stream = a byte range (a player seeking or buffering),
  -- cover = artwork, feed = the RSS itself.
  kind           TEXT NOT NULL,
  status_code    INTEGER NOT NULL,
  bytes_sent     INTEGER,
  -- Total size at the time, so a partial fetch can be judged against it.
  total_bytes    INTEGER,
  range_header   TEXT,
  -- A coarse client family ("Pocket Casts", "Apple Podcasts", …) rather than the
  -- raw user agent, which is both long and needlessly identifying.
  client         TEXT,
  -- Set only when something went wrong, in the same plain language as the
  -- activity log.
  error          TEXT
);

CREATE INDEX idx_media_access_episode ON media_access(episode_id, requested_at DESC);
CREATE INDEX idx_media_access_show ON media_access(show_id, requested_at DESC);
CREATE INDEX idx_media_access_time ON media_access(requested_at DESC);
CREATE INDEX idx_media_access_failures ON media_access(status_code, requested_at DESC);
