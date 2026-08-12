import { ARTWORK_MAX_PX, ARTWORK_MIN_PX, DIRECTORY_IMAGE_FORMATS } from '../constants.js';
import { isValidCategory } from '../web/lib/apple-categories.js';

/**
 * Directory readiness: the things Apple Podcasts or Spotify would reject a feed
 * for, said out loud before the operator finds out at submission time.
 *
 * Everything here is already knowable — the cover is measured at scan time, the
 * category is validated on save, the episode counts are one query. What was
 * missing is anyone putting them together and saying "this would be turned
 * down, and here is the reason". That is the whole job of this module.
 *
 * COST GUARANTEE, ENFORCED BY THE SIGNATURE
 * -----------------------------------------
 * The factory takes `covers` and nothing else. No `db`, no `settings`, no `fs`.
 * The show row, its counts, the base URL and the folder path all arrive as
 * arguments, so a caller rendering fifty shows fetches them once, its own way,
 * and calls `forShow()` fifty times against pure data. An N+1 query cannot be
 * written into this file by accident: there is nothing here to query with.
 * `covers` is used only for `describeDimensions()`, which is arithmetic on two
 * numbers and touches no disk.
 *
 * VOCABULARY
 * ----------
 * `level` is health.js's, minus one: `error` blocks (a directory refuses the
 * feed) and `warn` is advisory (the feed is accepted, but it is worse than it
 * could be). There is deliberately no `info`. A readiness panel exists to list
 * what is wrong; a row that is merely true is the thing that teaches people to
 * stop reading the panel.
 */
export function createReadiness({ covers }) {
  return {
    /**
     * @param {object} show      a raw `shows` table row
     * @param {object} ctx
     * @param {object} ctx.counts   from episodes.counts(showId)
     * @param {string|null} ctx.baseUrl
     * @param {string} ctx.folder   the show's folder path on disk
     * @returns {{ready: boolean, blocking: number, advisory: number, checks: object[], failed: object[]}}
     */
    forShow(show, { counts = {}, baseUrl = null, folder = '' } = {}) {
      const checks = [];

      /**
       * A check that cannot be evaluated is not emitted at all.
       *
       * With no artwork there is no artwork format or size row — not "unknown",
       * absent. With an empty feed there is no duration or on-disk row. Two
       * reasons, and both matter more than completeness: "can't tell yet" rows
       * are noise stacked on top of the row that actually needs attention, and
       * a green "0 episodes have no duration" is a lie told with a tick beside
       * it. Silence is the honest answer to a question that has no answer yet.
       */
      const add = (check) => {
        checks.push(check);
      };

      // Counts and columns that concurrent work is still adding. Defaulted here
      // so this module is correct against today's schema and gets sharper on its
      // own as those land — no edit needed there or here.
      const inFeed = counts.inFeed ?? counts.active ?? 0;
      const active = counts.active ?? inFeed;
      const total = counts.total ?? inFeed;
      const scheduled = counts.scheduled ?? 0;
      const missing = counts.missing ?? 0;
      const noDuration = counts.inFeedNoDuration ?? 0;
      const listing = show.directory_listing ?? 'allowed';

      const coverFilename = show.cover_filename ?? null;
      const coverFormat = show.cover_format ?? null;
      const coverWidth = show.cover_width ?? null;
      const coverHeight = show.cover_height ?? null;

      // --- 1. base_url ------------------------------------------------------
      add({
        id: 'base_url',
        level: 'error',
        ok: Boolean(baseUrl),
        label: 'Public address',
        detail: baseUrl
          ? baseUrl
          : 'A feed needs an address that a podcast app can reach from outside your network — a directory fetches it from the internet, not from your LAN. Set the public URL in Settings.',
      });

      // --- 2. folder_present ------------------------------------------------
      const folderMissing = show.status === 'folder_missing';
      add({
        id: 'folder_present',
        level: 'error',
        ok: !folderMissing,
        label: 'Show folder',
        detail: folderMissing
          ? `SelfPod cannot see \`${folder}\` at the moment, so the episodes in this show cannot be served. A directory that fetched an episode now would get nothing back.`
          : folder,
      });

      // --- 3. episodes_present ----------------------------------------------
      // Three failing wordings, because the advice differs. Telling someone to
      // drop a file into a folder that already has files reads as SelfPod not
      // having looked, and is worse than saying nothing.
      add({
        id: 'episodes_present',
        level: 'error',
        ok: inFeed > 0,
        label: 'Episodes in the feed',
        detail:
          inFeed > 0
            ? `${inFeed} episode${inFeed === 1 ? '' : 's'} in the feed`
            : total === 0
              ? `This show has no episodes yet. Drop an audio file into \`${folder}\`, or upload one here.`
              : scheduled > 0 && scheduled === active
                ? `Every episode here is waiting on a publish date in the future, so the feed is empty for now. They join it at their own times — nothing to fix unless one of them was meant to be out already.`
                : `This show has ${total} episode${total === 1 ? '' : 's'}, but none of them is in the feed right now, so a directory fetching it sees an empty podcast. The episode list shows what happened to each one.`,
      });

      // --- 4. artwork_present -----------------------------------------------
      add({
        id: 'artwork_present',
        level: 'error',
        ok: Boolean(coverFilename),
        label: 'Cover art',
        detail: coverFilename
          ? coverFilename
          : `Apple Podcasts and Spotify both refuse a show with no artwork. Drop a \`cover.jpg\` into \`${folder}\`, or upload one here.`,
      });

      // --- 5. artwork_format ------------------------------------------------
      // Only meaningful once there is a file to have a format.
      if (coverFilename) {
        const formatOk = coverFormat !== null && DIRECTORY_IMAGE_FORMATS.includes(coverFormat);
        add({
          id: 'artwork_format',
          level: 'error',
          ok: formatOk,
          label: 'Artwork format',
          detail: formatOk
            ? coverFormat.toUpperCase()
            : coverFormat === null
              ? `SelfPod could not read \`${coverFilename}\` as an image, so it cannot tell a directory what the artwork is. Apple Podcasts accepts ${formatList()} only. Note that the address gives nothing away: SelfPod serves artwork from a URL ending \`cover.jpg\` whatever the real file is, so the feed can look right while the image behind it is not.`
              : `\`${coverFilename}\` is ${coverFormat.toUpperCase()}, and Apple Podcasts accepts ${formatList()} only. Nothing about the address gives this away: SelfPod serves artwork from a URL ending \`cover.jpg\` whatever the real file is, so the feed looks correct right up until the image is fetched and refused. Re-saving the cover as a JPEG settles it.`,
        });
      }

      // --- 6. artwork_size --------------------------------------------------
      // Needs both a file and real dimensions. An unreadable image has no size
      // to judge, and the format row above is already saying so.
      if (coverFilename && coverWidth && coverHeight) {
        const problem = covers.describeDimensions({ width: coverWidth, height: coverHeight });
        add({
          id: 'artwork_size',
          level: 'error',
          ok: problem === null,
          label: 'Artwork size',
          // covers.js calls this non-blocking, and its own message says so —
          // true about the feed, wrong about submission, so readiness writes
          // its own sentence rather than borrowing `.message`.
          detail: problem
            ? `The cover is ${problem.width}×${problem.height}px (${problem.problems.join(
                ' and ',
              )}). Your existing subscribers see it as it is and the feed keeps working, so there is no hurry — but Apple Podcasts accepts square artwork between ${ARTWORK_MIN_PX} and ${ARTWORK_MAX_PX}px only, and a submission is turned down on this alone.`
            : `${coverWidth}×${coverHeight}px`,
        });
      }

      // --- 7. description ---------------------------------------------------
      const description = String(show.description ?? '').trim();
      add({
        id: 'description',
        level: 'error',
        ok: description.length > 0,
        label: 'Show description',
        detail: description
          ? `${description.length} character${description.length === 1 ? '' : 's'}`
          : 'Directories require a description, and it is what someone reads before deciding to subscribe. A sentence or two is enough.',
      });

      // --- 8. owner_email ---------------------------------------------------
      const ownerEmail = String(show.author_email ?? '').trim();
      add({
        id: 'owner_email',
        level: 'error',
        ok: ownerEmail.length > 0,
        label: 'Owner email address',
        detail: ownerEmail
          ? ownerEmail
          : 'Apple Podcasts emails the owner address to confirm the show is yours, so a submission without one cannot be completed. It goes into the feed rather than onto a page in the app.',
      });

      // --- 9. category ------------------------------------------------------
      const category = show.itunes_category ?? null;
      const categoryOk = isValidCategory(category);
      const subcategory = show.itunes_subcategory ?? null;
      add({
        id: 'category',
        level: 'error',
        ok: categoryOk,
        label: 'Category',
        detail: categoryOk
          ? subcategory
            ? `${category} → ${subcategory}`
            : category
          : category
            ? `"${category}" is not one of Apple's categories, and a directory matches the name literally — a difference in wording or capitalisation is enough to be refused. Pick one from the list in Show metadata.`
            : "A directory needs to know where to file the show, and matches the name against Apple's own list. Pick one from the list in Show metadata.",
      });

      // --- 10. directory_listing --------------------------------------------
      // A deliberate setting, not a mistake. It blocks submission, so it belongs
      // here; it does not deserve to be told off for doing what it was asked.
      const blocked = listing === 'blocked';
      add({
        id: 'directory_listing',
        level: 'error',
        ok: !blocked,
        label: 'Directory listing',
        detail: blocked
          ? 'You have asked directories to leave this show out of their index, which is what a private feed usually wants. If you mean to submit it, change that in Show metadata first.'
          : 'Directories may list this show',
      });

      // --- 11. author_name (advisory) ---------------------------------------
      const authorName = String(show.author_name ?? '').trim();
      add({
        id: 'author_name',
        level: 'warn',
        ok: authorName.length > 0,
        label: 'Author name',
        detail: authorName
          ? authorName
          : 'A feed without an author is still accepted. The name is what most apps print under the show title, though, and an empty line there tends to read as something being broken.',
      });

      // --- 12. episode_durations (advisory) ---------------------------------
      // Nothing to say about durations in a feed with no episodes.
      if (inFeed > 0) {
        add({
          id: 'episode_durations',
          level: 'warn',
          ok: noDuration === 0,
          label: 'Episode durations',
          detail:
            noDuration === 0
              ? `All ${inFeed} episode${inFeed === 1 ? '' : 's'} have a duration`
              : `${noDuration} of ${inFeed} episode${inFeed === 1 ? '' : 's'} in the feed carry no duration, because SelfPod could not read one from the file's own tags. Apps show those as zero length until a listener has downloaded the whole file. Re-saving the audio with a tool that writes proper tags usually restores it.`,
        });

        // --- 13. episodes_on_disk (advisory) --------------------------------
        add({
          id: 'episodes_on_disk',
          level: 'warn',
          ok: missing === 0,
          label: 'Episode files on disk',
          detail:
            missing === 0
              ? `All ${inFeed} file${inFeed === 1 ? '' : 's'} present`
              : `${missing} episode file${missing === 1 ? '' : 's'} cannot be found on disk right now. They stay in the feed for their grace period so that a brief outage does not look like a deletion to subscribers, but a download of those episodes fails until the files are back.`,
        });
      }

      const failed = checks.filter((check) => check.ok === false);
      const blocking = failed.filter((check) => check.level === 'error').length;
      const advisory = failed.filter((check) => check.level === 'warn').length;

      return { ready: blocking === 0, blocking, advisory, checks, failed };
    },
  };
}

/** "JPEG and PNG", from the constant, so the copy cannot drift from the check. */
function formatList() {
  const labels = DIRECTORY_IMAGE_FORMATS.map((f) => f.toUpperCase());
  return labels.length <= 1
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
