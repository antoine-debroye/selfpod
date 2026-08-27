import { HOLD_REASONS, SEGMENT_SOURCES } from '../constants.js';

/**
 * How a repeated segment is described to the person deciding about it (spec §19.9).
 *
 * Shared by the JSON API and the review page so the two cannot drift, for the same
 * reason the subscription ledger is: this is the answer to "why would SelfPod cut
 * that?", and two accounts of it would leave the operator unable to tell which is
 * right.
 *
 * Nothing here says whether a segment is an advert, because SelfPod does not know. A
 * theme tune, a sponsor read, a standing intro and a recurring stinger all repeat
 * identically and nothing in the audio separates them. What is offered instead is
 * everything that would let a person tell in two seconds: how long it is, how many
 * episodes carry it, where in an episode it sits, and a way to listen to it.
 */
export function presentSegment(segment, { episodes } = {}) {
  if (!segment) return null;

  const occurrences = segment.occurrences ?? [];
  const durationSeconds = Math.round((segment.duration_ms ?? 0) / 10) / 100;

  return {
    id: segment.id,
    showId: segment.show_id,
    status: segment.status,
    source: segment.source,
    /**
     * Where it came from, in words, because the two sources deserve very different
     * amounts of trust. Something that differs between two downloads of one episode
     * cannot be the theme tune — the theme is in both copies — so it is an advert by
     * construction. Something that merely repeats might be anything the show does
     * every week.
     */
    sourceLabel:
      segment.source === SEGMENT_SOURCES.DIFF
        ? 'Changed between two downloads of the same episode'
        : `Repeats across ${segment.episode_count} episodes`,
    durationSeconds,
    durationLabel: formatDuration(segment.duration_ms ?? 0),
    episodeCount: segment.episode_count,
    occurrenceCount: segment.occurrence_count,
    autoApproved: Boolean(segment.auto_approved),
    holdReason: segment.hold_reason ?? null,
    /** Why automatic mode declined to take this one unasked, in the owner's language. */
    holdMessage: segment.hold_reason ? (HOLD_REASONS[segment.hold_reason] ?? null) : null,
    /** Always the same position within its episode, or "it moves about". */
    positionLabel: describePosition(occurrences, episodes),
    exemplar: segment.exemplar_episode_id
      ? {
          episodeId: segment.exemplar_episode_id,
          startMs: segment.exemplar_start_ms,
          endMs: segment.exemplar_end_ms,
          title: episodes?.get(segment.exemplar_episode_id)?.title ?? null,
          /** Admin-only, and the segment alone — not the episode it was cut from. */
          sampleUrl: `/api/ad-segments/${segment.id}/sample.mp3`,
        }
      : null,
    occurrences: occurrences.map((row) => ({
      episodeId: row.episode_id,
      episodeTitle: episodes?.get(row.episode_id)?.title ?? null,
      startMs: row.start_ms,
      endMs: row.end_ms,
      atLabel: formatDuration(row.start_ms),
    })),
    firstSeenAt: segment.first_seen_at,
    decidedAt: segment.decided_at,
  };
}

/**
 * "38 seconds in, every time" beats a table of millisecond offsets.
 *
 * Position is the single most useful thing for telling a sponsor read from a theme:
 * a theme is at 0:00 in every episode, a sponsor read is somewhere in the middle and
 * usually not the same somewhere.
 */
function describePosition(occurrences, episodes) {
  if (!occurrences.length) return null;
  const starts = occurrences.map((row) => row.start_ms ?? 0);
  const earliest = Math.min(...starts);
  const latest = Math.max(...starts);

  if (earliest < 5000 && latest < 5000) return 'At the very start of every episode';

  if (episodes) {
    const atEnd = occurrences.every((row) => {
      const episode = episodes.get(row.episode_id);
      if (!episode?.duration_seconds) return false;
      return episode.duration_seconds * 1000 - (row.end_ms ?? 0) < 15_000;
    });
    if (atEnd) return 'At the very end of every episode';
  }

  if (latest - earliest < 10_000) return `Around ${formatDuration(earliest)} in, every time`;
  return `Between ${formatDuration(earliest)} and ${formatDuration(latest)} in`;
}

/** `m:ss`, or `h:mm:ss` past an hour. Segments are seconds; positions can be hours. */
function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Whether SelfPod has looked properly and found nothing — which is not "not yet".
 *
 * Comparing episodes finds audio that is *encoded* identically. That happens when a
 * producer concatenates pre-encoded pieces, and it is what a podcast host does when it
 * stitches an advert in at serve time. A show mastered and encoded in one pass is
 * different: its theme tune is encoded afresh in every episode, so it is the same
 * sound and different bytes, and no number of further episodes will make it match.
 *
 * Measured on three real Planet Money episodes: nine matching frames out of ninety
 * thousand, longest identical run 1.6 seconds. That is the ordinary case for a
 * professionally produced show. Telling someone "nothing found yet" for ever, when the
 * answer is "not this way, and not ever for this show", is the kind of silence this
 * app exists to avoid.
 */
export function describeComparability({ show, episodes, segments }) {
  const comparable = episodes
    .listByShow(show.id)
    .filter((row) => row.filename.toLowerCase().endsWith('.mp3'));
  return {
    comparableEpisodes: comparable.length,
    lookedAndFoundNothing:
      segments.length === 0 && comparable.length >= (show.ad_auto_min_episodes ?? 3),
  };
}
