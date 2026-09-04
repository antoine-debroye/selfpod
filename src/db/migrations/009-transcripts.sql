-- Hearing the words in an episode, and cutting by what they say (spec §19.6).
--
-- SelfPod now transcribes the opening and closing minutes of each MP3 episode and looks
-- for sponsor reads in the text: the same words day after day, wording that sounds like
-- an advert, and — the strongest signal of all — a boundary the owner has pointed at:
-- "the programme starts when it says this".
--
-- Additive in effect, not in form. `ad_segments.source` is a CHECK constraint, and
-- SQLite cannot widen one in place, so the two catalogue tables are rebuilt with the
-- same rows. The order below matters: the migration runner keeps foreign keys ON and
-- cannot turn them off inside its transaction, so the child table is dropped first —
-- while nothing references it — and the parent only once it has no children left for
-- an implicit DELETE to cascade into. Renaming the replacements last is what rewrites
-- the child's foreign key to point at the new parent's name.
--
-- An older image run against this schema reads `source = 'transcript'` as a segment
-- that repeats and carries on. That keeps rolling back a bad update non-destructive,
-- which is the property every migration after 007 preserves.

CREATE TABLE ad_segments_v2 (
  id             TEXT PRIMARY KEY,
  show_id        TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  signature      TEXT NOT NULL,
  -- 'transcript' is found by what was said. For a repeated read it is the hash of the
  -- words; for a boundary the owner taught it is `marker:{id}`.
  source         TEXT NOT NULL CHECK (source IN ('corpus', 'diff', 'transcript')),
  status         TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'approved', 'rejected')),
  auto_approved  INTEGER NOT NULL DEFAULT 0,
  hold_reason    TEXT,
  duration_ms    INTEGER NOT NULL,
  episode_count  INTEGER NOT NULL DEFAULT 0,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  exemplar_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  exemplar_start_ms   INTEGER,
  exemplar_end_ms     INTEGER,
  first_seen_at  TEXT NOT NULL,
  decided_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,

  -- What was said, for segments found by — or later matched to — the words.
  -- `text` is normalised (lower-case, no accents or punctuation) and is what future
  -- episodes are matched against; `raw_text` is what the recogniser wrote, for the
  -- owner to read. `cues` is a JSON array of the sponsor cues that fired, and
  -- `cue_score` their weight, so the page can say *why* something sounded like an
  -- advert rather than merely that it did.
  text           TEXT,
  raw_text       TEXT,
  cue_score      REAL,
  cues           TEXT,
  language       TEXT,

  UNIQUE(show_id, signature)
);

INSERT INTO ad_segments_v2
  (id, show_id, signature, source, status, auto_approved, hold_reason, duration_ms,
   episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
   first_seen_at, decided_at, created_at, updated_at)
SELECT
   id, show_id, signature, source, status, auto_approved, hold_reason, duration_ms,
   episode_count, occurrence_count, exemplar_episode_id, exemplar_start_ms, exemplar_end_ms,
   first_seen_at, decided_at, created_at, updated_at
FROM ad_segments;

CREATE TABLE ad_segment_occurrences_v2 (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id  TEXT NOT NULL REFERENCES ad_segments_v2(id) ON DELETE CASCADE,
  episode_id  TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  start_frame INTEGER NOT NULL,
  end_frame   INTEGER NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  UNIQUE(segment_id, episode_id, start_frame)
);

INSERT INTO ad_segment_occurrences_v2 (id, segment_id, episode_id, start_frame, end_frame, start_ms, end_ms)
SELECT id, segment_id, episode_id, start_frame, end_frame, start_ms, end_ms
FROM ad_segment_occurrences;

DROP TABLE ad_segment_occurrences;
DROP TABLE ad_segments;

ALTER TABLE ad_segments_v2 RENAME TO ad_segments;
ALTER TABLE ad_segment_occurrences_v2 RENAME TO ad_segment_occurrences;

CREATE INDEX idx_ad_segments_show ON ad_segments(show_id, status);
CREATE INDEX idx_ad_occurrences_episode ON ad_segment_occurrences(episode_id);

-- What is known about an episode's transcript. The words themselves live under
-- /data/.tx, for the reason the fingerprints live under /data/.fp.
--
-- A failed attempt is a row too, with its reason, so the page can say "SelfPod could
-- not read this one" instead of showing an episode that is for ever about to be
-- listened to. Three failures and the episode is left alone.
CREATE TABLE episode_transcripts (
  episode_id        TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  algorithm_version INTEGER NOT NULL,
  model             TEXT NOT NULL,
  scope             TEXT NOT NULL CHECK (scope IN ('edges', 'whole')),
  head_ms           INTEGER NOT NULL,
  tail_ms           INTEGER NOT NULL,
  language          TEXT,
  status            TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  failure           TEXT,
  attempts          INTEGER NOT NULL DEFAULT 1,
  attempted_at      TEXT NOT NULL,
  sha256            TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  word_count        INTEGER,
  cpu_ms            INTEGER,
  created_at        TEXT NOT NULL
);

-- A boundary the owner has pointed at: "the programme starts when it says this", or
-- "ends once it has said this". Everything on the far side of it is cut, whatever it
-- is — which is how a pre-roll that is a different advert every day is removed.
CREATE TABLE ad_markers (
  id          TEXT PRIMARY KEY,
  show_id     TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('programme_starts', 'programme_ends')),
  -- Whether the marker's own words go with the cut. "The programme starts when it says
  -- 'Vous écoutez RMC'" keeps the jingle; "cut everything up to and including 'this
  -- episode is sponsored by'" does not.
  inclusive   INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL,
  raw_text    TEXT NOT NULL,
  language    TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_ad_markers_show ON ad_markers(show_id);

-- Where SelfPod listens, per show. 'edges' is the opening and closing minutes; 'whole'
-- is the entire episode, which costs as much as the episode is long. Defaulted so an
-- existing show changes in no way until its advert mode is switched on.
ALTER TABLE shows ADD COLUMN ad_transcribe TEXT NOT NULL DEFAULT 'edges'
  CHECK (ad_transcribe IN ('off', 'edges', 'whole'));
ALTER TABLE shows ADD COLUMN ad_transcribe_head_seconds INTEGER NOT NULL DEFAULT 300;
ALTER TABLE shows ADD COLUMN ad_transcribe_tail_seconds INTEGER NOT NULL DEFAULT 240;
