import { id3v2Size, readFrames, readXing } from './mp3-frames.js';

/**
 * Removing stretches of an MP3, without decoding it (spec §19.5).
 *
 * The plan for this was ffmpeg: `-c copy` with the concat demuxer, cutting at frame
 * boundaries. That is the right tool for a general audio pipeline, and it would have
 * meant a subprocess, a licence question (Alpine's ffmpeg is a GPL build), tens of
 * megabytes of image, and — the part that actually matters here — the whole H.264,
 * H.265, AV1 and VP9 decoder stack sitting inside an image that is fed files chosen by
 * strangers.
 *
 * None of it is needed. An MP3 *is* a sequence of self-contained frames, which is why
 * a podcast host can stitch an advert onto one while it is being streamed. Removing a
 * stretch is therefore removing frames and joining what remains — the same operation,
 * run backwards. Detection already reads every frame's position, so the cut list
 * arrives in frame indices and there is nothing left to work out.
 *
 * The result is byte-for-byte identical to the original outside the cut ranges. Not
 * "visually lossless" or "transparent": the same bytes.
 *
 * ## The two things that are not free
 *
 * **The bit reservoir.** An MP3 frame may borrow space from the frames before it, so
 * the first frame or two after a join can decode with part of its data missing — a
 * soft artefact of about 26 ms, once per join. Every frame-boundary cut has this,
 * ffmpeg's included; the only way to avoid it is to decode and re-encode, which costs
 * the quality of the whole file to fix a twentieth of a second at each join.
 *
 * **Encoder delay.** A LAME-encoded file begins with about 1,100 samples of silence
 * the decoder is meant to skip, described in a header this code rewrites but does not
 * try to re-derive per segment. In practice that is a few tens of milliseconds at each
 * join, which is inaudible in speech and would be audible in gapless music. This is
 * for podcasts.
 *
 * Neither is a reason to prefer re-encoding, and both are reasons the trimmed duration
 * is *measured* from the result rather than computed as "original minus what was cut".
 */

/**
 * Cuts frame ranges out of an MP3.
 *
 * @param {Buffer} buffer
 * @param {Array<{startFrame: number, endFrame: number}>} ranges — `end` is exclusive
 * @returns {{buffer: Buffer, framesKept: number, framesRemoved: number, durationMs: number} | null}
 */
export function cutFrames(buffer, ranges) {
  const { frames } = readFrames(buffer);
  if (!frames.length) return null;

  const xing = readXing(buffer, frames[0]);
  const firstAudio = xing ? 1 : 0;

  // Normalised so overlapping or unsorted ranges cannot remove more than they name.
  const cuts = normalise(ranges, frames.length - firstAudio).map((range) => ({
    start: range.start + firstAudio,
    end: range.end + firstAudio,
  }));
  if (!cuts.length) return null;

  const removed = new Uint8Array(frames.length);
  for (const range of cuts) {
    for (let i = Math.max(firstAudio, range.start); i < Math.min(frames.length, range.end); i += 1) {
      removed[i] = 1;
    }
  }

  const parts = [];
  // The ID3v2 tag is the episode's own metadata — title, artwork, chapters. It
  // belongs to the file, not to the audio, so it survives the cut untouched.
  const tagBytes = id3v2Size(buffer);
  if (tagBytes > 0) parts.push(buffer.subarray(0, tagBytes));

  const kept = [];
  let keptBytes = 0;
  let durationMs = 0;
  for (let i = firstAudio; i < frames.length; i += 1) {
    if (removed[i]) continue;
    const frame = frames[i];
    kept.push(frame);
    keptBytes += frame.length;
    durationMs += (frame.samplesPerFrame / frame.sampleRate) * 1000;
  }
  if (!kept.length) return null;

  // Runs of adjacent kept frames are copied in one slice rather than one per frame:
  // for an hour of audio that is a handful of copies instead of 137,000.
  let runStart = kept[0].offset;
  let runEnd = kept[0].offset + kept[0].length;
  for (let i = 1; i < kept.length; i += 1) {
    if (kept[i].offset === runEnd) {
      runEnd += kept[i].length;
      continue;
    }
    parts.push(buffer.subarray(runStart, runEnd));
    runStart = kept[i].offset;
    runEnd = kept[i].offset + kept[i].length;
  }
  parts.push(buffer.subarray(runStart, runEnd));

  if (xing) {
    // Rewritten rather than dropped. Without a correct Xing header a variable-bitrate
    // file reports the wrong length — every podcast app would show the original's
    // duration for a file that is minutes shorter — and seeking lands in the wrong
    // place, which is the failure people describe as "the scrubber is broken".
    const header = rewriteXing(buffer, frames[0], kept, keptBytes);
    parts.splice(tagBytes > 0 ? 1 : 0, 0, header);
  }

  return {
    buffer: Buffer.concat(parts),
    framesKept: kept.length,
    framesRemoved: frames.length - firstAudio - kept.length,
    durationMs: Math.round(durationMs),
  };
}

/**
 * Clamps cut ranges to the file and discards empty ones.
 *
 * Overlaps are deliberately *not* merged here, and that is not an oversight. What
 * removes the frames is a bitmap with one entry per frame, so marking a frame twice is
 * the same as marking it once — overlapping ranges cannot remove more than they name,
 * by construction rather than by being tidied up first. An earlier version merged them
 * as well, which no test could distinguish because the bitmap had already made it
 * impossible to observe.
 *
 * Overlaps are real, incidentally: the same audio is often found once by repetition
 * across episodes and once by comparing two downloads.
 */
function normalise(ranges, frameCount) {
  return (ranges ?? [])
    .map((range) => ({
      start: Math.max(0, Math.floor(range.startFrame ?? range.start ?? 0)),
      end: Math.min(frameCount, Math.ceil(range.endFrame ?? range.end ?? 0)),
    }))
    .filter((range) => range.end > range.start);
}

/**
 * A copy of the Xing frame with its counts and seek table corrected.
 *
 * The table of contents is recomputed rather than left alone or discarded: it maps a
 * percentage through the file to a byte offset, so after frames are removed every
 * entry in the original points somewhere that no longer means what it did.
 */
function rewriteXing(buffer, xingFrame, keptFrames, keptBytes) {
  const header = Buffer.from(buffer.subarray(xingFrame.offset, xingFrame.offset + xingFrame.length));
  const sideInfo =
    xingFrame.version === 1
      ? xingFrame.channelMode === 'mono'
        ? 17
        : 32
      : xingFrame.channelMode === 'mono'
        ? 9
        : 17;
  const at = 4 + sideInfo;
  const flags = header.readUInt32BE(at + 4);
  let cursor = at + 8;

  if (flags & 0x01) {
    header.writeUInt32BE(keptFrames.length, cursor);
    cursor += 4;
  }
  if (flags & 0x02) {
    // Total bytes of the new file, header frame included, which is what the field
    // means and what a player divides by to estimate an average bitrate.
    header.writeUInt32BE(keptBytes + xingFrame.length, cursor);
    cursor += 4;
  }
  if (flags & 0x04) {
    const total = keptBytes + xingFrame.length;
    let index = 0;
    let offset = xingFrame.length;
    for (let i = 0; i < 100; i += 1) {
      const target = Math.floor((i / 100) * keptFrames.length);
      while (index < target && index < keptFrames.length) {
        offset += keptFrames[index].length;
        index += 1;
      }
      header[cursor + i] = Math.min(255, Math.floor((offset / total) * 256));
    }
  }

  return header;
}
