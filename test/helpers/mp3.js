/**
 * Builds MP3 files frame by frame, for tests.
 *
 * Synthesised rather than committed as binary fixtures, for two reasons. A stitched
 * file is exactly "these frames, then those frames" — which is what a podcast host
 * does when it inserts an advert — so building one in code says what the test means
 * far more clearly than a checked-in blob whose contents nobody can see in a diff.
 * And the frames need to be *distinct*: a fixture repeated to make length gives
 * thousands of identical frames, which makes any sequence comparison degenerate and
 * a passing test meaningless.
 */

/** MPEG-1 Layer III, 128 kbit/s, 44.1 kHz — 417 bytes a frame, 26.12 ms of audio. */
const FRAME_BYTES = 417;
export const FRAME_MS = (1152 / 44100) * 1000;

function frameHeader(channelMode = 'joint', bitrateIndex = 9, sampleRateIndex = 0) {
  const modes = { stereo: 0, joint: 1, dual: 2, mono: 3 };
  return Buffer.from([
    0xff,
    0xfb, // MPEG-1, Layer III, no CRC
    (bitrateIndex << 4) | (sampleRateIndex << 2),
    (modes[channelMode] << 6) | 0x00,
  ]);
}

/**
 * One frame whose payload is derived from `seed`.
 *
 * Deterministic so a test can rebuild the same "advert" twice, and distinct across
 * seeds so two different frames never hash alike by construction.
 */
export function frame(seed, { channelMode = 'joint', bitrateIndex = 9 } = {}) {
  const header = frameHeader(channelMode, bitrateIndex);
  const payload = Buffer.alloc(FRAME_BYTES - 4);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < payload.length; i += 1) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    // Never emit 0xFF, so a payload byte can never be mistaken for a frame sync and
    // the test's own data cannot desynchronise the parser it is testing.
    payload[i] = x & 0xfe;
  }
  return Buffer.concat([header, payload]);
}

/** A run of `count` frames, numbered from `from` — a "segment" of audio. */
export function segment(from, count, options = {}) {
  const frames = [];
  for (let i = 0; i < count; i += 1) frames.push(frame(from + i, options));
  return Buffer.concat(frames);
}

/** Joins segments the way a podcast host stitches an advert onto a programme. */
export function stitch(...parts) {
  return Buffer.concat(parts);
}

/** An ID3v2 tag of the given payload size, with its synchsafe length. */
export function id3v2(payloadSize = 100) {
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 3; // version 2.3
  header[6] = (payloadSize >> 21) & 0x7f;
  header[7] = (payloadSize >> 14) & 0x7f;
  header[8] = (payloadSize >> 7) & 0x7f;
  header[9] = payloadSize & 0x7f;
  // Filled with a byte that is not 0xFF, so nothing inside the tag looks like audio.
  return Buffer.concat([header, Buffer.alloc(payloadSize, 0x41)]);
}
