-- Cutting a pre-roll by the sound of the jingle that follows it, not by its words (spec §19.6).
--
-- A boundary the owner teaches today is matched in a whisper transcript, and a
-- recognizer writes the same station ident differently on different days — "Vous
-- pouvez vous écouter RMC" one day, "Vous pouvez vous écouter..." the next, cut off
-- mid-word. The words are the unreliable half. The *sound* of a jingle is the same
-- recording every day, and SelfPod already fingerprints every MP3 for exactly this
-- kind of comparison (007-ad-segments.sql) — so a short clip of it, matched the same
-- way the acoustic corpus search matches anything else, finds the jingle whatever the
-- pre-roll in front of it says, and whatever whisper heard.
--
-- An anchor's cut lands in `ad_segments` like every other cut, under the signature
-- `anchor:{id}`, `source = 'corpus'` — accurate, since it is found by comparing
-- sound — so nothing downstream needs to learn a new source. What is new here is
-- only the anchor itself: the clip, and per-episode whether it was heard.
--
-- Additive only: two new tables, nothing altered on an existing one. An older image
-- run against this schema ignores both and falls back to the word marker, which is
-- what keeps rolling back a bad update non-destructive — the property every
-- migration after 007 preserves.

-- The jingle SelfPod is listening for, per show. `role` is deliberately CHECK-limited
-- to 'programme_starts': the closing side of an episode keeps working exactly as it
-- does today, by the words alone, and this table has nothing to say about it.
CREATE TABLE ad_anchors (
  id                  TEXT PRIMARY KEY,
  show_id             TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'programme_starts' CHECK (role IN ('programme_starts')),

  -- The boundary these words already taught, if the two agree on where the jingle is.
  -- Nullable both ways: an anchor can exist with no words behind it (ad_transcribe =
  -- 'off', where there is nothing to transcribe), and a marker can exist with no
  -- anchor (a show with nothing SelfPod can fingerprint).
  marker_id           TEXT REFERENCES ad_markers(id) ON DELETE SET NULL,

  -- 'proposed'    SelfPod found this itself, offered it, and is waiting;
  -- 'pointed_at'  the owner selected a range on an episode page;
  -- 'from_marker' a marker's located words agreed with a proposal, so the boundary
  --               the owner already taught was carried over rather than asked again.
  origin              TEXT NOT NULL CHECK (origin IN ('proposed', 'pointed_at', 'from_marker')),

  -- NULL means this is a proposal only, and it cuts nothing until the owner presses
  -- "yes, that's the jingle" — or it was linked from a marker, which is a decision
  -- already taken and is confirmed on arrival.
  confirmed_at        TEXT,
  -- "That is not the jingle": recorded so the same clip is not proposed again.
  dismissed_at         TEXT,

  -- The fingerprint algorithm the clip was captured under. A clip from an old
  -- algorithm is meaningless against a fingerprint from a new one — mixing them
  -- would produce matches that mean nothing — so a version bump here means SelfPod
  -- re-derives the clip from the exemplar rather than trusting stale bits.
  algorithm_version   INTEGER NOT NULL,

  -- The reference sub-fingerprints themselves: a few seconds, ~1 KB. Kept in the
  -- database rather than under /data/.fp, unlike a whole-episode fingerprint. That
  -- directory holds large, purely derived, rebuildable data; this is small and it is
  -- not derived — it is the audio the owner (or SelfPod, provisionally) pointed at,
  -- and it must outlive the one episode it happened to be taken from.
  clip                BLOB NOT NULL,

  -- How far the clip's own start sits after the jingle's true onset, so a cut can be
  -- placed at (located offset − lead_ms) rather than at the clip itself, which was
  -- deliberately inset from the true edges to keep the match clean.
  lead_ms             INTEGER NOT NULL,

  -- How long the *whole* matched region was before it was inset down to a clip —
  -- normally longer than the clip itself, sometimes by seconds. Used only to say how
  -- far into an episode the jingle's own audio plausibly still runs, so the ordinary
  -- "audio this show repeats" search does not offer the tail of the very same jingle
  -- back as a second, unexplained find the moment this anchor is confirmed.
  match_span_ms       INTEGER NOT NULL DEFAULT 0,

  exemplar_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  exemplar_start_ms   INTEGER NOT NULL,
  exemplar_end_ms     INTEGER NOT NULL,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_ad_anchors_show ON ad_anchors(show_id);

-- Whether the jingle was heard in a given episode, and where — recorded every pass,
-- a miss as much as a hit, because "SelfPod looked and did not hear it" is the fact
-- an owner needs on the episode page, not silence they have to interpret themselves.
CREATE TABLE ad_anchor_hits (
  anchor_id  TEXT NOT NULL REFERENCES ad_anchors(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  heard      INTEGER NOT NULL,
  at_ms      INTEGER,
  ber        REAL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (anchor_id, episode_id)
);

CREATE INDEX idx_ad_anchor_hits_episode ON ad_anchor_hits(episode_id);
