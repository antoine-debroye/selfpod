import { createHash } from 'node:crypto';

import { createFingerprinter } from './acoustic-fingerprint.js';
import { decodeToMono } from './decode-audio.js';
import { frameProfile } from './mp3-frames.js';
import { openGatedFile } from './pipeline-file.js';
import { createEnvelopeBuilder } from './snap-edges.js';
import { openWavWriter } from './wav.js';

/**
 * The per-file audio work, written once and run in the worker (spec §19.3, §19.6).
 *
 * Decoding an MP3 is the single most expensive thing SelfPod does with a file, and it
 * is pure CPU: an hour of audio was twelve seconds of a fully blocked event loop on a
 * desktop, several times that on a NAS. On the main thread that meant every range
 * request in flight stalled, the SSE heartbeat stopped, and `/health` did not answer —
 * long enough for the container's own health check to give up and have it restarted
 * mid-pass. These functions are what the worker runs; `audio-search.js` dispatches to
 * them, and falls back to calling them inline if no worker can be started, so the
 * result is the same bytes either way — the only difference is which thread was busy.
 *
 * Every function here reads its file through `openGatedFile`, which checks the open
 * descriptor is an ordinary file of a size SelfPod is willing to hold, so a path
 * swapped between the pipeline's own check and this read is still refused.
 */

/** Reads `[start, end)` of an open file into a fresh buffer. */
async function readRange(handle, start, end) {
  const length = Math.max(0, end - start);
  const buffer = Buffer.allocUnsafe(length);
  let at = 0;
  while (at < length) {
    const { bytesRead } = await handle.read(buffer, at, length - at, start + at);
    if (!bytesRead) break; // shorter than its stat said: a file truncated under us
    at += bytesRead;
  }
  return at === length ? buffer : buffer.subarray(0, at);
}

/**
 * Reads an episode, hashes it, and fingerprints what it sounds like.
 *
 * `expectSha256` is the digest of the fingerprint already stored: when the bytes
 * still match it the decode is skipped and only the digest comes back, so a touched
 * but unchanged file costs one read and no CPU. Returned typed arrays are meant to be
 * transferred, not copied.
 */
export async function fingerprintFile({ path, maxBytes, expectSha256 = null }) {
  const { handle, size } = await openGatedFile(path, { maxBytes });
  let bytes;
  try {
    bytes = await readRange(handle, 0, size);
  } finally {
    await handle.close();
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectSha256 && sha256 === expectSha256) return { result: { sha256, bytes: bytes.length, unchanged: true } };

  const profile = frameProfile(bytes);
  if (!profile) return { result: { sha256, bytes: bytes.length, noFrames: true } };
  if (profile.truncated) return { result: { sha256, bytes: bytes.length, tooLong: true } };

  const fingerprinter = createFingerprinter();
  const decoded = await decodeToMono(bytes, profile.frames, (samples) => fingerprinter.push(samples));
  const hashes = fingerprinter.finish();

  return {
    result: {
      sha256,
      bytes: bytes.length,
      hashes,
      frameCount: profile.frameCount,
      durationMs: profile.durationMs,
      sampleRate: profile.sampleRate,
      samplesPerFrame: profile.frames[0]?.samplesPerFrame ?? 1152,
      decodeErrors: decoded.errors,
      discontinuities: profile.discontinuities.length,
    },
    transfer: [hashes.buffer],
  };
}

/**
 * Reads an episode once and describes its frames, for the transcriber.
 *
 * The frame table comes back as four typed arrays rather than an array of objects:
 * an hour is 137,000 frames, and a structured clone of that many objects costs more
 * than the walk that produced them. `framesFromTable` turns it back into the shape
 * `mp3-frames.js` works with, on the thread that needs it.
 */
export async function profileFile({ path, maxBytes }) {
  const { handle, size } = await openGatedFile(path, { maxBytes });
  let bytes;
  try {
    bytes = await readRange(handle, 0, size);
  } finally {
    await handle.close();
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const profile = frameProfile(bytes);
  if (!profile) return { result: { sha256, bytes: bytes.length, noFrames: true } };

  const count = profile.frames.length;
  const offsets = new Uint32Array(count);
  const lengths = new Uint16Array(count);
  const sampleRates = new Uint32Array(count);
  const samplesPerFrame = new Uint16Array(count);
  for (let i = 0; i < count; i += 1) {
    const frame = profile.frames[i];
    offsets[i] = frame.offset;
    lengths[i] = frame.length;
    sampleRates[i] = frame.sampleRate;
    samplesPerFrame[i] = frame.samplesPerFrame;
  }
  return {
    result: {
      sha256,
      bytes: bytes.length,
      frameCount: profile.frameCount,
      durationMs: profile.durationMs,
      sampleRate: profile.sampleRate,
      truncated: profile.truncated,
      table: { offsets, lengths, sampleRates, samplesPerFrame },
    },
    transfer: [offsets.buffer, lengths.buffer, sampleRates.buffer, samplesPerFrame.buffer],
  };
}

/** The frame objects `mp3-frames.js` reasons about, rebuilt from a transferred table. */
export function framesFromTable({ offsets, lengths, sampleRates, samplesPerFrame }) {
  const frames = new Array(offsets.length);
  for (let i = 0; i < offsets.length; i += 1) {
    frames[i] = { offset: offsets[i], length: lengths[i], sampleRate: sampleRates[i], samplesPerFrame: samplesPerFrame[i] };
  }
  return frames;
}

/**
 * Decodes one stretch of an episode to a 16-bit WAV file, for the recogniser.
 *
 * Only the bytes of the window are read — `start` to `end`, with `frames` relative
 * to `start` — so an hour-long episode is not held in memory for the minutes whisper
 * takes over its first five. The WAV is written here, a chunk at a time, rather than
 * returned: a whole-episode window is over a hundred megabytes of samples, and the
 * whole point of the chunked writer was never to hold that at once. What comes back
 * is the loudness envelope the edge-snapping reads, and the sample count.
 */
export async function decodeWindowToWav({ path, maxBytes, start, end, frames, skipSamples = 0, wavPath, targetRate }) {
  const { handle } = await openGatedFile(path, { maxBytes });
  let bytes;
  try {
    bytes = await readRange(handle, start, end);
  } finally {
    await handle.close();
  }

  const envelope = createEnvelopeBuilder(targetRate);
  const writer = openWavWriter(wavPath, { sampleRate: targetRate });
  let toSkip = skipSamples;
  let closed = false;
  try {
    const decoded = await decodeToMono(
      bytes,
      frames,
      (samples) => {
        // The primer frames' output: decoded so the bit reservoir is primed by the
        // time the window starts, then dropped.
        if (toSkip >= samples.length) {
          toSkip -= samples.length;
          return;
        }
        const kept = toSkip ? samples.subarray(toSkip) : samples;
        toSkip = 0;
        writer.write(kept);
        envelope.push(kept);
      },
      { targetRate, resample: 'average' },
    );
    const { samples } = writer.close();
    closed = true;
    const values = envelope.finish();
    return {
      result: { samples, errors: decoded.errors, envelope: values, hopMs: envelope.hopMs },
      transfer: [values.buffer],
    };
  } finally {
    if (!closed) writer.close();
  }
}
