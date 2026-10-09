import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { SCAN_TRIGGER } from '../../src/constants.js';
import { SETTING_KEYS } from '../../src/services/settings.js';
import { createTestServer } from '../helpers/http.js';

/**
 * The dashboard's weight, and the small things the October audit found around it:
 * a 1400 px cover in a 250 px card, one card fetch per show on Rescan all, four
 * access-log queries per show to paint cards that show none of the answers, a
 * sidebar that stopped at eight shows without saying so, and a handful of names.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

let server;

beforeEach(async () => {
  server = await createTestServer();
  await server.login();
});

afterEach(async () => {
  await server.cleanup();
});

async function cover(slug, { size = 1500, bytes = null } = {}) {
  await writeFile(
    join(server.config.showsDir, slug, 'cover.jpg'),
    bytes ?? (await sharp({ create: { width: size, height: size, channels: 3, background: '#3E2D4A' } }).jpeg().toBuffer()),
  );
}

async function seed(slug = 'late-night', { art = true } = {}) {
  await server.addAudio(slug, 'sample.mp3');
  if (art) await cover(slug);
  await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
  return server.shows.getBySlug(slug);
}

describe('the cover thumbnail (GET /media/:slug/:token/cover-400.jpg)', () => {
  it('is the cover at 400 px, a JPEG, with the cover headers and a token check', async () => {
    const show = await seed();
    const url = `/media/${show.slug}/${show.feed_token}/cover-400.jpg`;

    const full = await server.app.inject({ method: 'GET', url: `/media/${show.slug}/${show.feed_token}/cover.jpg` });
    assert.equal(full.statusCode, 200);
    const response = await server.app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/jpeg');
    assert.equal(response.headers['cache-control'], 'public, max-age=3600');
    const meta = await sharp(Buffer.from(response.rawPayload)).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 400);
    assert.ok(response.rawPayload.length < full.rawPayload.length / 4, 'the thumbnail should be a fraction of the cover');

    // Its ETag is the cover's with the width on the end: a new cover is a new thumbnail.
    assert.equal(response.headers.etag, full.headers.etag.replace(/"$/, '-400"'));
    const again = await server.app.inject({ method: 'GET', url, headers: { 'if-none-match': response.headers.etag } });
    assert.equal(again.statusCode, 304);

    // The wrong token is the same 404 the cover gives, not a hint that the show exists.
    const wrong = await server.app.inject({ method: 'GET', url: `/media/${show.slug}/not-the-token/cover-400.jpg` });
    assert.equal(wrong.statusCode, 404);
    const noShow = await server.app.inject({ method: 'GET', url: `/media/nobody/${show.feed_token}/cover-400.jpg` });
    assert.equal(noShow.statusCode, 404);
  });

  it('is made once and kept under the data directory, one per show', async () => {
    const show = await seed();
    const url = `/media/${show.slug}/${show.feed_token}/cover-400.jpg`;
    await server.app.inject({ method: 'GET', url });
    const first = (await readdir(server.config.coverThumbDir)).filter((name) => name.endsWith('.jpg'));
    assert.equal(first.length, 1);
    assert.ok(first[0].startsWith(`${show.id}-400-`), first[0]);

    await server.app.inject({ method: 'GET', url });
    assert.deepEqual((await readdir(server.config.coverThumbDir)).filter((name) => name.endsWith('.jpg')), first);

    // A new cover is a new file, and the old one is gone.
    await cover(show.slug, { size: 1600 });
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const refreshed = server.shows.get(show.id);
    const next = await server.app.inject({ method: 'GET', url: `/media/${refreshed.slug}/${refreshed.feed_token}/cover-400.jpg` });
    assert.equal(next.statusCode, 200);
    const second = (await readdir(server.config.coverThumbDir)).filter((name) => name.endsWith('.jpg'));
    assert.equal(second.length, 1);
    assert.notEqual(second[0], first[0]);
  });

  it('serves the full cover when the small one cannot be made, never a broken image', async () => {
    // Bytes the scanner accepts as the cover file but sharp cannot decode.
    const garbage = Buffer.from('not really a jpeg, but it is called one');
    await server.addAudio('odd-art', 'sample.mp3');
    await cover('odd-art', { bytes: garbage });
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const show = server.shows.getBySlug('odd-art');
    assert.equal(show.cover_filename, 'cover.jpg', 'setup: the scanner should still record the cover');

    const response = await server.app.inject({ method: 'GET', url: `/media/${show.slug}/${show.feed_token}/cover-400.jpg` });
    assert.equal(response.statusCode, 200);
    assert.ok(Buffer.from(response.rawPayload).equals(garbage), 'the full file, byte for byte');
    const full = await server.app.inject({ method: 'GET', url: `/media/${show.slug}/${show.feed_token}/cover.jpg` });
    assert.equal(response.headers.etag, full.headers.etag, 'the full cover under the thumbnail address carries the cover ETag');
    assert.equal((await readdir(server.config.coverThumbDir)).filter((name) => name.endsWith('.jpg')).length, 0);
  });

  it('is what the dashboard card asks for', async () => {
    const show = await seed();
    const body = (await server.get('/', { accept: 'text/html' })).body;
    assert.match(body, new RegExp(`<img class="art" src="/media/${show.slug}/${show.feed_token}/cover-400\\.jpg\\?v=[^"]*"`));
    assert.doesNotMatch(body, new RegExp(`src="/media/${show.slug}/${show.feed_token}/cover\\.jpg`), 'the full cover should not be on the dashboard');
  });
});

describe('the dashboard', () => {
  it('renders every card from two grouped queries, and the same card the per-show fragment renders', async () => {
    const a = await seed('alpha');
    const b = await seed('bravo', { art: false });
    // An owner address, so alpha's card shows its figures rather than the warning
    // that it has none; bravo has no artwork, so its card warns about that.
    server.settings.update({ [SETTING_KEYS.DEFAULT_AUTHOR_NAME]: 'Tape Club', [SETTING_KEYS.DEFAULT_AUTHOR_EMAIL]: 'owner@example.com' });
    server.shows.applyDefaultsToBlankShows();
    const [episode] = server.episodes.listByShow(a.id);
    // Some traffic, so the figures are not all zero.
    for (let n = 0; n < 3; n += 1) {
      server.stats.record({ showId: a.id, episodeId: episode.id, kind: 'download', statusCode: 200, bytesSent: 1000, totalBytes: 1000 });
    }
    server.stats.record({ showId: a.id, episodeId: episode.id, kind: 'stream', statusCode: 206, bytesSent: 10, totalBytes: 1000, rangeHeader: 'bytes=100-109' });
    server.stats.record({ showId: a.id, kind: 'feed', statusCode: 200, bytesSent: 500, totalBytes: 500 });
    server.stats.record({ showId: b.id, episodeId: server.episodes.listByShow(b.id)[0].id, kind: 'download', statusCode: 500, bytesSent: null, totalBytes: 1000 });

    // The figures the batch presenter hands each card are the per-show presenter's.
    const batch = server.presentShows([a, b]);
    const shared = ['downloads', 'streams', 'failures', 'bytes', 'episodesTouched', 'lastAt', 'feedFetches', 'feedLastAt'];
    for (const [index, show] of [a, b].entries()) {
      const single = server.presentShow(show).stats;
      for (const key of shared) assert.equal(batch[index].stats[key], single[key], `${show.slug} ${key}`);
    }
    assert.equal(batch[0].stats.downloads, 3);
    assert.equal(batch[0].stats.streams, 1);
    assert.equal(batch[0].stats.feedFetches, 1);
    assert.equal(batch[1].stats.failures, 1);

    // Rendering the dashboard asks the access log for every show at once, never per show.
    const calls = { forShow: 0, forShows: 0 };
    const original = { forShow: server.stats.forShow, forShows: server.stats.forShows };
    server.stats.forShow = (...args) => { calls.forShow += 1; return original.forShow.apply(server.stats, args); };
    server.stats.forShows = (...args) => { calls.forShows += 1; return original.forShows.apply(server.stats, args); };
    let dashboard;
    let grid;
    try {
      dashboard = await server.get('/', { accept: 'text/html' });
      grid = await server.get('/ui/dashboard/grid', { 'hx-request': 'true' });
    } finally {
      Object.assign(server.stats, original);
    }
    assert.equal(dashboard.statusCode, 200);
    assert.equal(grid.statusCode, 200);
    assert.equal(calls.forShow, 0, 'the dashboard must not ask the access log once per show');
    assert.equal(calls.forShows, 2, 'one grouped fetch per render');

    // And the card it paints is the card the per-show fragment paints: same markup, same numbers.
    const cardOf = (html, show) => {
      const match = html.match(new RegExp(`<article class="show-card[^"]*"\\s+id="show-card-${show.id}"[\\s\\S]*?</article>`));
      assert.ok(match, `no card for ${show.slug}`);
      return match[0].replace(/\s+/g, ' ');
    };
    for (const show of [a, b]) {
      const fragment = await server.get(`/ui/shows/${show.slug}/card`, { 'hx-request': 'true' });
      assert.equal(fragment.statusCode, 200);
      assert.equal(cardOf(dashboard.body, show), cardOf(fragment.body, show));
    }
    assert.match(cardOf(dashboard.body, a), new RegExp(`${server.episodes.counts(a.id).inFeed} in feed`));
    assert.match(cardOf(dashboard.body, b), /meta--warn/);
  });

  it('swaps the grid once when a library-wide scan finishes, and a card only on its own scan', async () => {
    const show = await seed();
    const body = (await server.get('/', { accept: 'text/html' })).body;
    const grid = body.match(/<div class="show-grid" id="show-grid"[^>]*>/)?.[0];
    assert.ok(grid, 'no grid');
    assert.match(grid, /hx-get="\/ui\/dashboard\/grid"/);
    assert.match(grid, /hx-trigger="sse:scan-finished-all from:body"/);
    assert.match(grid, /hx-swap="outerHTML"/);

    const card = body.match(new RegExp(`<article class="show-card"\\s+id="show-card-${show.id}"[^>]*>`))?.[0];
    assert.ok(card, 'no card');
    assert.match(card, new RegExp(`sse:show-scanned-${show.id} from:body`));
    assert.match(card, new RegExp(`sse:ad-changed-${show.id} from:body`));
    assert.doesNotMatch(card, /sse:scan-finished-/, 'a card re-reading itself on every scan is N fetches per Rescan all');

    // The grid fragment is the grid, with the cards in it.
    const fragment = await server.get('/ui/dashboard/grid', { 'hx-request': 'true' });
    assert.equal(fragment.statusCode, 200);
    assert.match(fragment.body, /id="show-grid"/);
    assert.match(fragment.body, new RegExp(`id="show-card-${show.id}"`));
  });
});

describe('the sidebar', () => {
  it('lists eight shows and a way to the rest', async () => {
    for (let n = 1; n <= 9; n += 1) await server.makeShowFolder(`show-${String(n).padStart(2, '0')}`);
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const body = (await server.get('/', { accept: 'text/html' })).body;
    const sidebar = body.match(/<nav class="sidebar"[\s\S]*?<\/nav>/)[0];
    assert.equal((sidebar.match(/href="\/shows\/show-\d\d"/g) ?? []).length, 8);
    assert.match(sidebar, /id="sidebar-all-shows"[^>]*>[\s\S]*?All 9 shows…/);
    assert.match(sidebar, /<a class="nav-item nav-item--more" href="\/"/);
  });

  it('says nothing about the rest when there is no rest', async () => {
    for (let n = 1; n <= 3; n += 1) await server.makeShowFolder(`show-${n}`);
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const body = (await server.get('/', { accept: 'text/html' })).body;
    const sidebar = body.match(/<nav class="sidebar"[\s\S]*?<\/nav>/)[0];
    assert.equal((sidebar.match(/href="\/shows\/show-\d"/g) ?? []).length, 3);
    assert.doesNotMatch(sidebar, /sidebar-all-shows/);
  });
});

describe('names', () => {
  it('the episode page is headed by the episode, with "Edit episode" as the small line', async () => {
    const show = await seed();
    const [episode] = server.episodes.listByShow(show.id);
    const body = (await server.get(`/shows/${show.slug}/episodes/${episode.id}`, { accept: 'text/html' })).body;
    const title = episode.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(body, new RegExp(`<h1>${title}</h1>`));
    assert.match(body, /<div class="sub">Edit episode · /);
    assert.match(body, new RegExp(`<b aria-current="page">${title}</b>`), 'the crumb is the episode, not "Edit episode"');
    // The button beside the reach figures goes to this show's statistics, and says so.
    assert.match(body, new RegExp(`href="/stats\\?showId=${show.slug}">Show statistics</a>`));
    assert.doesNotMatch(body, />All shows</);
  });

  it('following a feed is "Follow a feed" on the page, in the crumb and in Settings', async () => {
    const show = await seed();
    const page = (await server.get(`/shows/${show.slug}/subscription`, { accept: 'text/html' })).body;
    assert.match(page, /<h1>Follow a feed<\/h1>/);
    assert.match(page, /<b aria-current="page">Follow a feed<\/b>/);
    assert.match(page, /<title>[^<]*follow a feed[^<]*<\/title>/i);
    assert.doesNotMatch(page, /<h1>Subscription<\/h1>/);
    const settings = (await server.get('/settings', { accept: 'text/html' })).body;
    assert.match(settings, /id="subscriptions-enabled-title">Follow a feed</);
  });

  it('the old Adverts address still arrives, at the cuts page', async () => {
    const show = await seed();
    const old = await server.get(`/shows/${show.slug}/adverts`, { accept: 'text/html' });
    assert.equal(old.statusCode, 301);
    assert.equal(old.headers.location, `/shows/${show.slug}/cuts`);
    const page = await server.get(`/shows/${show.slug}/cuts`, { accept: 'text/html' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /id="cuts-panel"/);
    // The settings form's Save sits in the same row every other form uses.
    assert.match(page.body, /<div class="form-actions">\s*<button class="btn btn-sm btn-primary" type="submit">Save<\/button>/);
    assert.doesNotMatch(page.body, /<div class="actions">\s*<button[^>]*>Save/);
  });

  it('every class the cuts pages use is defined, and one danger button class is left', async () => {
    const css = readFileSync(join(ROOT, 'src/web/public/css/app.css'), 'utf8');
    assert.match(css, /^\.muted \{ color: var\(--ink-soft\); \}/m);
    assert.doesNotMatch(css, /\.btn-ghost--danger/);
    const views = join(ROOT, 'src/web/views');
    const { readdirSync } = await import('node:fs');
    for (const file of readdirSync(views, { recursive: true })) {
      if (!String(file).endsWith('.eta')) continue;
      assert.doesNotMatch(readFileSync(join(views, String(file)), 'utf8'), /btn-ghost--danger/, String(file));
    }
    // The repeated colours are tokens now, with the values they always had.
    for (const [token, value] of [['--warn-ink', '#8A5E10'], ['--info-ink', '#1E547A'], ['--err-ink', '#8C2A20'], ['--err-line', '#ECC9C3'], ['--field-bg', '#fff']]) {
      assert.match(css, new RegExp(`${token}:\\s*${value};`), token);
    }
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/:root \{[\s\S]*?\n\}/, '');
    for (const hex of ['#8A5E10', '#1E547A', '#8C2A20', '#ECC9C3']) {
      assert.ok(!rules.includes(hex), `${hex} is still spelt out outside :root`);
    }
  });
});
