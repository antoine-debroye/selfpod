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
    assert.ok(response.body.includes('Load more'));
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
