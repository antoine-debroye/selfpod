import assert from 'node:assert/strict';
import { rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sharp from 'sharp';

import { EPISODE_STATUS, SCAN_TRIGGER, SHOW_STATUS } from '../../src/constants.js';
import { createTestInstance } from '../helpers/harness.js';

let app;

beforeEach(async () => {
  app = await createTestInstance();
});

afterEach(async () => {
  await app.cleanup();
});

async function scanAll() {
  return app.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
}

describe('show discovery (spec §5)', () => {
  it('turns a new folder into a show with no configuration anywhere', async () => {
    await app.makeShowFolder('late-night-tape-club');
    await scanAll();

    const show = app.shows.getBySlug('late-night-tape-club');
    assert.ok(show, 'the folder should have become a show');
    assert.equal(show.title, 'Late Night Tape Club', 'title humanised from the folder name');
    assert.equal(show.feed_token.length, 22);
    assert.equal(show.status, SHOW_STATUS.ACTIVE);
  });

  it('imports show.json once when discovering a folder', async () => {
    const dir = await app.makeShowFolder('imported');
    await writeFile(
      join(dir, 'show.json'),
      JSON.stringify({
        title: 'Imported Title',
        description: 'From disk',
        author_name: 'Disk Author',
        author_email: 'disk@example.com',
        language: 'fr',
        category: 'Arts → Books',
        explicit: true,
      }),
    );
    await scanAll();

    const show = app.shows.getBySlug('imported');
    assert.equal(show.title, 'Imported Title');
    assert.equal(show.author_email, 'disk@example.com');
    assert.equal(show.language, 'fr');
    assert.equal(show.itunes_category, 'Arts');
    assert.equal(show.itunes_subcategory, 'Books');
    assert.equal(show.explicit, 1);
  });

  it('never lets show.json override a later edit (the database is authoritative)', async () => {
    const dir = await app.makeShowFolder('authoritative');
    await writeFile(join(dir, 'show.json'), JSON.stringify({ title: 'From Disk' }));
    await scanAll();

    const show = app.shows.getBySlug('authoritative');
    app.shows.update(show.id, { title: 'Edited In UI' });
    await scanAll();

    assert.equal(app.shows.getBySlug('authoritative').title, 'Edited In UI');
  });

  it('ignores folder names that cannot appear in a URL, and says so', async () => {
    await app.makeShowFolder('has spaces');
    const record = await scanAll();
    assert.equal(app.shows.getBySlug('has spaces'), null);
    assert.ok(
      record.warnings.some((w) => w.message.includes("can't be used in a feed URL")),
      'the skipped folder must be visible in the activity log',
    );
  });

  it('pauses a show whose folder disappears instead of deleting its data', async () => {
    await app.addAudio('vanishing', 'sample.mp3');
    await scanAll();
    const show = app.shows.getBySlug('vanishing');
    assert.equal(app.episodes.counts(show.id).active, 1);

    await rm(join(app.config.showsDir, 'vanishing'), { recursive: true, force: true });
    await scanAll();

    const paused = app.shows.get(show.id);
    assert.equal(paused.status, SHOW_STATUS.FOLDER_MISSING);
    assert.ok(paused.folder_missing_since);
    assert.equal(app.episodes.counts(show.id).total, 1, 'episode rows survive for the confirm-purge step');
  });
});

describe('episode scanning (spec §6.3)', () => {
  it('picks up every supported format with the right MIME type', async () => {
    for (const fixture of ['sample.mp3', 'sample.m4a', 'sample.aac', 'sample.ogg', 'sample.opus', 'sample.wav', 'sample.flac']) {
      await app.addAudio('all-formats', fixture);
    }
    await scanAll();

    const show = app.shows.getBySlug('all-formats');
    const byName = new Map(app.episodes.listByShow(show.id).map((e) => [e.filename, e]));
    assert.equal(byName.size, 7);
    assert.equal(byName.get('sample.m4a').mime_type, 'audio/x-m4a');
    assert.equal(byName.get('sample.mp3').mime_type, 'audio/mpeg');
    assert.equal(byName.get('sample.opus').mime_type, 'audio/opus');
    for (const episode of byName.values()) {
      assert.ok(episode.duration_seconds > 0, `${episode.filename} should have a duration`);
      assert.ok(episode.file_size_bytes > 0);
    }
  });

  it('warns about an unsupported audio file rather than ignoring it silently', async () => {
    const dir = await app.makeShowFolder('unsupported');
    await writeFile(join(dir, 'episode-99.wma'), 'not really audio');
    const record = await scanAll();
    const warning = record.warnings.find((w) => w.file === 'episode-99.wma');
    assert.ok(warning, 'the ignored file must appear in the activity log');
    assert.match(warning.message, /mp3, m4a/);
  });

  it('keeps the GUID stable when a file is renamed on disk', async () => {
    await app.addAudio('renames', 'sample.mp3', 'original.mp3');
    await scanAll();
    const show = app.shows.getBySlug('renames');
    const before = app.episodes.listByShow(show.id)[0];

    await rename(
      join(app.config.showsDir, 'renames', 'original.mp3'),
      join(app.config.showsDir, 'renames', "renamed 🎙️ it's ‘live’.mp3"),
    );
    await scanAll();

    const after = app.episodes.listByShow(show.id);
    assert.equal(after.length, 1, 'a rename must not create a second episode');
    assert.equal(after[0].id, before.id, 'the GUID must not change');
    assert.equal(after[0].filename, "renamed 🎙️ it's ‘live’.mp3");
  });

  it('never overwrites a title the user edited', async () => {
    await app.addAudio('titles', 'sample.mp3');
    await scanAll();
    const show = app.shows.getBySlug('titles');
    const episode = app.episodes.listByShow(show.id)[0];

    app.episodes.update(episode.id, { title: 'My Careful Title' });
    await app.scanner.scanShowNow(show.id, SCAN_TRIGGER.MANUAL, { rehash: true });

    const after = app.episodes.get(episode.id);
    assert.equal(after.title, 'My Careful Title');
    assert.equal(after.title_is_custom, 1);
  });

  it('suggests a title from the filename, stripping a date prefix', async () => {
    await app.addAudio('naming', 'sample.wav', '2026-08-07-episode-one.wav');
    await scanAll();
    const show = app.shows.getBySlug('naming');
    assert.equal(app.episodes.listByShow(show.id)[0].title, 'Episode One');
  });

  it('defaults the publish date to the file mtime', async () => {
    const path = await app.addAudio('dates', 'sample.mp3');
    const when = new Date('2026-03-04T05:06:07.000Z');
    await utimes(path, when, when);
    await scanAll();
    const show = app.shows.getBySlug('dates');
    assert.equal(app.episodes.listByShow(show.id)[0].pub_date, when.toISOString());
  });

  it('skips re-hashing unchanged files but still notices a new one', async () => {
    await app.addAudio('incremental', 'sample.mp3', 'one.mp3');
    const first = await scanAll();
    assert.equal(first.added, 1);

    const second = await scanAll();
    assert.equal(second.added, 0, 'a repeat scan must not re-add anything');
    assert.equal(second.updated, 0, 'nothing changed, so nothing should be written');

    await app.addAudio('incremental', 'sample.m4a', 'two.m4a');
    const third = await scanAll();
    assert.equal(third.added, 1);
    assert.equal(third.filesFound, 2);
  });

  it('ignores subdirectories inside a show folder', async () => {
    await app.addAudio('nested', 'sample.mp3', 'top.mp3');
    await app.makeShowFolder(join('nested', 'season-2'));
    await app.addAudio(join('nested', 'season-2'), 'sample.mp3', 'buried.mp3');
    await scanAll();
    const show = app.shows.getBySlug('nested');
    const names = app.episodes.listByShow(show.id).map((e) => e.filename);
    assert.deepEqual(names, ['top.mp3']);
  });
});

describe('byte-identical files (content-based identity)', () => {
  it('publishes one episode and says so, rather than silently dropping the duplicate', async () => {
    // Identity is derived from content, so two copies of the same audio are the
    // same episode. That is intended — but it must be visible, not silent.
    await app.addAudio('duplicates', 'sample.mp3', 'episode-a.mp3');
    await app.addAudio('duplicates', 'sample.mp3', 'episode-b.mp3');
    const record = await scanAll();

    const show = app.shows.getBySlug('duplicates');
    assert.equal(app.episodes.listByShow(show.id).length, 1);
    const warning = record.warnings.find((w) => w.message.includes('same audio'));
    assert.ok(warning, 'the collapsed duplicate must be reported in the activity log');
    assert.match(warning.message, /episode-[ab]\.mp3/);
  });

  it('keeps the same filename across rescans instead of flip-flopping', async () => {
    await app.addAudio('stable', 'sample.mp3', 'aaa-first.mp3');
    await app.addAudio('stable', 'sample.mp3', 'zzz-second.mp3');
    await scanAll();
    const show = app.shows.getBySlug('stable');
    const first = app.episodes.listByShow(show.id)[0].filename;

    await app.scanner.scanShowNow(show.id, SCAN_TRIGGER.MANUAL, { rehash: true });
    assert.equal(app.episodes.listByShow(show.id)[0].filename, first);
  });
});

describe('missing files and the grace period (spec §6.3)', () => {
  it('marks a vanished file missing but keeps it in the feed', async () => {
    await app.addAudio('blips', 'sample.mp3', 'ep1.mp3');
    await scanAll();
    const show = app.shows.getBySlug('blips');
    const episode = app.episodes.listByShow(show.id)[0];

    await rm(join(app.config.showsDir, 'blips', 'ep1.mp3'));
    await scanAll();

    const after = app.episodes.get(episode.id);
    assert.equal(after.status, EPISODE_STATUS.MISSING);
    assert.ok(after.missing_since);
    assert.equal(
      app.episodes.listForFeed(show.id).length,
      1,
      'a share blip must not drop the episode from the feed',
    );
  });

  it('drops it from the feed once the grace period has passed', async () => {
    await app.addAudio('grace', 'sample.mp3', 'ep1.mp3');
    await scanAll();
    const show = app.shows.getBySlug('grace');
    await rm(join(app.config.showsDir, 'grace', 'ep1.mp3'));
    await scanAll();

    const swept = app.episodes.sweepMissing(0); // as if the grace period elapsed
    assert.equal(swept.length, 1);
    assert.equal(app.episodes.listForFeed(show.id).length, 0);
  });

  it('restores the same GUID when the file comes back', async () => {
    await app.addAudio('return', 'sample.mp3', 'ep1.mp3');
    await scanAll();
    const show = app.shows.getBySlug('return');
    const before = app.episodes.listByShow(show.id)[0];

    const path = join(app.config.showsDir, 'return', 'ep1.mp3');
    const backup = join(app.dataDir, 'stashed.mp3');
    await rename(path, backup);
    await scanAll();
    assert.equal(app.episodes.get(before.id).status, EPISODE_STATUS.MISSING);

    await rename(backup, path);
    await scanAll();

    const after = app.episodes.get(before.id);
    assert.equal(after.status, EPISODE_STATUS.ACTIVE);
    assert.equal(after.id, before.id, 'the GUID must survive the round trip');
    assert.equal(app.episodes.listByShow(show.id).length, 1);
  });
});

describe('"remove from feed" is not undone by a rescan (spec §11.3)', () => {
  it('leaves a user-removed episode removed even though its file is present', async () => {
    await app.addAudio('removals', 'sample.mp3', 'ep1.mp3');
    await scanAll();
    const show = app.shows.getBySlug('removals');
    const episode = app.episodes.listByShow(show.id)[0];

    app.episodes.removeFromFeed(episode.id);
    assert.equal(app.episodes.listForFeed(show.id).length, 0);

    await app.scanner.scanShowNow(show.id, SCAN_TRIGGER.MANUAL, { rehash: true });

    const after = app.episodes.get(episode.id);
    assert.equal(after.status, EPISODE_STATUS.REMOVED, 'the rescan must not resurrect it');
    assert.equal(app.episodes.listByShow(show.id).length, 1, 'and must not add a duplicate');
  });

  it('still tracks a rename while the episode is removed', async () => {
    await app.addAudio('removed-rename', 'sample.mp3', 'ep1.mp3');
    await scanAll();
    const show = app.shows.getBySlug('removed-rename');
    const episode = app.episodes.listByShow(show.id)[0];
    app.episodes.removeFromFeed(episode.id);

    await rename(
      join(app.config.showsDir, 'removed-rename', 'ep1.mp3'),
      join(app.config.showsDir, 'removed-rename', 'ep1-renamed.mp3'),
    );
    await app.scanner.scanShowNow(show.id, SCAN_TRIGGER.MANUAL, { rehash: true });

    const after = app.episodes.get(episode.id);
    assert.equal(after.filename, 'ep1-renamed.mp3');
    assert.equal(after.status, EPISODE_STATUS.REMOVED);
  });

  it('restores it only when the user explicitly asks', async () => {
    await app.addAudio('restore', 'sample.mp3', 'ep1.mp3');
    await scanAll();
    const show = app.shows.getBySlug('restore');
    const episode = app.episodes.listByShow(show.id)[0];
    app.episodes.removeFromFeed(episode.id);
    app.episodes.restoreToFeed(episode.id);
    assert.equal(app.episodes.listForFeed(show.id).length, 1);
  });
});

describe('cover art (spec §10)', () => {
  async function writeCover(slug, filename, { width = 1500, height = 1500 } = {}) {
    const dir = join(app.config.showsDir, slug);
    const buffer = await sharp({
      create: { width, height, channels: 3, background: { r: 62, g: 45, b: 74 } },
    })
      [filename.endsWith('.png') ? 'png' : filename.endsWith('.webp') ? 'webp' : 'jpeg']()
      .toBuffer();
    await writeFile(join(dir, filename), buffer);
  }

  it('detects cover.png, not just cover.jpg', async () => {
    await app.addAudio('png-cover', 'sample.mp3');
    await writeCover('png-cover', 'cover.png');
    await scanAll();

    const show = app.shows.getBySlug('png-cover');
    assert.equal(show.cover_filename, 'cover.png');
    assert.equal(show.cover_width, 1500);
    assert.equal(show.cover_format, 'png');
  });

  it('honours the documented filename priority order', async () => {
    await app.addAudio('priority', 'sample.mp3');
    await writeCover('priority', 'artwork.jpg');
    await writeCover('priority', 'cover.webp');
    await scanAll();
    // cover.webp comes before artwork.jpg in COVER_FILENAMES
    assert.equal(app.shows.getBySlug('priority').cover_filename, 'cover.webp');
  });

  it('warns with the real dimensions when artwork is too small, without blocking', async () => {
    await app.addAudio('small-cover', 'sample.mp3');
    await writeCover('small-cover', 'cover.jpg', { width: 200, height: 200 });
    const record = await scanAll();

    const warning = record.warnings.find((w) => w.message.includes('200×200'));
    assert.ok(warning, 'the warning must quote the actual detected size');
    assert.match(warning.message, /1400–3000px/);
    assert.ok(app.shows.getBySlug('small-cover').cover_filename, 'the cover is still used');
  });

  it('warns when a show has no artwork at all', async () => {
    await app.addAudio('no-cover', 'sample.mp3');
    const record = await scanAll();
    assert.ok(record.warnings.some((w) => w.message.includes('no cover art')));
  });

  it('pads non-square artwork to 1400 square on request', async () => {
    await app.addAudio('normalise', 'sample.mp3');
    await writeCover('normalise', 'cover.jpg', { width: 1600, height: 900 });
    await scanAll();

    const dir = join(app.config.showsDir, 'normalise');
    const result = await app.covers.normalise(dir, 'cover.jpg');
    assert.equal(result.after.width, 1400);
    assert.equal(result.after.height, 1400);
    assert.equal(result.after.warning, null, 'the warning should be resolved afterwards');
  });
});

describe('scan logging (spec §11.5)', () => {
  it('records counts and a per-show row for every scan', async () => {
    await app.addAudio('logged', 'sample.mp3');
    await scanAll();

    const entries = app.activity.list({ limit: 10 });
    assert.ok(entries.length >= 2, 'a global row plus a per-show row');
    const global = entries.find((e) => e.show_id === null);
    assert.equal(global.trigger, SCAN_TRIGGER.MANUAL);
    assert.equal(global.added, 1);
    assert.ok(global.finished_at, 'the row must be closed so "when did this last run" is answerable');
  });

  it('reports a permission failure as an actionable sentence naming the UID', async () => {
    const error = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const formatted = app.activity.formatFileError('/data/shows/x/ep.wav', error);
    assert.match(formatted.message, /Permission denied/);
    assert.match(formatted.message, /UID \d+/);
    assert.match(formatted.message, /PUID\/PGID/);
    assert.ok(!formatted.message.includes('at Object.'), 'no stack traces in user-facing text');
  });
});
