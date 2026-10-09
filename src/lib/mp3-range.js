import { MAX_FRAMES, id3v2Size, readFrameHeader, readXing } from './mp3-frames.js';
import { openGatedFile } from './pipeline-file.js';

/**
 * Reading part of an MP3 without reading all of it.
 *
 * The sample a decision is made by listening to is ten seconds of an episode, and
 * serving it used to read the whole episode off the share and walk every frame of
 * it, on every play. The frames wanted are known by index, and an index is only a
 * byte offset once the headers before it have been walked — so this walks them from
 * a file handle a chunk at a time, keeps the table it builds per file, and reads
 * only the bytes the frames occupy.
 *
 * The walk here must agree with `readFrames` frame for frame, because the indices
 * stored in the catalogue were measured by it. It is the same loop — the same sync
 * search, the same bounded resynchronisation, the same cap — over a sliding window
 * instead of a whole buffer, and `test/unit/mp3-range.test.js` holds the two to it.
 */

/** Longer than any valid MPEG audio frame (1,729 bytes), so a frame is never cut by the window. */
const WINDOW_SLACK = 4096;
const CHUNK_BYTES = 1024 * 1024;
const MAX_SYNC_SEARCH = 512 * 1024;
const RESYNC_BYTES = 8192;

/**
 * Walks a file's frame headers and returns where every audio frame is.
 *
 * @returns {Promise<{offsets: Uint32Array, lengths: Uint16Array, frameCount: number, sampleRate: number|null,
 *   samplesPerFrame: number|null, truncated: boolean, size: number, mtimeMs: number} | null>}
 *   null when the file has no frames at all.
 */
export async function frameTable(path, { maxFrames = MAX_FRAMES } = {}) {
  const { handle, size, mtimeMs } = await openGatedFile(path, { maxBytes: Infinity });
  try {
    let buffer = Buffer.alloc(0);
    let bufferStart = 0;

    /** Makes sure `[at, at + WINDOW_SLACK)` (or to the end of the file) is in `buffer`. */
    async function windowAt(at) {
      const wantedEnd = Math.min(size, at + WINDOW_SLACK);
      if (at >= bufferStart && wantedEnd <= bufferStart + buffer.length) return;
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - at));
      let read = 0;
      while (read < chunk.length) {
        const { bytesRead } = await handle.read(chunk, read, chunk.length - read, at + read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      buffer = read === chunk.length ? chunk : chunk.subarray(0, read);
      bufferStart = at;
    }

    async function headerAt(at) {
      if (at + 4 > size) return null;
      await windowAt(at);
      return readFrameHeader(buffer, at - bufferStart);
    }

    await windowAt(0);
    let offset = id3v2Size(buffer);
    const offsets = [];
    const lengths = [];
    let first = null;

    // Find the first frame. Anything before it is a tag or junk.
    const searchEnd = Math.min(size - 4, offset + MAX_SYNC_SEARCH);
    while (offset <= searchEnd && !(await headerAt(offset))) offset += 1;

    while (offset + 4 <= size && offsets.length < maxFrames) {
      const frame = await headerAt(offset);
      if (!frame) {
        // Resynchronise: skip a byte and look again, but only for a bounded distance,
        // so a truncated or corrupt tail cannot turn into a linear scan of megabytes.
        let probe = offset + 1;
        const limit = Math.min(size - 4, offset + RESYNC_BYTES);
        while (probe <= limit && !(await headerAt(probe))) probe += 1;
        if (probe > limit) break;
        offset = probe;
        continue;
      }
      if (!first) first = { ...frame, offset };
      offsets.push(offset);
      lengths.push(frame.length);
      offset += frame.length;
    }
    if (!offsets.length) return null;

    // The Xing frame itself is a header, not audio, and the catalogue's frame indices
    // count from the first audio frame — exactly as `frameProfile` counts them.
    await windowAt(first.offset);
    const firstBytes = buffer.subarray(first.offset - bufferStart, first.offset - bufferStart + first.length);
    const xing = readXing(firstBytes, { ...first, offset: 0 });
    const firstAudio = xing ? 1 : 0;
    const count = offsets.length - firstAudio;
    const table = {
      offsets: Uint32Array.from(offsets.slice(firstAudio)),
      lengths: Uint16Array.from(lengths.slice(firstAudio)),
      frameCount: count,
      truncated: offsets.length >= maxFrames,
      size,
      mtimeMs,
      sampleRate: null,
      samplesPerFrame: null,
    };
    if (count) {
      const audioFirst = await headerAt(table.offsets[0]);
      table.sampleRate = audioFirst?.sampleRate ?? null;
      table.samplesPerFrame = audioFirst?.samplesPerFrame ?? null;
    }
    return table;
  } finally {
    await handle.close();
  }
}

/**
 * The bytes of audio frames `[fromFrame, toFrame)`, read straight from the file.
 *
 * Adjacent frames are read in one piece, so a ten-second clip is one or two reads.
 * No tag and no Xing header: a player estimates length from the bitrate, which is
 * right for a clip that exists only to be listened to once.
 */
export async function readFrameRange(path, table, fromFrame, toFrame) {
  const from = Math.max(0, Math.floor(fromFrame));
  const to = Math.min(table.frameCount, Math.ceil(toFrame));
  if (to <= from) return Buffer.alloc(0);

  const runs = [];
  let runStart = table.offsets[from];
  let runEnd = runStart + table.lengths[from];
  for (let i = from + 1; i < to; i += 1) {
    if (table.offsets[i] === runEnd) {
      runEnd += table.lengths[i];
      continue;
    }
    runs.push([runStart, runEnd]);
    runStart = table.offsets[i];
    runEnd = runStart + table.lengths[i];
  }
  runs.push([runStart, runEnd]);

  const { handle } = await openGatedFile(path, { maxBytes: Infinity });
  try {
    const parts = [];
    for (const [start, end] of runs) {
      const part = Buffer.allocUnsafe(end - start);
      let read = 0;
      while (read < part.length) {
        const { bytesRead } = await handle.read(part, read, part.length - read, start + read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      parts.push(read === part.length ? part : part.subarray(0, read));
    }
    return Buffer.concat(parts);
  } finally {
    await handle.close();
  }
}

/**
 * Frame tables kept per file, keyed on its path, size and modification time.
 *
 * A table is a few bytes a frame — under a megabyte for an hour — and a handful of
 * them is all the review page ever plays from at once. A file that changes gets a
 * new key and the old entry ages out.
 */
export function createFrameTableCache({ maxEntries = 8 } = {}) {
  const entries = new Map();
  return {
    async get(path, { size, mtimeMs }) {
      const key = `${path}\0${size}\0${mtimeMs}`;
      const hit = entries.get(key);
      if (hit) {
        // Re-inserted so the most recently used is the last to go.
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }
      const table = await frameTable(path);
      if (!table) return null;
      entries.set(key, table);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return table;
    },
    size() {
      return entries.size;
    },
  };
}
