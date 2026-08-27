import { FINGERPRINT_VERSION } from '../constants.js';

/**
 * The on-disk form of an episode's acoustic fingerprint (spec §19.4).
 *
 * Four bytes a frame and a small header, which for an hour-long episode is about
 * 550 kB. That is why these live under `/data/.fp` rather than in SQLite: a library of
 * five hundred episodes would otherwise put several hundred megabytes of BLOBs into a
 * database measured in megabytes — read synchronously on the thread that also serves
 * media, and carried in every backup the operator takes. `/data/.art` exists for the
 * same reason, and everything here is derived and rebuildable in the same way.
 *
 * Frame timings are not stored, because they do not need to be. Samples-per-frame is
 * fixed by the MPEG version and layer, and neither changes within a file — a variable
 * *bitrate* file still has frames of constant duration, which is what makes a
 * millisecond convertible to a frame index by arithmetic rather than by a stored table.
 * Storing them would roughly double the file to record something already known.
 *
 * What the four bytes hold changed in version 2. They used to be a hash of each MP3
 * frame's bytes, which found only audio that had been copied rather than re-encoded —
 * so on a professionally mastered show it found nothing at all. They are now
 * Haitsma–Kalker sub-fingerprints of the decoded sound, one every 11.6ms. The file is
 * the same shape and about the same size; the version guards the change, and an older
 * file is simply recomputed.
 */

const MAGIC = 0x53504650; // "SPFP"
const HEADER_BYTES = 28;

/**
 * @param {{hashes: number[]|Uint32Array, sampleRate: number, samplesPerFrame: number, durationMs: number}} fingerprint
 * @returns {Buffer}
 */
export function encodeFingerprint({ hashes, sampleRate, samplesPerFrame, durationMs }) {
  const buffer = Buffer.alloc(HEADER_BYTES + hashes.length * 4);
  buffer.writeUInt32BE(MAGIC, 0);
  buffer.writeUInt32BE(FINGERPRINT_VERSION, 4);
  buffer.writeUInt32BE(hashes.length, 8);
  buffer.writeUInt32BE(sampleRate || 0, 12);
  buffer.writeUInt32BE(samplesPerFrame || 0, 16);
  buffer.writeUInt32BE(Math.min(durationMs || 0, 0xffffffff), 20);
  buffer.writeUInt32BE(0, 24); // reserved, so a later field costs no format change
  for (let i = 0; i < hashes.length; i += 1) {
    buffer.writeUInt32BE(hashes[i] >>> 0, HEADER_BYTES + i * 4);
  }
  return buffer;
}

/**
 * Reads a fingerprint file, or returns null.
 *
 * Null rather than an exception for anything unrecognised, truncated or written by a
 * different version. These files are a cache: the only correct response to one that
 * cannot be read is to recompute it, and making that an error would turn a stale cache
 * into a broken feature.
 */
export function decodeFingerprint(buffer) {
  if (!buffer || buffer.length < HEADER_BYTES) return null;
  if (buffer.readUInt32BE(0) !== MAGIC) return null;

  const version = buffer.readUInt32BE(4);
  if (version !== FINGERPRINT_VERSION) return null;

  const frameCount = buffer.readUInt32BE(8);
  if (buffer.length < HEADER_BYTES + frameCount * 4) return null;

  const hashes = new Uint32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    hashes[i] = buffer.readUInt32BE(HEADER_BYTES + i * 4);
  }

  return {
    version,
    hashes,
    sampleRate: buffer.readUInt32BE(12) || null,
    samplesPerFrame: buffer.readUInt32BE(16) || null,
    durationMs: buffer.readUInt32BE(20) || null,
  };
}

/** Milliseconds from the start of the audio to a frame index. */
export function frameToMs(index, { sampleRate, samplesPerFrame }) {
  if (!sampleRate || !samplesPerFrame) return 0;
  return Math.round((index * samplesPerFrame * 1000) / sampleRate);
}

/**
 * The frame index at or before a given millisecond offset.
 *
 * The bridge between the two units this feature works in. The search reasons in
 * sub-fingerprints of 11.6ms because that is the resolution sound can be compared at;
 * a cut is made of MP3 frames of 26.1ms because that is what audio can be removed at.
 * Everything that crosses between them comes through here.
 */
export function msToFrame(ms, { sampleRate, samplesPerFrame }) {
  if (!sampleRate || !samplesPerFrame) return 0;
  return Math.floor((ms * sampleRate) / (samplesPerFrame * 1000));
}
