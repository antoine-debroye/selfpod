import { HOLD_REASONS, SEGMENT_SOURCES } from '../constants.js';
import { describeVerdict, flattenTranscript, parseCues, presentExcerpt, LOW_CONFIDENCE } from './present-transcript.js';
import { describeCues } from './advert-cues.js';
import { meanConfidence } from './transcript.js';

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
export function presentSegment(segment, { episodes, transcripts = null, mode = 'review' } = {}) {
  if (!segment) return null;

  const occurrences = segment.occurrences ?? [];
  const durationSeconds = Math.round((segment.duration_ms ?? 0) / 10) / 100;
  const positionLabel = describePosition(occurrences, episodes);
  const spoken = segment.source === SEGMENT_SOURCES.TRANSCRIPT || Boolean(segment.text);
  const isMarker = String(segment.signature ?? '').startsWith('marker:');
  const cues = parseCues(segment.cues);

  /*
   * The words, when there are any. The exemplar occurrence is shown with a few
   * seconds of context either side, so the owner reads what will go and what stays.
   */
  let excerpt = null;
  let confidence = null;
  const exemplarOccurrence =
    occurrences.find((row) => row.episode_id === segment.exemplar_episode_id) ?? occurrences[0] ?? null;
  const transcript = exemplarOccurrence ? transcripts?.get?.(exemplarOccurrence.episode_id) : null;
  if (transcript && exemplarOccurrence) {
    const words = flattenTranscript(transcript);
    excerpt = presentExcerpt(words, { startMs: exemplarOccurrence.start_ms, endMs: exemplarOccurrence.end_ms }, { cues });
    if (excerpt) {
      excerpt.episodeId = exemplarOccurrence.episode_id;
      confidence = meanConfidence(words.slice(excerpt.cutStartWord, excerpt.cutEndWord + 1));
    }
  }

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
    sourceLabel: isMarker
      ? 'The boundary you set'
      : segment.source === SEGMENT_SOURCES.DIFF
        ? 'Changed between two downloads of the same episode'
        : segment.source === SEGMENT_SOURCES.TRANSCRIPT
          ? segment.episode_count > 1
            ? `The same words in ${segment.episode_count} episodes`
            : 'Sounds like a sponsor read, heard once'
          : `Repeats across ${segment.episode_count} ${segment.episode_count === 1 ? 'episode' : 'episodes'}`,
    durationSeconds,
    durationLabel: formatDuration(segment.duration_ms ?? 0),
    episodeCount: segment.episode_count,
    occurrenceCount: segment.occurrence_count,
    autoApproved: Boolean(segment.auto_approved),
    holdReason: segment.hold_reason ?? null,
    /** Why automatic mode declined to take this one unasked, in the owner's language. */
    holdMessage: segment.hold_reason ? (HOLD_REASONS[segment.hold_reason] ?? null) : null,
    /** Always the same position within its episode, or "it moves about". */
    positionLabel,
    /* ---- the words (spec §19.6) ---- */
    spoken,
    isMarker,
    text: segment.text ?? null,
    rawText: segment.raw_text ?? null,
    language: segment.language ?? null,
    cueScore: segment.cue_score ?? null,
    cues: cues.map((cue) => ({ id: cue.id, phrase: cue.phrase, weight: cue.weight })),
    cuesLabel: describeCues(cues),
    // The recogniser's confidence in the *words*, never in a verdict — the API has a
    // test that refuses a key called "confidence" for exactly that reason.
    heardClearly: confidence === null ? null : confidence >= LOW_CONFIDENCE,
    /** What SelfPod is going to do, and why, in one sentence. Only for what was heard. */
    why: spoken ? describeVerdict(segment, { mode, positionLabel, confidence, occurrences }) : null,
    excerpt,
    contextSampleUrl: exemplarOccurrence ? `/api/ad-segments/${segment.id}/sample.mp3?context=3` : null,
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
 * A show can genuinely have nothing in common between its episodes — no theme, no
 * standing sponsor read, no bed under the credits. Saying "nothing found yet" to
 * someone in that position leaves them waiting for an answer that has already arrived,
 * which is the kind of silence this app exists to avoid.
 */
export function describeComparability({ show, episodes, segments, fingerprinted }) {
  /*
   * Counted from episodes SelfPod has actually *listened to*, not from MP3 files
   * sitting in the folder.
   *
   * Those two numbers differ for as long as the work takes, and reading a show is not
   * quick: it decodes every episode. Counting files meant the page announced "compared
   * 5 episodes and found no repeated audio" the moment the show was switched on —
   * before it had compared anything. On a real show it said exactly that, and a minute
   * later there were three segments sitting underneath the sentence denying they
   * existed.
   *
   * Stating a conclusion before doing the work is the failure this app is built
   * against, so the count now comes from the fingerprint table.
   */
  const compared = fingerprinted ?? 0;
  return {
    comparableEpisodes: compared,
    lookedAndFoundNothing: segments.length === 0 && compared >= (show.ad_auto_min_episodes ?? 3),
  };
}
