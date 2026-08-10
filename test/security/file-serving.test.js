import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTestServer } from '../helpers/http.js';

/**
 * Adversarial tests for file serving.
 *
 * The threat these defend against is the serious one for a self-hosted app exposed
 * through a tunnel: using the media endpoints to read files that are not podcast
 * episodes — the SQLite database, the host's /etc/passwd, anything on the NAS the
 * container can see.
 *
 * Two layers are tested separately on purpose. Validation stops bad values getting
 * into the database; the serving layer must *also* refuse them, because a single
 * missed validation path should not become an arbitrary file read. So several tests
 * write hostile values straight into the database and then check the response.
 */
describe('file serving cannot be used to read anything but episodes', () => {
  let server;
  let show;
  let episode;
  let secretPath;

  before(async () => {
    server = await createTestServer();
    await server.addAudio('audit', 'sample.m4a', 'legit.m4a');
    await server.scanner.scanAllNow('manual');
    show = server.shows.getBySlug('audit');
    episode = server.episodes.listByShow(show.id)[0];

    // A file outside the shows directory, standing in for anything on the NAS.
    secretPath = join(server.dataDir, 'secret-outside-shows.txt');
    await writeFile(secretPath, 'TOP-SECRET-NAS-CONTENT');
  });

  after(async () => {
    await server.cleanup();
  });

  const media = () => `/media/${show.slug}/${show.feed_token}`;

  /** Fails the test if a response body contains anything it should never expose. */
  function assertNoLeak(response, what) {
    const body = response.body ?? '';
    assert.ok(!body.includes('TOP-SECRET-NAS-CONTENT'), `${what} leaked a file outside the show folder`);
    assert.ok(!body.includes('root:x:'), `${what} leaked /etc/passwd`);
    assert.ok(!body.includes('SQLite format'), `${what} leaked the database`);
  }

  describe('the filename segment of a media URL', () => {
    it('is decorative — traversal there cannot change which file is served', async () => {
      // Resolution is by episode id; the filename exists only so apps see a sensible
      // name. These must all return the same audio, never anything else.
      for (const attempt of [
        '../../../../etc/passwd',
        '..%2F..%2F..%2Fetc%2Fpasswd',
        '....//....//etc/passwd',
        '%2e%2e%2f%2e%2e%2fdb.sqlite',
        'legit.m4a/../../../db.sqlite',
      ]) {
        const response = await server.app.inject({
          url: `${media()}/${episode.id}/${attempt}`,
        });
        assert.ok(
          [200, 404].includes(response.statusCode),
          `unexpected ${response.statusCode} for ${attempt}`,
        );
        assertNoLeak(response, `filename segment "${attempt}"`);
        if (response.statusCode === 200) {
          assert.equal(response.headers['content-type'], 'audio/x-m4a');
        }
      }
    });
  });

  describe('an episode row poisoned with a traversal filename', () => {
    it('refuses to serve rather than escaping the show folder', async () => {
      const original = episode.filename;
      for (const hostile of [
        '../secret-outside-shows.txt',
        '../../etc/passwd',
        '/etc/passwd',
        '../db.sqlite',
        'subdir/../../secret-outside-shows.txt',
      ]) {
        server.db.prepare('UPDATE episodes SET filename = ? WHERE id = ?').run(hostile, episode.id);
        const response = await server.app.inject({
          url: `${media()}/${episode.id}/${encodeURIComponent('anything.m4a')}`,
        });
        assert.equal(response.statusCode, 404, `"${hostile}" must not be served`);
        assertNoLeak(response, `episode filename "${hostile}"`);
      }
      server.db.prepare('UPDATE episodes SET filename = ? WHERE id = ?').run(original, episode.id);
    });
  });

  describe('a show row poisoned with a traversal cover name', () => {
    it('refuses to serve rather than escaping the show folder', async () => {
      for (const hostile of [
        '../secret-outside-shows.txt',
        '../../etc/passwd',
        '/etc/passwd',
        '../db.sqlite',
      ]) {
        server.db.prepare('UPDATE shows SET cover_filename = ? WHERE id = ?').run(hostile, show.id);
        const response = await server.app.inject({ url: `${media()}/cover.jpg` });
        assert.equal(response.statusCode, 404, `cover "${hostile}" must not be served`);
        assertNoLeak(response, `cover filename "${hostile}"`);
      }
      server.db.prepare('UPDATE shows SET cover_filename = NULL WHERE id = ?').run(show.id);
    });
  });

  describe('a show row poisoned with a traversal slug', () => {
    it('cannot relocate the show directory outside /data/shows', async () => {
      const original = show.slug;
      for (const hostile of ['../', '..', '../../etc', 'audit/../..']) {
        server.db.prepare('UPDATE shows SET slug = ? WHERE id = ?').run(hostile, show.id);
        const poisoned = server.shows.get(show.id);
        const response = await server.app.inject({
          url: `/media/${encodeURIComponent(hostile)}/${poisoned.feed_token}/${episode.id}/x.m4a`,
        });
        assert.ok(response.statusCode >= 400, `slug "${hostile}" must not resolve`);
        assertNoLeak(response, `slug "${hostile}"`);
      }
      server.db.prepare('UPDATE shows SET slug = ? WHERE id = ?').run(original, show.id);
    });
  });

  describe('the /assets static root', () => {
    it('serves only the app\'s own files', async () => {
      const ok = await server.app.inject({ url: '/assets/css/app.css' });
      assert.equal(ok.statusCode, 200);

      for (const attempt of [
        '/assets/../../../etc/passwd',
        '/assets/..%2f..%2f..%2fetc%2fpasswd',
        '/assets/%2e%2e/%2e%2e/package.json',
        '/assets/../../../../../../etc/passwd',
        '/assets/./../../src/index.js',
      ]) {
        const response = await server.app.inject({ url: attempt });
        assert.ok(response.statusCode >= 300, `${attempt} returned ${response.statusCode}`);
        assert.ok(!(response.body ?? '').includes('root:x:'), `${attempt} leaked /etc/passwd`);
        assert.ok(
          !(response.body ?? '').includes('createTestServer') && !(response.body ?? '').includes('"dependencies"'),
          `${attempt} leaked source or package metadata`,
        );
      }
    });
  });

  describe('a symlink planted inside a show folder', () => {
    it('is not followed out of the show folder', async () => {
      // Not a remote attack — it needs filesystem access — but a self-hosted server
      // whose media folder is a shared drive should not turn a symlink into a way to
      // publish the host's files to the internet.
      const outside = await mkdtemp(join(tmpdir(), 'selfpod-outside-'));
      const target = join(outside, 'host-secret.m4a');
      await writeFile(target, 'HOST-FILE-VIA-SYMLINK');
      const linkPath = join(server.config.showsDir, 'audit', 'innocent.m4a');
      await symlink(target, linkPath);

      await server.scanner.scanAllNow('manual');
      const episodes = server.episodes.listByShow(show.id);
      const linked = episodes.find((e) => e.filename === 'innocent.m4a');

      if (!linked) {
        // Ignoring symlinks outright is the safest outcome and needs no assertion
        // beyond "it did not become an episode".
        return;
      }
      const response = await server.app.inject({
        url: `${media()}/${linked.id}/innocent.m4a`,
      });
      assert.ok(
        !(response.body ?? '').includes('HOST-FILE-VIA-SYMLINK'),
        'a symlink inside a show folder published a file from outside it',
      );
    });
  });

  describe('the reason recorded for a refusal', () => {
    it('tells a symlink escape apart from a file that is simply gone', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'selfpod-reason-'));
      await writeFile(join(outside, 'target.m4a'), 'OUTSIDE');
      const escaping = join(server.config.showsDir, 'audit', 'escaping.m4a');
      await symlink(join(outside, 'target.m4a'), escaping);
      await server.scanner.scanAllNow('manual');

      server.db.prepare('DELETE FROM media_access').run();
      const episodes = server.episodes.listByShow(show.id);
      const linked = episodes.find((e) => e.filename === 'escaping.m4a');

      if (linked) {
        await server.app.inject({
          url: `${media()}/${linked.id}/escaping.m4a`,
          headers: { 'user-agent': 'Pocket Casts/7.5' },
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        const [row] = server.stats.list({ episodeId: linked.id });
        assert.ok(row, 'the refusal must be recorded');
        assert.match(
          row.error,
          /inside this show's folder|symlink/,
          `a symlink escape was explained as: ${row.error}`,
        );
      }

      // A genuinely absent file must keep its own, much plainer explanation — the
      // containment check runs first and used to swallow this case.
      const original = episode.filename;
      server.db
        .prepare('UPDATE episodes SET filename = ? WHERE id = ?')
        .run('vanished-episode.m4a', episode.id);
      server.db.prepare('DELETE FROM media_access').run();
      await server.app.inject({
        url: `${media()}/${episode.id}/vanished-episode.m4a`,
        headers: { 'user-agent': 'Pocket Casts/7.5' },
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
      const [missing] = server.stats.list({ episodeId: episode.id });
      assert.ok(missing, 'a missing file must be recorded too');
      assert.match(missing.error, /is not on disk/, `a missing file was explained as: ${missing.error}`);
      server.db.prepare('UPDATE episodes SET filename = ? WHERE id = ?').run(original, episode.id);
    });
  });

  describe('uploads', () => {
    it('cannot write outside the show folder, whatever the filename claims', async () => {
      await server.login();
      const hostile = [
        '../../../evil.m4a',
        '..%2f..%2fevil.m4a',
        '/etc/cron.d/evil.m4a',
        '....//....//evil.m4a',
      ];
      for (const name of hostile) {
        const boundary = '----selfpodaudit';
        const payload = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
              'Content-Type: audio/mpeg\r\n\r\n',
          ),
          await readFile(join(server.config.showsDir, 'audit', 'legit.m4a')),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const response = await server.request({
          method: 'POST',
          url: `/api/shows/${show.id}/upload`,
          payload,
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        });
        assert.ok(
          [200, 201, 400, 409, 415, 422].includes(response.statusCode),
          `unexpected ${response.statusCode} for upload named "${name}"`,
        );
        // Whatever it accepted must be a bare name inside the show folder.
        for (const saved of response.json().accepted ?? []) {
          assert.ok(
            !saved.filename.includes('/') && !saved.filename.includes('\\') && !saved.filename.startsWith('.'),
            `upload "${name}" was stored as "${saved.filename}"`,
          );
        }
      }

      // Whatever happened above, nothing may exist outside the show folder.
      const { readdir } = await import('node:fs/promises');
      const dataEntries = await readdir(server.dataDir);
      assert.ok(!dataEntries.includes('evil.m4a'), 'an upload escaped into /data');
      const showEntries = await readdir(server.config.showsDir);
      assert.ok(!showEntries.includes('evil.m4a'), 'an upload escaped into /data/shows');
    });
  });

  describe('the database and other /data files', () => {
    it('are not reachable through any media route', async () => {
      await mkdir(join(server.config.showsDir, 'audit'), { recursive: true });

      // With a valid episode id the filename segment is ignored by design, so this
      // one legitimately succeeds — what matters is that it serves the episode's
      // audio and not the database.
      const decorative = await server.app.inject({ url: `${media()}/${episode.id}/db.sqlite` });
      assertNoLeak(decorative, 'a media URL claiming to be db.sqlite');
      if (decorative.statusCode === 200) {
        assert.equal(decorative.headers['content-type'], 'audio/x-m4a');
      }

      for (const url of [
        '/media/audit/db.sqlite',
        '/media/../db.sqlite',
        '/db.sqlite',
        '/data/db.sqlite',
        '/feeds/../db.sqlite',
      ]) {
        const response = await server.app.inject({ url });
        assertNoLeak(response, url);
        assert.ok(response.statusCode >= 300, `${url} returned ${response.statusCode}`);
      }
    });
  });
});
