-- Indexes for the four foreign keys the advert tables are joined and cascaded on.
--
-- Additive only, and safe to roll back from: an older image neither knows nor
-- needs these, and SQLite ignores an index it did not create.
--
-- Every one of these columns is used as a join or a lookup on every pass and every
-- page render — the rule behind a cut (marker_id, anchor_id), the restores on a cut
-- (segment_id) — and as the child side of an ON DELETE cascade, which without an
-- index means a full scan of the child table for every parent row deleted.
CREATE INDEX IF NOT EXISTS idx_ad_cut_overrides_segment ON ad_cut_overrides(segment_id);
CREATE INDEX IF NOT EXISTS idx_ad_segments_marker ON ad_segments(marker_id);
CREATE INDEX IF NOT EXISTS idx_ad_segments_anchor ON ad_segments(anchor_id);
CREATE INDEX IF NOT EXISTS idx_ad_anchors_marker ON ad_anchors(marker_id);
