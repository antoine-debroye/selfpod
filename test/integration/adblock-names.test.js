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

describe('names an ad blocker would hide', () => {
  it('are recognised, so this test can fail', () => {
    for (const name of ['ad-panel', 'ad-note', 'ad-totals', 'ads', 'adverts', 'sponsor-box', 'adBanner', 'ep-ad__player']) {
      assert.ok(looksLikeAnAdvert(name), name);
    }
    for (const name of ['cuts-panel', 'badge', 'readiness', 'upload-form', 'ep-added', 'banner', 'cutbar__head', 'shadow', 'loaded']) {
      assert.ok(!looksLikeAnAdvert(name), name);
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
});

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

    const paths = ['/', `/shows/${show.slug}`, `/shows/${show.slug}/adverts`, `/shows/${show.slug}/episodes/${episode.id}`, `/ui/shows/${show.slug}/ad-panel`];
    const found = {};
    for (const path of paths) {
      const response = await server.get(path);
      assert.equal(response.statusCode, 200, path);
      const bad = offenders(namesInMarkup(response.body));
      if (bad.length) found[path] = bad;
    }
    // The page really has the thing that went missing, under a name that survives.
    assert.match((await server.get(`/shows/${show.slug}/adverts`)).body, /id="cuts-panel"/);
    assert.deepEqual(found, {});
  });
});
