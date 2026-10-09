import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTestServer } from '../helpers/http.js';
import { FRAME_MS, segment, stitch } from '../helpers/mp3.js';

/**
 * Ad blockers hide page elements by name, before any script runs and whatever the server
 * sent. 1.9.0 named the Adverts panel `ad-panel` and its notes `ad-note`; EasyList hides
 * both (`###ad-panel`, `##.ad-panel`, `##.ad-note`), so for an owner with uBlock Origin or
 * AdGuard the Adverts page rendered blank while every test here passed. This page is about
 * adverts, so the temptation to name things after them never goes away: no class or id
 * SelfPod renders may look like an advert to a filter list.
 *
 * The same lists carry network rules, which match a request by its URL rather than an
 * element by its name: `/ad-panel`, `/adverts`, `/ad-segments/…/sample.mp3` are the shape
 * of what `||example.com/ad-*` rules exist to stop. A blocked fragment fetch or `<audio
 * src>` fails without a word, so no path the browser fetches — hx-get, hx-post, src, href,
 * action, a URL literal in app.js — may carry one of these words as a segment either.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Words filter lists hide elements by, as a whole part of a name split on - and _. */
const BANNED_PARTS = new Set(['ad', 'ads', 'advert', 'adverts', 'advertisement', 'advertising', 'sponsor', 'sponsors', 'sponsored', 'promo', 'promoted', 'adbox', 'adslot', 'adunit', 'adsense', 'adwrap']);
/** And as a fragment anywhere in a name, which catches `adBanner`, `topads`, `sponsorBlock`. */
const BANNED_FRAGMENT = /advert|sponsor|adsense|adslot|adunit|adbox|adbanner|ad_?wrap|topads|sidead/i;

function looksLikeAnAdvert(name) {
  if (BANNED_FRAGMENT.test(name)) return true;
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[-_]+/)
    .some((part) => BANNED_PARTS.has(part));
}

/** Every class and id in some HTML, with template code taken out first. */
function namesInMarkup(html) {
  const names = new Set();
  const plain = html.replace(/<%[\s\S]*?%>/g, ' ');
  for (const match of plain.matchAll(/\b(?:class|id)\s*=\s*"([^"]*)"/g)) {
    for (const name of match[1].split(/\s+/)) if (/^[A-Za-z][\w-]*$/.test(name)) names.add(name);
  }
  return names;
}

function offenders(names) {
  return [...names].filter(looksLikeAnAdvert).sort();
}

/** The attributes whose value the browser turns into a request. */
const URL_ATTRIBUTES = ['hx-get', 'hx-post', 'hx-delete', 'hx-put', 'hx-patch', 'src', 'href', 'action', 'formaction', 'sse-swap'];

/**
 * Whether a URL (or the template of one) has a banned word as a path segment, a query
 * part, or a hyphenated word inside one — `/ad-panel`, `/adverts`, `?ad=1`.
 */
function urlLooksLikeAnAdvert(url) {
  return url
    .split(/[/?&=#\s]+/)
    .filter((part) => /^[A-Za-z][\w-]*$/.test(part))
    .some(looksLikeAnAdvert);
}

/** Every request-making attribute value in some HTML, with template code taken out first. */
function urlsInMarkup(html) {
  const urls = new Set();
  const plain = html.replace(/<%[\s\S]*?%>/g, ' ');
  const attribute = new RegExp(`\\b(?:${URL_ATTRIBUTES.join('|')})\\s*=\\s*"([^"]*)"`, 'g');
  for (const match of plain.matchAll(attribute)) urls.add(match[1]);
  return urls;
}

function urlOffenders(urls) {
  return [...urls].filter(urlLooksLikeAnAdvert).sort();
}

describe('names an ad blocker would hide', () => {
  it('are recognised, so this test can fail', () => {
    for (const name of ['ad-panel', 'ad-note', 'ad-totals', 'ads', 'adverts', 'sponsor-box', 'adBanner', 'ep-ad__player']) {
      assert.ok(looksLikeAnAdvert(name), name);
    }
    for (const name of ['cuts-panel', 'badge', 'readiness', 'upload-form', 'ep-added', 'banner', 'cutbar__head', 'shadow', 'loaded']) {
      assert.ok(!looksLikeAnAdvert(name), name);
    }
    // The URLs 1.9.1 left behind, and the ones that replaced them.
    for (const url of [
      '/ui/shows/tape-club/ad-panel',
      '/ui/shows/<%= slug %>/ad-work',
      '/shows/tape-club/adverts',
      '/ui/episodes/abc/adverts',
      '/api/ad-segments/abc/sample.mp3?context=3',
      '/api/ad-anchors/abc/sample.mp3',
      '/ui/shows/tape-club/ad-markers/abc/remove',
      '/stats?ad=1',
    ]) {
      assert.ok(urlLooksLikeAnAdvert(url), url);
    }
    for (const url of [
      '/ui/shows/tape-club/cuts-panel',
      '/shows/tape-club/cuts',
      '/ui/episodes/abc/cuts',
      '/api/cuts/segments/abc/sample.mp3?context=3',
      '/ui/shows/tape-club/boundaries/abc/remove',
      '/ui/shows/tape-club/jingles/abc/confirm',
      '/assets/js/app.js?v=1',
      '/media/tape-club/token/cover.jpg?v=2',
      '/api/episodes/abc/audio?copy=original',
      'cuts-work-3',
      'https://podcasts.apple.com/',
      '#modal-root',
    ]) {
      assert.ok(!urlLooksLikeAnAdvert(url), url);
    }
  });

  it('are in no template, stylesheet or script', () => {
    const views = join(ROOT, 'src/web/views');
    const templates = readdirSync(views, { recursive: true }).filter((file) => String(file).endsWith('.eta'));
    assert.ok(templates.length > 10);
    const found = {};
    for (const file of templates) {
      const bad = offenders(namesInMarkup(readFileSync(join(views, String(file)), 'utf8')));
      if (bad.length) found[file] = bad;
    }

    const css = readFileSync(join(ROOT, 'src/web/public/css/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = new Set();
    for (const block of css.matchAll(/([^{}]+)\{/g)) {
      for (const match of block[1].matchAll(/[.#](-?[A-Za-z_][\w-]*)/g)) selectors.add(match[1]);
    }
    const badCss = offenders(selectors);
    if (badCss.length) found['app.css'] = badCss;

    const js = readFileSync(join(ROOT, 'src/web/public/js/app.js'), 'utf8');
    const jsNames = new Set();
    for (const match of js.matchAll(/['"`]([^'"`]*[.#][A-Za-z][\w-]*[^'"`]*)['"`]/g)) {
      for (const name of match[1].matchAll(/[.#]([A-Za-z][\w-]*)/g)) jsNames.add(name[1]);
    }
    for (const match of js.matchAll(/classList\.(?:add|remove|toggle|contains)\(\s*'([^']+)'/g)) jsNames.add(match[1]);
    const badJs = offenders(jsNames);
    if (badJs.length) found['app.js'] = badJs;

    for (const file of ['src/services/adverts-view.js', 'src/web/routes/events.js']) {
      const bad = offenders(namesInMarkup(readFileSync(join(ROOT, file), 'utf8')));
      if (bad.length) found[file] = bad;
    }

    assert.deepEqual(found, {});
  });

  it('are in no address the browser fetches', async () => {
    const found = {};

    const views = join(ROOT, 'src/web/views');
    const templates = readdirSync(views, { recursive: true }).filter((file) => String(file).endsWith('.eta'));
    assert.ok(templates.length > 10);
    let seen = 0;
    for (const file of templates) {
      const urls = urlsInMarkup(readFileSync(join(views, String(file)), 'utf8'));
      seen += urls.size;
      const bad = urlOffenders(urls);
      if (bad.length) found[file] = bad;
    }
    assert.ok(seen > 50, `only ${seen} request attributes found across the templates — is the scan still reading them?`);

    // HTML built in code rather than in a template: the topbar actions, the live
    // stream's strip, the work strip, and every URL the view-model hands a template.
    for (const file of ['src/web/routes/pages.js', 'src/web/routes/events.js', 'src/services/adverts-view.js']) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const urls = new Set([...urlsInMarkup(source), ...literalPaths(source)]);
      const bad = urlOffenders(urls);
      if (bad.length) found[file] = bad;
    }

    // app.js: every path it fetches or opens is a literal starting with a slash.
    const js = readFileSync(join(ROOT, 'src/web/public/js/app.js'), 'utf8');
    const jsPaths = literalPaths(js);
    assert.ok(jsPaths.size >= 2, 'app.js stopped carrying any URL literal — is the scan still reading them?');
    const badJs = urlOffenders(jsPaths);
    if (badJs.length) found['app.js'] = badJs;

    assert.deepEqual(found, {});
  });
});

/**
 * Every quoted or template string in some source that starts with a slash: a path.
 * A route pattern (`/shows/:slug/adverts`) is a server-side name, never an address the
 * browser asks for, so it is left out — the one such pattern is the 301 that keeps old
 * bookmarks working, and what matters is that nothing rendered points at it.
 */
function literalPaths(source) {
  const paths = new Set();
  for (const match of source.matchAll(/['"`](\/[^'"`\s]*)['"`]/g)) paths.add(match[1]);
  // Template literals with holes: `/ui/shows/${slug}/cuts-work` — the text between the
  // holes is what a filter would match on.
  for (const match of source.matchAll(/`(\/[^`]*)`/g)) paths.add(match[1].replace(/\$\{[^}]*\}/g, 'x'));
  return new Set([...paths].filter((path) => !/\/:[a-zA-Z]/.test(path)));
}

describe('the pages as served', () => {
  let server;

  beforeEach(async () => {
    server = await createTestServer();
    await server.login();
  });

  afterEach(async () => {
    await server.cleanup();
  });

  it('name nothing on the Adverts, show, episode and dashboard pages like an advert', async () => {
    const showDir = await server.makeShowFolder('tape-club');
    await writeFile(join(showDir, '.keep'), '');
    await server.scanner.scanAllNow('manual');
    const show = server.shows.getBySlug('tape-club');
    server.db.prepare('UPDATE shows SET ad_trim_mode = ? WHERE id = ?').run('review', show.id);
    const frames = (seconds) => Math.round((seconds * 1000) / FRAME_MS);
    for (let n = 0; n < 3; n += 1) {
      await writeFile(
        join(showDir, `episode-${n}.mp3`),
        stitch(segment(100_000 + n * 50_000, frames(45)), segment(2_000, frames(40)), segment(600_000 + n * 50_000, frames(45))),
      );
    }
    await server.scanner.scanAllNow('manual');
    await server.adPipeline.processShow(show.id);
    const [episode] = server.episodes.listByShow(show.id);

    const paths = ['/', `/shows/${show.slug}`, `/shows/${show.slug}/cuts`, `/shows/${show.slug}/episodes/${episode.id}`, `/ui/shows/${show.slug}/cuts-panel`];
    const found = {};
    let clips = 0;
    for (const path of paths) {
      const response = await server.get(path);
      assert.equal(response.statusCode, 200, path);
      const bad = offenders(namesInMarkup(response.body));
      if (bad.length) found[path] = bad;
      // And every address on the page, as the view-model built it.
      const urls = urlsInMarkup(response.body);
      clips += [...urls].filter((url) => url.includes('/sample.mp3')).length;
      const badUrls = urlOffenders(urls);
      if (badUrls.length) found[`${path} (urls)`] = badUrls;
    }
    // The page really has the thing that went missing, under a name that survives.
    assert.match((await server.get(`/shows/${show.slug}/cuts`)).body, /id="cuts-panel"/);
    // And it really plays a clip, so the clip's address was among what was checked.
    assert.ok(clips > 0, 'no sample clip on the Adverts page — the URL check never saw one');
    assert.deepEqual(found, {});
  });
});
