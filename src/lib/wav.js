import { closeSync, openSync, writeSync } from 'node:fs';

/**
 * Writing 16-bit mono WAV a chunk at a time (spec §19.6).
 *
 * The recogniser reads a WAV file and nothing else, and the audio for it comes out of
 * the decoder in small chunks. Writing each chunk as it arrives means a whole-episode
 * transcription — an hour is over a hundred megabytes of samples — never holds more
 * than a chunk in memory. The header's two lengths are not known until the end, so
 * they are written last, in place.
 */
const HEADER_BYTES = 44;
const CHUNK_SAMPLES = 16_384;

/**
 * @param {string} path
 * @param {{sampleRate: number}} options
 * @returns {{write(samples: ArrayLike<number>): void, close(): {samples: number, bytes: number}}}
 */
export function openWavWriter(path, { sampleRate }) {
  const fd = openSync(path, 'w');
  writeSync(fd, Buffer.alloc(HEADER_BYTES));
  let samples = 0;
  const chunk = Buffer.alloc(CHUNK_SAMPLES * 2);

  return {
    write(input) {
      let at = 0;
      while (at < input.length) {
        const n = Math.min(CHUNK_SAMPLES, input.length - at);
        for (let i = 0; i < n; i += 1) {
          const value = input[at + i];
          const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
          chunk.writeInt16LE(Math.round(clamped * 32767), i * 2);
        }
        writeSync(fd, chunk, 0, n * 2);
        samples += n;
        at += n;
      }
    },
    close() {
      const dataBytes = samples * 2;
      const header = Buffer.alloc(HEADER_BYTES);
      header.write('RIFF', 0, 'ascii');
      header.writeUInt32LE(36 + dataBytes, 4);
      header.write('WAVE', 8, 'ascii');
      header.write('fmt ', 12, 'ascii');
      header.writeUInt32LE(16, 16); // PCM chunk size
      header.writeUInt16LE(1, 20); // PCM
      header.writeUInt16LE(1, 22); // mono
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(sampleRate * 2, 28); // byte rate
      header.writeUInt16LE(2, 32); // block align
      header.writeUInt16LE(16, 34); // bits per sample
      header.write('data', 36, 'ascii');
      header.writeUInt32LE(dataBytes, 40);
      writeSync(fd, header, 0, HEADER_BYTES, 0);
      closeSync(fd);
      return { samples, bytes: HEADER_BYTES + dataBytes };
    },
  };
}
