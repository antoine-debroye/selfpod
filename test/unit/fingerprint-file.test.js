import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeFingerprint, encodeFingerprint } from '../../src/lib/fingerprint-file.js';

/**
 * The fingerprint file is read once per episode per pass, so its decoder was rewritten
 * as a single copy and byte swap. The only thing that matters about that rewrite is that
 * it reads back exactly what was written — every bit, including the high one.
 */
describe('reading a fingerprint file back', () => {
  it('returns every sub-fingerprint exactly as written, high bits included', () => {
    const hashes = new Uint32Array(10_000);
    let state = 0x9e3779b9;
    for (let i = 0; i < hashes.length; i += 1) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      hashes[i] = state >>> 0;
    }
    hashes[0] = 0xffffffff;
    hashes[1] = 0x80000000;
    hashes[2] = 0;
    const file = encodeFingerprint({ hashes, sampleRate: 44_100, samplesPerFrame: 1152, durationMs: 116_000 });

    const decoded = decodeFingerprint(file);
    assert.equal(decoded.hashes.length, hashes.length);
    assert.deepEqual(Array.from(decoded.hashes), Array.from(hashes));
    // Independently of the decoder: the bytes on disk are big-endian.
    for (const i of [0, 1, 2, 777, 9_999]) assert.equal(decoded.hashes[i], file.readUInt32BE(28 + i * 4));
    assert.equal(decoded.sampleRate, 44_100);
    assert.equal(decoded.durationMs, 116_000);
  });

  it('does not share memory with the buffer it was read from', () => {
    const file = encodeFingerprint({ hashes: [1, 2, 3], sampleRate: 1, samplesPerFrame: 1, durationMs: 1 });
    const decoded = decodeFingerprint(file);
    file.fill(0);
    assert.deepEqual(Array.from(decoded.hashes), [1, 2, 3]);
  });

  it('reads a file whose bytes sit at an odd offset inside a larger buffer', () => {
    const file = encodeFingerprint({ hashes: [0xdeadbeef, 42], sampleRate: 1, samplesPerFrame: 1, durationMs: 1 });
    const pool = Buffer.alloc(file.length + 3);
    file.copy(pool, 3);
    assert.deepEqual(Array.from(decodeFingerprint(pool.subarray(3)).hashes), [0xdeadbeef, 42]);
  });

  it('refuses a truncated file rather than reading past its end', () => {
    const file = encodeFingerprint({ hashes: [1, 2, 3], sampleRate: 1, samplesPerFrame: 1, durationMs: 1 });
    assert.equal(decodeFingerprint(file.subarray(0, file.length - 1)), null);
  });
});
