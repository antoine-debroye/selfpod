-- Finding and cutting the audio a show repeats (spec §19).
--
-- SelfPod records every stretch of audio that recurs — across a show's episodes, or
-- between two downloads of one episode — and lets the owner decide which of them to
-- remove. It never decides that itself, because it cannot: a theme tune, a sponsor
-- read, a standing intro and a recurring stinger all repeat identically, and nothing
-- in the audio separates them.
--
-- Additive only: three new tables and columns that are all nullable or defaulted, so
-- an older image run against this schema ignores them and keeps working. That is what
-- makes rolling back a bad update non-destructive, and it is a property every
-- migration after this one should preserve rather than rediscover.

-- A stretch of audio the show repeats, and what the owner decided about it.
CREATE TABLE ad_segments (
  id             TEXT PRIMARY KEY,
  show_id        TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,

  -- Content identity, from a digest of the segment's frame hashes with a few frames
  -- trimmed off each end. The edges are where two encodes of the same audio disagree
  -- — the bit reservoir carries state across a splice — so trimming them is what lets
  -- the same segment be recognised wherever it was spliced in.
  signature      TEXT NOT NULL,

  -- 'corpus'  found by repetition across episodes;
  -- 'diff'    found by comparing two downloads of one episode, which is a stronger
  --           signal: a theme tune appears in both copies, so it can never be what
  --           differs between them.
  source         TEXT NOT NULL CHECK (source IN ('corpus', 'diff')),

  status         TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'approved', 'rejected')),
  -- Recorded so an owner can see which cuts they were asked about and which were
  -- taken on their behalf, and reverse either.
  auto_approved  INTEGER NOT NULL DEFAULT 0,
  -- Why an automatic approval was withheld, in the machine's own terms, so the UI can
  -- say "held back because this is always at the start of the episode" rather than
  -- leaving a candidate sitting there with no explanation.
  hold_reason    TEXT,

  duration_ms    INTEGER NOT NULL,
  -- Two counts, never conflated. `episode_count` is how many distinct episodes carry
  -- this segment and is what a threshold reads; `occurrence_count` is how many times
  -- it appears in total. A show that plays one sponsor read twice per episode has an
  -- occurrence count of six across three episodes, and reading that as six episodes
  -- is how "appears in three episodes" fires on a single file.
  episode_count  INTEGER NOT NULL DEFAULT 0,
  occurrence_count INTEGER NOT NULL DEFAULT 0,

  -- Where to play a sample from, so the owner can hear what they are about to remove
  -- before removing it. Nothing is copied for this: it is an offset into an episode
  -- that is already on disk.
  exemplar_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  exemplar_start_ms   INTEGER,
  exemplar_end_ms     INTEGER,

  first_seen_at  TEXT NOT NULL,
  decided_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,

  UNIQUE(show_id, signature)
);

CREATE INDEX idx_ad_segments_show ON ad_segments(show_id, status);

-- Every place a segment appears. This is the cut list: approving a segment means
-- removing these ranges from those episodes.
CREATE TABLE ad_segment_occurrences (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id  TEXT NOT NULL REFERENCES ad_segments(id) ON DELETE CASCADE,
  episode_id  TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,

  -- Frames are the authority and milliseconds are for display. A cut is made at frame
  -- boundaries, because that is the only place an MP3 can be cut without re-encoding,
  -- and a millisecond figure rounded back into a frame index would drift.
  start_frame INTEGER NOT NULL,
  end_frame   INTEGER NOT NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,

  UNIQUE(segment_id, episode_id, start_frame)
);

CREATE INDEX idx_ad_occurrences_episode ON ad_segment_occurrences(episode_id);

-- What is known about an episode's fingerprint. The fingerprint itself is not here.
--
-- The frame hashes live under /data/.fp, for the reason /data/.art exists: everything
-- in them is derived and rebuildable, and putting them in SQLite would turn a database
-- measured in megabytes into one measured in hundreds. A single hour-long episode is
-- roughly 137,000 hashes; a library of five hundred would be hundreds of megabytes of
-- BLOBs, read synchronously on the thread that also serves media, inside the file the
-- operator backs up.
--
-- Every column below exists so the file can be invalidated and rebuilt: if the audio
-- changes, `sha256` no longer matches and the fingerprint is recomputed; if the
-- algorithm changes, `algorithm_version` does the same for the whole corpus at once.
CREATE TABLE episode_fingerprints (
  episode_id        TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  algorithm_version INTEGER NOT NULL,
  frame_count       INTEGER NOT NULL,
  sample_rate       INTEGER,
  duration_ms       INTEGER,
  -- Of the audio file the fingerprint was taken from, so a replaced file is noticed.
  sha256            TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  created_at        TEXT NOT NULL
);

-- How much SelfPod may do on its own, per show.
--
--   'off'     nothing is detected or cut;
--   'review'  segments are found and catalogued, and wait for the owner;
--   'auto'    segments that pass the safety guard are approved on sight — and are
--             still catalogued, still listed, and still reversible.
--
-- Defaulting to 'off' means this migration changes nothing about any existing show
-- until somebody asks it to.
ALTER TABLE shows ADD COLUMN ad_trim_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (ad_trim_mode IN ('off', 'review', 'auto'));

-- How many distinct episodes a segment must appear in before automatic mode will
-- approve it unasked. Per show, because a weekly show and a daily one build a corpus
-- at very different rates.
ALTER TABLE shows ADD COLUMN ad_auto_min_episodes INTEGER NOT NULL DEFAULT 3;

-- The trimmed copy of an episode, if there is one.
--
-- The original is never modified and never deleted. A bad cut is undone by
-- regenerating from the original, never by downloading again — which matters most for
-- a show that stitches adverts per request, where downloading again gives a different
-- edit rather than the same file back.
ALTER TABLE episodes ADD COLUMN trim_status TEXT
  CHECK (trim_status IS NULL OR trim_status IN ('pending', 'trimming', 'trimmed', 'failed'));
ALTER TABLE episodes ADD COLUMN trimmed_filename TEXT;    -- inside /data/.trimmed/{show_id}
ALTER TABLE episodes ADD COLUMN trimmed_bytes INTEGER;
-- Measured from the trimmed file, never computed as "original minus what was cut".
-- Cutting at frame boundaries and rejoining adds a little at every join, and for FLAC
-- the file's own header keeps the *uncut* length unless the audio is re-encoded.
ALTER TABLE episodes ADD COLUMN trimmed_duration_seconds INTEGER;
ALTER TABLE episodes ADD COLUMN trimmed_etag TEXT;        -- content version for the enclosure URL

-- Why an episode is being kept out of the feed, or NULL to publish it normally.
--
-- A real gate rather than an inference from trim_status, because there is no existing
-- state that means "on disk, scanned, and deliberately not published yet". Without one
-- the choice would be between publishing an episode and then silently replacing its
-- audio — where a listener already part-way through a download gets a file stitched
-- from two different versions — and not downloading it at all.
ALTER TABLE episodes ADD COLUMN publish_hold TEXT
  CHECK (publish_hold IS NULL OR publish_hold IN ('awaiting_review', 'awaiting_corpus', 'trimming'));
