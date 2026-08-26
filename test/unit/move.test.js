import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { SCAN_TRIGGER } from '../../src/constants.js';
import { moveIntoPlace, stagingPathFor } from '../../src/lib/move.js';
import { createTestInstance } from '../helpers/harness.js';

let app;

beforeEach(async () => {
  app = await createTestInstance();
});

afterEach(async () => {
  await app.cleanup();
});

describe('EXDEV staging is invisible to the library', () => {
  it('stages beside the destination under a dot-prefixed name', () => {
    const staged = stagingPathFor('/data/shows/tape-club/Episode 12.mp3');

    assert.equal(
      staged,
      '/data/shows/tape-club/.Episode 12.mp3.selfpod-incoming',
      'the staging file must sit beside its destination so the final rename stays on one filesystem',
    );
    assert.ok(
      basename(staged).startsWith('.'),
      'a visible staging name is what made the scanner warn about SelfPod\'s own temporary file',
    );
  });

  it('does not blame the user for a copy that is still in progress', async () => {
    // Exactly what a slow cross-filesystem move looks like at the moment a scan runs.
    const dir = await app.makeShowFolder('tape-club');
    await app.addAudio('tape-club', 'sample.mp3', 'real-episode.mp3');
    const inFlight = stagingPathFor(join(dir, 'half-copied.mp3'));
    await writeFile(inFlight, 'not yet a whole file');

    const record = await app.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    // Positive control: the scan really ran and really looked at this folder,
    // so "no warning" means the file was ignored, not that nothing happened.
    assert.equal(record.added, 1, 'the genuine episode beside it was still picked up');

    const complaint = record.warnings.find((w) => String(w.file ?? '').includes('selfpod-incoming'));
    assert.equal(
      complaint,
      undefined,
      `SelfPod warned about its own staging file: ${complaint?.message}`,
    );
    assert.equal(
      app.episodes.listByShow(app.shows.getBySlug('tape-club').id).length,
      1,
      'a partial copy must never become an episode',
    );
  });

  it('would have warned under the old visible staging name', async () => {
    // The counter-proof for the test above. Without this, "no warning" could mean
    // the scanner simply never looked, and the regression test would be vacuous.
    const dir = await app.makeShowFolder('tape-club');
    await writeFile(join(dir, 'half-copied.mp3.selfpod-incoming'), 'not yet a whole file');

    const record = await app.scanner.scanAllNow(SCAN_TRIGGER.MANUAL);

    const complaint = record.warnings.find((w) => String(w.file ?? '').includes('selfpod-incoming'));
    assert.ok(
      complaint,
      'the old name really did produce a warning, so dot-prefixing is what silences it',
    );
    assert.match(complaint.message, /doesn't serve that file type/);
  });

  it('leaves nothing behind when the copy fails', async () => {
    const dir = await app.makeShowFolder('tape-club');
    const destination = join(dir, 'never-arrives.mp3');

    await assert.rejects(
      () => moveIntoPlace(join(dir, 'source-that-does-not-exist.mp3'), destination),
      /ENOENT/,
    );

    const left = await readdir(dir);
    assert.deepEqual(left, [], 'a failed move must not leave a staging file in the show folder');
  });
});
