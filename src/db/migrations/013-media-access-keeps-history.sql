-- Request history outlives the episode it was about.
--
-- `media_access.episode_id` cascaded on delete, so removing an episode — from the
-- page, or by deleting its file — also removed every request ever made for it, and
-- the show's and the instance's totals shrank to match. A download that happened
-- happened; the log is a record of it, not a property of the episode row. The link
-- to `episodes` is dropped (the id is kept, so the log can still say which episode
-- it was and the page can say it is gone), and the link to `shows` keeps cascading:
-- removing a show is the one case where the owner means to forget it.
--
-- SQLite cannot alter a foreign key in place, so the table is rebuilt. Additive in
-- effect — every row and index comes back as it was — and an older image reading
-- this table sees exactly the columns it expects.
CREATE TABLE media_access_kept (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id     TEXT,
  show_id        TEXT REFERENCES shows(id) ON DELETE CASCADE,
  requested_at   TEXT NOT NULL,
  kind           TEXT NOT NULL,
  status_code    INTEGER NOT NULL,
  bytes_sent     INTEGER,
  total_bytes    INTEGER,
  range_header   TEXT,
  client         TEXT,
  error          TEXT
);

INSERT INTO media_access_kept
  (id, episode_id, show_id, requested_at, kind, status_code, bytes_sent, total_bytes, range_header, client, error)
  SELECT id, episode_id, show_id, requested_at, kind, status_code, bytes_sent, total_bytes, range_header, client, error
    FROM media_access;

DROP TABLE media_access;
ALTER TABLE media_access_kept RENAME TO media_access;

CREATE INDEX idx_media_access_episode ON media_access(episode_id, requested_at DESC);
CREATE INDEX idx_media_access_show ON media_access(show_id, requested_at DESC);
CREATE INDEX idx_media_access_time ON media_access(requested_at DESC);
CREATE INDEX idx_media_access_failures ON media_access(status_code, requested_at DESC);
