-- SelfPod initial schema (spec §7).
--
-- The database is authoritative for everything: which files exist, their stable
-- GUIDs, whether the user edited a title. The hand-rolled prototype re-derived
-- all of that from the filesystem on every run, which is exactly why GUIDs were
-- unstable and "did the user customise this?" was unanswerable (spec §7.1).

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE shows (
  id                   TEXT PRIMARY KEY,               -- stable UUID, also the <podcast:guid>
  slug                 TEXT UNIQUE NOT NULL,           -- folder name; appears in URLs
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  author_name          TEXT NOT NULL,
  author_email         TEXT NOT NULL,
  language             TEXT NOT NULL DEFAULT 'en',
  itunes_category      TEXT NOT NULL DEFAULT 'Technology',
  itunes_subcategory   TEXT,
  explicit             INTEGER NOT NULL DEFAULT 0,
  cover_filename       TEXT,                           -- actual file on disk, may be .png
  cover_width          INTEGER,                        -- cached so the §10.2 warning needs no image read
  cover_height         INTEGER,
  cover_format         TEXT,
  cover_mtime          TEXT,
  feed_token           TEXT UNIQUE NOT NULL,           -- credential: never logged, never in show.json
  status               TEXT NOT NULL DEFAULT 'active', -- active | folder_missing
  folder_missing_since TEXT,
  last_scan_id         INTEGER,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE episodes (
  id                 TEXT PRIMARY KEY,                 -- the feed <guid>; random, never derived
  show_id            TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  filename           TEXT NOT NULL,
  identity_key       TEXT NOT NULL,                    -- content hash; survives renames (§7.2)
  title              TEXT NOT NULL,
  title_is_custom    INTEGER NOT NULL DEFAULT 0,       -- 1 = scanner must never touch the title
  tag_title          TEXT,                             -- last title suggested by embedded tags
  description        TEXT NOT NULL DEFAULT '',
  season             INTEGER,
  episode_number     INTEGER,
  explicit           INTEGER,                          -- NULL = inherit from the show
  pub_date           TEXT NOT NULL,                    -- ISO 8601
  pub_date_is_custom INTEGER NOT NULL DEFAULT 0,
  duration_seconds   INTEGER,                          -- NULL when extraction failed: tag is omitted
  bitrate_kbps       INTEGER,
  file_size_bytes    INTEGER NOT NULL,
  file_mtime         TEXT,                             -- with filename+size, lets rescans skip hashing
  mime_type          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',   -- active | missing | removed
  missing_since      TEXT,
  removed_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE(show_id, identity_key)
);

CREATE INDEX idx_episodes_show_status ON episodes(show_id, status);
CREATE INDEX idx_episodes_show_pubdate ON episodes(show_id, pub_date DESC);
CREATE INDEX idx_episodes_missing ON episodes(status, missing_since);

CREATE TABLE scan_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id     TEXT REFERENCES shows(id) ON DELETE CASCADE, -- NULL = global scan
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  trigger     TEXT NOT NULL,                -- watcher | scheduled | manual | startup | upload
  files_found INTEGER,
  added       INTEGER,
  updated     INTEGER,
  missing     INTEGER,
  removed     INTEGER,
  errors_json TEXT,                         -- JSON array of {file, message}
  warnings_json TEXT,                       -- JSON array of {file, message}
  note        TEXT
);

CREATE INDEX idx_scan_log_started ON scan_log(started_at DESC);
CREATE INDEX idx_scan_log_show ON scan_log(show_id, started_at DESC);

-- Sessions live in the database rather than in memory so that a container
-- restart — or a migration of /data to a new machine — does not sign the admin
-- out, and so nothing stateful exists outside the single volume.
CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Failed-login tracking for per-account backoff. IP-based limits alone are not
-- enough behind a tunnel, where every request shares the proxy's address.
CREATE TABLE login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  succeeded   INTEGER NOT NULL DEFAULT 0,
  source      TEXT
);

CREATE INDEX idx_login_attempts_user ON login_attempts(username, attempted_at DESC);
