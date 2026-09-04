import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Collecting the audio SelfPod derived from an episode, when the episode goes.
 *
 * Three caches live outside the database: the fingerprints under `/data/.fp`, the
 * transcripts under `/data/.tx` and the trimmed copies under `/data/.trimmed`. The database rows that describe them go
 * with the foreign-key cascade; the files do not, and nothing else would ever come
 * back for them.
 *
 * That matters more here than for artwork, which is the precedent this follows. A
 * trimmed copy is very nearly the size of the episode, so a deleted two-hundred
 * episode show would leave tens of gigabytes on a NAS with no row anywhere that could
 * name them — and the operator's only clue would be a volume that never gets emptier.
 * `forgetAllForShow` is worse still: it re-imports the episodes under new ids, so the
 * old files become permanently unreachable rather than merely orphaned.
 *
 * Deliberately built from `config` alone. Deletion happens inside the show and episode
 * stores, which are constructed long before anything that reads audio, and a
 * collaborator with real dependencies could not be handed to them.
 */
export function createDerivedAudio({ config, logger }) {
  const roots = [config.fingerprintDir, config.trimmedDir, config.transcriptDir];

  /** Everything derived from one episode. Names are `{episodeId}.{something}`. */
  async function forget(showId, episodeId) {
    for (const root of roots) {
      const directory = join(root, showId);
      let entries;
      try {
        entries = await readdir(directory);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.startsWith(`${episodeId}.`)) continue;
        await rm(join(directory, name), { force: true }).catch((err) => {
          logger?.warn({ showId, episodeId, name, err }, 'could not remove derived audio');
        });
      }
    }
  }

  /** Everything derived from a whole show. */
  async function forgetShow(showId) {
    for (const root of roots) {
      await rm(join(root, showId), { recursive: true, force: true }).catch((err) => {
        logger?.warn({ showId, err }, 'could not remove a show\'s derived audio');
      });
    }
  }

  return { forget, forgetShow };
}
