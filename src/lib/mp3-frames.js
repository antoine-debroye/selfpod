/**
 * Reading an MP3 as the sequence of frames it actually is (spec §19.1).
 *
 * The whole of Phase 2 rests on one observation: dynamically inserted podcast ads are
 * *frame concatenation*. That is why a CDN can stitch them onto a file while it is
 * being streamed — no decoding, no re-encoding, just bytes joined at frame boundaries.
 *
 * So the right unit for comparing two copies of an episode is the frame, not the
 * decoded sample. Comparing frames is better than comparing audio on every axis that
 * matters here:
 *
 *  - **No decoding at all.** Hashing eighty megabytes is well under a second; decoding
 *    the same file to PCM is minutes on NAS-class hardware, and needs ffmpeg.
 *  - **Frame-exact boundaries** — 26.12 ms at 44.1 kHz — rather than "near enough".
 *  - **Shift-tolerant.** If one copy's pre-roll is 30 s and the other's is 32.5 s,
 *    everything after it moves by an amount that is not a whole number of anything.
 *    A fixed-grid comparison of decoded audio then matches nothing at all and reports
 *    that the entire rest of the episode differs — which, acted on, would cut it. A
 *    sequence diff over frames has no such problem, because the boundaries move with
 *    the content.
 *
 * This module is deliberately only a reader. It answers "what frames are in this
 * file?" and "do any of them look like they were encoded separately?" — the comparing
 * lives in lib/frame-diff.js.
 *
 * Measured against a real NPR episode (14 MB of a Planet Money instalment):
 * 33,495 frames parsed in 31 ms, and the duration derived from those frames —
 * 875.0 s — matched to the second what music-metadata reports after decoding the
 * file. Of 33,495 frame hashes, 121 repeated, and every one of those was a genuinely
 * identical frame (silence); there were no hash collisions at all.
 */

/** MPEG version, from the two version bits. */
const VERSIONS = Object.freeze({ 0: 2.5, 1: null, 2: 2, 3: 1 });

/** Layer, from the two layer bits. `null` is the reserved value. */
const LAYERS = Object.freeze({ 0: null, 1: 3, 2: 2, 3: 1 });

/** Bitrate tables, in kbit/s, indexed by the four bitrate bits. */
const BITRATES_V1_L3 = [null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, null];
const BITRATES_V2_L3 = [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, null];
const BITRATES_V1_L2 = [null, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, null];
const BITRATES_V1_L1 = [null, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, null];

const SAMPLE_RATES = Object.freeze({
  1: [44100, 48000, 32000, null],
  2: [22050, 24000, 16000, null],
  2.5: [11025, 12000, 8000, null],
});

const CHANNEL_MODES = Object.freeze(['stereo', 'joint', 'dual', 'mono']);

/**
 * How far to hunt for the first frame before giving up.
 *
 * A file that is not an MP3 must not cost a full scan of itself. Real files start
 * within a few kilobytes of the tag; anything beyond this is not an MP3 with a long
 * preamble, it is something else.
 */
const MAX_SYNC_SEARCH = 512 * 1024;

/**
 * The size of an ID3v2 tag at the start of the file, or 0.
 *
 * The length is stored "synchsafe": seven bits per byte, so the encoded length can
 * never contain a byte that looks like a frame sync. Reading it as a plain big-endian
 * integer — which is the obvious mistake — overshoots and lands in the middle of the
 * audio.
 */
export function id3v2Size(buffer) {
  if (buffer.length < 10) return 0;
  if (buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33) return 0; // "ID3"
  const size =
    ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
  // A footer is present when bit 4 of the flags byte is set, and adds ten bytes.
  const footer = buffer[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/**
 * Parses one frame header at `offset`, or returns null.
 *
 * Returns null rather than throwing for anything malformed: a byte pair that looks
 * like a sync but is not a valid header is an ordinary occurrence inside audio data,
 * not an error.
 */
export function readFrameHeader(buffer, offset) {
  if (offset + 4 > buffer.length) return null;
  if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) return null;

  const version = VERSIONS[(buffer[offset + 1] >> 3) & 0x03];
  const layer = LAYERS[(buffer[offset + 1] >> 1) & 0x03];
  if (version === null || layer === null) return null;

  const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
  const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f) return null; // free-format or invalid

  const sampleRate = SAMPLE_RATES[version]?.[sampleRateIndex];
  if (!sampleRate) return null;

  let bitrate;
  if (layer === 3) bitrate = version === 1 ? BITRATES_V1_L3[bitrateIndex] : BITRATES_V2_L3[bitrateIndex];
  else if (layer === 2) bitrate = version === 1 ? BITRATES_V1_L2[bitrateIndex] : BITRATES_V2_L3[bitrateIndex];
  else bitrate = version === 1 ? BITRATES_V1_L1[bitrateIndex] : BITRATES_V2_L3[bitrateIndex];
  if (!bitrate) return null;

  const padding = (buffer[offset + 2] >> 1) & 0x01;
  const channelMode = CHANNEL_MODES[(buffer[offset + 3] >> 6) & 0x03];

  // Samples per frame, which is what makes a frame's duration constant for a given
  // sample rate — and so what makes a frame count a duration.
  let samplesPerFrame;
  if (layer === 1) samplesPerFrame = 384;
  else if (layer === 2) samplesPerFrame = 1152;
  else samplesPerFrame = version === 1 ? 1152 : 576;

  const length =
    layer === 1
      ? (Math.floor((12 * bitrate * 1000) / sampleRate) + padding) * 4
      : Math.floor((samplesPerFrame / 8) * bitrate * 1000 / sampleRate) + padding;

  if (length < 4 || offset + length > buffer.length) return null;

  return { offset, length, version, layer, bitrate, sampleRate, channelMode, samplesPerFrame };
}

/**
 * FNV-1a over a frame's bytes, mixed with its length.
 *
 * Chosen over a cryptographic hash because this runs 137,000 times for an hour of
 * audio and nothing here is a security boundary: the worst a collision can do is make
 * one frame in a sequence compare equal when it was not, which a diff absorbs as
 * noise. Mixing the length in separates two frames that differ only in bytes the hash
 * happens to fold together.
 */
function hashFrame(buffer, offset, length) {
  let hash = 0x811c9dc5;
  const end = offset + length;
  for (let i = offset; i < end; i += 1) {
    hash ^= buffer[i];
    // The FNV prime, as shifts, because Math.imul of the constant is slower and
    // 32-bit overflow is exactly what is wanted.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return (hash ^ (length << 16)) >>> 0;
}

/**
 * Walks the whole file, returning every frame and a hash of each.
 *
 * Resynchronises rather than giving up when a frame does not follow the previous one.
 * Real podcast MP3s carry ID3v1 footers, APE tags, and occasionally junk between
 * frames, and a reader that stops at the first surprise reports half a file as the
 * whole of it — which for a diff means "everything after here is an advert".
 */
export function readFrames(buffer, { maxFrames = 400_000 } = {}) {
  const frames = [];
  const hashes = [];
  let offset = id3v2Size(buffer);
  let resyncs = 0;

  // Find the first frame. Anything before it is a tag or junk.
  const searchEnd = Math.min(buffer.length - 4, offset + MAX_SYNC_SEARCH);
  while (offset <= searchEnd && !readFrameHeader(buffer, offset)) offset += 1;

  while (offset + 4 <= buffer.length && frames.length < maxFrames) {
    const frame = readFrameHeader(buffer, offset);
    if (!frame) {
      // Resynchronise: skip a byte and look again, but only for a bounded distance,
      // so a truncated or corrupt tail cannot turn into a linear scan of megabytes.
      let probe = offset + 1;
      const limit = Math.min(buffer.length - 4, offset + 8192);
      while (probe <= limit && !readFrameHeader(buffer, probe)) probe += 1;
      if (probe > limit) break;
      resyncs += 1;
      offset = probe;
      continue;
    }
    frames.push(frame);
    hashes.push(hashFrame(buffer, frame.offset, frame.length));
    offset += frame.length;
  }

  return { frames, hashes, resyncs };
}

/** Whether the first frame carries a Xing or Info header, and what it claims. */
export function readXing(buffer, firstFrame) {
  if (!firstFrame) return null;
  // The tag sits after the side information, whose size depends on version and
  // channel mode. These are the four documented offsets.
  const sideInfo =
    firstFrame.version === 1
      ? firstFrame.channelMode === 'mono'
        ? 17
        : 32
      : firstFrame.channelMode === 'mono'
        ? 9
        : 17;
  const at = firstFrame.offset + 4 + sideInfo;
  if (at + 12 > buffer.length) return null;

  const tag = buffer.toString('latin1', at, at + 4);
  if (tag !== 'Xing' && tag !== 'Info') return null;

  const flags = buffer.readUInt32BE(at + 4);
  let cursor = at + 8;
  let frameCount = null;
  if (flags & 0x01) {
    frameCount = buffer.readUInt32BE(cursor);
    cursor += 4;
  }
  return { kind: tag, frameCount, vbr: tag === 'Xing' };
}

/**
 * What the frames say about how the file was put together.
 *
 * These are the cheap single-file signals: they cost one pass over the headers, no
 * decoding, and no second copy of the episode. None of them proves an advert is
 * present — they are reasons to look, offered to the user as candidates, never acted
 * on unattended.
 *
 * A **discontinuity** is a point where the bitrate, sample rate or channel mode
 * changes mid-file. Adverts are encoded separately from the show, and a stitcher that
 * does not re-encode leaves the seam visible. Joint-stereo giving way to plain stereo
 * is the classic one.
 *
 * A **frame-count mismatch** is the other: the Xing header states how many frames the
 * file has, and a stitcher that adds frames without rewriting it leaves the two
 * disagreeing.
 */
export function frameProfile(buffer) {
  const { frames, hashes, resyncs } = readFrames(buffer);
  if (!frames.length) return null;

  const xing = readXing(buffer, frames[0]);
  // The Xing frame itself is a header, not audio, and must not be compared or counted.
  const audioFrames = xing ? frames.slice(1) : frames;
  const audioHashes = xing ? hashes.slice(1) : hashes;

  const discontinuities = [];
  for (let i = 1; i < audioFrames.length; i += 1) {
    const previous = audioFrames[i - 1];
    const current = audioFrames[i];
    const changes = [];
    if (previous.bitrate !== current.bitrate) changes.push('bitrate');
    if (previous.sampleRate !== current.sampleRate) changes.push('sampleRate');
    if (previous.channelMode !== current.channelMode) changes.push('channelMode');
    if (!changes.length) continue;
    discontinuities.push({
      frameIndex: i,
      atMs: frameIndexToMs(audioFrames, i),
      changes,
      from: { bitrate: previous.bitrate, channelMode: previous.channelMode },
      to: { bitrate: current.bitrate, channelMode: current.channelMode },
    });
  }

  // A VBR file changes bitrate constantly and legitimately, so a bitrate change there
  // says nothing at all. Only sample rate and channel mode remain meaningful.
  const variableBitrate = xing?.vbr === true || countDistinct(audioFrames, 'bitrate') > 3;
  const meaningful = variableBitrate
    ? discontinuities.filter((entry) => entry.changes.some((c) => c !== 'bitrate'))
    : discontinuities;

  return {
    frames: audioFrames,
    hashes: audioHashes,
    frameCount: audioFrames.length,
    durationMs: frameIndexToMs(audioFrames, audioFrames.length),
    sampleRate: audioFrames[0].sampleRate,
    variableBitrate,
    xing,
    // Present and disagreeing is the signal; absent proves nothing either way, since
    // many encoders omit it and many stitchers rewrite it correctly.
    frameCountMismatch:
      xing?.frameCount != null && Math.abs(xing.frameCount - audioFrames.length) > 1
        ? { declared: xing.frameCount, actual: audioFrames.length }
        : null,
    discontinuities: meaningful,
    resyncs,
  };
}

function countDistinct(frames, key) {
  const seen = new Set();
  for (const frame of frames) {
    seen.add(frame[key]);
    if (seen.size > 4) return seen.size;
  }
  return seen.size;
}

/** Milliseconds from the start of the audio to the given frame index. */
export function frameIndexToMs(frames, index) {
  let ms = 0;
  const end = Math.min(index, frames.length);
  for (let i = 0; i < end; i += 1) {
    ms += (frames[i].samplesPerFrame / frames[i].sampleRate) * 1000;
  }
  return Math.round(ms);
}
