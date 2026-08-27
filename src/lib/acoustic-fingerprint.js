/**
 * Fingerprinting what an episode *sounds* like, rather than what its bytes are (spec §19.3).
 *
 * ## Why this exists at all
 *
 * SelfPod's first attempt at finding repeated audio hashed MP3 frames and compared them
 * exactly. That was built on the belief that a producer dropping the same audio into an
 * edit yields the same encoded frames. It does not. A programme is normally mastered
 * and encoded in one pass, so the same theme tune is encoded afresh in every episode —
 * the same sound arriving as different data.
 *
 * Measured on three real Planet Money episodes, same encoder, same 128 kbit/s, same
 * 44.1 kHz: **nine matching frames out of ninety thousand**. Two of those episodes open
 * with audio that correlates at r = 0.988 — as near identical as recordings get — and
 * share eighteen frames before diverging. Exact matching cannot see that, and no number
 * of further episodes would change it.
 *
 * ## What replaces it
 *
 * The Haitsma–Kalker scheme, which is the standard answer and is nearly twenty-five
 * years old. Take the energy in 33 logarithmically spaced bands between 300 Hz and
 * 2 kHz, and emit one bit per band pair for whether that pair's energy difference rose
 * or fell since the previous frame. Thirty-two bits every 11.6 ms.
 *
 * The detail that makes it work, and the one an implementation gets wrong: the bit is
 * the **sign of a difference of differences**, never an energy. Loudness normalisation
 * multiplies every band by the same factor and moves no sign; re-encoding at a
 * different bitrate perturbs energies and moves few. Hashing band energies directly
 * would be defeated by the volume control, which is the first thing any ad network
 * applies.
 *
 * Two fingerprints are compared by how many bits differ. Identical audio scores near
 * zero; unrelated audio scores near a half, because unrelated bits agree half the time.
 * Measured on the episodes above: **0.085 against 0.51**. That gap is the feature.
 */

const RATE = 5512;
const FRAME = 2048;
/** 11.6 ms between sub-fingerprints, which is the resolution a cut can be placed at. */
export const HOP = 64;
const BANDS = 33;
const LOW_HZ = 300;
const HIGH_HZ = 2000;

/**
 * The band a fingerprint stops caring about.
 *
 * Speech and music both carry their structure between 300 Hz and 2 kHz. Below that is
 * rumble and room; above it is mostly what a codec throws away first, so including it
 * would make a fingerprint depend on the bitrate it was encoded at — which is the one
 * thing it must not do.
 */
function bandEdges() {
  const edges = new Int32Array(BANDS + 1);
  for (let i = 0; i <= BANDS; i += 1) {
    edges[i] = Math.round((LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / BANDS) * FRAME) / RATE);
  }
  return edges;
}

const EDGES = bandEdges();
const WINDOW = (() => {
  const w = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  return w;
})();

/** In-place radix-2 FFT. Written out rather than added as a dependency: it is 20 lines. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/**
 * Turns a stream of 5512 Hz mono samples into sub-fingerprints, a chunk at a time.
 *
 * Incremental because an episode is an hour of audio and there is no reason for all of
 * it to exist at once: the decoder hands over a few seconds, this consumes them, and
 * what is kept is one analysis window plus the running output — about 1.2 MB an hour,
 * against the 800 MB the same episode would occupy as float PCM.
 */
export function createFingerprinter() {
  // One analysis window's worth of samples, plus whatever has not filled one yet.
  let pending = new Float64Array(0);
  let previous = null;
  const out = [];
  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);

  function bandEnergies(at, samples) {
    for (let i = 0; i < FRAME; i += 1) {
      re[i] = samples[at + i] * WINDOW[i];
      im[i] = 0;
    }
    fft(re, im);
    const energies = new Float64Array(BANDS);
    for (let b = 0; b < BANDS; b += 1) {
      let sum = 0;
      for (let k = EDGES[b]; k < EDGES[b + 1]; k += 1) sum += re[k] * re[k] + im[k] * im[k];
      energies[b] = sum;
    }
    return energies;
  }

  return {
    /** @param {Float32Array|Float64Array} samples mono, 5512 Hz */
    push(samples) {
      const buffer = new Float64Array(pending.length + samples.length);
      buffer.set(pending);
      /*
       * Anything that is not a number becomes silence, here rather than at the decoder.
       *
       * This is the one place samples turn into bits, so it is the place the invariant
       * belongs — every caller is covered by it and none has to remember. And it is a
       * correctness fix rather than a habit: a damaged or hostile MP3 can decode to
       * NaN, every comparison with NaN is false, so an unguarded fingerprint of it is a
       * run of zero bits. Two unrelated damaged files would then agree perfectly, and
       * SelfPod would offer to cut the agreement out of both.
       */
      for (let i = 0; i < samples.length; i += 1) {
        const value = samples[i];
        buffer[pending.length + i] = Number.isFinite(value) ? value : 0;
      }

      let at = 0;
      while (at + FRAME <= buffer.length) {
        const energies = bandEnergies(at, buffer);
        if (previous) {
          let bits = 0;
          for (let m = 0; m < 32; m += 1) {
            const now = energies[m] - energies[m + 1];
            const before = previous[m] - previous[m + 1];
            bits = ((bits << 1) | (now - before > 0 ? 1 : 0)) >>> 0;
          }
          out.push(bits >>> 0);
        }
        previous = energies;
        at += HOP;
      }
      pending = buffer.slice(at);
    },

    finish() {
      return Uint32Array.from(out);
    },
  };
}

/** Bits set in a 32-bit word. */
export function popcount(value) {
  let x = value | 0;
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (Math.imul(x, 0x01010101) >> 24) & 0xff;
}

/**
 * The proportion of bits that differ between two stretches of fingerprint.
 *
 * Zero means the same audio; a half means unrelated audio, because unrelated bits agree
 * half the time by chance. Everything this module decides is a threshold on this number.
 */
export function bitErrorRate(a, b, aAt, bAt, length) {
  let wrong = 0;
  for (let i = 0; i < length; i += 1) wrong += popcount((a[aAt + i] ^ b[bAt + i]) >>> 0);
  return wrong / (length * 32);
}
