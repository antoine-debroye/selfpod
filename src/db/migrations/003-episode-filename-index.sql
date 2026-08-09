-- The scanner looks an episode up by (show_id, filename) once per file on every
-- scan; without an index that is a table scan per file on every interval.
CREATE INDEX IF NOT EXISTS idx_episodes_show_filename ON episodes(show_id, filename);
