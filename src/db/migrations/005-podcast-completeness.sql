-- Podcast completeness: episode type, directory listing, serial shows, and
-- per-episode artwork.
--
-- One migration rather than four. Migrations are applied by array index, each in its
-- own transaction (src/db/migrate.js), forward-only with no way down. Four files would
-- mean four user_version steps for one deployable change, and a boot that applied two
-- and failed on the third would leave a schema no code expects and nothing can undo.
-- These columns ship in one release, so they land together or not at all.

-- Apple treats a missing <itunes:episodeType> as "full", which makes a trailer or a
-- bonus episode unrepresentable. Stored explicitly and always emitted, so the feed
-- states what the owner chose rather than relying on a reader's default.
--
-- User-owned: the scanner must never write it. No audio tag says "trailer", and no
-- filename says it reliably either — "trailer-park ep 3.mp3" is not a trailer. A wrong
-- guess here is invisible until a podcast app orders the show oddly, which is exactly
-- the class of silent failure this app exists to remove. So SelfPod does not guess.
ALTER TABLE episodes ADD COLUMN episode_type TEXT NOT NULL DEFAULT 'full'
  CHECK (episode_type IN ('full', 'trailer', 'bonus'));

-- Per-episode artwork, all of it scanner-owned.
--
-- The image never goes into the show folder: that folder is the user's file share, and
-- SelfPod does not create files there that the user did not ask for (spec §13, lesson
-- 5 — the same reason covers.js refuses to delete a user's originals). The bytes live
-- in /data/.art/{show_id}/{episode_id}.{jpg|png}.
--
-- That directory is a cache, and every column below exists so it can be rebuilt from
-- the audio file or the sidecar image if it is ever lost.
ALTER TABLE episodes ADD COLUMN art_source TEXT
  CHECK (art_source IS NULL OR art_source IN ('sidecar', 'embedded'));
ALTER TABLE episodes ADD COLUMN art_filename      TEXT;    -- name inside /data/.art/{show_id}
ALTER TABLE episodes ADD COLUMN art_sidecar_name  TEXT;    -- the image beside the audio, when that is the source
ALTER TABLE episodes ADD COLUMN art_sidecar_mtime TEXT;    -- lets a replaced sidecar be noticed without hashing
ALTER TABLE episodes ADD COLUMN art_width         INTEGER; -- cached so the artwork-size warning needs no image read
ALTER TABLE episodes ADD COLUMN art_height        INTEGER;
ALTER TABLE episodes ADD COLUMN art_etag          TEXT;    -- bare sha256 hex of the cached bytes: the ETag and the ?v= buster

-- Episodic or serial. Serial tells a podcast app to open the show at the first episode
-- rather than the latest; it changes nothing about the order of the feed itself.
ALTER TABLE shows ADD COLUMN itunes_type TEXT NOT NULL DEFAULT 'episodic'
  CHECK (itunes_type IN ('episodic', 'serial'));

-- Whether podcast directories may list this show.
--
-- Every SelfPod feed is private by an unguessable token, and nothing until now told a
-- directory to leave a leaked URL out of its index. <itunes:block> is that instruction.
--
-- The default is 'allowed', which emits nothing and leaves every feed that is live
-- today byte-for-byte unchanged. Defaulting to 'blocked' would have been the stronger
-- privacy stance, but it would also remove any show already accepted by a directory on
-- the next poll after an upgrade — a destructive change nobody asked for, arriving as a
-- side effect of updating an image tag. Blocking is opted into per show instead.
--
-- Deliberately never imported from show.json: a safe default must not be flipped by a
-- file, which is the same reason the feed token is left out of that export.
ALTER TABLE shows ADD COLUMN directory_listing TEXT NOT NULL DEFAULT 'allowed'
  CHECK (directory_listing IN ('blocked', 'allowed'));
