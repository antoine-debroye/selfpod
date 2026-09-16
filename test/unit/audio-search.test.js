import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { createAudioSearch } from '../../src/lib/audio-search.js';
import { findRepeatedAudio } from '../../src/lib/repeated-audio.js';

/**
 * The repeated-audio search is quadratic and used to run on the thread that serves
 * listeners and answers the container's health check. These prove two things: the
 * worker gives the same answer, and while it works the main thread stays free.
 */
function noise(seed, length) {
  const out = new Uint32Array(length);
  let x = seed >>> 0 || 1;
  for (let k = 0; k < length; k += 1) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[k] = x >>> 0;
  }
  return out;
}

function corpus(count, length, { sharedAt = null } = {}) {
  const shared = noise(0xabcdef, 1200);
  return Array.from({ length: count }, (_, i) => {
    const fingerprint = noise((i + 1) * 104_729, length);
    if (sharedAt !== null) fingerprint.set(shared, sharedAt + (i % 5) * 200);
    return { id: `e${i}`, fingerprint };
  });
}

/** The longest the main thread went without running a 10 ms timer while `work` ran. */
async function longestStall(work) {
  let last = performance.now();
  let longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  last = performance.now();
  await work();
  await new Promise((resolve) => setTimeout(resolve, 20));
  clearInterval(timer);
  return longest;
}

const search = createAudioSearch();
after(() => search.close());

describe('the corpus search in a worker', () => {
  it('finds exactly what the same search finds on the main thread', async () => {
    const episodes = corpus(4, 6_000, { sharedAt: 800 });
    const inline = findRepeatedAudio(episodes, { minEpisodes: 2 });
    assert.ok(inline.length >= 1, 'setup: the shared stretch was not found at all');
    const inWorker = await search.repeatedAudio(episodes, { minEpisodes: 2 });
    assert.deepEqual(inWorker, inline);
  });

  it('leaves the main thread free while it works', async () => {
    const episodes = corpus(60, 60_000);
    const inlineStall = await longestStall(async () => findRepeatedAudio(episodes, { minEpisodes: 2 }));
    // Without this the test would prove nothing: the work has to be heavy enough to block.
    assert.ok(inlineStall > 400, `setup: the search only blocked for ${Math.round(inlineStall)} ms inline`);

    const workerStall = await longestStall(() => search.repeatedAudio(episodes, { minEpisodes: 2 }));
    assert.ok(
      workerStall < inlineStall / 4 && workerStall < 250,
      `the main thread stalled for ${Math.round(workerStall)} ms with the search in a worker (${Math.round(inlineStall)} ms inline)`,
    );
  });

  it('reports a failure instead of hanging, and recovers on the next call', async () => {
    await assert.rejects(search.repeatedAudio('not an array', {}), /is not a function|filter/);
    const again = await search.repeatedAudio(corpus(2, 1_000), { minEpisodes: 2 });
    assert.ok(Array.isArray(again));
  });
});
