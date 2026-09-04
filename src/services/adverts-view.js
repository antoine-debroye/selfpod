import { PUBLISH_HOLDS, SEGMENT_SOURCES, TRIM_STATUS } from '../constants.js';
import { presentSegment, describeComparability } from '../lib/present-segment.js';
import {
  describeAdvertStage,
  describeListenScope,
  describeVerdict,
  flattenTranscript,
  formatClock,
  presentExcerpt,
  regionsOf,
} from '../lib/present-transcript.js';
import { normaliseWord } from '../lib/text-normalise.js';

/**
 * Everything the pages say about adverts, built in one place (spec §19.6).
 *
 * The review panel, the episode page, the ledger row and the JSON API all describe
 * the same facts — what was heard, what will be cut, why — and this is where those
 * facts are assembled from the catalogue and the transcripts, so no two of them can
 * tell a different story.
 */
const LANGUAGE_NAMES = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese' };

export function createAdvertsView({ db, adDetect, transcriber, episodes, shows }) {
  /** 'ready' | 'unknown' (not yet proved) | 'missing' | 'failing' */
  function engineState() {
    return transcriber?.status?.()?.state ?? 'missing';
  }

  /** "about 40× real time" and "an episode's opening and closing is about 15 seconds of work". */
  function rateLabels(show) {
    const rate = transcriber?.status?.().rate ?? null;
    if (!rate) return { rateLabel: null, costLabel: null };
    const audioSeconds =
      show.ad_transcribe === 'whole'
        ? 3600
        : (show.ad_transcribe_head_seconds ?? 300) + (show.ad_transcribe_tail_seconds ?? 240);
    const work = Math.round(audioSeconds / rate);
    return {
      rateLabel: `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}× real time`,
      costLabel:
        show.ad_transcribe === 'whole'
          ? `an hour-long episode is about ${work >= 90 ? `${Math.round(work / 60)} minutes` : `${work} seconds`} of work`
          : `listening to ${describeListenScope(show)} of an episode is about ${work >= 90 ? `${Math.round(work / 60)} minutes` : `${work} seconds`} of work`,
    };
  }

  const api = {
    /** The context behind the review panel and the Adverts page. */
    async segmentsContext(show) {
      const rows = adDetect.listSegments(show.id);
      const transcripts = await adDetect.exemplarTranscripts(show.id);
      const markers = new Map(adDetect.listMarkers(show.id).map((marker) => [marker.id, marker]));
      const segments = rows.map((row) => {
        const presented = presentSegment(row, { episodes, transcripts, mode: show.ad_trim_mode ?? 'review' });
        if (presented.isMarker) {
          const marker = markers.get(String(row.signature).slice('marker:'.length));
          presented.markerId = marker?.id ?? null;
          presented.why = describeVerdict({ ...row, marker_role: marker?.role, marker_inclusive: marker?.inclusive }, { mode: show.ad_trim_mode });
        }
        return presented;
      });
      const progress = transcriber?.progress?.(show.id) ?? { done: 0, failed: 0, pending: 0, unsupported: 0, total: 0, mode: 'off' };
      const status = transcriber?.status?.() ?? { active: null, rate: null };
      const engine = engineState();
      // Nothing is pending on a machine that cannot listen: saying "still listening
      // to 3 episodes" there would be the wait-for-ever this feature is built against.
      if (engine !== 'ready') progress.pending = 0;
      const listening = {
        engine,
        engineLabel: transcriber?.engineLabel?.() ?? null,
        ...progress,
        inProgress: engine === 'ready' && show.ad_trim_mode !== 'off' && (Boolean(status.active && status.active.showId === show.id) || progress.pending > 0),
        scopeLabel: describeListenScope(show),
        progressLabel: `Listened to ${progress.done} of ${progress.total}, newest first…`,
      };
      return {
        mode: show.ad_trim_mode ?? 'off',
        minEpisodes: show.ad_auto_min_episodes ?? 3,
        held: episodes.counts(show.id).held,
        segments,
        listening,
        listen: {
          headMinutes: Math.round((show.ad_transcribe_head_seconds ?? 300) / 60),
          tailMinutes: Math.round((show.ad_transcribe_tail_seconds ?? 240) / 60),
          whole: show.ad_transcribe === 'whole',
          ...rateLabels(show),
        },
        ...describeComparability({
          show,
          episodes,
          segments: rows,
          fingerprinted: adDetect.countFingerprinted(show.id),
        }),
      };
    },

    /** The words of one episode, marked up for its page. */
    async episodeTranscript(episode, show) {
      const base = {
        engineLabel: transcriber?.engineLabel?.() ?? null,
        scopeLabel: describeListenScope(show),
        regions: [],
      };
      if (!show.ad_trim_mode || show.ad_trim_mode === 'off') return { ...base, state: 'off' };
      if (!/\.mp3$/i.test(episode.filename ?? '')) return { ...base, state: 'unsupported' };
      if (show.ad_transcribe === 'off') return { ...base, state: 'off' };
      const transcript = await transcriber.loadTranscript(episode);
      if (!transcript) {
        const row = transcriber.rowFor?.(episode.id) ?? null;
        if (row?.status === 'failed' && row.attempts >= 3) {
          return {
            ...base,
            state: 'failed',
            failureSentence:
              row.failure === 'timeout'
                ? 'SelfPod gave up listening to this episode three times over. It is published as it arrived.'
                : 'SelfPod could not read the words in this episode. It is published as it arrived.',
          };
        }
        if (engineState() === 'missing' || engineState() === 'failing') return { ...base, state: 'engine_missing' };
        if (engineState() === 'ready' && episode.publish_hold && transcriber.needsTranscript(episode, show)) return { ...base, state: 'listening' };
        return { ...base, state: 'not_looked' };
      }

      const words = flattenTranscript(transcript);
      const spoken = adDetect.spokenIn(episode.id);
      const markers = new Map(adDetect.listMarkers(show.id).map((marker) => [marker.id, marker]));
      const regions = regionsOf(transcript).map((region) => {
        const regionWords = [];
        words.forEach((word, index) => {
          if (word.window === region.index) regionWords.push({ index, word });
        });
        const marks = [];
        const marked = new Map();
        for (const row of spoken) {
          const inRegion = regionWords.filter(({ word }) => (word.s + word.e) / 2 >= row.start_ms && (word.s + word.e) / 2 <= row.end_ms);
          if (!inRegion.length) continue;
          const isMarker = String(row.signature).startsWith('marker:');
          const marker = isMarker ? markers.get(String(row.signature).slice('marker:'.length)) : null;
          for (const { index } of inRegion) marked.set(index, row.status);
          marks.push({
            segmentId: row.id,
            markerId: marker?.id ?? null,
            isMarker,
            status: row.status,
            atLabel: `${formatClock(row.start_ms)}–${formatClock(row.end_ms)}`,
            startWord: inRegion[0].index,
            endWord: inRegion[inRegion.length - 1].index,
            why: describeVerdict({ ...row, marker_role: marker?.role, marker_inclusive: marker?.inclusive }, { mode: show.ad_trim_mode }),
            autoApproved: Boolean(row.auto_approved),
          });
        }
        const cueWords = new Set();
        for (const row of spoken) {
          const excerpt = presentExcerpt(words, { startMs: row.start_ms, endMs: row.end_ms }, { cues: row.cues ? JSON.parse(row.cues) : [] });
          for (const word of excerpt?.words ?? []) if (word.cue) cueWords.add(word.i);
        }
        const waiting = marks.filter((mark) => mark.status === 'candidate');
        const cut = marks.filter((mark) => mark.status === 'approved');
        const summary = waiting.length
          ? `${waiting.length} ${waiting.length === 1 ? 'stretch' : 'stretches'} waiting for you at ${waiting.map((mark) => mark.atLabel).join(', ')}`
          : cut.length
            ? `cut ${cut.map((mark) => mark.atLabel).join(', ')}`
            : 'nothing that sounds like a sponsor read';
        return {
          ...region,
          languageLabel: LANGUAGE_NAMES[region.language] ?? region.language,
          summary,
          open: waiting.length > 0 || cut.length > 0,
          words: regionWords.map(({ index, word }) => ({
            i: index,
            t: word.w,
            startMs: word.s,
            endMs: word.e,
            role: null,
            mark: marked.get(index) ?? null,
            cue: cueWords.has(index) ? 'cue' : null,
            low: (word.p ?? 1) < 0.45,
          })),
          marks,
        };
      });
      return {
        ...base,
        state: 'heard',
        language: transcript.language,
        languageLabel: LANGUAGE_NAMES[transcript.language] ?? transcript.language,
        regions,
      };
    },

    /**
     * Everything that happened to one episode's adverts, for its own page.
     *
     * The show's page answers "what does this show repeat?"; this answers "what was
     * taken out of *this* episode, and what is still to decide?" — which is the
     * question somebody has when they click an episode and want to know why it is
     * eight seconds shorter than the file on their share, or why it is not in the feed
     * yet. Built from the same catalogue and worded with the same sentences as the
     * show's page, because two accounts of one decision is how they drift apart.
     */
    async episodeAdverts(episode, show) {
      const listened = await api.episodeTranscript(episode, show);
      const off = !show.ad_trim_mode || show.ad_trim_mode === 'off';
      const markers = new Map(adDetect.listMarkers(show.id).map((marker) => [marker.id, marker]));
      const rows = off ? [] : adDetect.spokenIn(episode.id);
      const audible = off
        ? []
        : db
            .prepare(
              `SELECT s.*, o.start_ms, o.end_ms, o.start_frame, o.end_frame
                 FROM ad_segment_occurrences o
                 JOIN ad_segments s ON s.id = o.segment_id
                WHERE o.episode_id = ? AND s.source != '${SEGMENT_SOURCES.TRANSCRIPT}' AND s.text IS NULL
                ORDER BY o.start_ms`,
            )
            .all(episode.id);

      const present = (row) => {
        const marker = markers.get(String(row.signature).slice('marker:'.length));
        const isMarker = String(row.signature).startsWith('marker:');
        return {
          segmentId: row.id,
          markerId: marker?.id ?? null,
          isMarker,
          status: row.status,
          atLabel: `${formatClock(row.start_ms)}–${formatClock(row.end_ms)}`,
          startMs: row.start_ms,
          endMs: row.end_ms,
          lengthLabel: formatClock(Math.max(0, row.end_ms - row.start_ms)),
          text: row.raw_text ?? null,
          heard: Boolean(row.text),
          sourceLabel: presentSegment(row, { episodes }).sourceLabel,
          why: describeVerdict({ ...row, marker_role: marker?.role, marker_inclusive: marker?.inclusive }, { mode: show.ad_trim_mode }),
          // The stretch itself, with a few seconds either side so the edges can be
          // judged by ear rather than by reading a timestamp.
          sampleUrl: `/api/ad-segments/${row.id}/sample.mp3?context=3`,
          autoApproved: Boolean(row.auto_approved),
        };
      };

      const all = [...rows, ...audible].map(present).sort((a, b) => a.startMs - b.startMs);
      const cut = all.filter((entry) => entry.status === 'approved');
      const waiting = all.filter((entry) => entry.status === 'candidate');
      const kept = all.filter((entry) => entry.status === 'rejected');

      const before = episode.duration_seconds ?? null;
      const after = episode.trimmed_duration_seconds ?? null;
      const savedSeconds = before !== null && after !== null ? Math.max(0, before - after) : null;

      return {
        off,
        listened,
        cut,
        waiting,
        kept,
        /* Held, and why — an episode kept out of the feed with nothing saying why is
           the failure this whole app is built against. */
        hold: episode.publish_hold
          ? {
              reason: episode.publish_hold,
              sentence:
                episode.publish_hold === PUBLISH_HOLDS.AWAITING_REVIEW
                  ? 'Not in your feed yet: SelfPod is waiting for you to decide about what it found.'
                  : episode.publish_hold === PUBLISH_HOLDS.TRIMMING
                    ? 'Not in your feed for a moment: SelfPod is cutting the approved adverts out of it.'
                    : listened.state === 'listening'
                      ? 'Not in your feed yet: SelfPod is still listening to this episode.'
                      : 'Not in your feed yet: SelfPod has not compared enough episodes of this show to tell what it repeats.',
            }
          : null,
        trim: {
          status: episode.trim_status ?? null,
          failed: episode.trim_status === TRIM_STATUS.FAILED,
          isTrimmed: Boolean(episode.trimmed_filename),
          beforeSeconds: before,
          afterSeconds: after,
          savedSeconds,
          savedLabel: savedSeconds ? formatClock(savedSeconds * 1000) : null,
          beforeBytes: episode.file_size_bytes ?? null,
          afterBytes: episode.trimmed_bytes ?? null,
        },
        advertsUrl: `/shows/${encodeURIComponent(show.slug)}/adverts`,
      };
    },

    /** Converts a range of words in an episode to milliseconds and their text. */
    async wordRange(episode, startWord, endWord) {
      const transcript = await transcriber.loadTranscript(episode);
      if (!transcript) return null;
      const words = flattenTranscript(transcript);
      const from = Number(startWord);
      const to = Number(endWord);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= words.length || from > to) return null;
      const chosen = words.slice(from, to + 1);
      if (!chosen.some((word) => normaliseWord(word.w).length)) return null;
      return {
        startMs: chosen[0].s,
        endMs: chosen[chosen.length - 1].e,
        rawText: chosen.map((word) => word.w).join(' '),
        language: transcript.language ?? null,
      };
    },

    /** What the ledger row and the episode row say about an episode's adverts. */
    advertsFor(episode, show) {
      if (!episode || !show) return null;
      const row = transcriber?.rowFor?.(episode.id) ?? null;
      const markers = adDetect.listMarkers(show.id);
      const spoken = adDetect.spokenIn(episode.id).map((entry) => {
        const marker = markers.find((candidate) => entry.signature === `marker:${candidate.id}`);
        return marker ? { ...entry, marker_role: marker.role, marker_inclusive: marker.inclusive } : entry;
      });
      return describeAdvertStage({
        episode,
        show,
        row,
        spoken,
        markers,
        pending: engineState() === 'ready' && Boolean(episode.publish_hold) && Boolean(transcriber?.needsTranscript?.(episode, show)),
        engineMissing: engineState() === 'missing' || engineState() === 'failing',
        listenLabel: describeListenScope(show),
      });
    },

    /** Applies the listening settings from a form, saying what is wrong with them. */
    listenSettingsFrom(body, show) {
      const parse = (value, fallback) => {
        if (value === undefined || value === null || value === '') return fallback;
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 0 && parsed <= 15 ? parsed : null;
      };
      const head = parse(body.listenHeadMinutes, Math.round((show.ad_transcribe_head_seconds ?? 300) / 60));
      const tail = parse(body.listenTailMinutes, Math.round((show.ad_transcribe_tail_seconds ?? 240) / 60));
      const whole = body.listenWhole === '1' || body.listenWhole === true || body.listenWhole === 'true';
      if (head === null || tail === null) return { error: 'Minutes to listen to have to be whole numbers between 0 and 15.' };
      if (!whole && head === 0 && tail === 0) return { error: 'Choose somewhere to listen, or turn the feature off.' };
      return {
        fields: {
          ad_transcribe: whole ? 'whole' : 'edges',
          ad_transcribe_head_seconds: head * 60,
          ad_transcribe_tail_seconds: tail * 60,
        },
      };
    },
  };

  return api;
}
