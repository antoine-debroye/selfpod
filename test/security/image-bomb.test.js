import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';

import { createTestServer } from '../helpers/http.js';
import { IMAGE_MAX_INPUT_PIXELS } from '../../src/constants.js';

/**
 * A decompression bomb dropped on the share.
 *
 * `/data/shows` is a network share other people can write to, so a cover or an
 * episode sidecar is a stranger's choice. sharp's default pixel ceiling is ~268
 * megapixels; an 8000×8000 PNG of one colour is 60 KB on disk and 192 MB decoded,
 * and 16000×16000 is a gigabyte. The scanner decodes sidecars on its own, on every
 * scan, so one such file used to be a crash loop with no banner to explain it.
 */
const SIDE = 8000; // 64 megapixels: past the 40 MP ceiling, cheap to build in a test

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    let c = (crc ^ buffer[i]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A valid 8-bit greyscale PNG of one colour: tiny on disk, enormous decoded. */
function bombPng(side) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows = Buffer.alloc(side * (side + 1)); // one filter byte per row, then zeros
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('an image too large to decode safely', () => {
  let server;
  let png;

  before(async () => {
    server = await createTestServer();
    png = bombPng(SIDE);
    assert.ok(SIDE * SIDE > IMAGE_MAX_INPUT_PIXELS, 'the test image must exceed the ceiling');
    assert.ok(png.length < 200_000, `the bomb should be small on disk, got ${png.length} bytes`);
  });

  after(async () => {
    await server.cleanup();
  });

  it('is refused as episode artwork with a sentence that says why', async () => {
    await assert.rejects(
      server.episodeArt.store({ showId: 'show', episodeId: 'episode', buffer: png }),
      /million pixels/,
    );
  });

  it('is refused as an uploaded cover without being decoded', async () => {
    const dir = await server.makeShowFolder('bomb-upload');
    const source = join(dir, 'upload.png');
    await writeFile(source, png);
    await assert.rejects(server.covers.saveUpload(dir, source), (err) => {
      assert.equal(err.code, 'image_too_large');
      assert.match(err.message, /million pixels/);
      return true;
    });
  });

  it('does not stop a scan, and the scan log says what happened', async () => {
    await server.addAudio('bomb-sidecar', 'sample.mp3', 'episode.mp3');
    await writeFile(join(server.config.showsDir, 'bomb-sidecar', 'episode.png'), png);
    await server.scanner.scanAllNow('manual');

    const show = server.shows.getBySlug('bomb-sidecar');
    assert.ok(show, 'the show was still discovered');
    const [episode] = server.episodes.listByShow(show.id);
    assert.ok(episode, 'the episode beside the bomb was still added');
    assert.equal(episode.art_source ?? null, null, 'the bomb was not adopted as artwork');

    const scan = server.activity.latestForShow(show.id);
    const warning = scan.warnings.find((w) => /episode\.png/.test(w.file ?? '') || /episode\.png/.test(w.message));
    assert.ok(warning, `expected a warning naming episode.png, got ${JSON.stringify(scan.warnings)}`);
    assert.match(warning.message, /million pixels/);
  });
});
