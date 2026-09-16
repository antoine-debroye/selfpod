import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANCHOR_MATCH_BER,
  CLIP_GUARD_MS,
  MIN_ANCHOR_CUT_MS,
  SUB_MS,
  anchorClipFrom,
  findHeadAnchors,
  locateAnchor,
} from '../../src/lib/audio-anchor.js';

/**
 * Built the same way `repeated-audio.test.js` builds fingerprints, for the same
 * reason: the point of these tests is the search, and a chosen sequence is far
 * easier to make fail on purpose than decoded audio would be.
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

function noise(seed, length) {
  const next = rng(seed);
  return Uint32Array.from({ length }, () => next());
}

/** The same audio, recognised imperfectly — see repeated-audio.test.js for why. */
function degraded(source, seed, { untouchedInN = 40, wrongBits = 5 } = {}) {
  const next = rng(seed);
  return Uint32Array.from(source, (word) => {
    if (next() % untouchedInN === 0) return word;
    let out = word;
    for (let i = 0; i < wrongBits; i += 1) out = (out ^ (1 << (next() % 32))) >>> 0;
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

/** Sub-fingerprints in `n` seconds, at the fixed 11.61ms hop every fingerprint uses. */
const subs = (n) => Math.round((n * 1000) / SUB_MS);

describe('locating a stored clip in an episode', () => {
  it('finds a clip degraded the way a re-encode degrades it', () => {
    const clip = noise(1, subs(3));
    const heard = degraded(clip, 2, { untouchedInN: 4, wrongBits: 4 }); // ~8% wrong, like a real re-encode
    const episode = join(noise(3, subs(10)), heard, noise(4, subs(20)));

    const hit = locateAnchor(clip, episode);
    assert.ok(hit, 'a clip degraded by about 8% was not found');
    assert.ok(hit.ber <= ANCHOR_MATCH_BER, `ber ${hit.ber} above the threshold`);
    assert.ok(Math.abs(hit.atMs / 1000 - 10) < 0.5, `found at ${hit.atMs}ms, not around 10s`);
  });

  it('does not find a clip in audio that only coincidentally resembles it', () => {
    const clip = noise(1, subs(3));
    // Independent noise settles around 50% wrong; real unrelated audio settles lower
    // (repeated-audio.js measures 0.43, because adjacent bands are correlated), so
    // this is if anything the harder case for "not found" to get right.
    const episode = join(noise(5, subs(10)), noise(6, subs(3)), noise(7, subs(20)));

    assert.equal(locateAnchor(clip, episode), null);
  });

  it('returns the earlier of two plays, not the better match', () => {
    const clip = noise(1, subs(3));
    const first = degraded(clip, 2, { untouchedInN: 4, wrongBits: 4 }); // ~8% wrong
    const second = degraded(clip, 3, { untouchedInN: 200, wrongBits: 1 }); // near-perfect
    const episode = join(noise(8, subs(5)), first, noise(9, subs(20)), second, noise(10, subs(5)));

    const hit = locateAnchor(clip, episode);
    assert.ok(hit);
    assert.ok(
      Math.abs(hit.atMs / 1000 - 5) < 0.5,
      `found the later, cleaner play at ${hit.atMs}ms instead of the earlier one at ~5000ms`,
    );
  });

  it('finds nothing past the search window', () => {
    const clip = noise(1, subs(3));
    const heard = degraded(clip, 2, { untouchedInN: 4, wrongBits: 4 });
    const episode = join(noise(11, subs(400)), heard, noise(12, subs(10)));

    assert.equal(locateAnchor(clip, episode, { searchMs: 300_000 }), null, 'the clip sits at 400s, past a 300s search');
    const found = locateAnchor(clip, episode, { searchMs: 420_000 });
    assert.ok(found, 'widening the search window should find it');
  });

  it('handles an episode shorter than the clip itself', () => {
    const clip = noise(1, subs(3));
    const shortEpisode = noise(13, subs(1));
    assert.equal(locateAnchor(clip, shortEpisode), null);
  });

  it('handles no clip and no episode without throwing', () => {
    assert.equal(locateAnchor(null, noise(1, subs(3))), null);
    assert.equal(locateAnchor(noise(1, subs(3)), null), null);
    assert.equal(locateAnchor(new Uint32Array(0), noise(1, subs(3))), null);
  });
});

describe('proposing a jingle from what every episode\'s opening shares', () => {
  it('accepts audio present in every episode at a varying offset', () => {
    const ident = noise(20, subs(3));
    const episodes = [
      { id: 'e1', fingerprint: join(ident, noise(21, subs(60))) },
      { id: 'e2', fingerprint: join(ident, noise(22, subs(60))) },
      { id: 'e3', fingerprint: join(noise(23, subs(20)), ident, noise(24, subs(40))) },
      { id: 'e4', fingerprint: join(noise(25, subs(20)), ident, noise(26, subs(40))) },
    ];

    const [found] = findHeadAnchors(episodes);
    assert.ok(found, 'a three-second ident shared by every episode at varying offsets was not proposed');
    assert.equal(found.episodeCount, 4);
    assert.ok(found.spreadMs >= MIN_ANCHOR_CUT_MS, `spread ${found.spreadMs}ms should clear the pre-roll floor`);
  });

  it('rejects audio only some episodes share', () => {
    const ad = noise(30, subs(15));
    const ident = noise(31, subs(3));
    const episodes = [
      // No advert in front — the ident sits at 0:00.
      { id: 'e1', fingerprint: join(ident, noise(32, subs(60))) },
      { id: 'e2', fingerprint: join(ident, noise(33, subs(60))) },
      // The advert, shared by only these two, then the same ident.
      { id: 'e3', fingerprint: join(ad, ident, noise(34, subs(60))) },
      { id: 'e4', fingerprint: join(ad, ident, noise(35, subs(60))) },
    ];

    const found = findHeadAnchors(episodes);
    // The advert itself is rejected (present in only 2 of 4), and the ident is found
    // instead — this is the real shape of the show this feature exists for.
    assert.ok(!found.some((segment) => Math.abs(segment.durationMs - 15_000) < 2000), 'the advert was proposed as the jingle');
    assert.ok(found.some((segment) => Math.abs(segment.durationMs - 3000) < 1500), 'the actual ident was not proposed');
  });

  it('rejects audio that opens every episode at 0:00 — a theme tune, not a boundary', () => {
    const theme = noise(40, subs(4));
    const episodes = [
      { id: 'e1', fingerprint: join(theme, noise(41, subs(60))) },
      { id: 'e2', fingerprint: join(theme, noise(42, subs(60))) },
      { id: 'e3', fingerprint: join(theme, noise(43, subs(60))) },
    ];

    assert.deepEqual(findHeadAnchors(episodes), []);
  });

  it('rejects audio at a fixed, non-zero position in every episode — a mid-show element, not a boundary', () => {
    // Same shape as a real show's fixed sponsor break: programme, then the same read
    // every time at the same offset, then more programme. Nothing about its position
    // varies, so nothing here says "boundary."
    const read = noise(44, subs(8));
    const episodes = [
      { id: 'e1', fingerprint: join(noise(45, subs(9)), read, noise(46, subs(9))) },
      { id: 'e2', fingerprint: join(noise(47, subs(9)), read, noise(48, subs(9))) },
      { id: 'e3', fingerprint: join(noise(49, subs(9)), read, noise(50, subs(9))) },
    ];

    assert.deepEqual(findHeadAnchors(episodes), []);
  });

  it('proposes nothing from fewer than two usable episodes', () => {
    assert.deepEqual(findHeadAnchors([{ id: 'e1', fingerprint: noise(1, subs(30)) }]), []);
    assert.deepEqual(findHeadAnchors([]), []);
  });
});

describe('taking a clip from a candidate region', () => {
  it('insets the clip and reports how far it moved from the true edge', () => {
    const ident = noise(50, subs(4));
    const fingerprintsById = new Map([
      ['e1', { hashes: join(ident, noise(51, subs(30))) }],
      ['e2', { hashes: join(noise(52, subs(20)), ident, noise(53, subs(30))) }],
    ]);
    const candidate = {
      occurrences: [
        { episodeId: 'e1', startMs: 0, endMs: 4000 },
        { episodeId: 'e2', startMs: 20_000, endMs: 24_000 },
      ],
    };

    const clip = anchorClipFrom(candidate, fingerprintsById);
    assert.ok(clip, 'a four-second region should yield a clip');
    assert.equal(clip.exemplarEpisodeId, 'e1', 'took the clip from the first of two equally long occurrences');
    assert.equal(clip.leadMs, Math.round(Math.round(CLIP_GUARD_MS / SUB_MS) * SUB_MS), 'lead is the rounded guard');
    assert.ok(clip.hashes.length > 0);

    // The clip located back inside the exemplar itself must land near the guard —
    // proving leadMs actually corrects a located offset back to the true edge.
    const hit = locateAnchor(clip.hashes, fingerprintsById.get('e1').hashes);
    assert.ok(hit);
    assert.ok(Math.abs(hit.atMs - clip.leadMs) < 100, `hit at ${hit.atMs}ms should be near leadMs ${clip.leadMs}ms`);
    assert.ok(Math.abs(hit.atMs - clip.leadMs - 0) < 100, 'correcting by leadMs should land back at the true onset (0ms)');
  });

  it('prefers the longest occurrence, not the earliest, to a shorter one an edge has clamped', () => {
    // The shape a real jingle-at-0:00 occurrence takes: findRepeatedAudio's own edge
    // correction cannot push before frame 0, so an occurrence starting at 0 is
    // shorter than one with room either side of it, even though both describe the
    // same audio. Picking "earliest" would reliably pick the clamped, shorter one.
    const ident = noise(80, subs(4));
    const fingerprintsById = new Map([
      ['clamped', { hashes: join(ident.subarray(subs(1)), noise(81, subs(30))) }], // clamped at 0: only 3s visible
      ['clean', { hashes: join(noise(82, subs(20)), ident, noise(83, subs(30))) }], // the full 4s, mid-file
    ]);
    const candidate = {
      occurrences: [
        { episodeId: 'clamped', startMs: 0, endMs: subs(3) * SUB_MS },
        { episodeId: 'clean', startMs: 20_000, endMs: 20_000 + subs(4) * SUB_MS },
      ],
    };

    const clip = anchorClipFrom(candidate, fingerprintsById);
    assert.ok(clip, 'the longer occurrence should have yielded a clip');
    assert.equal(clip.exemplarEpisodeId, 'clean', 'took the clip from the shorter, edge-clamped occurrence');
  });

  it('declines a region too short to survive the inset', () => {
    const ident = noise(60, subs(1)); // one second — the guard alone would consume it
    const fingerprintsById = new Map([['e1', { hashes: ident }]]);
    const candidate = { occurrences: [{ episodeId: 'e1', startMs: 0, endMs: 1000 }] };

    assert.equal(anchorClipFrom(candidate, fingerprintsById), null);
  });

  it('declines when the exemplar has no fingerprint', () => {
    const candidate = { occurrences: [{ episodeId: 'gone', startMs: 0, endMs: 4000 }] };
    assert.equal(anchorClipFrom(candidate, new Map()), null);
  });

  it('caps the clip length, without changing leadMs', () => {
    const ident = noise(70, subs(10)); // a ten-second region, longer than MAX_CLIP_MS allows
    const fingerprintsById = new Map([['e1', { hashes: ident }]]);
    const candidate = { occurrences: [{ episodeId: 'e1', startMs: 0, endMs: 10_000 }] };

    const clip = anchorClipFrom(candidate, fingerprintsById);
    assert.ok(clip);
    assert.ok(clip.hashes.length * SUB_MS <= 3000 + SUB_MS, `clip is ${clip.hashes.length * SUB_MS}ms, above the 3s cap`);
    assert.equal(clip.leadMs, Math.round(Math.round(CLIP_GUARD_MS / SUB_MS) * SUB_MS));
  });
});
