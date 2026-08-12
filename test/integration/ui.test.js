import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import sharp from 'sharp';

import { SCAN_TRIGGER } from '../../src/constants.js';
import { SETTING_KEYS } from '../../src/services/settings.js';
import { createTestServer } from '../helpers/http.js';

let server;

beforeEach(async () => {
  server = await createTestServer();
});

afterEach(async () => {
  await server.cleanup();
});

/** Fails loudly on a template that rendered but produced broken markup. */
function assertRendersCleanly(response, { name }) {
  assert.equal(response.statusCode, 200, `${name} should render (got ${response.statusCode})`);
  const body = response.body;
  assert.ok(body.length > 200, `${name} produced suspiciously little output`);
  assert.ok(!body.includes('undefined</'), `${name} rendered a literal "undefined"`);
  assert.ok(!body.includes('[object Object]'), `${name} rendered "[object Object]"`);
  assert.ok(!/&lt;(div|span|form|button|svg)\b/.test(body), `${name} double-escaped markup`);
  return body;
}

async function seed(slug = 'late-night', fixtures = ['sample.m4a']) {
  for (const fixture of fixtures) await server.addAudio(slug, fixture);
  await writeFile(
    join(server.config.showsDir, slug, 'cover.jpg'),
    await sharp({ create: { width: 1500, height: 1500, channels: 3, background: '#3E2D4A' } }).jpeg().toBuffer(),
  );
  await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
  return server.shows.getBySlug(slug);
}

describe('page rendering', () => {
  it('renders the sign-in page with the SelfPod wordmark', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/login', headers: { accept: 'text/html' } });
    const body = assertRendersCleanly(response, { name: '/login' });
    assert.ok(body.includes('Self<span>Pod</span>'), 'the wordmark should read SelfPod');
    assert.ok(!body.includes('Podhost'), 'no trace of the design file’s placeholder name');
    assert.ok(body.includes("Drop a file."), 'the editorial hero line from the design');
    assert.ok(body.includes('/assets/css/app.css'), 'stylesheet linked');
    assert.ok(!body.includes('fonts.googleapis.com'), 'fonts must be self-hosted, not from a CDN');
  });

  it('renders the dashboard with show cards', async () => {
    const show = await seed();
    await server.login();
    const response = await server.get('/', { accept: 'text/html' });
    const body = assertRendersCleanly(response, { name: '/' });
    assert.ok(body.includes(show.title));
    assert.ok(body.includes('Your workshop'));
    assert.ok(body.includes('New show'));
    assert.ok(body.includes('or just make a folder'), 'the dashed new-show tile from the design');
  });

  it('shows an empty state that explains the folder workflow', async () => {
    await server.login();
    const body = assertRendersCleanly(await server.get('/', { accept: 'text/html' }), { name: 'empty dashboard' });
    assert.ok(body.includes('No shows yet'));
    assert.ok(body.includes(server.config.showsDir), 'tells the user where to put a folder');
  });

  it('renders show detail with feed URL, QR code and episode table', async () => {
    const show = await seed('late-night', ['sample.m4a', 'sample.mp3']);
    await server.login();
    const response = await server.get(`/shows/${show.slug}`, { accept: 'text/html' });
    const body = assertRendersCleanly(response, { name: '/shows/:slug' });

    assert.ok(body.includes(`/feeds/${show.slug}/${show.feed_token}.xml`), 'the full feed URL is shown');
    assert.ok(body.includes('<svg') && body.includes('viewBox'), 'a QR code SVG is embedded');
    assert.ok(body.includes('Rotate feed token'));
    assert.ok(body.includes('Show metadata'));
    assert.ok(body.includes('Episodes'));
    assert.ok(body.includes('sample.m4a'));
    // Spec §10.4: the artwork-caching note must be permanent, not conditional.
    assert.ok(body.includes('cache artwork on'), 'the third-party artwork caching note is present');
    // Spec §11.3: the two delete actions must read as clearly distinct.
    assert.ok(body.includes('Remove from feed') && body.includes('Delete file'));
  });

  it('renders the category picker from Apple’s list, not as free text', async () => {
    const show = await seed();
    await server.login();
    const body = (await server.get(`/shows/${show.slug}`, { accept: 'text/html' })).body;
    assert.ok(body.includes('<select id="f-category"'), 'category is a select, never a text input');
    assert.ok(body.includes('>Technology<'));
    assert.ok(body.includes('>Society &amp; Culture<'), 'ampersands in Apple’s names are escaped');
    assert.ok(body.includes('optgroup'), 'subcategories are grouped by category');
  });

  it('renders episode edit with a stable GUID and a three-state explicit control', async () => {
    const show = await seed();
    const episode = server.episodes.listByShow(show.id)[0];
    await server.login();
    const response = await server.get(`/shows/${show.slug}/episodes/${episode.id}`, { accept: 'text/html' });
    const body = assertRendersCleanly(response, { name: 'episode edit' });

    assert.ok(body.includes(episode.id), 'the GUID is displayed');
    assert.ok(body.includes('won’t change') || body.includes("unchanged if you rename"), 'GUID stability is explained');
    assert.ok(body.includes('Inherit from show'), 'explicit can inherit, which a toggle cannot express');
    assert.ok(body.includes('type="datetime-local"'), 'publish date is a real date input');
  });

  it('renders the upload page with a working no-JS form', async () => {
    const show = await seed();
    await server.login();
    const response = await server.get(`/shows/${show.slug}/upload`, { accept: 'text/html' });
    const body = assertRendersCleanly(response, { name: 'upload' });

    assert.ok(body.includes('enctype="multipart/form-data"'), 'a real multipart form, so it works without JS');
    assert.ok(body.includes('mp3, m4a, aac, ogg, opus, wav, flac'), 'supported formats are listed');
    assert.ok(body.includes('<noscript>'), 'a submit button exists without JavaScript');
    assert.ok(body.includes('100 MB'), 'the proxy upload-limit caveat is stated up front');
  });

  it('renders the activity log', async () => {
    await seed();
    await server.login();
    const response = await server.get('/activity', { accept: 'text/html' });
    const body = assertRendersCleanly(response, { name: 'activity' });
    assert.ok(body.includes('Scan history'));
    assert.ok(body.includes('manual scan') || body.includes('scan'));
    assert.ok(body.includes('never need to read container logs'), 'explains why this page exists');
  });

  it('renders settings with runtime facts and the migration hint', async () => {
    await server.login();
    const response = await server.get('/settings', { accept: 'text/html' });
    const body = assertRendersCleanly(response, { name: 'settings' });
    assert.ok(body.includes('Fallback rescan interval'));
    assert.ok(body.includes('Missing-file grace period'));
    assert.ok(body.includes(server.config.dataDir));
    assert.ok(body.includes('UID'), 'shows the UID it runs as, for permission debugging');
    assert.ok(body.includes('copy'), 'mentions copying the volume to move machines');
  });

  it('renders the new-show page', async () => {
    await server.login();
    const body = assertRendersCleanly(await server.get('/shows/new', { accept: 'text/html' }), { name: 'new show' });
    assert.ok(body.includes('Folder name'));
    assert.ok(body.includes('never needs its container config edited'), 'reinforces the one-volume promise');
  });

  it('renders a 404 page inside the app shell', async () => {
    await server.login();
    const response = await server.get('/shows/does-not-exist', { accept: 'text/html' });
    assert.equal(response.statusCode, 404);
    assert.ok(response.body.includes('<html'), 'a browser gets HTML, not a JSON payload');
    assert.ok(!response.body.includes('"error"'));
  });
});

describe('setup wizard', () => {
  it('walks all three steps and completes', async () => {
    const fresh = await createTestServer({ completeSetup: false, env: { PUBLIC_BASE_URL: '' } });
    try {
      await fresh.login();

      const step1 = await fresh.get('/setup/1', { accept: 'text/html' });
      assert.equal(step1.statusCode, 200);
      assert.ok(step1.body.includes('Choose your password'));

      const post1 = await fresh.post('/setup/1', {
        password: 'my-own-password-1',
        passwordConfirm: 'my-own-password-1',
      });
      assert.equal(post1.statusCode, 303);
      assert.equal(post1.headers.location, '/setup/2');

      const badUrl = await fresh.post('/setup/2', { publicBaseUrl: 'podcast.example.com' });
      assert.equal(badUrl.statusCode, 422, 'a URL without a scheme is rejected');
      assert.ok(badUrl.body.includes('Include the scheme'));

      const post2 = await fresh.post('/setup/2', { publicBaseUrl: 'https://pods.example.org/' });
      assert.equal(post2.statusCode, 303);
      assert.equal(fresh.settings.publicBaseUrl(), 'https://pods.example.org', 'trailing slash stripped');

      const post3 = await fresh.post('/setup/3', {
        defaultAuthorName: 'Antoine',
        defaultAuthorEmail: 'studio@example.com',
        defaultLanguage: 'en',
      });
      assert.equal(post3.statusCode, 303);
      assert.equal(post3.headers.location, '/');
      assert.equal(fresh.settings.setupComplete(), true);

      // The new password must actually work.
      const relogin = await fresh.login('my-own-password-1');
      assert.equal(relogin.statusCode, 200);
    } finally {
      await fresh.cleanup();
    }
  });

  it('keeps the app pointed at the wizard until it is finished', async () => {
    const fresh = await createTestServer({ completeSetup: false });
    try {
      await fresh.login();
      const dashboard = await fresh.get('/', { accept: 'text/html' });
      assert.equal(dashboard.statusCode, 303);
      assert.equal(dashboard.headers.location, '/setup');
    } finally {
      await fresh.cleanup();
    }
  });
});

describe('htmx fragments', () => {
  it('returns a bare fragment, not a whole page, for an htmx request', async () => {
    const show = await seed();
    await server.login();
    const response = await server.get(`/ui/shows/${show.slug}/card`, { 'hx-request': 'true' });
    assert.equal(response.statusCode, 200);
    assert.ok(!response.body.includes('<html'), 'a fragment must not be wrapped in a layout');
    assert.ok(response.body.includes('show-card'));
  });

  it('saves show metadata and returns the re-rendered form with a saved marker', async () => {
    const show = await seed();
    await server.login();
    const response = await server.post(
      `/ui/shows/${show.slug}/meta`,
      { title: 'Renamed Show', description: 'New description', authorName: 'A', authorEmail: 'a@b.co', language: 'en', category: 'Arts', subcategory: 'Books' },
      { 'hx-request': 'true' },
    );
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Saved ✓'));
    assert.ok(response.body.includes('Renamed Show'));
    assert.equal(server.shows.get(show.id).itunes_subcategory, 'Books');
  });

  it('returns 422 with field errors and keeps what the user typed', async () => {
    const show = await seed();
    await server.login();
    const response = await server.post(
      `/ui/shows/${show.slug}/meta`,
      { title: 'Kept Title', authorEmail: 'not-an-email', category: 'Arts' },
      { 'hx-request': 'true' },
    );
    assert.equal(response.statusCode, 422);
    // Apostrophes are HTML-escaped by the template engine, so assert on a
    // stretch of the message that has none.
    assert.ok(response.body.includes('look like an email address'));
    assert.ok(response.body.includes('Kept Title'), 'a validation error must not discard the user’s work');
    assert.ok(response.body.includes('is-invalid'));
  });

  it('redirects instead of returning a fragment when htmx is absent', async () => {
    const show = await seed();
    await server.login();
    const response = await server.post(`/ui/shows/${show.slug}/meta`, {
      title: 'No JS Title',
      category: 'Arts',
    });
    assert.equal(response.statusCode, 303, 'the same URL works as a plain form post');
    assert.equal(server.shows.get(show.id).title, 'No JS Title');
  });

  it('requires the exact folder name before deleting a show', async () => {
    const show = await seed();
    await server.login();

    const wrong = await server.post(`/ui/shows/${show.slug}/delete`, { confirm: 'nope', deleteFiles: '0' }, { 'hx-request': 'true' });
    assert.equal(wrong.statusCode, 422);
    assert.ok(server.shows.get(show.id), 'the show must still exist');

    const right = await server.post(`/ui/shows/${show.slug}/delete`, { confirm: show.slug, deleteFiles: '0' }, { 'hx-request': 'true' });
    assert.equal(right.statusCode, 200);
    assert.equal(right.headers['hx-redirect'], '/');
    assert.equal(server.shows.get(show.id), null);
  });

  it('rotates the token and returns a feed box with the new URL and QR', async () => {
    const show = await seed();
    await server.login();
    const before = show.feed_token;
    const response = await server.post(`/ui/shows/${show.slug}/rotate-token`, {}, { 'hx-request': 'true' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['hx-retarget'], '#feed-box');
    const after = server.shows.get(show.id).feed_token;
    assert.notEqual(after, before);
    assert.ok(response.body.includes(after));
    assert.ok(!response.body.includes(before), 'the old token must be gone from the page');
  });

  it('edits a setting inline and renders the display row back', async () => {
    await server.login();
    const editForm = await server.get('/ui/settings/rescanIntervalSeconds?edit=1', { 'hx-request': 'true' });
    assert.ok(editForm.body.includes('<form'));

    const saved = await server.post('/ui/settings/rescanIntervalSeconds', { value: '10m' }, { 'hx-request': 'true' });
    assert.equal(saved.statusCode, 200);
    assert.equal(server.settings.rescanIntervalSeconds(), 600, 'shorthand like "10m" is understood');
    assert.ok(saved.body.includes('Edit'), 'we are back to the display row');

    const tooShort = await server.post('/ui/settings/rescanIntervalSeconds', { value: '5s' }, { 'hx-request': 'true' });
    assert.equal(tooShort.statusCode, 422);
    assert.ok(tooShort.body.includes('1 minute and 6 hours'));
  });

  it('removes an episode from the feed and re-renders the table', async () => {
    const show = await seed('removals', ['sample.mp3']);
    const episode = server.episodes.listByShow(show.id)[0];
    await server.login();

    const response = await server.post(`/ui/episodes/${episode.id}/remove`, {}, { 'hx-request': 'true' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['hx-retarget'], '#episode-table');
    assert.equal(server.episodes.get(episode.id).status, 'removed');
    assert.ok(response.body.includes('Not in feed'));
  });

  it('refuses to delete an audio file without the explicit confirmation', async () => {
    const show = await seed('deletions', ['sample.mp3']);
    const episode = server.episodes.listByShow(show.id)[0];
    await server.login();

    const unconfirmed = await server.post(`/ui/episodes/${episode.id}/delete-file`, {}, { 'hx-request': 'true' });
    assert.equal(unconfirmed.statusCode, 422);
    assert.ok(server.episodes.get(episode.id), 'nothing may be deleted without confirmation');

    const confirmed = await server.post(`/ui/episodes/${episode.id}/delete-file`, { confirm: '1' }, { 'hx-request': 'true' });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(server.episodes.get(episode.id), null);
  });

  it('renders each modal', async () => {
    const show = await seed();
    const episode = server.episodes.listByShow(show.id)[0];
    await server.login();

    for (const [url, expected] of [
      ['/ui/modals/new-show', 'New show'],
      ['/ui/modals/change-password', 'Change admin password'],
      [`/ui/modals/delete-show/${show.slug}`, show.slug],
      [`/ui/modals/rotate-token/${show.slug}`, 'Rotate the feed token'],
      [`/ui/modals/delete-episode/${episode.id}`, 'Delete the audio file'],
    ]) {
      const response = await server.get(url, { 'hx-request': 'true' });
      assert.equal(response.statusCode, 200, `${url} should render`);
      assert.ok(response.body.includes('<dialog'), `${url} should be a native dialog`);
      assert.ok(response.body.includes(expected), `${url} should mention ${expected}`);
    }
  });

  it('paginates the activity log', async () => {
    await seed();
    for (let i = 0; i < 30; i += 1) await server.scanner.scanAllNow(SCAN_TRIGGER.SCHEDULED);
    await server.login();
    const response = await server.get('/ui/activity?offset=0', { 'hx-request': 'true' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Show older'));
  });
});

describe('degraded states surface in the UI', () => {
  it('renders the permission banner on every page, naming the path and UID', async () => {
    server.health.set('shows_readable', {
      level: 'error',
      message: 'SelfPod cannot read your shows folder `/data/shows`. Permission denied. SelfPod is running as UID 1000; check that this user can read files there.',
      detail: { path: '/data/shows', uid: 1000 },
    });
    await server.login();

    for (const url of ['/', '/settings', '/activity']) {
      const body = (await server.get(url, { accept: 'text/html' })).body;
      assert.ok(body.includes('banner--err'), `${url} should carry the banner`);
      assert.ok(body.includes('UID 1000'), `${url} should name the UID`);
      assert.ok(body.includes('/data/shows'), `${url} should name the path`);
    }

    // It must also be visible before signing in, since a broken instance may not
    // be signable-into at all.
    const login = await server.app.inject({ method: 'GET', url: '/login', headers: { accept: 'text/html' } });
    assert.ok(login.body.includes('banner--err'));
  });

  /**
   * A permanent, expected state must not occupy the banner reserved for faults.
   * Polling mode on a network share is normal, unfixable and not worth a warning on
   * every page — and a banner that is always there is a banner nobody reads when
   * something is genuinely broken.
   */
  it('keeps an informational state out of the top banner', async () => {
    server.health.clear('watcher');
    server.health.set('watcher', {
      level: 'info',
      message: "Live file detection isn't available on this volume — SelfPod is checking for new files every 5 minutes instead.",
    });
    await server.login();

    for (const url of ['/', '/settings', '/activity']) {
      const body = (await server.get(url, { accept: 'text/html' })).body;
      assert.ok(!body.includes('banner--warn'), `${url} raised a banner for an informational state`);
      assert.ok(!body.includes('banner--err'), `${url} raised an error banner`);
    }

    // Still reported where someone would go looking for it.
    const status = (await server.get('/api/status')).json();
    const watcher = status.issues.find((i) => i.key === 'watcher');
    assert.ok(watcher, 'the state must still be reported by /api/status');
    assert.equal(watcher.level, 'info');
    assert.equal(status.status, 'ok', 'an informational state is not a degraded instance');
  });

  it('still banners a real fault', async () => {
    server.health.clear('watcher');
    server.health.set('inotify', {
      level: 'warn',
      message: 'Live file detection stopped working (ENOSPC).',
    });
    await server.login();
    const body = (await server.get('/', { accept: 'text/html' })).body;
    assert.ok(body.includes('banner--warn'), 'a genuine fault must still be impossible to miss');
    assert.ok(body.includes('ENOSPC'));
    server.health.clear('inotify');
  });

  /**
   * Polling mode is reference information about how a volume behaves, not something to
   * act on, so the dashboard says nothing about it. Settings is the single place that
   * states the current mode — a permanent notice on the busiest page is just something
   * to scroll past.
   */
  it('says nothing about polling mode on the dashboard', async () => {
    server.health.set('watcher', {
      level: 'info',
      message: "Live file detection isn't available on this volume — SelfPod is checking for new files every 5 minutes instead.",
    });
    server.services.watcher.status = () => ({ mode: 'polling', enabled: true, degraded: true, lastEventAt: null });
    await server.login();

    const body = (await server.get('/', { accept: 'text/html' })).body;
    assert.ok(!body.includes('watcher-notice'), 'the dashboard notice should be gone');
    assert.ok(!body.includes('checking for new files every'), 'and its wording with it');
    assert.ok(!body.includes('banner--warn') && !body.includes('banner--err'), 'and no banner either');
  });

  it('states the current mode in Settings, which is now the only place', async () => {
    server.services.watcher.status = () => ({ mode: 'polling', enabled: true, degraded: true, lastEventAt: null });
    await server.login();
    const body = (await server.get('/settings', { accept: 'text/html' })).body;
    assert.match(body, /Live file detection/);
    assert.match(body, /Currently checking every/);
    assert.match(body, /normal for SMB and NFS shares/);
  });

  it('states live-events mode too, not only the fallback', async () => {
    server.services.watcher.status = () => ({ mode: 'events', enabled: true, degraded: false, lastEventAt: null });
    await server.login();
    const body = (await server.get('/settings', { accept: 'text/html' })).body;
    assert.match(body, /Currently using live events/);
  });



  it('surfaces scan errors on the show page', async () => {
    const show = await seed();
    const scanId = server.activity.start({ showId: show.id, trigger: 'manual' });
    server.activity.finish(scanId, {
      errors: [{ file: 'broken.wav', message: 'Could not read `broken.wav`: permission denied. SelfPod is running as UID 1000.' }],
    });
    await server.login();

    const body = (await server.get(`/shows/${show.slug}`, { accept: 'text/html' })).body;
    assert.ok(body.includes('broken.wav'));
    assert.ok(body.includes('UID 1000'));
    assert.ok(body.includes('the full activity log'), 'links onward to the full detail');
  });
});

describe('static assets', () => {
  it('serves the stylesheet, fonts and vendored htmx', async () => {
    for (const [url, type] of [
      ['/assets/css/app.css', /text\/css/],
      ['/assets/js/htmx.min.js', /javascript/],
      ['/assets/js/htmx-ext-sse.js', /javascript/],
      ['/assets/js/app.js', /javascript/],
      ['/assets/fonts/inter-variable.woff2', /font\/woff2|application\/font-woff2|octet-stream/],
      ['/assets/img/favicon.svg', /svg/],
    ]) {
      const response = await server.app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, `${url} should be served`);
      assert.match(response.headers['content-type'], type, `${url} content type`);
    }
  });

  it('declares self-hosted fonts and no external references in the CSS', async () => {
    const css = (await server.app.inject({ method: 'GET', url: '/assets/css/app.css' })).body;
    assert.ok(css.includes('@font-face'));
    assert.ok(css.includes('/assets/fonts/fraunces-variable.woff2'));
    assert.ok(!css.includes('fonts.googleapis.com'), 'no CDN font requests — this must work offline');
    assert.ok(!css.includes('http://') && !css.includes('https://'), 'no external URLs at all');
  });
});

/**
 * `created_at` answers "did the file I just dropped get picked up?", which is a
 * different question from the editorial pub date and the one people actually ask.
 */
describe('the Added column tells you when SelfPod first saw a file', () => {
  /**
   * Just the episode table. The show page also renders the reach and access-log
   * tables, and `ep-table--pinned` is the class only the episode table carries.
   */
  function episodeTable(body) {
    const start = body.indexOf('<table class="ep-table ep-table--pinned">');
    assert.notEqual(start, -1, 'the show page should contain the episode table');
    const end = body.indexOf('</table>', start);
    assert.notEqual(end, -1, 'the episode table should be closed');
    return body.slice(start, end);
  }

  it('gives the episode table an Added column header', async () => {
    const show = await seed('added-column', ['sample.m4a']);
    await server.login();
    const response = await server.get(`/shows/${show.slug}`, { accept: 'text/html' });
    const body = assertRendersCleanly(response, { name: 'show detail with Added column' });

    const table = episodeTable(body);
    assert.ok(table.includes('>Added</th>'), 'the episode table should have an Added header');
    assert.ok(
      table.includes('When SelfPod first saw this file on disk'),
      'the header should explain how Added differs from Published',
    );
  });

  it('fills the Added cell for a real scanned episode', async () => {
    const show = await seed('added-cell', ['sample.m4a']);
    await server.login();
    const response = await server.get(`/shows/${show.slug}`, { accept: 'text/html' });
    const table = episodeTable(assertRendersCleanly(response, { name: 'show detail Added cell' }));

    const cell = table.match(/<td class="ep-date ep-added mono" title="([^"]*)">([^<]*)<\/td>/);
    assert.ok(cell, 'the row should carry an Added cell');
    const tooltip = cell[1];
    const text = cell[2].trim();

    // formatDateTime and relativeTime both degrade quietly on a missing value —
    // to '—' and to '' — so these are the assertions that prove createdAt
    // actually reached the template rather than the helpers papering over a gap.
    assert.notEqual(tooltip, '—', 'the tooltip fell back to an em dash, so createdAt never arrived');
    assert.notEqual(text, '—', 'the Added cell shows an em dash instead of a date');
    assert.notEqual(text, 'undefined', 'the Added cell rendered the literal string "undefined"');
    assert.match(text, /just now|ago$/, `the Added cell should read as a relative time, got "${text}"`);
  });

  it('keeps the header count and the cell count in step', async () => {
    const show = await seed('added-columns-match', ['sample.m4a']);
    await server.login();
    const response = await server.get(`/shows/${show.slug}`, { accept: 'text/html' });
    const table = episodeTable(assertRendersCleanly(response, { name: 'show detail column counts' }));

    const thead = table.slice(table.indexOf('<thead>'), table.indexOf('</thead>'));
    const tbody = table.slice(table.indexOf('<tbody>'));
    const firstRow = tbody.slice(tbody.indexOf('<tr'), tbody.indexOf('</tr>'));

    // No row in this table spans columns — the only colspan in the views belongs
    // to access-log-rows, a different table — so a plain count is exact.
    assert.ok(!firstRow.includes('colspan'), 'an episode row grew a colspan; this count is no longer exact');

    const headers = (thead.match(/<th\b/g) ?? []).length;
    const cells = (firstRow.match(/<td\b/g) ?? []).length;
    assert.ok(headers > 0, 'the episode table should have headers at all');
    assert.equal(
      cells,
      headers,
      `a column was added to the header or the row but not both (${headers} headers, ${cells} cells)`,
    );
  });

  it('names when the episode was added on the episode page', async () => {
    const show = await seed('added-episode-page', ['sample.m4a']);
    const episode = server.episodes.listByShow(show.id)[0];
    await server.login();
    const response = await server.get(`/shows/${show.slug}/episodes/${episode.id}`, { accept: 'text/html' });
    const body = assertRendersCleanly(response, { name: 'episode edit with added date' });

    assert.match(
      body,
      /added (just now|in |\d+ (second|minute|hour|day|month|year)s? ago)/,
      'the episode page should say when the file was first seen',
    );
    assert.ok(
      body.includes('SelfPod first saw this file on'),
      'the exact timestamp should be available as a tooltip',
    );
    assert.ok(
      !body.includes('SelfPod first saw this file on —'),
      'the tooltip fell back to an em dash, so createdAt never reached the page',
    );
  });
});

describe('the activity page', () => {
  /** A show with two episodes, and the scan that found them, in both logs. */
  async function seedActivity() {
    const show = await seed('late-night', ['sample.m4a', 'sample.mp3']);
    return { show, episodes: server.episodes.listByShow(show.id) };
  }

  it('renders both logs on one page', async () => {
    await seedActivity();
    await server.login();
    const body = assertRendersCleanly(await server.get('/activity', { accept: 'text/html' }), { name: '/activity' });

    assert.ok(body.includes('<h1>Activity</h1>'), 'the page now holds two logs, so it is no longer titled after one');
    assert.ok(body.includes('Episode timeline'), 'the new card');
    assert.ok(body.includes('Scan history'), 'the old one, demoted to a card title');
    assert.ok(body.includes('id="episode-timeline"') && body.includes('id="activity-list"'), 'both swap targets exist');
    assert.ok(body.includes('never need to read container logs'), 'the page still explains why it exists');
  });

  it('states the limit of a derived timeline rather than implying it is a log', async () => {
    await seedActivity();
    await server.login();
    const body = (await server.get('/activity', { accept: 'text/html' })).body;
    assert.ok(body.includes('rather than from a running log'), 'says what it is built from');
    assert.ok(body.includes('leaves no trace of ever having gone'), 'names the case it cannot show');
  });

  it('names an actual episode in the timeline, which no scan row ever could', async () => {
    const { show, episodes } = await seedActivity();
    await server.login();
    const body = (await server.get('/activity', { accept: 'text/html' })).body;

    for (const episode of episodes) {
      assert.ok(
        body.includes(`/shows/${show.slug}/episodes/${episode.id}`),
        `the timeline links to ${episode.id}`,
      );
      assert.ok(body.includes(episode.title), `the timeline names "${episode.title}"`);
    }
    assert.ok(body.includes('Picked up from disk and added to the feed.'), 'each event says what it means');
  });

  it('renders cleanly under every filter the bars can set', async () => {
    const { show } = await seedActivity();
    await server.login();
    for (const query of [
      'event=added',
      'event=missing',
      `timelineShow=${show.slug}`,
      'outcome=clean',
      'outcome=problems',
      'trigger=manual',
      `event=added&timelineShow=${show.slug}&showId=${show.slug}&trigger=manual&outcome=clean`,
    ]) {
      assertRendersCleanly(await server.get(`/activity?${query}`, { accept: 'text/html' }), {
        name: `/activity?${query}`,
      });
    }
  });

  it('marks the active chip as the current alternative, not as a pressed toggle', async () => {
    await seedActivity();
    await server.login();
    const body = (await server.get('/activity?event=added', { accept: 'text/html' })).body;
    assert.ok(body.includes('name="event" value="added"'), 'a chip is a real submit button with a value');
    assert.ok(body.includes('aria-current="true"'), 'the active chip is announced');
    assert.ok(!body.includes('aria-pressed'), 'these are alternatives, so a toggle role would misdescribe them');
  });

  it('explains an empty timeline differently when a filter caused it', async () => {
    await seedActivity();
    await server.login();
    const unfiltered = (await server.get('/ui/activity/timeline', { 'hx-request': 'true' })).body;
    assert.ok(!unfiltered.includes('No episodes match'), 'there are episodes to show');

    const filtered = (await server.get('/ui/activity/timeline?event=removed', { 'hx-request': 'true' })).body;
    assert.ok(filtered.includes('No episodes match'), 'nothing has been removed');
    assert.ok(filtered.includes('Try “All”'), 'and it says how to get back');
  });

  it('explains an empty scan log filtered to problems as the good outcome', async () => {
    await seedActivity();
    await server.login();
    const body = (await server.get('/ui/activity?outcome=problems', { 'hx-request': 'true' })).body;
    assert.ok(body.includes('No scans had problems'));
    assert.ok(body.includes('This is the good outcome.'));
  });

  it('returns every activity fragment bare, with no layout around it', async () => {
    await seedActivity();
    await server.login();
    for (const url of [
      '/ui/activity',
      '/ui/activity/items',
      '/ui/activity/timeline',
      '/ui/activity/timeline/items',
    ]) {
      const response = await server.get(url, { 'hx-request': 'true' });
      assert.equal(response.statusCode, 200, `${url} should answer`);
      assert.ok(!response.body.includes('<html'), `${url} must not be wrapped in a layout`);
    }
  });

  it('returns items without their container, so paging appends instead of nesting', async () => {
    await seedActivity();
    await server.login();

    const scanContainer = (await server.get('/ui/activity', { 'hx-request': 'true' })).body;
    const scanItems = (await server.get('/ui/activity/items', { 'hx-request': 'true' })).body;
    assert.ok(scanContainer.includes('id="activity-list"'), 'the filter route still returns the container');
    assert.ok(!scanItems.includes('id="activity-list"'), 'the pager route must not repeat the container id');

    const timelineContainer = (await server.get('/ui/activity/timeline', { 'hx-request': 'true' })).body;
    const timelineItems = (await server.get('/ui/activity/timeline/items', { 'hx-request': 'true' })).body;
    assert.ok(timelineContainer.includes('id="episode-timeline"'), 'same for the timeline');
    assert.ok(!timelineItems.includes('id="episode-timeline"'), 'and its pager route is items only');
  });

  it('points the scan pager at itself and carries the filter into the next page', async () => {
    await seedActivity();
    for (let i = 0; i < 30; i += 1) await server.scanner.scanAllNow(SCAN_TRIGGER.SCHEDULED);
    await server.login();

    const body = (await server.get('/ui/activity/items?trigger=scheduled', { 'hx-request': 'true' })).body;
    assert.ok(body.includes('id="activity-more"'), 'the pager is the swap target');
    assert.ok(body.includes('hx-target="#activity-more"'), 'and it targets itself, not the container');
    assert.ok(body.includes('/ui/activity/items?trigger=scheduled'), 'the next page keeps the filter');
    assert.ok(body.includes('offset=25'), 'and moves the offset on');
    assert.ok(body.includes('of'), 'the count tells you how far in you are');
  });

  it('keeps one card’s filters when the other card is filtered', async () => {
    const { show } = await seedActivity();
    await server.login();
    const body = (await server.get(
      `/activity?event=added&trigger=manual&outcome=clean&showId=${show.slug}`,
      { accept: 'text/html' },
    )).body;

    // The timeline bar owns event and timelineShow, so it must carry the scan log's keys.
    assert.ok(body.includes('<input type="hidden" name="trigger" value="manual">'), 'trigger survives a chip click');
    assert.ok(body.includes('<input type="hidden" name="outcome" value="clean">'), 'so does outcome');
    assert.ok(body.includes(`<input type="hidden" name="showId" value="${show.slug}">`), 'and the scan log’s show');
    // And the scan bar carries the timeline's.
    assert.ok(body.includes('<input type="hidden" name="event" value="added">'), 'the timeline event survives too');
  });

  it('filters with JavaScript switched off, because every bar is a real GET form', async () => {
    await seedActivity();
    await server.login();
    const response = await server.get('/activity?event=added', { accept: 'text/html' });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('<html'), 'a plain browser gets the whole page back');
    assert.ok(response.body.includes('method="get" action="/activity"'), 'the bar submits on its own');
    assert.ok(response.body.includes('<noscript>'), 'and offers a submit button when htmx cannot run');
  });
});

/**
 * Directory readiness.
 *
 * A feed can be perfectly healthy here and still be turned down by Apple Podcasts or
 * Spotify — no artwork at all, artwork in a format they refuse, an empty description,
 * no owner email. None of that produced a single word anywhere in SelfPod: you found
 * out at submission time, or never. That is the same shape as every failure in the
 * spec's §13, which is why the panel exists.
 */
describe('the directory readiness panel', () => {
  // The outer hook builds the server; this signs in, which every page here needs.
  beforeEach(async () => {
    await server.login();
  });

  it('lists what would stop a directory accepting the feed', async () => {
    // Audio but no artwork, no description, no owner email: three blocking checks.
    await server.addAudio('bare-show', 'sample.m4a');
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const show = server.shows.getBySlug('bare-show');

    const response = await server.get(`/shows/${show.slug}`);
    const body = assertRendersCleanly(response, { name: 'show page' });

    assert.match(body, /Directory readiness/, 'the panel is on the page');
    assert.match(body, /blocking/, 'and says how many things block a submission');
    assert.match(body, /itunes:image|no cover art|artwork/i, 'artwork is one of them');
  });

  it('labels severity in words, not by colour alone', async () => {
    await server.addAudio('wordy', 'sample.m4a');
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const show = server.shows.getBySlug('wordy');

    const body = (await server.get(`/shows/${show.slug}`)).body;
    assert.match(body, /Blocking/, 'a blocking check says so');
    assert.match(
      body,
      /Advisory/,
      'and an advisory one is distinguished by a word, so the panel works without colour',
    );
  });

  it('collapses the checks that already pass rather than hiding them', async () => {
    const show = await seed('passing-show');
    const body = (await server.get(`/shows/${show.slug}`)).body;
    assert.match(body, /check(s)? already pass/, 'the passing checks are counted');
    assert.match(body, /<details/, 'and kept out of the way rather than dropped');
  });

  it('tells a ready show it is ready without claiming anything was submitted', async () => {
    const show = await seed('ready-show');
    server.shows.update(show.id, {
      description: 'A show about things.',
      authorName: 'A Person',
      authorEmail: 'person@example.com',
    });

    const body = (await server.get(`/shows/${show.slug}`)).body;
    assert.match(body, /Ready to submit/, 'it says the feed would be accepted');
    assert.match(
      body,
      /cannot submit a show for you/,
      'and is honest that SelfPod does not do the submitting',
    );
  });

  it('reports blocked artwork for a format Apple refuses, even behind a .jpg URL', async () => {
    await server.addAudio('webp-show', 'sample.m4a');
    await writeFile(
      join(server.config.showsDir, 'webp-show', 'cover.webp'),
      await sharp({ create: { width: 1500, height: 1500, channels: 3, background: '#3E2D4A' } })
        .webp()
        .toBuffer(),
    );
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);
    const show = server.shows.getBySlug('webp-show');
    assert.equal(show.cover_format, 'webp', 'the fixture really is a WebP');

    const body = (await server.get(`/shows/${show.slug}`)).body;
    assert.match(body, /WebP|webp/, 'the panel names the real format');
    assert.match(
      body,
      /cover\.jpg/,
      'and explains that the address ends in .jpg whatever the file is',
    );
  });

  it('says so when a show has been kept out of directories on purpose', async () => {
    const show = await seed('blocked-show');
    server.shows.update(show.id, { directoryListing: 'blocked' });

    const body = (await server.get(`/shows/${show.slug}`)).body;
    assert.match(body, /out of their index|out of directories/i, 'the panel raises it');
    assert.ok(
      !/wrong|mistake|should not/i.test(body.split('Directory readiness')[1]?.slice(0, 2000) ?? ''),
      'without scolding — it is a deliberate setting, not a fault',
    );
  });

  it('serves the readiness panel as a bare fragment', async () => {
    const show = await seed('frag-show');
    const response = await server.get(`/ui/shows/${show.slug}/readiness`, { 'hx-request': 'true' });
    assert.equal(response.statusCode, 200, 'the fragment renders');
    assert.ok(!response.body.includes('<html'), 'a fragment must not be wrapped in a layout');
    assert.match(response.body, /id="feed-readiness"/, 'and is the element it replaces');
  });

  it('keeps readiness out of the fault banner entirely', async () => {
    await server.addAudio('quiet-show', 'sample.m4a');
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    const dashboard = (await server.get('/')).body;
    assert.ok(
      !dashboard.includes('Directory readiness'),
      'a banner that is always there is a banner nobody reads when something is really wrong',
    );
  });
});

/**
 * The episode form's artwork cell. Read-only on purpose: artwork comes from the
 * files, and SelfPod does not write into a show folder.
 */
describe('episode artwork on the episode page', () => {
  async function artworkCell(slug, { embed = false, sidecar = false } = {}) {
    const { mp3WithEmbeddedArtwork } = await import('../helpers/harness.js');
    const picture = await sharp({
      create: { width: 1400, height: 1400, channels: 3, background: '#204020' },
    })
      .jpeg()
      .toBuffer();

    await server.makeShowFolder(slug);
    if (embed) {
      await writeFile(join(server.config.showsDir, slug, 'ep-one.mp3'), await mp3WithEmbeddedArtwork(picture));
    } else {
      await server.addAudio(slug, 'sample.mp3', 'ep-one.mp3');
    }
    if (sidecar) await writeFile(join(server.config.showsDir, slug, 'ep-one.jpg'), picture);
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    const show = server.shows.getBySlug(slug);
    const episode = server.episodes.listByShow(show.id)[0];
    await server.login();
    const response = await server.get(`/shows/${show.slug}/episodes/${episode.id}`, {
      accept: 'text/html',
    });
    const body = assertRendersCleanly(response, { name: 'episode edit with artwork' });
    // Collapsed, so an assertion about the wording is not also an assertion about
    // where the template happens to wrap its lines.
    return body.replace(/\s+/g, ' ');
  }

  it('says the artwork came from the file’s own tags, and how big it is', async () => {
    const text = await artworkCell('art-embedded', { embed: true });
    assert.ok(text.includes('Episode artwork'), 'the cell is labelled');
    assert.ok(text.includes("From the file's own tags"), 'and names where it came from');
    assert.ok(text.includes('1400 × 1400'), 'the real dimensions are stated');
  });

  it('names the sidecar file when that is where the artwork came from', async () => {
    const text = await artworkCell('art-sidecar', { embed: true, sidecar: true });
    assert.ok(text.includes('ep-one.jpg'), 'the sidecar is named, since it is the file to replace');
    assert.ok(text.includes('beside the audio'));
  });

  it('explains both ways to add artwork when the episode has none', async () => {
    const text = await artworkCell('art-none');
    assert.ok(text.includes("Uses the show's cover"), 'it says what happens today');
    assert.ok(text.includes('embed artwork in the audio file'), 'and the first way to change it');
    assert.ok(text.includes('ep-one.jpg'), 'and the exact filename to use for the second');
  });
});

/**
 * The defaults applied to shows SelfPod discovers on its own.
 *
 * These three settings were seeded at first boot and readable through the API, but had
 * no write path anywhere — so every discovered show got "Technology" and there was no
 * way to change it short of editing each show afterwards.
 */
describe('defaults for new shows', () => {
  beforeEach(async () => {
    await server.login();
  });

  it('offers category, subcategory and explicit as editable rows', async () => {
    const body = assertRendersCleanly(await server.get('/settings'), { name: 'settings' });
    assert.match(body, /Default category/, 'category is on the page');
    assert.match(body, /Default subcategory/, 'and subcategory');
    assert.match(body, /Default explicit flag/, 'and the explicit flag');
  });

  it('edits the category with a picker from Apple’s list, not a text box', async () => {
    const response = await server.get('/ui/settings/defaultCategory?edit=1', { 'hx-request': 'true' });
    assert.equal(response.statusCode, 200, 'the editor renders');
    assert.match(response.body, /<select/, 'a free-text category would reach the feed and be rejected');
    assert.match(response.body, /Technology/, 'and it is populated from the real taxonomy');
  });

  it('saves a new default category', async () => {
    const response = await server.post(
      '/ui/settings/defaultCategory',
      { value: 'Arts' },
      { 'hx-request': 'true' },
    );
    assert.equal(response.statusCode, 200, 'the save succeeds');
    assert.equal(server.settings.defaults().category, 'Arts', 'and it is what new shows will get');
  });

  it('refuses a category Apple does not have', async () => {
    const before = server.settings.defaults().category;
    const response = await server.post(
      '/ui/settings/defaultCategory',
      { value: 'Underwater Basket Weaving' },
      { 'hx-request': 'true' },
    );
    assert.equal(response.statusCode, 422, 'it is rejected rather than stored');
    assert.equal(server.settings.defaults().category, before, 'and nothing changed');
  });

  it('drops a subcategory that the new category has no place for', async () => {
    await server.post('/ui/settings/defaultCategory', { value: 'Arts' }, { 'hx-request': 'true' });
    await server.post('/ui/settings/defaultSubcategory', { value: 'Books' }, { 'hx-request': 'true' });
    assert.equal(server.settings.defaults().subcategory, 'Books', 'the pair is valid to begin with');

    await server.post('/ui/settings/defaultCategory', { value: 'Technology' }, { 'hx-request': 'true' });
    assert.ok(
      !server.settings.defaults().subcategory,
      'a mismatched pair would reach a feed as a nested category Apple rejects',
    );
  });

  it('applies the default to a show it discovers next', async () => {
    await server.post('/ui/settings/defaultCategory', { value: 'Arts' }, { 'hx-request': 'true' });
    await server.addAudio('inherits-default', 'sample.m4a');
    await server.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    assert.equal(
      server.shows.getBySlug('inherits-default').itunes_category,
      'Arts',
      'which is the whole point of a default',
    );
  });
});
