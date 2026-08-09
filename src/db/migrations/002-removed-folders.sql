-- Removing a show while keeping its folder used to be undone by the very next
-- scan: discovery saw the folder, adopted it, and minted a new show id, a new
-- feed token and a fresh GUID for every episode. Every subscriber's URL broke and
-- their played state was lost — precisely the failure spec §7.2 exists to prevent.
--
-- A tombstone records "the user deliberately removed this folder's show", so
-- discovery leaves it alone until they ask for it back.
CREATE TABLE removed_folders (
  slug       TEXT PRIMARY KEY,
  removed_at TEXT NOT NULL
);
