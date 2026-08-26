import { AD_TRIM_MODES, SEGMENT_STATUS } from '../constants.js';
import { EVENTS } from '../lib/events.js';
import { resolvePublishHold } from '../lib/publish-hold.js';

/**
 * Running detection, decisions and trimming in order, one show at a time (spec §19.8).
 *
 * The three pieces underneath — fingerprinting, the catalogue, the cutter — each do
 * one thing and none of them decides when to run. This does, and it is deliberately
 * the only place that does, because every one of them reads or writes whole episodes
 * off a NAS disk.
 *
 * ## One chain for the whole application
 *
 * Not one per show, and not one per subsystem. SelfPod's usual hardware is a
 * two-core Celeron or an ARM A55 that is also serving the audio, and the failure this
 * prevents is not slowness — it is a library scan, a subscription download and three
 * shows' worth of fingerprinting all deciding at once that they may use the disk.
 * Serialising costs wall-clock time nobody is waiting on: the work happens behind a
 * publish hold, so the only observable difference is when an episode appears.
 */
export function createAdPipeline({ db, events, logger, shows, episodes, adDetect, trimmer }) {
  let chain = Promise.resolve();
  let active = null;

  /** Queues work behind everything already queued. Failures do not break the chain. */
  function serialise(label, work) {
    const queued = chain.then(
      async () => {
        active = label;
        try {
          return await work();
        } finally {
          active = null;
        }
      },
      async () => {
        active = label;
        try {
          return await work();
        } finally {
          active = null;
        }
      },
    );
    chain = queued.catch(() => {});
    return queued;
  }

  const countUndecided = db.prepare(
    `SELECT COUNT(*) AS n
       FROM ad_segment_occurrences o
       JOIN ad_segments s ON s.id = o.segment_id
      WHERE o.episode_id = ? AND s.status = '${SEGMENT_STATUS.CANDIDATE}'`,
  );
  const countFingerprinted = db.prepare(
    `SELECT COUNT(*) AS n
       FROM episode_fingerprints f
       JOIN episodes e ON e.id = f.episode_id
      WHERE e.show_id = ?`,
  );

  /**
   * Re-answers "is this episode ready to go out?" for every episode of a show.
   *
   * Run after each stage rather than once at the end, so an episode that turns out to
   * need nothing is released as soon as that is known instead of waiting behind the
   * trimming of episodes that do.
   */
  function settleHolds(show) {
    const corpusSize = countFingerprinted.get(show.id)?.n ?? 0;
    let released = 0;
    let held = 0;

    for (const episode of episodes.listByShow(show.id)) {
      const wanted = resolvePublishHold({
        mode: show.ad_trim_mode,
        corpusSize,
        minEpisodes: show.ad_auto_min_episodes ?? 3,
        undecidedSegments: countUndecided.get(episode.id)?.n ?? 0,
        trimStatus: episode.trim_status,
      });
      if (wanted === (episode.publish_hold ?? null)) {
        if (wanted) held += 1;
        continue;
      }
      episodes.setSystemFields(episode.id, { publish_hold: wanted });
      if (wanted) held += 1;
      else released += 1;
    }
    return { released, held, corpusSize };
  }

  const api = {
    /**
     * Everything a show needs, in order: fingerprint, detect, cut, publish.
     *
     * Idempotent. Running it twice on an unchanged show fingerprints nothing, finds
     * the segments it already has, and rewrites no audio.
     */
    processShow(showId) {
      return serialise(`ad:${showId}`, async () => {
        const show = shows.get(showId);
        if (!show) return { skipped: 'unknown_show' };

        if (!AD_TRIM_MODES.includes(show.ad_trim_mode) || show.ad_trim_mode === 'off') {
          // Turning the feature off has to actually let the episodes out. A show left
          // holding its own episodes because a setting changed is a feed that stopped
          // for a reason nothing states.
          const { released } = settleHolds(show);
          if (released) events?.emit(EVENTS.SHOW_CHANGED, { showId, slug: show.slug });
          return { skipped: 'mode_off', released };
        }

        const started = Date.now();
        const fingerprinted = await adDetect.fingerprintShow(showId);

        // Deliberately no settle here. Between fingerprinting and detection there are
        // no segments yet, so every episode looks like it has nothing outstanding —
        // settling on that would release the whole show untrimmed for as long as
        // detection takes, which is the one thing the hold exists to prevent. "Nothing
        // to decide" and "not yet asked" are not the same answer.
        const detected = await adDetect.detectForShow(showId);

        // Now it means something, and an episode that turned out to need nothing is
        // released here rather than waiting behind the cutting of episodes that do.
        settleHolds(show);

        const trimmed = await trimmer.trimShow(showId);
        const holds = settleHolds(show);

        logger?.info(
          {
            showId,
            slug: show.slug,
            mode: show.ad_trim_mode,
            fingerprinted: fingerprinted?.fingerprinted ?? 0,
            segments: detected?.segments ?? 0,
            trimmed: trimmed.trimmed,
            failed: trimmed.failed,
            held: holds.held,
            ms: Date.now() - started,
          },
          'ran advert detection for a show',
        );
        events?.emit(EVENTS.SHOW_CHANGED, { showId, slug: show.slug });
        return { ...holds, fingerprinted, detected, trimmed };
      });
    },

    /** Every show that has the feature on. Used at boot and on the scheduler's tick. */
    async processAll() {
      const rows = db
        .prepare("SELECT id FROM shows WHERE ad_trim_mode IS NOT NULL AND ad_trim_mode != 'off'")
        .all();
      const results = [];
      for (const row of rows) results.push(await api.processShow(row.id));
      return results;
    },

    /**
     * Re-settles one show's holds without doing any work.
     *
     * For the review UI: approving a segment should let the episodes it was holding out
     * as soon as the trim lands, and the owner should not have to wait for a scheduler
     * tick to see it.
     */
    settle(showId) {
      const show = shows.get(showId);
      if (!show) return { released: 0, held: 0 };
      const result = settleHolds(show);
      if (result.released) events?.emit(EVENTS.SHOW_CHANGED, { showId, slug: show.slug });
      return result;
    },

    /** What the chain is doing, for the status endpoint. */
    status() {
      return { busy: active !== null, doing: active };
    },
  };

  return api;
}
