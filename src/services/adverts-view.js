import { PUBLISH_HOLDS, SEGMENT_KINDS, SEGMENT_STATUS, TRIM_STATUS, TRIMMABLE_EXTENSIONS } from '../constants.js';
import { DECISIONS, EPISODE_STATES, STRETCH_STATES } from '../lib/adverts-vocabulary.js';
import { barMarks, markStyle, restoreCovers } from '../lib/cut-bar.js';
import { escapeHtml } from '../lib/html.js';
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

/** Episodes on one page of the timeline; "Show older" appends the next. */
export const TIMELINE_PAGE_SIZE = 30;

const RESTORED_SENTENCE = 'Restored in this episode; the rule still applies elsewhere.';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function isTrimmableName(filename) {
  const at = String(filename ?? '').lastIndexOf('.');
  return at >= 0 && TRIMMABLE_EXTENSIONS.includes(String(filename).slice(at).toLowerCase());
}

/** "about 40 seconds" / "about 3 minutes". */
function aboutLabel(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `about ${plural(Math.max(1, Math.round(seconds)), 'second')}`;
  return `about ${plural(Math.round(seconds / 60), 'minute')}`;
}

/**
 * The work-owed sentence, from `adPipeline.workOwed`: "2 episodes to listen to, about 1
 * minute". Empty when nothing is owed, so the strip that carries it disappears.
 */
export function describeWork(owed) {
  if (!owed) return '';
  const parts = [];
  if (owed.toCut) parts.push(`Cutting ${plural(owed.toCut, 'episode')}…`);
  if (owed.toHear) {
    const about = aboutLabel(owed.estimateSeconds);
    parts.push(`${plural(owed.toHear, 'episode')} to listen to${about ? `, ${about}` : ''}`);
  }
  if (owed.toRead) parts.push(`${plural(owed.toRead, 'episode')} to read`);
  if (!parts.length && owed.busy) parts.push('Checking this show…');
  return parts.join(' · ');
}

/**
 * The inside of the work strip, as HTML — built here once for the page and for the
 * live stream, so the two cannot differ. While there is work, it asks again in ten
 * seconds: the stream is the fast path, the poll is what makes the strip right without it.
 */
export function workStripHtml(show, owed) {
  const sentence = describeWork(owed);
  if (!sentence) return '';
  return `<span class="cuts-work__text" hx-get="/ui/shows/${escapeHtml(encodeURIComponent(show.slug))}/ad-work" hx-trigger="load delay:10s" hx-target="#cuts-work" hx-swap="innerHTML">${escapeHtml(sentence)}</span>`;
}

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

  /** The one anchor worth showing: confirmed first, else the newest not-yet-dismissed proposal. */
  function currentAnchorFor(showId) {
    const rows = adDetect.listAnchors(showId).filter((row) => !row.dismissed_at);
    return rows.find((row) => row.confirmed_at) ?? rows[rows.length - 1] ?? null;
  }

  /**
   * What the page (and the API) say about the jingle SelfPod is listening for —
   * built here so a confirmed-or-not proposal is described the same way wherever it
   * appears, the same reason everything else in this file exists.
   */
  function presentAnchor(anchor) {
    if (!anchor) return null;
    const summary = adDetect.anchorSummary(anchor.id);
    return {
      id: anchor.id,
      origin: anchor.origin,
      confirmed: Boolean(anchor.confirmed_at),
      markerId: anchor.marker_id,
      heard: summary.heard,
      missed: summary.missed,
      checked: summary.total,
      exemplarEpisodeId: anchor.exemplar_episode_id,
      createdAt: anchor.created_at,
      sentence: !anchor.confirmed_at
        ? `Every episode has the same few seconds near the start, at a different point each time — which is what a station jingle behind a changing pre-roll sounds like. Confirm it and SelfPod will cut whatever comes before it, every day, without hearing the words.`
        : summary.total
          ? `Heard in ${summary.heard} of ${summary.total} episode${summary.total === 1 ? '' : 's'} checked.`
          : null,
    };
  }

  const api = {
    currentAnchorFor,
    presentAnchor,

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
        anchor: presentAnchor(currentAnchorFor(show.id)),
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
      // Reads heard once are not stored (spec §19.6); they are worked out here and
      // highlighted as waiting, so the owner can teach from them.
      const suggestions = await adDetect.sponsorSuggestions(episode.id);
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
          const isMarker = row.kind === SEGMENT_KINDS.BOUNDARY_WORDS;
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
        const suggested = [];
        for (const suggestion of suggestions) {
          const inRegion = regionWords.filter(({ word }) => (word.s + word.e) / 2 >= suggestion.startMs && (word.s + word.e) / 2 <= suggestion.endMs);
          if (!inRegion.length) continue;
          for (const { index } of inRegion) if (!marked.has(index)) marked.set(index, 'candidate');
          suggested.push({
            atLabel: `${formatClock(suggestion.startMs)}–${formatClock(suggestion.endMs)}`,
            startWord: inRegion[0].index,
            endWord: inRegion[inRegion.length - 1].index,
            rawText: suggestion.rawText,
            cues: suggestion.cues,
          });
        }
        const cueWords = new Set();
        for (const row of [
          ...spoken.map((entry) => ({ startMs: entry.start_ms, endMs: entry.end_ms, cues: entry.cues ? JSON.parse(entry.cues) : [] })),
          ...suggestions,
        ]) {
          const excerpt = presentExcerpt(words, { startMs: row.startMs, endMs: row.endMs }, { cues: row.cues ?? [] });
          for (const word of excerpt?.words ?? []) if (word.cue) cueWords.add(word.i);
        }
        const waiting = [...marks.filter((mark) => mark.status === 'candidate'), ...suggested];
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
          suggested,
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
                WHERE o.episode_id = ? AND s.text IS NULL
                  AND s.kind NOT IN ('${SEGMENT_KINDS.BOUNDARY_WORDS}', '${SEGMENT_KINDS.REMEMBERED_WORDS}', '${SEGMENT_KINDS.REPEATED_WORDS}')
                ORDER BY o.start_ms`,
            )
            .all(episode.id);

      const present = (row) => {
        const marker = markers.get(String(row.signature).slice('marker:'.length));
        const isMarker = row.kind === SEGMENT_KINDS.BOUNDARY_WORDS;
        return {
          segmentId: row.id,
          kind: row.kind,
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

      const cuts = off ? null : api.showCuts(show);
      const bar = cuts ? api.episodeBar(episode, cuts) : null;
      return {
        off,
        offSentence: 'SelfPod is not looking for adverts in this show, so this episode is published exactly as it arrived.',
        listened,
        cut,
        waiting,
        kept,
        bar,
        publishedAudioUrl: `/api/episodes/${encodeURIComponent(episode.id)}/audio`,
        originalAudioUrl: `/api/episodes/${encodeURIComponent(episode.id)}/audio?copy=original`,
        teachRangeUrl: `/ui/episodes/${encodeURIComponent(episode.id)}/teach-range`,
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
          failedSentence: 'SelfPod could not cut this episode, so it is published as it arrived, adverts included.',
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
        anchorStatus: adDetect.anchorStatusFor(episode.id),
        anchorCut: adDetect.anchorCutFor(episode.id),
      });
    },


    /* ---- the cuts, episode by episode (spec §19.6) --------------------------- */

    /**
     * Everything the cut pages need about one show, read in a handful of queries
     * rather than one per episode: the episode table asks for every row's pill at once.
     */
    showCuts(show) {
      const off = !show.ad_trim_mode || show.ad_trim_mode === 'off';
      const segments = new Map(adDetect.listSegments(show.id).map((row) => [row.id, row]));
      const occurrences = new Map();
      for (const row of db
        .prepare(
          `SELECT o.episode_id, o.segment_id, o.start_ms, o.end_ms
             FROM ad_segment_occurrences o
             JOIN ad_segments s ON s.id = o.segment_id
            WHERE s.show_id = ?
            ORDER BY o.start_ms`,
        )
        .all(show.id)) {
        if (!occurrences.has(row.episode_id)) occurrences.set(row.episode_id, []);
        occurrences.get(row.episode_id).push(row);
      }
      const restores = new Map();
      for (const row of db
        .prepare(
          `SELECT r.* FROM ad_cut_overrides r JOIN episodes e ON e.id = r.episode_id
            WHERE e.show_id = ? ORDER BY r.start_ms`,
        )
        .all(show.id)) {
        if (!restores.has(row.episode_id)) restores.set(row.episode_id, []);
        restores.get(row.episode_id).push(row);
      }
      const looked = new Set(
        db
          .prepare('SELECT f.episode_id FROM episode_fingerprints f JOIN episodes e ON e.id = f.episode_id WHERE e.show_id = ?')
          .all(show.id)
          .map((row) => row.episode_id),
      );
      const markers = new Map(adDetect.listMarkers(show.id).map((marker) => [marker.id, marker]));
      const anchors = new Map(adDetect.listAnchors(show.id).map((anchor) => [anchor.id, anchor]));
      const reasons = new Map();
      const reasonFor = (segment) => {
        if (reasons.has(segment.id)) return reasons.get(segment.id);
        const marker = markers.get(segment.marker_id ?? String(segment.signature).slice('marker:'.length));
        const anchor = anchors.get(segment.anchor_id ?? String(segment.signature).slice('anchor:'.length));
        const row = {
          ...segment,
          marker_role: marker?.role,
          marker_inclusive: marker?.inclusive,
          anchor_auto_confirmed: Boolean(anchor?.auto_confirmed),
        };
        const presented = presentSegment(row, { episodes, mode: show.ad_trim_mode ?? 'review' });
        const why = presented.why ?? describeVerdict(row, { mode: show.ad_trim_mode, positionLabel: presented.positionLabel, occurrences: row.occurrences ?? [] });
        reasons.set(segment.id, why);
        return why;
      };
      return { show, off, segments, occurrences, restores, looked, markers, anchors, reasonFor };
    },

    /** The stretches of one episode, each with its state, reason, place on the bar and actions. */
    stretchesOf(episode, cuts) {
      const { show, segments, reasonFor } = cuts;
      const own = cuts.occurrences.get(episode.id) ?? [];
      const restores = cuts.restores.get(episode.id) ?? [];
      const used = new Set();
      const stretches = [];
      const slug = encodeURIComponent(show.slug);
      const episodeBase = `/ui/episodes/${encodeURIComponent(episode.id)}`;
      for (const occurrence of own) {
        const segment = segments.get(occurrence.segment_id);
        if (!segment || segment.status === SEGMENT_STATUS.REJECTED) continue;
        const approved = segment.status === SEGMENT_STATUS.APPROVED;
        const restore = approved ? restores.find((row) => !used.has(row.id) && restoreCovers(row, occurrence)) : null;
        if (restore) used.add(restore.id);
        const state = restore ? 'restored' : approved ? 'cut' : 'waiting';
        const why = reasonFor(segment);
        stretches.push({
          key: `${segment.id}:${occurrence.start_ms}`,
          segmentId: segment.id,
          overrideId: restore?.id ?? null,
          kind: segment.kind,
          state,
          reasonKey: restore ? 'restored' : why.key,
          reason: restore ? RESTORED_SENTENCE : why.sentence,
          startMs: occurrence.start_ms,
          endMs: occurrence.end_ms,
          offerMarker: state === 'waiting' && segment.raw_text ? why.offerMarker || false : false,
        });
      }
      for (const restore of restores) {
        if (used.has(restore.id)) continue;
        stretches.push({
          key: `restore:${restore.id}`,
          segmentId: restore.segment_id,
          overrideId: restore.id,
          kind: restore.segment_id ? segments.get(restore.segment_id)?.kind ?? null : null,
          state: 'restored',
          reasonKey: 'restored',
          reason: RESTORED_SENTENCE,
          startMs: restore.start_ms,
          endMs: restore.end_ms,
          offerMarker: false,
        });
      }
      stretches.sort((a, b) => a.startMs - b.startMs);
      const durationMs = (episode.duration_seconds ?? 0) * 1000;
      return barMarks(stretches, durationMs).map((stretch) => {
        const atLabel = `${formatClock(stretch.startMs)}–${formatClock(stretch.endMs)}`;
        const actions = [];
        if (stretch.state === 'cut') {
          actions.push({ label: DECISIONS.restoreHere, url: `${episodeBase}/segments/${encodeURIComponent(stretch.segmentId)}/restore`, primary: false });
          actions.push({ label: DECISIONS.stop, url: `/ui/shows/${slug}/segments/${encodeURIComponent(stretch.segmentId)}/stop`, primary: false });
        } else if (stretch.state === 'waiting') {
          const decide = `/ui/shows/${slug}/ad-segments/${encodeURIComponent(stretch.segmentId)}`;
          actions.push({ label: DECISIONS.remove, url: decide, name: 'status', value: SEGMENT_STATUS.APPROVED, primary: true });
          actions.push({ label: DECISIONS.keep, url: decide, name: 'status', value: SEGMENT_STATUS.REJECTED, primary: false });
          if (stretch.offerMarker) actions.push({ label: DECISIONS.teach, url: decide, name: 'status', value: stretch.offerMarker, primary: false });
        } else if (stretch.state === 'restored' && stretch.overrideId) {
          actions.push({ label: DECISIONS.remove, url: `${episodeBase}/restores/${encodeURIComponent(stretch.overrideId)}/undo`, primary: false });
        }
        return {
          ...stretch,
          stateLabel: STRETCH_STATES[stretch.state],
          atLabel,
          style: markStyle(stretch),
          // The stretch itself; the player adds a few seconds either side (app.js).
          playFrom: stretch.startMs,
          playTo: stretch.endMs,
          sampleUrl: stretch.segmentId ? `/api/ad-segments/${encodeURIComponent(stretch.segmentId)}/sample.mp3?context=3` : null,
          actions,
        };
      });
    },

    /** Where one episode stands, from its stretches: the pill, the caption, how much was cut. */
    episodeState(episode, stretches, cuts) {
      if (cuts.off) return null;
      const cutStretches = stretches.filter((stretch) => stretch.state === 'cut');
      let cutMs = 0;
      let reach = -1;
      for (const stretch of cutStretches) {
        const start = Math.max(stretch.startMs, reach);
        if (stretch.endMs > start) cutMs += stretch.endMs - start;
        reach = Math.max(reach, stretch.endMs);
      }
      const measured =
        episode.trimmed_filename && episode.duration_seconds && episode.trimmed_duration_seconds
          ? Math.max(0, (episode.duration_seconds - episode.trimmed_duration_seconds) * 1000)
          : null;
      const savedMs = cutMs > 0 ? measured || cutMs : 0;
      let state;
      if (!isTrimmableName(episode.filename)) state = 'untouched';
      else if (stretches.some((stretch) => stretch.state === 'waiting')) state = 'waiting';
      else if (episode.publish_hold && !(episode.publish_hold === PUBLISH_HOLDS.TRIMMING && cutMs > 0)) {
        state =
          engineState() === 'ready' && transcriber?.needsTranscript?.(episode, cuts.show) ? 'listening' : 'held';
      } else if (cutMs > 0) state = 'cut';
      else if (cuts.looked.has(episode.id)) state = 'clean';
      else state = 'untouched';
      const words = EPISODE_STATES[state];
      return {
        state,
        pill: state === 'cut' ? `cut ${formatClock(savedMs)}` : words.pill,
        caption: state === 'cut' ? `Cut ${formatClock(savedMs)}.` : words.caption,
        savedMs,
        waiting: stretches.filter((stretch) => stretch.state === 'waiting').length,
      };
    },

    /** Every episode's pill for a show, keyed by episode id. Empty when the feature is off. */
    cutSummaries(showId, cuts = null) {
      const show = cuts?.show ?? shows.get(showId);
      const summaries = new Map();
      if (!show) return summaries;
      const data = cuts ?? api.showCuts(show);
      if (data.off) return summaries;
      for (const episode of episodes.listByShow(show.id)) {
        const state = api.episodeState(episode, api.stretchesOf(episode, data), data);
        if (state) summaries.set(episode.id, { ...state, url: `/shows/${encodeURIComponent(show.slug)}/adverts#ep-${episode.id}` });
      }
      return summaries;
    },

    /** One line for the dashboard card: "27 min of adverts cut", "2 waiting", or nothing. */
    showCaption(show) {
      const summaries = [...api.cutSummaries(show.id).values()];
      if (!summaries.length) return null;
      const waiting = summaries.filter((row) => row.state === 'waiting').length;
      if (waiting) return `${waiting} waiting`;
      const saved = summaries.reduce((sum, row) => sum + (row.state === 'cut' ? row.savedMs : 0), 0);
      return saved > 0 ? `${Math.max(1, Math.round(saved / 60000))} min of adverts cut` : null;
    },

    /** One episode as the bar and its stretches. */
    episodeBar(episode, cuts) {
      const stretches = api.stretchesOf(episode, cuts);
      const state = api.episodeState(episode, stretches, cuts);
      const before = episode.duration_seconds ?? null;
      const after = episode.trimmed_filename ? episode.trimmed_duration_seconds ?? null : before;
      return {
        id: episode.id,
        title: episode.title,
        url: `/shows/${encodeURIComponent(cuts.show.slug)}/episodes/${encodeURIComponent(episode.id)}`,
        durationMs: (before ?? 0) * 1000,
        lengthsLabel:
          before === null
            ? null
            : `${formatClock(before * 1000)} on your share · published ${formatClock((after ?? before) * 1000)}`,
        state,
        stretches,
        // Kept stretches are not drawn: nothing happens to them.
        audioUrl: `/api/episodes/${encodeURIComponent(episode.id)}/audio?copy=original`,
      };
    },

    /** One page of the timeline, newest first. `before` is the cursor the last page ended on. */
    timeline(show, { before = null, cuts = null } = {}) {
      const data = cuts ?? api.showCuts(show);
      const cursorOf = (episode) => `${episode.pub_date ?? ''}|${episode.id}`;
      const all = episodes
        .listByShow(show.id)
        .filter((episode) => episode.status === 'active' || episode.status === 'missing')
        .sort((a, b) => (cursorOf(a) < cursorOf(b) ? 1 : cursorOf(a) > cursorOf(b) ? -1 : 0));
      const from = before ? all.filter((episode) => cursorOf(episode) < String(before)) : all;
      const page = from.slice(0, TIMELINE_PAGE_SIZE);
      return {
        episodes: page.map((episode) => api.episodeBar(episode, data)),
        nextBefore: from.length > page.length ? cursorOf(page[page.length - 1]) : null,
        total: all.length,
      };
    },

    /** The rules card: what SelfPod cuts, and what it has been told to keep. */
    rules(show, cuts) {
      const data = cuts ?? api.showCuts(show);
      const slug = encodeURIComponent(show.slug);
      const listened = transcriber?.progress?.(show.id)?.done ?? 0;
      const mp3 = episodes.listByShow(show.id).filter((episode) => isTrimmableName(episode.filename)).length;
      const heardOf = listened || mp3;
      const segments = [...data.segments.values()];
      const rows = [];

      for (const marker of data.markers.values()) {
        const segment = segments.find((row) => row.marker_id === marker.id || row.signature === `marker:${marker.id}`);
        const ends = marker.role === 'programme_ends';
        rows.push({
          key: `marker:${marker.id}`,
          kind: SEGMENT_KINDS.BOUNDARY_WORDS,
          title: `“${marker.raw_text}”`,
          detail: `${ends ? (marker.inclusive ? 'The programme ends, and these words go too' : 'The programme ends after it says this') : 'The programme starts when it says this'} · heard in ${segment?.episode_count ?? 0} of ${heardOf}`,
          actions: [{ label: DECISIONS.forget, url: `/ui/shows/${slug}/ad-markers/${encodeURIComponent(marker.id)}/remove` }],
        });
      }

      const anchor = currentAnchorFor(show.id);
      if (anchor) {
        const summary = adDetect.anchorSummary(anchor.id);
        const base = `/ui/shows/${slug}/ad-anchors/${encodeURIComponent(anchor.id)}`;
        rows.push({
          key: `anchor:${anchor.id}`,
          kind: SEGMENT_KINDS.JINGLE,
          offered: !anchor.confirmed_at,
          title: anchor.confirmed_at ? 'The station jingle' : 'Is this the station jingle?',
          detail: anchor.confirmed_at
            ? `Everything before it is cut · heard in ${summary.heard} of ${summary.total}${anchor.auto_confirmed ? ' · cut automatically' : ''}`
            : 'The same few seconds near the start of every episode. Remove cuts whatever comes before it, every day; Keep leaves it alone.',
          sampleUrl: anchor.exemplar_episode_id ? `/api/ad-anchors/${encodeURIComponent(anchor.id)}/sample.mp3?context=2` : null,
          actions: anchor.confirmed_at
            ? [{ label: DECISIONS.forget, url: `${base}/remove` }]
            : [
                { label: DECISIONS.remove, url: `${base}/confirm`, primary: true },
                { label: DECISIONS.keep, url: `${base}/dismiss` },
              ],
        });
      }

      const kept = [];
      for (const segment of segments) {
        if (segment.kind === SEGMENT_KINDS.BOUNDARY_WORDS || segment.kind === SEGMENT_KINDS.JINGLE) continue;
        if (segment.status === SEGMENT_STATUS.CANDIDATE) continue;
        const count = new Set((segment.occurrences ?? []).map((row) => row.episode_id)).size;
        const words = segment.raw_text ? `“${segment.raw_text.length > 120 ? `${segment.raw_text.slice(0, 118)}…` : segment.raw_text}”` : null;
        const forget = { label: DECISIONS.forget, url: `/ui/shows/${slug}/segments/${encodeURIComponent(segment.id)}/forget` };
        if (segment.status === SEGMENT_STATUS.REJECTED) {
          kept.push({
            key: segment.id,
            kind: segment.kind,
            title: words ?? `${formatClock(segment.duration_ms)} of sound`,
            detail: `in ${plural(count, 'episode')}`,
            actions: [
              { label: DECISIONS.remove, url: `/ui/shows/${slug}/ad-segments/${encodeURIComponent(segment.id)}`, name: 'status', value: SEGMENT_STATUS.APPROVED },
              forget,
            ],
          });
          continue;
        }
        const label =
          segment.kind === SEGMENT_KINDS.TAUGHT_RANGE
            ? `${formatClock(segment.duration_ms)} you marked as an advert`
            : segment.kind === SEGMENT_KINDS.DIFF
              ? `${formatClock(segment.duration_ms)} inserted by the host`
              : words ?? `${formatClock(segment.duration_ms)} of repeated sound`;
        rows.push({
          key: segment.id,
          kind: segment.kind,
          title: label,
          detail: `${segment.auto_approved ? 'Cut automatically' : segment.kind === SEGMENT_KINDS.TAUGHT_RANGE ? 'Cut' : 'An advert you removed'} · in ${plural(count, 'episode')}`,
          actions: [forget],
        });
      }
      return { rows, kept };
    },

    /** The whole Adverts panel. `owed` is `adPipeline.workOwed(show.id)`. */
    async panel(show, { owed = null, before = null } = {}) {
      const context = await api.segmentsContext(show);
      const cuts = api.showCuts(show);
      const summaries = api.cutSummaries(show.id, cuts);
      const all = [...summaries.values()];
      const counts = episodes.counts(show.id);
      const anyStretch = [...cuts.occurrences.values()].some((rows) =>
        rows.some((row) => cuts.segments.get(row.segment_id)?.status !== SEGMENT_STATUS.REJECTED),
      );
      const rules = api.rules(show, cuts);
      const nothing = !anyStretch && !rules.rows.length;
      return {
        ...context,
        off: cuts.off,
        offSentence: 'SelfPod is not looking for adverts in this show. Your episodes are published exactly as they arrive.',
        workHtml: workStripHtml(show, owed),
        totals: [
          { label: 'Episodes cut', value: String(all.filter((row) => row.savedMs > 0).length) },
          { label: 'Minutes removed', value: String(Math.round(all.reduce((sum, row) => sum + row.savedMs, 0) / 60000)) },
          { label: 'Waiting', value: String(all.filter((row) => row.state === 'waiting').length) },
          { label: 'Held', value: String(counts.held) },
        ],
        heldSentence: counts.held
          ? `${plural(counts.held, 'episode')} ${counts.held === 1 ? 'is' : 'are'} not in your feed yet: ${all.some((row) => row.state === 'waiting') ? 'they go out once you have decided about what is waiting.' : context.listening?.pending ? 'SelfPod is still listening to them.' : 'SelfPod needs a few more episodes to compare first.'}`
          : null,
        engineSentence:
          !cuts.off && (context.listening?.engine === 'missing' || context.listening?.engine === 'failing')
            ? "SelfPod cannot read the words in this show's episodes, so it compares them by sound only."
            : null,
        failedSentence:
          !cuts.off && context.listening?.failed > 0
            ? `${plural(context.listening.failed, 'episode')} could not be listened to, and ${context.listening.failed === 1 ? 'is' : 'are'} published as ${context.listening.failed === 1 ? 'it' : 'they'} arrived.`
            : null,
        emptySentence: cuts.off || !nothing
          ? null
          : context.lookedAndFoundNothing
            ? `Looked at ${plural(context.comparableEpisodes, 'episode')} and found nothing to cut.`
            : 'Nothing to cut yet — SelfPod needs a few episodes to compare.',
        rules,
        timeline: cuts.off ? { episodes: [], nextBefore: null, total: 0 } : api.timeline(show, { cuts, before }),
      };
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
