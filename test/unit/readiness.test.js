import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCovers } from '../../src/services/covers.js';
import { createReadiness } from '../../src/services/readiness.js';

/**
 * Readiness is a pure function of a show row and four numbers, and these tests
 * are the proof: not one of them opens a database, starts a server or touches
 * the filesystem. If that ever stops being true, this file stops compiling long
 * before anyone notices an N+1 on the dashboard.
 *
 * The real `createCovers` is used rather than a stub, so Apple's 1400–3000px
 * range is genuinely exercised instead of being restated in the test.
 */
const readiness = createReadiness({ covers: createCovers({ config: {}, logger: null }) });

/** A show that would be accepted by a directory today: every check passes. */
function readyShow(overrides = {}) {
  return {
    id: 'show-1',
    slug: 'late-night',
    title: 'Late Night',
    description: 'Two people talking after everyone else has gone to bed.',
    author_name: 'Sam Okonkwo',
    author_email: 'sam@example.com',
    language: 'en',
    itunes_category: 'Society & Culture',
    itunes_subcategory: 'Personal Journals',
    explicit: 0,
    cover_filename: 'cover.jpg',
    cover_width: 1500,
    cover_height: 1500,
    cover_format: 'jpeg',
    status: 'active',
    directory_listing: 'allowed',
    ...overrides,
  };
}

/** Counts for a healthy three-episode feed. */
function counts(overrides = {}) {
  return {
    active: 3,
    missing: 0,
    removed: 0,
    expired: 0,
    total: 3,
    inFeed: 3,
    scheduled: 0,
    inFeedNoDuration: 0,
    ...overrides,
  };
}

function report(showOverrides = {}, ctxOverrides = {}) {
  return readiness.forShow(readyShow(showOverrides), {
    counts: counts(ctxOverrides.counts),
    baseUrl: 'baseUrl' in ctxOverrides ? ctxOverrides.baseUrl : 'https://podcast.example.com',
    folder: ctxOverrides.folder ?? '/data/shows/late-night',
  });
}

const byId = (result) => Object.fromEntries(result.checks.map((c) => [c.id, c]));
const ids = (result) => result.checks.map((c) => c.id);

describe('directory readiness', () => {
  it('builds a full report from a plain row, with no database anywhere', () => {
    const result = report();
    assert.equal(result.ready, true);
    assert.equal(result.blocking, 0);
    assert.equal(result.advisory, 0);
    assert.deepEqual(result.failed, []);
    assert.ok(result.checks.length >= 13);
    for (const check of result.checks) {
      assert.ok(['error', 'warn'].includes(check.level), `${check.id} uses health's vocabulary`);
      assert.notEqual(check.level, 'info', 'there is deliberately no info level');
      assert.equal(typeof check.label, 'string');
      assert.ok(check.detail, `${check.id} carries a detail even when it passes`);
    }
  });

  it('gives a passing check a fact, not just a tick', () => {
    const checks = byId(report());
    assert.equal(checks.artwork_size.detail, '1500×1500px');
    assert.equal(checks.owner_email.detail, 'sam@example.com');
    assert.match(checks.category.detail, /Society & Culture/);
    assert.match(checks.episodes_present.detail, /3 episodes in the feed/);
  });
});

describe('artwork', () => {
  it('reports artwork as blocking when a show has no cover file', () => {
    const result = report({ cover_filename: null, cover_width: null, cover_height: null, cover_format: null });
    const check = byId(result).artwork_present;
    assert.equal(check.ok, false);
    assert.equal(check.level, 'error');
    assert.ok(result.blocking >= 1);
    assert.equal(result.ready, false);
  });

  it('omits the artwork format and size checks entirely when there is no artwork', () => {
    // Not "unknown", absent: a row that cannot be evaluated is noise stacked on
    // top of the row that actually needs attention.
    const result = report({ cover_filename: null, cover_width: null, cover_height: null, cover_format: null });
    assert.ok(!ids(result).includes('artwork_format'));
    assert.ok(!ids(result).includes('artwork_size'));
  });

  it('reports a cover.webp as blocking even though its feed URL ends in cover.jpg', () => {
    const result = report({ cover_filename: 'cover.webp', cover_format: 'webp' });
    const check = byId(result).artwork_format;
    assert.equal(check.ok, false);
    assert.equal(check.level, 'error');
    assert.match(check.detail, /WEBP/);
    assert.match(check.detail, /cover\.jpg/, 'the copy must say the address reveals nothing');
    assert.equal(result.ready, false);
  });

  it('reports an unreadable cover as blocking rather than assuming it is fine', () => {
    const result = report({ cover_filename: 'cover.jpg', cover_format: null });
    assert.equal(byId(result).artwork_format.ok, false);
  });

  it('reports a 1000×1000 cover as blocking while still saying subscribers see it as it is', () => {
    const result = report({ cover_width: 1000, cover_height: 1000 });
    const check = byId(result).artwork_size;
    assert.equal(check.ok, false);
    assert.equal(check.level, 'error', 'covers.js calls this cosmetic; a submission does not');
    assert.match(check.detail, /1000×1000px/);
    assert.match(check.detail, /smaller than 1400px/);
    assert.match(check.detail, /subscribers see it as it is/);
    assert.match(check.detail, /1400 and 3000px/);
    assert.equal(result.ready, false);
  });

  it('reports a 1500×1000 cover as not square', () => {
    const check = byId(report({ cover_width: 1500, cover_height: 1000 })).artwork_size;
    assert.equal(check.ok, false);
    assert.match(check.detail, /not square/);
    assert.match(check.detail, /1500×1000px/);
  });

  it('passes every artwork check for a 1500×1500 JPEG', () => {
    const checks = byId(report());
    for (const id of ['artwork_present', 'artwork_format', 'artwork_size']) {
      assert.equal(checks[id].ok, true, `${id} should pass`);
    }
  });

  it('omits the size check when the image could not be measured', () => {
    const result = report({ cover_width: null, cover_height: null, cover_format: null });
    assert.ok(ids(result).includes('artwork_format'), 'there is still a file with a format to judge');
    assert.ok(!ids(result).includes('artwork_size'), 'but no dimensions to judge');
  });
});

describe('metadata', () => {
  it('reports an empty description as blocking, and one word clears it', () => {
    const empty = byId(report({ description: '   ' })).description;
    assert.equal(empty.ok, false);
    assert.equal(empty.level, 'error');
    assert.equal(byId(report({ description: 'Talking.' })).description.ok, true);
  });

  it('reports a missing owner email as blocking', () => {
    const check = byId(report({ author_email: '' })).owner_email;
    assert.equal(check.ok, false);
    assert.equal(check.level, 'error');
  });

  it('reports a missing author name as advisory, not blocking', () => {
    const result = report({ author_name: '' });
    const check = byId(result).author_name;
    assert.equal(check.ok, false);
    assert.equal(check.level, 'warn');
    assert.equal(result.blocking, 0);
    assert.equal(result.advisory, 1);
    assert.equal(result.ready, true);
  });

  it('reports a category that is not on Apple’s list as blocking', () => {
    for (const value of ['Podcasts', 'society & culture', '']) {
      const result = report({ itunes_category: value });
      assert.equal(byId(result).category.ok, false, `${JSON.stringify(value)} is not Apple's string`);
      assert.equal(result.ready, false);
    }
    assert.equal(byId(report({ itunes_category: 'Technology' })).category.ok, true);
  });
});

describe('episodes', () => {
  it('gives all three episodes_present wordings for the three cases, and they differ', () => {
    const noEpisodes = byId(
      report({}, { counts: { active: 0, total: 0, inFeed: 0, scheduled: 0 } }),
    ).episodes_present;
    const allScheduled = byId(
      report({}, { counts: { active: 2, total: 2, inFeed: 0, scheduled: 2 } }),
    ).episodes_present;
    const noneInFeed = byId(
      report({}, { counts: { active: 0, total: 4, inFeed: 0, scheduled: 0, removed: 4 } }),
    ).episodes_present;

    for (const check of [noEpisodes, allScheduled, noneInFeed]) {
      assert.equal(check.ok, false);
      assert.equal(check.level, 'error');
    }

    const details = new Set([noEpisodes.detail, allScheduled.detail, noneInFeed.detail]);
    assert.equal(details.size, 3, 'each case earns its own advice');

    // Telling someone to drop a file into a folder that already has files reads
    // as SelfPod not having looked.
    assert.match(noEpisodes.detail, /\/data\/shows\/late-night/);
    assert.ok(!allScheduled.detail.includes('/data/shows/late-night'));
    assert.ok(!noneInFeed.detail.includes('/data/shows/late-night'));

    assert.match(allScheduled.detail, /future/);
    assert.match(noneInFeed.detail, /empty podcast/);
  });

  it('omits the duration and on-disk checks when the feed is empty', () => {
    const result = report({}, { counts: { active: 0, total: 0, inFeed: 0 } });
    assert.ok(!ids(result).includes('episode_durations'), 'no episodes, no duration claim to make');
    assert.ok(!ids(result).includes('episodes_on_disk'));
  });

  it('counts episodes without a duration rather than reporting all-or-nothing', () => {
    const check = byId(report({}, { counts: { inFeed: 7, active: 7, total: 7, inFeedNoDuration: 2 } }))
      .episode_durations;
    assert.equal(check.ok, false);
    assert.equal(check.level, 'warn');
    assert.match(check.detail, /2 of 7/);
  });

  it('reports missing files on disk as advisory', () => {
    const result = report({}, { counts: { active: 2, missing: 1, inFeed: 3, total: 3 } });
    const check = byId(result).episodes_on_disk;
    assert.equal(check.ok, false);
    assert.equal(check.level, 'warn');
    assert.equal(result.ready, true, 'a file inside its grace period does not block a submission');
  });

  it('treats absent counts fields as zero so a pre-migration caller still works', () => {
    const result = readiness.forShow(readyShow(), {
      counts: { active: 3, missing: 0, removed: 0, expired: 0, total: 3, inFeed: 3 },
      baseUrl: 'https://podcast.example.com',
      folder: '/data/shows/late-night',
    });
    assert.equal(result.ready, true);
    assert.equal(byId(result).episode_durations.ok, true);
  });
});

describe('environment', () => {
  it('reports a missing show folder as blocking', () => {
    const result = report({ status: 'folder_missing' });
    const check = byId(result).folder_present;
    assert.equal(check.ok, false);
    assert.equal(check.level, 'error');
    assert.match(check.detail, /\/data\/shows\/late-night/);
    assert.equal(result.ready, false);
  });

  it('reports no public base URL as blocking', () => {
    const result = report({}, { baseUrl: null });
    const check = byId(result).base_url;
    assert.equal(check.ok, false);
    assert.equal(check.level, 'error');
    assert.equal(result.ready, false);
  });
});

describe('directory listing', () => {
  it('reports a blocked directory listing as blocking, without scolding wording', () => {
    const result = report({ directory_listing: 'blocked' });
    const check = byId(result).directory_listing;
    assert.equal(check.ok, false);
    assert.equal(check.level, 'error');
    assert.equal(result.ready, false);
    // It is a deliberate setting doing exactly what it was asked to do.
    assert.match(check.detail, /what a private feed usually wants/);
    assert.ok(
      !/\b(should|must|wrong|mistake|failed|forgot)\b/i.test(check.detail),
      `copy must not tell the user off: ${check.detail}`,
    );
  });

  it('treats a missing directory_listing (pre-migration row) as allowed', () => {
    const row = readyShow();
    delete row.directory_listing;
    const result = readiness.forShow(row, {
      counts: counts(),
      baseUrl: 'https://podcast.example.com',
      folder: '/data/shows/late-night',
    });
    assert.equal(byId(result).directory_listing.ok, true);
    assert.equal(result.ready, true);
  });
});

describe('report shape', () => {
  it('says a show is ready when only advisories are failing', () => {
    const result = report({ author_name: '' }, { counts: { inFeed: 3, active: 2, missing: 1, total: 3, inFeedNoDuration: 1 } });
    assert.equal(result.blocking, 0);
    assert.equal(result.advisory, 3);
    assert.equal(result.ready, true, 'advisories never block a submission');
    assert.equal(result.failed.length, 3);
    for (const check of result.failed) assert.equal(check.ok, false);
  });

  it('returns checks in the same order whatever the outcome', () => {
    // The panel must not reshuffle itself between renders.
    const allPassing = ids(report());
    const allFailing = ids(
      report(
        {
          description: '',
          author_name: '',
          author_email: '',
          itunes_category: 'Nonsense',
          status: 'folder_missing',
          cover_filename: 'cover.webp',
          cover_format: 'webp',
          cover_width: 900,
          cover_height: 700,
          directory_listing: 'blocked',
        },
        { baseUrl: null, counts: { inFeed: 1, active: 1, total: 1, missing: 1, inFeedNoDuration: 1 } },
      ),
    );
    assert.deepEqual(allFailing, allPassing);
    assert.deepEqual(allPassing, [
      'base_url',
      'folder_present',
      'episodes_present',
      'artwork_present',
      'artwork_format',
      'artwork_size',
      'description',
      'owner_email',
      'category',
      'directory_listing',
      'author_name',
      'episode_durations',
      'episodes_on_disk',
    ]);
  });
});
