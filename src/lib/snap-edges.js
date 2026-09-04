/**
 * Putting a cut on a pause rather than in the middle of a word (spec §19.6).
 *
 * A speech recogniser places a word to within a few hundred milliseconds, which is fine
 * for reading and wrong for cutting: a cut a fifth of a second early clips the last
 * syllable of the programme, and one a fifth late leaves the first syllable of the
 * advert. The loudness envelope of the same audio knows where the pauses are. So each
 * edge the words propose is moved to the quietest moment nearby, and only then biased
 * outwards and rounded to a frame.
 *
 * The envelope is one byte every ten milliseconds — 0 for silence, 255 for full scale,
 * linear in decibels between — computed while the audio was decoded for transcription
 * and stored with the transcript, so this never decodes anything.
 */

/** Decibels per envelope unit: 80 dB of range across 255 steps. */
const DB_PER_UNIT = 80 / 255;

/** How far from the local minimum still counts as "the pause" — 3 dB, about a third. */
const TOLERANCE_UNITS = Math.round(3 / DB_PER_UNIT);

/**
 * @param {number} edgeMs the edge the words propose, in episode milliseconds
 * @param {Uint8Array|null} envelope
 * @param {{fromMs: number, hopMs?: number, searchMs?: number, smoothHops?: number}} options
 *   `fromMs` is the episode time of `envelope[0]`
 * @returns {number} the edge to cut at, in episode milliseconds
 */
export function snapToDip(
  edgeMs,
  envelope,
  { fromMs = 0, hopMs = 10, searchMs = 600, smoothHops = 5, direction = 'both' } = {},
) {
  if (!envelope?.length) return edgeMs;
  const centre = Math.round((edgeMs - fromMs) / hopMs);
  const reach = Math.round(searchMs / hopMs);
  // `direction` limits the search to one side: the end of a pre-roll may move
  // earlier onto the pause before the programme's first word, never later into it.
  const lo = Math.max(0, direction === 'after' ? centre : centre - reach);
  const hi = Math.min(envelope.length - 1, direction === 'before' ? centre : centre + reach);
  if (lo > hi) return edgeMs;

  // Each hop takes the loudest of its neighbours, so a single quiet sample inside a
  // word does not pass for a pause: a pause has to last `smoothHops` to register at
  // full depth, and its edges are pulled in by half that.
  const half = Math.floor(smoothHops / 2);
  const smoothed = new Uint8Array(hi - lo + 1);
  let floor = 255;
  for (let k = lo; k <= hi; k += 1) {
    let value = 0;
    for (let m = Math.max(0, k - half); m <= Math.min(envelope.length - 1, k + half); m += 1) {
      value = Math.max(value, envelope[m]);
    }
    smoothed[k - lo] = value;
    floor = Math.min(floor, value);
  }

  // The quiet moment nearest the proposed edge, among all moments within a few
  // decibels of the quietest. Nearest rather than quietest, so a long pause a few
  // hundred milliseconds away does not drag the cut away from a shorter one right here.
  let best = centre;
  let bestDistance = Infinity;
  for (let k = lo; k <= hi; k += 1) {
    if (smoothed[k - lo] > floor + TOLERANCE_UNITS) continue;
    const distance = Math.abs(k - centre);
    if (distance < bestDistance) {
      best = k;
      bestDistance = distance;
    }
  }
  return fromMs + best * hopMs;
}

/**
 * Builds an envelope from the samples as they are decoded.
 *
 * @param {number} sampleRate
 * @param {{hopMs?: number}} [options]
 */
export function createEnvelopeBuilder(sampleRate, { hopMs = 10 } = {}) {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const values = [];
  let sum = 0;
  let count = 0;

  function flush() {
    const rms = Math.sqrt(sum / Math.max(1, count));
    const db = 20 * Math.log10(Math.max(rms, 1e-5));
    values.push(Math.max(0, Math.min(255, Math.round((db + 80) / DB_PER_UNIT))));
    sum = 0;
    count = 0;
  }

  return {
    push(samples) {
      for (let i = 0; i < samples.length; i += 1) {
        const sample = samples[i];
        if (Number.isFinite(sample)) sum += sample * sample;
        count += 1;
        if (count === hop) flush();
      }
    },
    finish() {
      if (count) flush();
      return Uint8Array.from(values);
    },
    hopMs,
  };
}

export function encodeEnvelope(envelope) {
  return Buffer.from(envelope).toString('base64');
}

export function decodeEnvelope(text) {
  if (!text) return null;
  return new Uint8Array(Buffer.from(text, 'base64'));
}
