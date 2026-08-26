-- Downloading one episode a second time, later, to see what changed (spec §19.10).
--
-- Some podcast hosts stitch adverts into the audio as it is served rather than baking
-- them into the file, so the same episode can differ between two downloads. What
-- differs cannot be the theme tune — the theme is in both copies — which makes this the
-- one signal in SelfPod that identifies an advert rather than merely something that
-- repeats.
--
-- It is deliberately not done to every episode. A second fetch is a second
-- IAB-countable download, so it doubles the publisher's figures for an episode taken
-- once; and hosts cache the stitch per listener, so most second fetches return
-- byte-identical audio and learn nothing. It happens only where the first download
-- carried a positive signal, and only after a day, by which time the host's cache has
-- usually rolled.
--
-- Every column here is nullable, per the rule that an older image run against a newer
-- schema must keep working: rolling back a bad update stays non-destructive.

-- Why SelfPod wants to look again, in the words shown to the operator. Null means it
-- does not — the ordinary case.
ALTER TABLE feed_items ADD COLUMN recheck_reason TEXT;

-- The earliest it may. Set a day out at download time.
ALTER TABLE feed_items ADD COLUMN recheck_after TEXT;

-- When it actually looked, whatever the outcome. Set even when the two downloads turn
-- out identical, because "we looked and it was the same" is the answer most of the
-- time and re-asking it every day would be the whole cost of the feature for none of
-- the benefit.
ALTER TABLE feed_items ADD COLUMN rechecked_at TEXT;

-- What the second download turned out to be: 'identical', 'differs', or a failure
-- reason. Kept so the operator can be told why an episode was fetched twice and what
-- it bought.
ALTER TABLE feed_items ADD COLUMN recheck_outcome TEXT;

-- Due items are looked up by time across the whole table, so the index is on the
-- deadline. Partial, because the overwhelming majority of rows have no deadline at all
-- and there is no reason to carry them.
CREATE INDEX IF NOT EXISTS idx_feed_items_recheck
  ON feed_items (recheck_after)
  WHERE recheck_after IS NOT NULL AND rechecked_at IS NULL;
