-- What kind of thing each cut is, per-episode restores, and what a pass needs to skip
-- work it has already done (spec §19.8).
--
-- Additive only. Every column is ADD COLUMN and every table is new; nothing is
-- rebuilt, renamed or dropped. `source` and the `marker:` / `anchor:` / `tx:`
-- signature prefixes stay exactly as 1.8 wrote them, and 1.9 keeps writing them, so an
-- older image run against this database still reads and inserts rows — the property
-- every migration since 007 preserves, and the only rollback an owner updating by
-- changing an image tag has.
--
-- What does not survive a rollback: a per-episode restore. An older image ignores
-- ad_cut_overrides and cuts that stretch again on its next pass.

-- The kind of a catalogue row, said once instead of inferred from a signature prefix
-- in six different queries.
--
--   jingle            cut before the station jingle, found by its sound (ad_anchors)
--   boundary_words    cut at a boundary the owner taught by its words (ad_markers)
--   remembered_words  words the owner marked as an advert, or as not one
--   repeated_words    the same words heard in several episodes
--   repeated_audio    the same sound heard in several episodes
--   diff              what changed between two downloads of one episode
--   taught_range      a stretch the owner pointed at by time, with no words to match
ALTER TABLE ad_segments ADD COLUMN kind TEXT NOT NULL DEFAULT 'repeated_audio'
  CHECK (kind IN ('jingle', 'boundary_words', 'remembered_words', 'repeated_words',
                  'repeated_audio', 'diff', 'taught_range'));

-- The rule a jingle or boundary row carries out. Removing the rule removes its row.
ALTER TABLE ad_segments ADD COLUMN marker_id TEXT REFERENCES ad_markers(id) ON DELETE CASCADE;
ALTER TABLE ad_segments ADD COLUMN anchor_id TEXT REFERENCES ad_anchors(id) ON DELETE CASCADE;

-- When audio carrying this cut was first published, so the page can say "cut on its
-- own since Tuesday" rather than leave the owner to notice.
ALTER TABLE ad_segments ADD COLUMN first_cut_at TEXT;

-- The backfill. It reads the same evidence 1.8 read, once:
--   * a `marker:` or `anchor:` signature names its rule;
--   * `diff` rows were only ever written by the second-download comparison;
--   * a word row with no cues was written by teachSegment alone — every detector that
--     finds words scores their cues, so the absence is the owner's hand;
--   * everything else found by comparing sound stays repeated_audio, including rows
--     the words were later attached to.
UPDATE ad_segments SET kind = 'boundary_words', marker_id = substr(signature, 8)
 WHERE signature LIKE 'marker:%'
   AND substr(signature, 8) IN (SELECT id FROM ad_markers);
UPDATE ad_segments SET kind = 'jingle', anchor_id = substr(signature, 8)
 WHERE signature LIKE 'anchor:%'
   AND substr(signature, 8) IN (SELECT id FROM ad_anchors);
UPDATE ad_segments SET kind = 'diff' WHERE source = 'diff';
UPDATE ad_segments SET kind = 'remembered_words'
 WHERE source = 'transcript' AND signature NOT LIKE 'marker:%' AND cues IS NULL;
UPDATE ad_segments SET kind = 'repeated_words'
 WHERE source = 'transcript' AND signature NOT LIKE 'marker:%' AND cues IS NOT NULL;

-- A rule row whose rule is already gone cuts in the name of nothing. 1.8 removed these
-- by hand when the rule went; any left behind are removed here.
DELETE FROM ad_segments
 WHERE (signature LIKE 'marker:%' AND marker_id IS NULL)
    OR (signature LIKE 'anchor:%' AND anchor_id IS NULL);

-- "Sounds like a sponsor read, heard once" is no longer a row (spec §19.6): it is
-- highlighted in the transcript, where it can be taught from, and it never could be
-- cut on its own. One the owner decided about is a remembered read and is kept.
DELETE FROM ad_segments WHERE status = 'candidate' AND hold_reason = 'only_heard_once';
UPDATE ad_segments SET kind = 'remembered_words', hold_reason = NULL
 WHERE hold_reason = 'only_heard_once';

CREATE INDEX idx_ad_segments_kind ON ad_segments(show_id, kind);

-- "Restore here": a stretch of one episode the owner wants left in, whatever rule
-- would cut it. Keyed on the episode and the time, not on the catalogue row, because
-- rows are folded together and re-found under new signatures as a show grows, and a
-- restore must outlive both. `segment_id` records what was restored, for the page.
CREATE TABLE ad_cut_overrides (
  id          TEXT PRIMARY KEY,
  episode_id  TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  segment_id  TEXT REFERENCES ad_segments(id) ON DELETE SET NULL,
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL CHECK (end_ms > start_ms),
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_ad_cut_overrides_episode ON ad_cut_overrides(episode_id);

-- A jingle SelfPod confirmed on its own, in automatic mode, rather than one the owner
-- pressed "yes" on. Forgetting one of these dismisses it, so it is not proposed again.
ALTER TABLE ad_anchors ADD COLUMN auto_confirmed INTEGER NOT NULL DEFAULT 0;

-- A pass that can tell a file is unchanged without reading it, and knows which
-- episodes the repeated-audio search has already compared.
ALTER TABLE episode_fingerprints ADD COLUMN file_mtime_ms INTEGER;
ALTER TABLE episode_fingerprints ADD COLUMN searched_at TEXT;

-- The language the recogniser was told to expect ('auto' when it was not told), so a
-- show whose language is set later is read again rather than left half one way.
ALTER TABLE episode_transcripts ADD COLUMN language_requested TEXT;

-- When an episode was first held out of the feed, so a hold that has gone on too long
-- is said out loud rather than discovered.
ALTER TABLE episodes ADD COLUMN publish_hold_since TEXT;
UPDATE episodes SET publish_hold_since = updated_at WHERE publish_hold IS NOT NULL;
