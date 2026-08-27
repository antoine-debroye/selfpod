import { MPEGDecoder } from 'mpg123-decoder';

/**
 * Decoding an MP3 to the low-rate mono signal a fingerprint needs (spec §19.3).
 *
 * ## Why there is a decoder here at all
 *
 * Everything else SelfPod does with audio is byte work — reading frame headers, joining
 * frames, cutting between them — and that is deliberate: it is why cutting an hour-long
 * episode takes a thirtieth of a second and why no codec library is in the container.
 * Finding a theme tune that was *re-encoded* rather than copied cannot be done that
 * way. The same sound arrives as different data, so the only thing left to compare is
 * the sound, and hearing it means decoding it.
 *
 * ## Why this is not the ffmpeg decision again
 *
 * The case against bundling ffmpeg was four things: GPL, which propagates; a full
 * H.264/H.265/AV1/VP9 decoder stack inside an image fed files chosen by strangers;
 * eighty megabytes; and a subprocess. None of them applies here. This is an MP3 decoder
 * and nothing else, it is about eighty kilobytes of WebAssembly, it runs in-process
 * inside the Wasm sandbox rather than as a child process, and it is LGPL-2.1 rather
 * than GPL — used through its published interface, replaceable by anyone who wants a
 * different build, and recorded in THIRD-PARTY-LICENSES with the image label saying so.
 * That obligation is real and small; the earlier one was real and large.
 *
 * ## Memory
 *
 * The whole point of the shape below. Asking the decoder for an entire episode at once
 * returns float PCM at the source rate — about 860 MB for forty minutes of stereo,
 * which on a two-gigabyte NAS is not a slowdown but an ending. Frames go in a batch at
 * a time and come back out immediately as mono at 5512 Hz, which is fourteen thousand
 * times less data per second than it arrived as, and even that is consumed rather than
 * kept. Peak is a few megabytes whatever the episode's length.
 */

/** What the fingerprint wants. Everything below is in service of producing exactly this. */
export const TARGET_RATE = 5512;

/** Frames handed to the decoder at once — a couple of seconds of audio. */
const BATCH_FRAMES = 96;

/**
 * Decodes an MP3 and hands the caller mono 5512 Hz samples in chunks.
 *
 * @param {Buffer} buffer the whole file
 * @param {Array<{offset: number, length: number}>} frames from `readFrames`
 * @param {(samples: Float64Array) => void} onSamples called with each chunk, in order
 * @returns {Promise<{sampleRate: number, samples: number, errors: number}>}
 */
export async function decodeToMono(buffer, frames, onSamples) {
  const decoder = new MPEGDecoder();
  await decoder.ready;

  let sourceRate = 0;
  let produced = 0;
  let errors = 0;
  // Fractional read position, so resampling does not drift over an hour. Kept across
  // batches: restarting it per batch would round a hundred times a minute and shift
  // the fingerprint against itself.
  let position = 0;

  try {
    for (let at = 0; at < frames.length; at += BATCH_FRAMES) {
      const batch = [];
      for (const frame of frames.slice(at, at + BATCH_FRAMES)) {
        batch.push(new Uint8Array(buffer.buffer, buffer.byteOffset + frame.offset, frame.length));
      }
      const decoded = decoder.decodeFrames(batch);
      errors += decoded.errors?.length ?? 0;
      if (!decoded.samplesDecoded) continue;
      sourceRate ||= decoded.sampleRate;

      const [left, right] = decoded.channelData;
      const step = decoded.sampleRate / TARGET_RATE;
      const count = Math.floor((decoded.samplesDecoded - position) / step);
      if (count <= 0) {
        position -= decoded.samplesDecoded;
        continue;
      }

      const out = new Float64Array(count);
      for (let i = 0; i < count; i += 1) {
        // Nearest sample rather than an interpolating filter. The fingerprint reads
        // band energies between 300 Hz and 2 kHz, and the aliasing this admits lands
        // far above that — it is audible and irrelevant, which is the right trade for
        // work that happens on every episode.
        const source = Math.min(Math.round(position + i * step), decoded.samplesDecoded - 1);
        // A damaged file can decode to NaN. That is dealt with where samples become
        // bits — see createFingerprinter — rather than twice.
        out[i] = right ? (left[source] + right[source]) / 2 : left[source];
      }
      onSamples(out);
      produced += count;
      position = position + count * step - decoded.samplesDecoded;
    }
  } finally {
    decoder.free();
  }

  return { sampleRate: sourceRate || null, samples: produced, errors };
}
