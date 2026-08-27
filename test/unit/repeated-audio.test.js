import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findRepeatedAudio } from '../../src/lib/repeated-audio.js';

/**
 * Fingerprints are built here rather than decoded from audio.
 *
 * The point of these tests is the *search* — how a match is seeded, grown and credited
 * to the episodes that share it — and that is far easier to state, and far easier to
 * make fail on purpose, over sequences whose contents are chosen. The decoding and
 * fingerprinting they would otherwise come from are tested against real audio in
 * acoustic-fingerprint.test.js.
 */
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x >>> 0;
  };
}

/** A stretch of unrelated audio. */
function noise(seed, length) {
  const next = rng(seed);
  return Uint32Array.from({ length }, () => next());
}

/**
 * The same audio, recognised imperfectly — as a different encode of it would be.
 *
 * Unevenly, which is the part that matters. Re-encoding does not smear every
 * sub-fingerprint equally: loud, well-defined audio comes back bit-for-bit identical
 * while quieter passages move a lot. Measured between two real episodes sharing a
 * theme, about 15% of bits were wrong overall and 4% of sub-fingerprints were
 * nonetheless exact.
 *
 * Corrupting every word by the same amount would be tidier and would test the wrong
 * thing: it makes an exact match impossible, so nothing could ever be found, and a
 * search that gave up would look correct.
 */
function degraded(source, seed, { untouchedInN = 40, wrongBits = 5 } = {}) {
  const next = rng(seed);
  return Uint32Array.from(source, (word) => {
    if (next() % untouchedInN === 0) return word;
    let out = word;
    for (let i = 0; i < wrongBits; i += 1) out = (out ^ (1 << next() % 32)) >>> 0;
    return out >>> 0;
  });
}

function join(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** 86 sub-fingerprints a second. */
const seconds = (n) => Math.round(n * 86.13);

describe('finding what episodes share', () => {
  it('finds a shared stretch and says which episodes carry it', () => {
    const theme = noise(11, seconds(12));
    const episodes = [
      { id: 'a', fingerprint: join(noise(1, seconds(20)), theme, noise(2, seconds(20))) },
      { id: 'b', fingerprint: join(noise(3, seconds(8)), theme, noise(4, seconds(30))) },
      { id: 'c', fingerprint: join(noise(5, seconds(30)), theme, noise(6, seconds(5))) },
    ];

    const [found] = findRepeatedAudio(episodes, { minEpisodes: 2 });

    assert.ok(found, 'a twelve-second theme in three episodes was not found');
    assert.equal(found.episodeCount, 3);
    assert.ok(
      Math.abs(found.durationMs / 1000 - 12) < 1.5,
      `twelve seconds was measured as ${(found.durationMs / 1000).toFixed(1)}`,
    );
    // Each occurrence is where that episode actually has it, not where the first one did.
    const at = Object.fromEntries(found.occurrences.map((o) => [o.episodeId, o.startMs / 1000]));
    assert.ok(Math.abs(at.a - 20) < 1, `a: ${at.a}`);
    assert.ok(Math.abs(at.b - 8) < 1, `b: ${at.b}`);
    assert.ok(Math.abs(at.c - 30) < 1, `c: ${at.c}`);
  });

  it('credits an episode whose copy is recognised imperfectly', () => {
    // The case that decides whether this works on real shows. Two episodes carry the
    // same encode of a theme and match it exactly; a third carries a *different* encode,
    // so barely any single sub-fingerprint of it is bit-for-bit identical. Seeding alone
    // finds the easy two and stops — which on four real episodes reported a shared
    // opening as belonging to two of them. The third is found by gathering votes across
    // a whole stretch rather than trusting one lucky hit.
    const theme = noise(21, seconds(12));
    const episodes = [
      { id: 'a', fingerprint: join(noise(1, seconds(15)), theme, noise(2, seconds(15))) },
      { id: 'b', fingerprint: join(noise(3, seconds(9)), theme, noise(4, seconds(15))) },
      {
        id: 'c',
        fingerprint: join(noise(5, seconds(22)), degraded(theme, 99), noise(6, seconds(9))),
      },
    ];

    const [found] = findRepeatedAudio(episodes, { minEpisodes: 2 });

    assert.ok(found);
    assert.equal(
      found.episodeCount,
      3,
      'the episode whose copy was re-encoded was left out of its own theme tune',
    );
  });

  it('leaves alone episodes that share nothing', () => {
    const episodes = [
      { id: 'a', fingerprint: noise(1, seconds(40)) },
      { id: 'b', fingerprint: noise(2, seconds(40)) },
      { id: 'c', fingerprint: noise(3, seconds(40)) },
    ];

    assert.deepEqual(findRepeatedAudio(episodes, { minEpisodes: 2 }), []);
  });

  it('ignores a repeat too short to be worth cutting', () => {
    const sting = noise(31, seconds(2));
    const episodes = [
      { id: 'a', fingerprint: join(noise(1, seconds(20)), sting, noise(2, seconds(20))) },
      { id: 'b', fingerprint: join(noise(3, seconds(20)), sting, noise(4, seconds(20))) },
    ];

    assert.deepEqual(findRepeatedAudio(episodes, { minEpisodes: 2 }), []);
  });

  it('does not report the same audio twice', () => {
    const theme = noise(41, seconds(15));
    const episodes = [
      { id: 'a', fingerprint: join(noise(1, seconds(10)), theme, noise(2, seconds(10))) },
      { id: 'b', fingerprint: join(noise(3, seconds(10)), theme, noise(4, seconds(10))) },
    ];

    const found = findRepeatedAudio(episodes, { minEpisodes: 2 });

    assert.equal(found.length, 1, `one theme was reported ${found.length} times`);
  });

  it('needs two episodes before it says anything', () => {
    const one = { id: 'a', fingerprint: noise(1, seconds(60)) };
    assert.deepEqual(findRepeatedAudio([one], { minEpisodes: 1 }), []);
    assert.deepEqual(findRepeatedAudio([], {}), []);
  });

  it('finds two separate repeats in one show', () => {
    const opening = noise(51, seconds(10));
    const outro = noise(52, seconds(10));
    const episodes = [
      { id: 'a', fingerprint: join(opening, noise(1, seconds(30)), outro) },
      { id: 'b', fingerprint: join(opening, noise(2, seconds(45)), outro) },
    ];

    const found = findRepeatedAudio(episodes, { minEpisodes: 2 });

    assert.equal(found.length, 2, 'an opening and an outro should be two candidates, not one');
    for (const segment of found) {
      assert.ok(
        Math.abs(segment.durationMs / 1000 - 10) < 1.5,
        `a ten-second repeat was measured as ${(segment.durationMs / 1000).toFixed(1)}s`,
      );
    }
  });
});
