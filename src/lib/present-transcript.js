import { HOLD_REASONS } from '../constants.js';
import { describeCues } from './advert-cues.js';
import { normaliseWord } from './text-normalise.js';

/**
 * How what SelfPod heard is described to the person deciding about it (spec §19.6).
 *
 * Every candidate found by the words carries three things a person can act on: the
 * words themselves, with the proposed cut marked in them; the cues that made them
 * sound like an advert; and one sentence saying what SelfPod is going to do and why.
 * Shared by the JSON API and the templates, as present-segment.js is, so the two
 * cannot tell different stories.
 */

/** Words either side of a cut shown for context. */
const CONTEXT_MS = 4000;
/** Below this mean confidence the recogniser was guessing, and so would SelfPod be. */
export const LOW_CONFIDENCE = 0.45;

export function formatClock(ms) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function formatDay(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

/** Every word of a stored transcript in order, each knowing which window it came from. */
export function flattenTranscript(transcript) {
  const words = [];
  if (!transcript) return words;
  transcript.windows.forEach((window, index) => {
    for (const sentence of window.sentences) {
      for (const word of sentence.words) words.push({ ...word, window: index });
    }
  });
  return words;
}

/** The regions of a transcript for the episode page: opening, closing, or the whole thing. */
export function regionsOf(transcript) {
  if (!transcript) return [];
  return transcript.windows.map((window, index) => ({
    index,
    key: window.kind,
    label:
      window.kind === 'head'
        ? `Opening — first ${formatClock(window.toMs)}`
        : window.kind === 'tail'
          ? `Closing — last ${formatClock(window.toMs - window.fromMs)}`
          : 'The whole episode',
    fromMs: window.fromMs,
    toMs: window.toMs,
    language: window.language ?? transcript.language ?? null,
  }));
}

/**
 * Marks the words of a cue in a run of words, by matching the cue's phrase rather
 * than trusting an index into a transcript that may since have been remade.
 */
function markCues(words, cues) {
  const marks = new Map();
  const tokens = words.map((word) => normaliseWord(word.w).join(' '));
  for (const cue of cues ?? []) {
    if (cue.id === 'web_address' || cue.id === 'price' || cue.id === 'phone_number') {
      words.forEach((word, i) => {
        if (cue.phrase && word.w.toLowerCase().includes(String(cue.phrase).toLowerCase().split(/\s+/)[0])) marks.set(i, cue.id);
      });
      continue;
    }
    const phrase = String(cue.phrase).split(' ');
    for (let i = 0; i + phrase.length <= tokens.length; i += 1) {
      let ok = true;
      for (let k = 0; k < phrase.length; k += 1) {
        if (tokens[i + k] !== phrase[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        for (let k = 0; k < phrase.length; k += 1) marks.set(i + k, cue.id);
        break;
      }
    }
  }
  return marks;
}

/**
 * The words around a cut, with each word's part in it.
 *
 * @param {Array<object>} words the episode's flattened words
 * @param {{startMs: number, endMs: number}} cut
 * @param {{cues?: Array<object>}} [options]
 */
export function presentExcerpt(words, cut, { cues = [] } = {}) {
  const inRange = [];
  words.forEach((word, index) => {
    if (word.e < cut.startMs - CONTEXT_MS || word.s > cut.endMs + CONTEXT_MS) return;
    inRange.push({ index, word });
  });
  if (!inRange.length) return null;
  const marks = markCues(inRange.map((entry) => entry.word), cues);
  let cutStart = null;
  let cutEnd = null;
  const out = inRange.map(({ index, word }, position) => {
    const middle = (word.s + word.e) / 2;
    const inCut = middle >= cut.startMs && middle <= cut.endMs;
    if (inCut) {
      if (cutStart === null) cutStart = index;
      cutEnd = index;
    }
    return {
      i: index,
      t: word.w,
      startMs: word.s,
      endMs: word.e,
      role: inCut ? 'cut' : 'context',
      cue: marks.get(position) ?? null,
      low: (word.p ?? 1) < LOW_CONFIDENCE,
    };
  });
  return {
    words: out,
    cutStartWord: cutStart ?? inRange[0].index,
    cutEndWord: cutEnd ?? inRange[inRange.length - 1].index,
    firstWord: inRange[0].index,
    lastWord: inRange[inRange.length - 1].index,
  };
}

/** "the same words open every episode" / "the same words appear in 4 episodes". */
function repetitionPhrase(segment, positionLabel) {
  const count = segment.episode_count ?? 0;
  if (positionLabel === 'At the very start of every episode') return `the same words open ${count === 1 ? 'the episode' : `all ${count} episodes`}`;
  if (positionLabel === 'At the very end of every episode') return `the same words close ${count === 1 ? 'the episode' : `all ${count} episodes`}`;
  return `the same words appear in ${count} ${count === 1 ? 'episode' : 'episodes'}`;
}

/**
 * One sentence: what SelfPod is going to do about a segment found by the words, and
 * why. The keys are stable so the API can be tested on them; the sentences are for
 * people.
 *
 * @returns {{verdict: 'will_cut'|'asking'|'will_leave', key: string, sentence: string, offerMarker: boolean}}
 */
export function describeVerdict(segment, { mode = 'review', positionLabel = null, confidence = null, occurrences = [] } = {}) {
  const cues = parseCues(segment.cues);
  const said = describeCues(cues);
  const strong = (segment.cue_score ?? 0) >= 0.5;
  const decided = formatDay(segment.decided_at);
  const isMarker = String(segment.signature ?? '').startsWith('marker:');

  if (isMarker) {
    const ends = segment.marker_role === 'programme_ends';
    return {
      verdict: 'will_cut',
      key: 'boundary',
      sentence: ends
        ? segment.marker_inclusive
          ? `Everything from “${segment.raw_text}” to the end is cut, as you asked.`
          : `Everything after “${segment.raw_text}” is cut, as you asked.`
        : `Everything before “${segment.raw_text}” is cut, as you asked.`,
      offerMarker: false,
    };
  }
  if (segment.status === 'approved') {
    if (segment.auto_approved) {
      return {
        verdict: 'will_cut',
        key: 'strong_cues_repeats',
        sentence: `SelfPod cuts this on its own: it ${said || 'sounds like a sponsor read'}, and ${repetitionPhrase(segment, positionLabel)}.`,
        offerMarker: false,
      };
    }
    return {
      verdict: 'will_cut',
      key: 'remembered_advert',
      sentence: `SelfPod cuts this on its own${decided ? `: you removed it on ${decided}` : ', because you removed it'}, and it cuts the same words from every later episode without asking.`,
      offerMarker: false,
    };
  }
  if (segment.status === 'rejected') {
    return {
      verdict: 'will_leave',
      key: 'remembered_not_advert',
      sentence: `SelfPod leaves this in${decided ? `: you kept it on ${decided}` : ''}, and will not offer the same words again.`,
      offerMarker: false,
    };
  }
  if (confidence !== null && confidence < LOW_CONFIDENCE) {
    return {
      verdict: 'asking',
      key: 'low_confidence',
      sentence: 'SelfPod is not sure it heard these words correctly, so it will not act on them alone.',
      offerMarker: false,
    };
  }
  if (segment.hold_reason === 'only_heard_once') {
    return {
      verdict: 'asking',
      key: 'cues_but_once',
      sentence: `It sounds like a sponsor read — it ${said || 'has the shape of one'} — but SelfPod has only heard it once. It is asking rather than guessing.`,
      offerMarker: false,
    };
  }
  if (!strong) {
    // Near the start of every episode — at 0:00 in some and behind a pre-roll in
    // others is exactly the shape of a jingle worth teaching as the boundary.
    // The end first: on a short episode the closing tag also sits within the first
    // minute and a half, and it is the end that it belongs to.
    const atEnd = positionLabel === 'At the very end of every episode';
    const starts = occurrences.map((row) => row.start_ms ?? row.startMs ?? 0);
    const nearStart =
      !atEnd &&
      (positionLabel === 'At the very start of every episode' ||
        (starts.length > 0 && Math.max(...starts) < 90_000));
    const offer = nearStart
      ? '. If this is where the programme starts, say so and SelfPod will cut everything before it, whatever it is'
      : atEnd
        ? '. If this is where the adverts start, say so and SelfPod will cut from these words to the end, whatever follows them'
        : '';
    return {
      verdict: 'asking',
      key: 'repeats_no_cues',
      sentence: `${capitalise(repetitionPhrase(segment, positionLabel))}, but nothing in them sounds like a sponsor read. That is usually the host's standing ${atEnd ? 'sign-off' : 'intro'}${offer}.`,
      offerMarker: nearStart ? 'programme_starts' : atEnd ? 'tail_starts' : false,
    };
  }
  if (segment.hold_reason) {
    return {
      verdict: 'asking',
      key: 'held',
      sentence: `This sounds like a sponsor read — it ${said} — but SelfPod will not cut it on its own: ${lowerFirst(HOLD_REASONS[segment.hold_reason] ?? segment.hold_reason)}`,
      offerMarker: false,
    };
  }
  if (mode === 'auto') {
    return {
      verdict: 'will_cut',
      key: 'strong_cues_repeats',
      sentence: `SelfPod will cut this on its own: it ${said}, and ${repetitionPhrase(segment, positionLabel)}.`,
      offerMarker: false,
    };
  }
  return {
    verdict: 'asking',
    key: 'strong_cues_review',
    sentence: `This sounds like a sponsor read — it ${said} — but you asked to decide first. Remove it once and SelfPod cuts the same read from later episodes without asking.`,
    offerMarker: false,
  };
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function parseCues(cues) {
  if (!cues) return [];
  if (Array.isArray(cues)) return cues;
  try {
    const parsed = JSON.parse(cues);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * What the ledger says about an episode, from the words' point of view.
 *
 * @param {{episode: object, show: object, row: object|null, spoken: Array<object>, markers: Array<object>, pending: boolean, engineMissing: boolean}} input
 * @returns {{stage: string, sentence: string, at?: string, segmentId?: string, reversible?: boolean}|null}
 */
export function describeAdvertStage({ episode, show, row, spoken, markers, pending, engineMissing, listenLabel }) {
  if (!show || !show.ad_trim_mode || show.ad_trim_mode === 'off') return null;
  const isMp3 = /\.mp3$/i.test(episode.filename ?? '');
  if (!isMp3) {
    const extension = (episode.filename ?? '').slice((episode.filename ?? '').lastIndexOf('.'));
    return {
      stage: 'unsupported',
      sentence: `Not listened to — SelfPod can only read MP3 episodes and this one is ${extension || 'something else'}. Published as it arrived.`,
    };
  }
  if (show.ad_transcribe === 'off') return null;
  if (row?.status === 'failed' && row.attempts >= 3) {
    return {
      stage: 'failed',
      sentence:
        row.failure === 'timeout'
          ? 'SelfPod gave up listening to this one three times over — published as it arrived. A sponsor read in it will not be caught.'
          : 'SelfPod could not read the words in this one — published as it arrived. A sponsor read in it will not be caught.',
    };
  }
  if (!row || row.status !== 'ok') {
    if (engineMissing) {
      return { stage: 'failed', sentence: 'Transcription is not available on this machine — published as it arrived.' };
    }
    if (pending) return { stage: 'listening', sentence: `Listening to ${listenLabel}…` };
    return null;
  }
  const cut = spoken.filter((entry) => entry.status === 'approved');
  const waiting = spoken.filter((entry) => entry.status === 'candidate');
  const boundary = cut.find((entry) => String(entry.signature).startsWith('marker:'));
  if (boundary) {
    const atStart = boundary.start_ms === 0;
    const sentence = atStart
      ? `Cut the ${formatClock(boundary.end_ms)} before “${boundary.raw_text}”, as you asked.`
      : boundary.marker_inclusive
        ? `Cut everything from ${formatClock(boundary.start_ms)} — “${boundary.raw_text}” and what follows it — as you asked.`
        : `Cut everything from ${formatClock(boundary.start_ms)}, after “${boundary.raw_text}”, as you asked.`;
    return {
      stage: atStart ? 'cut_before_marker' : 'cut_after_marker',
      sentence,
      at: `${formatClock(boundary.start_ms)}–${formatClock(boundary.end_ms)}`,
      segmentId: boundary.id,
    };
  }
  if (cut.length) {
    const first = cut[0];
    const at = `${formatClock(first.start_ms)}–${formatClock(first.end_ms)}`;
    if (first.auto_approved) {
      const said = describeCues(parseCues(first.cues));
      return {
        stage: 'cut_by_cues',
        sentence: `Cut ${at} automatically: it ${said || 'sounds like a sponsor read'}, and the same words appear in ${first.episode_count} episodes.`,
        at,
        segmentId: first.id,
        reversible: true,
      };
    }
    const decided = formatDay(first.decided_at);
    return {
      stage: 'cut_remembered',
      sentence: `Cut ${at} automatically, because you removed the same read${decided ? ` on ${decided}` : ' before'}.`,
      at,
      segmentId: first.id,
      reversible: true,
    };
  }
  if (waiting.length) {
    const first = waiting[0];
    const at = `${formatClock(first.start_ms)}–${formatClock(first.end_ms)}`;
    const said = describeCues(parseCues(first.cues));
    return {
      stage: 'heard_waiting',
      sentence: `Heard something at ${at} that ${said || 'repeats across episodes'}, waiting for you.`,
      at,
      segmentId: first.id,
    };
  }
  const missing = markers.find((marker) => marker.role === 'programme_starts');
  if (missing) {
    return {
      stage: 'marker_missing',
      sentence: `Could not hear “${missing.raw_text}” in ${listenLabel} — published as it arrived.`,
    };
  }
  return { stage: 'heard_nothing', sentence: `Listened to ${listenLabel}; heard no sponsor read. Published as it arrived.` };
}

/** "the first 5 min and last 4 min" / "the whole episode". */
export function describeListenScope(show) {
  const mode = show?.ad_transcribe ?? 'edges';
  if (mode === 'whole') return 'the whole episode';
  const head = Math.round((show?.ad_transcribe_head_seconds ?? 300) / 60);
  const tail = Math.round((show?.ad_transcribe_tail_seconds ?? 240) / 60);
  if (head && tail) return `the first ${head} min and last ${tail} min`;
  if (head) return `the first ${head} min`;
  if (tail) return `the last ${tail} min`;
  return 'nothing';
}
