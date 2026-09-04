import { AD_TRIM_MODES, SCAN_TRIGGER, SEGMENT_STATUS, TRIMMABLE_EXTENSIONS } from '../constants.js';
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
export function createAdPipeline({ db, events, logger, health, shows, episodes, adDetect, trimmer, activity, transcriber = null }) {
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
  function isTrimmable(episode) {
    const at = episode.filename.lastIndexOf('.');
    return at >= 0 && TRIMMABLE_EXTENSIONS.includes(episode.filename.slice(at).toLowerCase());
  }

  function settleHolds(show) {
    const corpusSize = countFingerprinted.get(show.id)?.n ?? 0;
    let released = 0;
    let held = 0;
    let untrimmable = 0;

    for (const episode of episodes.listByShow(show.id)) {
      if (!isTrimmable(episode)) untrimmable += 1;
      const wanted = resolvePublishHold({
        mode: show.ad_trim_mode,
        corpusSize,
        minEpisodes: show.ad_auto_min_episodes ?? 3,
        undecidedSegments: countUndecided.get(episode.id)?.n ?? 0,
        trimStatus: episode.trim_status,
        canBeTrimmed: isTrimmable(episode),
        // Only an episode already held waits for its words (see resolvePublishHold),
        // and only while there is a recogniser to wait for.
        transcriptPending:
          episode.publish_hold !== null &&
          episode.publish_hold !== undefined &&
          Boolean(transcriber?.available()) &&
          transcriber.needsTranscript(episode, show),
      });
      if (wanted === (episode.publish_hold ?? null)) {
        if (wanted) held += 1;
        continue;
      }
      episodes.setSystemFields(episode.id, { publish_hold: wanted });
      if (wanted) held += 1;
      else released += 1;
    }
    /*
     * A show SelfPod cannot read at all is worth saying out loud.
     *
     * The episodes are published — holding them would be waiting for something that
     * cannot happen — but the owner has switched on a feature that is doing nothing,
     * and nothing else on the page would tell them. Silence here is how "I turned on
     * advert removal and no adverts were removed" becomes unanswerable.
     */
    const key = `ad_trim_unsupported_${show.id}`;
    if (untrimmable && !corpusSize) {
      health?.set(key, {
        level: 'info',
        message: `SelfPod cannot remove adverts from “${show.title}”.`,
        detail:
          'It can only read the audio of MP3 episodes, and this show has none. The episodes are published exactly as they arrive.',
      });
    } else {
      health?.clear(key);
    }

    return { released, held, corpusSize };
  }

  /**
   * Writes a line in the activity log — but only when there is something to say.
   *
   * This runs on every scheduled tick for every show that has the feature on, and
   * nearly all of those runs find exactly what they found last time. Recording them
   * would put a few hundred rows a day per show into the log people go to when
   * something has gone wrong, which is the fastest way to make that log useless.
   *
   * The counters are the scan_log's own columns, so the wording has to be chosen with
   * care: `removed` renders as "dropped", a word this app already uses for an episode
   * leaving a feed, and `added` would claim episodes appeared. Only `updated` — an
   * episode whose audio changed — is true here. A warning is likewise reserved for a
   * genuine anomaly, because one warning files the row under "Problems" for ever, and
   * finding nothing to cut is the ordinary state of a healthy show.
   */
  function recordActivity(show, counts) {
    if (!activity) return;
    if (
      !counts.found && !counts.trimmed && !counts.failed && !counts.released &&
      !counts.transcribed && !counts.heard && !counts.rememberedCuts && !counts.markerCuts && !counts.transcriptionFailed
    ) return;

    const parts = [];
    if (counts.transcribed) {
      parts.push(`${counts.transcribed} ${counts.transcribed === 1 ? 'episode' : 'episodes'} listened to`);
    }
    if (counts.found) parts.push(`${counts.found} repeated ${counts.found === 1 ? 'segment' : 'segments'} found`);
    if (counts.heard) parts.push(`${counts.heard} sponsor ${counts.heard === 1 ? 'read' : 'reads'} heard`);
    if (counts.rememberedCuts) parts.push(`${counts.rememberedCuts} cut from memory`);
    if (counts.markerCuts) parts.push(`${counts.markerCuts} cut at the boundary you set`);
    if (counts.trimmed) {
      parts.push(`${counts.trimmed} ${counts.trimmed === 1 ? 'episode' : 'episodes'} trimmed`);
    }
    if (counts.released) {
      parts.push(`${counts.released} published`);
    }
    if (counts.held) parts.push(`${counts.held} still waiting on a decision`);

    const id = activity.start({ showId: show.id, trigger: SCAN_TRIGGER.ADVERTS });
    activity.finish(id, {
      filesFound: counts.examined,
      updated: counts.trimmed,
      note: `${show.title} — ${parts.join(', ')}.`,
      warnings: [
        ...(counts.failed
          ? [
              {
                file: null,
                message: `SelfPod could not remove the approved adverts from ${counts.failed} ${
                  counts.failed === 1 ? 'episode' : 'episodes'
                }. They are published as they arrived, adverts included.`,
              },
            ]
          : []),
        ...(counts.transcriptionFailed
          ? [
              {
                file: null,
                message: `SelfPod could not hear the words in ${counts.transcriptionFailed} ${
                  counts.transcriptionFailed === 1 ? 'episode' : 'episodes'
                }. ${counts.transcriptionFailed === 1 ? 'It is' : 'They are'} published as ${
                  counts.transcriptionFailed === 1 ? 'it' : 'they'
                } arrived; a sponsor read the host performs live will not be caught in ${
                  counts.transcriptionFailed === 1 ? 'it' : 'them'
                }.`,
              },
            ]
          : []),
      ],
    });
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

        // Hearing the words comes before either detector, so the acoustic one's finds
        // can be read against them in the same run (a pre-roll found by ear is let go
        // once its words say sponsor). Still inside the unsettled stretch below.
        const transcribed = transcriber ? await transcriber.transcribeShow(showId) : null;
        if (transcribed?.transcribed) {
          events?.emit(EVENTS.TRANSCRIBE_FINISHED, { showId, slug: show.slug, ...transcribed });
        }

        // Deliberately no settle here. Between fingerprinting and detection there are
        // no segments yet, so every episode looks like it has nothing outstanding —
        // settling on that would release the whole show untrimmed for as long as
        // detection takes, which is the one thing the hold exists to prevent. "Nothing
        // to decide" and "not yet asked" are not the same answer.
        const detected = await adDetect.detectForShow(showId);
        const heard = transcriber ? await adDetect.detectFromTranscripts(showId) : null;

        // Now it means something, and an episode that turned out to need nothing is
        // released here rather than waiting behind the cutting of episodes that do.
        settleHolds(show);

        const trimmed = await trimmer.trimShow(showId);
        const holds = settleHolds(show);

        recordActivity(show, {
          examined: fingerprinted?.fingerprinted ?? 0,
          corpus: holds.corpusSize,
          found: detected?.newSegments ?? 0,
          transcribed: transcribed?.transcribed ?? 0,
          transcriptionFailed: transcribed?.failed ?? 0,
          heard: heard?.newSegments ?? 0,
          rememberedCuts: heard?.rememberedCuts ?? 0,
          markerCuts: heard?.markerCuts ?? 0,
          trimmed: trimmed.trimmed,
          failed: trimmed.failed,
          held: holds.held,
          released: holds.released,
        });

        logger?.info(
          {
            showId,
            slug: show.slug,
            mode: show.ad_trim_mode,
            fingerprinted: fingerprinted?.fingerprinted ?? 0,
            transcribed: transcribed?.transcribed ?? 0,
            segments: detected?.segments ?? 0,
            spoken: heard?.segments ?? 0,
            trimmed: trimmed.trimmed,
            failed: trimmed.failed,
            held: holds.held,
            ms: Date.now() - started,
          },
          'ran advert detection for a show',
        );
        events?.emit(EVENTS.SHOW_CHANGED, { showId, slug: show.slug });
        return { ...holds, fingerprinted, transcribed, detected, heard, trimmed };
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
      return { busy: active !== null, doing: active, listening: transcriber?.status().active ?? null };
    },
  };

  return api;
}
