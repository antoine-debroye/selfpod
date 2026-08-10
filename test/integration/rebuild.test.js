import assert from 'node:assert/strict';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';

/**
 * Rebuilding a show's feed from disk.
 *
 * This is the escape hatch for the cases a rescan deliberately cannot fix: the
 * scanner never overwrites an edited title, never resurrects a removed episode, and
 * reads a tag-derived description only when it first sees a file. Each of those is
 * right by default, and each can leave a reorganised library with a feed that no
 * longer matches the folder.
 *
 * It costs every subscriber a re-download, so the tests care as much about it being
 * hard to trigger by accident as about it working.
 */
describe('rebuilding a feed from disk', () => {
  let server;
  let show;

  before(async () => {
    server = await createTestServer();
    await server.login();
  });

  after(async () => {
    await server.cleanup();
  });

  beforeEach(async () => {
    // A fresh show per test, since a rebuild is destructive by nature.
    const slug = `rebuild-${Math.abs(Date.now() % 100000)}-${server.shows.list().length}`;
    await server.addAudio(slug, 'sample.m4a', 'first.m4a');
    await server.addAudio(slug, 'sample.mp3', 'second.mp3');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug(slug);
  });

  describe('what it puts right', () => {
    it('restores a title the owner edited, which a rescan protects', async () => {
      const episode = server.episodes.listByShow(show.id)[0];
      const original = episode.title;
      server.episodes.update(episode.id, { title: 'A Hand-Written Title' });

      // A rescan must leave it alone — that is the behaviour being escaped from.
      await server.scanner.scanShowNow(show.id, 'manual', { rehash: true });
      assert.equal(server.episodes.get(episode.id).title, 'A Hand-Written Title');

      const response = await server.request({ method: 'POST', url: `/api/shows/${show.id}/rebuild` });
      assert.equal(response.statusCode, 200);

      const rebuilt = server.episodes.listByShow(show.id).find((e) => e.filename === episode.filename);
      assert.equal(rebuilt.title, original, 'the title should come from the file again');
      assert.equal(rebuilt.title_is_custom, 0);
    });

    it('brings back an episode that had been removed from the feed', async () => {
      const episode = server.episodes.listByShow(show.id)[0];
      server.episodes.removeFromFeed(episode.id);
      assert.equal(server.episodes.get(episode.id).status, 'removed');

      // A rescan deliberately leaves it removed.
      await server.scanner.scanShowNow(show.id, 'manual', { rehash: true });
      assert.equal(server.episodes.get(episode.id).status, 'removed');

      await server.request({ method: 'POST', url: `/api/shows/${show.id}/rebuild` });

      const rebuilt = server.episodes.listByShow(show.id);
      assert.equal(rebuilt.length, 2);
      assert.ok(rebuilt.every((e) => e.status === 'active'), 'every file in the folder should be back');
    });

    it('leaves every audio file untouched', async () => {
      const { readdir } = await import('node:fs/promises');
      const dir = join(server.config.showsDir, show.slug);
      const before_ = (await readdir(dir)).sort();
      await server.request({ method: 'POST', url: `/api/shows/${show.id}/rebuild` });
      const after_ = (await readdir(dir)).sort();
      assert.deepEqual(after_, before_, 'a rebuild must never touch the audio');
    });

    it('reports what it did, including the cost', async () => {
      const response = await server.request({ method: 'POST', url: `/api/shows/${show.id}/rebuild` });
      const body = response.json();
      assert.equal(body.ok, true);
      assert.equal(body.forgotten, 2);
      assert.equal(body.imported, 2);
      assert.match(
        body.note,
        /re-?download|download them again/i,
        'the consequence must be stated in the response',
      );
    });

    it('mints new identities, which is the part subscribers feel', async () => {
      const before_ = server.episodes.listByShow(show.id).map((e) => e.id).sort();
      await server.request({ method: 'POST', url: `/api/shows/${show.id}/rebuild` });
      const after_ = server.episodes.listByShow(show.id).map((e) => e.id).sort();
      assert.equal(after_.length, before_.length);
      assert.notDeepEqual(after_, before_, 'GUIDs are expected to change — this is why it is confirmed twice');
    });

    it('records it in the activity log', async () => {
      await server.request({ method: 'POST', url: `/api/shows/${show.id}/rebuild` });
      const entries = server.activity.list({ showId: show.id, limit: 10 });
      const rebuild = entries.find((e) => /rebuilt from disk/i.test(e.note ?? ''));
      assert.ok(rebuild, 'a rebuild must be explainable afterwards');
    });

    it('refuses when the folder is gone, rather than emptying the feed', async () => {
      const dir = join(server.config.showsDir, show.slug);
      const stashed = `${dir}.stashed`;
      await rename(dir, stashed);
      try {
        await server.scanner.scanAllNow('manual');
        const response = await server.request({ method: 'POST', url: `/api/shows/${show.id}/rebuild` });
        assert.equal(response.statusCode, 409);
        // The episodes must still be there — a missing share is not a reason to
        // discard the library.
        assert.ok(server.episodes.listByShow(show.id).length > 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rename(stashed, dir);
        await server.scanner.scanAllNow('manual');
      }
    });
  });

  describe('the double confirmation', () => {
    const post = (payload) => ({
      method: 'POST',
      url: `/ui/shows/${show.slug}/rebuild`,
      payload,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    it('rejects the acknowledgement on its own', async () => {
      const response = await server.request(post('acknowledge=1'));
      assert.equal(response.statusCode, 422);
      assert.equal(server.episodes.listByShow(show.id).length, 2, 'nothing should have happened');
    });

    it('rejects the typed name on its own', async () => {
      const response = await server.request(post(`confirm=${encodeURIComponent(show.slug)}`));
      assert.equal(response.statusCode, 422);
      assert.match(response.body, /Tick the box/);
      assert.equal(server.episodes.listByShow(show.id).length, 2);
    });

    it('rejects a mistyped name even when acknowledged', async () => {
      const response = await server.request(post('acknowledge=1&confirm=not-the-slug'));
      assert.equal(response.statusCode, 422);
      assert.match(response.body, /exactly to confirm/);
    });

    it('proceeds only when both are given', async () => {
      const ids = server.episodes.listByShow(show.id).map((e) => e.id).sort();
      const response = await server.request(post(`acknowledge=1&confirm=${encodeURIComponent(show.slug)}`));
      assert.ok([200, 303].includes(response.statusCode), `got ${response.statusCode}`);
      const after_ = server.episodes.listByShow(show.id).map((e) => e.id).sort();
      assert.notDeepEqual(after_, ids, 'the rebuild should have run');
      assert.equal(after_.length, 2);
    });

    it('needs an admin session', async () => {
      const anonymous = await server.app.inject({
        method: 'POST',
        url: `/api/shows/${show.id}/rebuild`,
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      assert.equal(anonymous.statusCode, 401);
    });

    it('cannot be triggered from another website', async () => {
      const crossSite = await server.app.inject({
        method: 'POST',
        url: `/api/shows/${show.id}/rebuild`,
        headers: { cookie: server.cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      });
      assert.ok(crossSite.statusCode >= 400, `cross-site rebuild returned ${crossSite.statusCode}`);
    });
  });

  describe('the modal', () => {
    it('states the consequence and offers both confirmations', async () => {
      const response = await server.request({
        method: 'GET',
        url: `/ui/modals/rebuild-show/${show.slug}`,
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /re-download/i);
      assert.match(response.body, /No audio file is touched/i);
      assert.match(response.body, /data-confirm-check/);
      assert.match(response.body, /data-confirm-match/);
      // Both gates must point at the same button, or the browser-side gate cannot
      // require both.
      const targets = [...response.body.matchAll(/data-confirm-target="([^"]+)"/g)].map((m) => m[1]);
      assert.equal(targets.length, 2);
      assert.equal(targets[0], targets[1]);
      assert.match(response.body, /id="confirm-rebuild-show" disabled/);
    });
  });
});
