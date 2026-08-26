import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { frameProfile } from '../../src/lib/mp3-frames.js';
import {
  findRepeatedSegments,
  safeToApproveAutomatically,
} from '../../src/lib/repeated-segments.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';

/** 1152 samples at 44.1 kHz, so a run of frames converts straight to seconds. */
const framesFor = (seconds) => Math.round((seconds * 1000) / FRAME_MS);

/**
 * A show, built the way a produced podcast is: the same theme every week, an episode
 * of its own, the same sponsor read in the middle, the same outro at the end.
 */
function makeShow({
  episodes = 5,
  themeSeconds = 25,
  sponsorSeconds = 30,
  outroSeconds = 30,
  programmeSeconds = 40,
} = {}) {
  const out = [];
  for (let n = 0; n < episodes; n += 1) {
    const file = stitch(
      segment(1_000, framesFor(themeSeconds)),
      segment(100_000 + n * 50_000, framesFor(programmeSeconds)),
      segment(2_000, framesFor(sponsorSeconds)),
      segment(600_000 + n * 50_000, framesFor(programmeSeconds)),
      segment(3_000, framesFor(outroSeconds)),
    );
    const profile = frameProfile(file);
    out.push({ id: `ep${n}`, hashes: profile.hashes, durationMs: profile.durationMs });
  }
  return out;
}

/** Adds the millisecond fields the approval guard reads. */
function withTiming(found, episodes) {
  const durations = Object.fromEntries(episodes.map((episode) => [episode.id, episode.durationMs]));
  return {
    durations,
    segments: found.map((entry) => ({
      ...entry,
      durationMs: entry.frames * FRAME_MS,
      occurrences: entry.occurrences.map((occurrence) => ({
        ...occurrence,
        startMs: occurrence.start * FRAME_MS,
        endMs: occurrence.end * FRAME_MS,
      })),
    })),
  };
}

describe('finding what a show repeats', () => {
  it('finds every repeated segment, and nothing else', () => {
    const episodes = makeShow();
    const found = findRepeatedSegments(episodes, { minEpisodes: 3 });

    assert.equal(found.length, 3, 'the theme, the sponsor read and the outro');
    const seconds = found.map((entry) => Math.round((entry.frames * FRAME_MS) / 1000)).sort((a, b) => a - b);
    assert.deepEqual(seconds, [25, 30, 30]);
  });

  it('counts distinct episodes, not occurrences', () => {
    // The number a threshold reads. A sixty-second advert that the search matched
    // three overlapping ways inside one file is one episode, and treating it as three
    // is how "appears in three episodes" fires on a single file.
    const episodes = makeShow({ episodes: 5 });
    for (const entry of findRepeatedSegments(episodes, { minEpisodes: 3 })) {
      assert.equal(entry.episodeCount, 5, 'present in all five');
      assert.equal(
        new Set(entry.occurrences.map((occurrence) => occurrence.episodeId)).size,
        entry.occurrences.length,
        'and once in each, after overlapping matches are merged',
      );
    }
  });

  it('counts every episode, however many there are', () => {
    // Regression. An earlier version stopped at the first match per seed, which paired
    // episodes off two at a time — so with an odd number the last one was never
    // paired, and a segment in all five was reported as being in four.
    for (const count of [2, 3, 4, 5, 7, 8]) {
      const episodes = makeShow({ episodes: count });
      const [biggest] = findRepeatedSegments(episodes, { minEpisodes: 2 });
      assert.equal(biggest.episodeCount, count, `${count} episodes were counted as ${biggest?.episodeCount}`);
    }
  });

  it('locates each occurrence where it actually is', () => {
    const episodes = makeShow({ themeSeconds: 25, programmeSeconds: 40 });
    const found = findRepeatedSegments(episodes, { minEpisodes: 3 });

    const theme = found.find((entry) => entry.occurrences.every((o) => o.start === 0));
    assert.ok(theme, 'the theme starts at the beginning of every episode');

    const sponsor = found.find((entry) => Math.round((entry.frames * FRAME_MS) / 1000) === 30
      && entry.occurrences[0].start > 0);
    assert.ok(sponsor);
    // Theme (25s) plus the first half of the programme (40s).
    assert.ok(
      Math.abs((sponsor.occurrences[0].start * FRAME_MS) / 1000 - 65) < 1.5,
      `sponsor read found at ${((sponsor.occurrences[0].start * FRAME_MS) / 1000).toFixed(1)}s, expected ~65s`,
    );
  });

  it('says nothing about a show that repeats nothing', () => {
    // The positive control. A detector that found segments in unrelated audio would
    // pass every test above and be worthless.
    const episodes = [];
    for (let n = 0; n < 5; n += 1) {
      const profile = frameProfile(segment(1_000_000 + n * 100_000, 3000));
      episodes.push({ id: `ep${n}`, hashes: profile.hashes, durationMs: profile.durationMs });
    }
    assert.deepEqual(findRepeatedSegments(episodes, { minEpisodes: 3 }), []);
  });

  it('needs more than one episode to have an opinion', () => {
    const [one] = makeShow({ episodes: 1 });
    assert.deepEqual(findRepeatedSegments([one], { minEpisodes: 1 }), []);
    assert.deepEqual(findRepeatedSegments([], {}), []);
    assert.deepEqual(findRepeatedSegments(null, {}), []);
  });

  it('honours the minimum episode count', () => {
    const episodes = makeShow({ episodes: 3 });
    assert.equal(findRepeatedSegments(episodes, { minEpisodes: 3 }).length, 3);
    assert.equal(findRepeatedSegments(episodes, { minEpisodes: 4 }).length, 0);
  });

  it('ignores something too short to be worth naming', () => {
    // Sized deliberately: long enough that the run is identifiable at all (a very
    // short one is discarded earlier, for lack of a stable signature), and shorter
    // than the minimum. Otherwise this passes without the minimum existing.
    const episodes = [];
    for (let n = 0; n < 4; n += 1) {
      const file = stitch(
        segment(9_000, 60), // ~1.6 seconds: a sting, not a segment
        segment(100_000 + n * 50_000, 2000),
      );
      const profile = frameProfile(file);
      episodes.push({ id: `ep${n}`, hashes: profile.hashes, durationMs: profile.durationMs });
    }

    assert.deepEqual(findRepeatedSegments(episodes, { minEpisodes: 3 }), []);
    // The control: it *is* findable, so the exclusion above is the minimum doing its
    // job rather than the detector missing it.
    assert.equal(
      findRepeatedSegments(episodes, { minEpisodes: 3, minRunFrames: 20 }).length,
      1,
    );
  });

  it('never reports two overlapping occurrences in one episode', () => {
    // The invariant that makes a merge step unnecessary: a run claims every frame it
    // covers as it is recorded, and a claimed frame can never seed or answer another
    // match. Asserted here rather than defended with code that never runs — including
    // against a theme that is the same bar looped four times, which is the case most
    // likely to make a run match a shifted copy of itself.
    const loop = () =>
      stitch(segment(5_000, 200), segment(5_000, 200), segment(5_000, 200), segment(5_000, 200));
    const episodes = [];
    for (let n = 0; n < 4; n += 1) {
      const profile = frameProfile(stitch(loop(), segment(100_000 + n * 50_000, 1500)));
      episodes.push({ id: `ep${n}`, hashes: profile.hashes, durationMs: profile.durationMs });
    }

    const found = findRepeatedSegments(episodes, { minEpisodes: 3 });
    assert.ok(found.length > 0, 'the looping theme was found');

    for (const entry of found) {
      const byEpisode = new Map();
      for (const occurrence of entry.occurrences) {
        if (!byEpisode.has(occurrence.episodeId)) byEpisode.set(occurrence.episodeId, []);
        byEpisode.get(occurrence.episodeId).push(occurrence);
      }
      for (const [episodeId, list] of byEpisode) {
        list.sort((a, b) => a.start - b.start);
        for (let i = 1; i < list.length; i += 1) {
          assert.ok(
            list[i].start >= list[i - 1].end,
            `${episodeId}: ${list[i - 1].start}-${list[i - 1].end} overlaps ${list[i].start}-${list[i].end}`,
          );
        }
      }
    }
  });

  it('does not let one episode look like three', () => {
    // The trap in "appears in at least three episodes". A show that plays the same
    // sponsor read twice in one episode produces several occurrences from a single
    // file, and counting occurrences instead of episodes fires the threshold on it.
    const episodes = [];
    for (let n = 0; n < 2; n += 1) {
      const file = stitch(
        segment(100_000 + n * 50_000, framesFor(20)),
        segment(2_000, framesFor(30)), // the sponsor read
        segment(300_000 + n * 50_000, framesFor(20)),
        segment(2_000, framesFor(30)), // and again, later in the same episode
        segment(700_000 + n * 50_000, framesFor(20)),
      );
      const profile = frameProfile(file);
      episodes.push({ id: `ep${n}`, hashes: profile.hashes, durationMs: profile.durationMs });
    }

    const [found] = findRepeatedSegments(episodes, { minEpisodes: 2 });
    assert.ok(found, 'the repeated read was found');
    assert.equal(found.episodeCount, 2, 'two episodes');
    assert.ok(found.occurrenceCount >= 4, 'but four or more occurrences');

    // And the threshold reads the episode count, so two episodes never satisfy three.
    assert.deepEqual(
      findRepeatedSegments(episodes, { minEpisodes: 3 }),
      [],
      'four occurrences across two episodes is not three episodes',
    );
  });

  it('stays fast on a real-sized library', () => {
    // Twenty episodes of about twenty minutes each: roughly the corpus a show builds
    // up after a few months of following it.
    const episodes = [];
    for (let n = 0; n < 20; n += 1) {
      const file = stitch(
        segment(1_000, framesFor(25)),
        segment(1_000_000 + n * 100_000, framesFor(600)),
        segment(2_000, framesFor(30)),
      );
      const profile = frameProfile(file);
      episodes.push({ id: `ep${n}`, hashes: profile.hashes, durationMs: profile.durationMs });
    }

    const started = process.hrtime.bigint();
    const found = findRepeatedSegments(episodes, { minEpisodes: 3 });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(found.length, 2);
    assert.equal(found[0].episodeCount, 20);
    assert.ok(ms < 15_000, `took ${ms.toFixed(0)}ms across 20 episodes`);
  });
});

describe('what may be cut without anyone looking first', () => {
  it('clears a sponsor read in the middle of the episode', () => {
    const episodes = makeShow();
    const { segments, durations } = withTiming(
      findRepeatedSegments(episodes, { minEpisodes: 3 }),
      episodes,
    );
    const sponsor = segments.find(
      (entry) => entry.occurrences[0].start > 0
        && entry.occurrences[0].endMs < episodes[0].durationMs - 20_000,
    );
    assert.ok(sponsor, 'the mid-episode segment was found');
    assert.deepEqual(safeToApproveAutomatically(sponsor, { episodeDurations: durations }), {
      safe: true,
      reason: null,
    });
  });

  it('refuses the theme tune, however many episodes it appears in', () => {
    // Not a corner case: "appears in at least three episodes" is the obvious rule, and
    // on any show with a theme it cuts the theme on episode three. Guaranteed, first
    // time, every time.
    const episodes = makeShow({ themeSeconds: 25 });
    const { segments, durations } = withTiming(
      findRepeatedSegments(episodes, { minEpisodes: 3 }),
      episodes,
    );
    const theme = segments.find((entry) => entry.occurrences.every((o) => o.start === 0));

    const verdict = safeToApproveAutomatically(theme, { episodeDurations: durations });
    assert.equal(verdict.safe, false);
    assert.equal(verdict.reason, 'always_at_the_start');
  });

  it('refuses the outro', () => {
    const episodes = makeShow({ outroSeconds: 30 });
    const { segments, durations } = withTiming(
      findRepeatedSegments(episodes, { minEpisodes: 3 }),
      episodes,
    );
    const outro = segments.find((entry) =>
      entry.occurrences.every((o) => o.endMs >= (durations[o.episodeId] ?? 0) - 1000),
    );
    assert.ok(outro, 'the closing segment was found');

    const verdict = safeToApproveAutomatically(outro, { episodeDurations: durations });
    assert.equal(verdict.safe, false);
    assert.equal(verdict.reason, 'always_at_the_end');
  });

  it('refuses anything too short or too long to be an advert', () => {
    const base = { episodeCount: 5, occurrences: [] };
    assert.equal(
      safeToApproveAutomatically({ ...base, durationMs: 6000 }, {}).reason,
      'too_short_to_be_an_advert',
    );
    assert.equal(
      safeToApproveAutomatically({ ...base, durationMs: 300_000 }, {}).reason,
      'too_long_to_be_an_advert',
      'a five-minute repeat is a recurring part of the programme, not an advert',
    );
  });

  it('refuses anything it has not seen often enough', () => {
    const verdict = safeToApproveAutomatically(
      { episodeCount: 2, durationMs: 30_000, occurrences: [] },
      { minEpisodes: 3 },
    );
    assert.equal(verdict.safe, false);
    assert.equal(verdict.reason, 'seen_too_few_times');
  });

  it('clears anything found by diffing two downloads, whatever its position', () => {
    // A theme tune is in both copies of an episode, so it can never be what differs
    // between them. Something that *does* differ between two fetches of the same
    // episode is an advert by construction.
    const verdict = safeToApproveAutomatically(
      { episodeCount: 1, durationMs: 8000, occurrences: [] },
      { source: 'diff' },
    );
    assert.deepEqual(verdict, { safe: true, reason: null });
  });
});
