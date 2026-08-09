import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  SCAN_TRIGGER,
  SHOW_STATUS,
  audioMimeType,
  isSupportedAudioFile,
  SUPPORTED_EXTENSIONS_LABEL,
} from '../../constants.js';
import { badRequest, conflict, notFound, payloadTooLarge, unprocessable } from '../../lib/errors.js';
import { moveIntoPlace } from '../../lib/move.js';
import { sanitiseUploadFilename } from '../../lib/slug.js';
import { newId } from '../../lib/tokens.js';

export default async function showRoutes(fastify, services) {
  const { config, settings, shows, episodes, covers, scanner, feeds, presentShow, presentEpisode } = services;

  fastify.addHook('onRequest', fastify.requireAdminApi);

  function findShow(idOrSlug) {
    const show = shows.get(idOrSlug) ?? shows.getBySlug(idOrSlug);
    if (!show) throw notFound('That show no longer exists.', 'show_not_found');
    return show;
  }

  /* ------------------------------------------------------------------ shows */

  fastify.get('/shows', async () => ({
    shows: shows.list().map((show) => presentShow(show)),
    publicBaseUrl: settings.publicBaseUrl(),
  }));

  fastify.post('/shows', async (request, reply) => {
    const { title, slug } = request.body ?? {};
    const show = await shows.create({ title, slug });
    await scanner.scanShowNow(show.id, SCAN_TRIGGER.MANUAL);
    reply.status(201);
    return { show: presentShow(shows.get(show.id)) };
  });

  fastify.get('/shows/:id', async (request) => ({
    show: presentShow(findShow(request.params.id), { includeEpisodes: true }),
  }));

  fastify.patch('/shows/:id', async (request) => {
    const show = findShow(request.params.id);
    const updated = shows.update(show.id, request.body ?? {});
    return { show: presentShow(updated) };
  });

  fastify.delete('/shows/:id', async (request) => {
    const show = findShow(request.params.id);
    const deleteFiles = isTrue(request.query?.deleteFiles) || isTrue(request.body?.deleteFiles);
    const confirm = request.query?.confirm ?? request.body?.confirm;

    // Typing the folder name is the confirmation for a destructive action that
    // can take an entire library of audio with it (spec §11.6).
    if (String(confirm ?? '') !== show.slug) {
      throw unprocessable(
        `To confirm, type the show's folder name exactly: ${show.slug}`,
        'confirmation_required',
        { confirm: `Type "${show.slug}" to confirm.` },
      );
    }

    const result = await shows.remove(show.id, { deleteFiles });
    return { ok: true, ...result };
  });

  /* ------------------------------------------------------------- feed token */

  fastify.post('/shows/:id/rotate-token', async (request) => {
    const show = findShow(request.params.id);
    const updated = shows.rotateToken(show.id);
    feeds.invalidate(show.id);
    return {
      show: presentShow(updated),
      note: 'The old feed URL stops working now. Anyone already subscribed needs the new URL. Copies already downloaded, and any CDN cache in front of SelfPod, may still serve briefly.',
    };
  });

  /* ------------------------------------------------------------------ scans */

  fastify.post('/shows/:id/rescan', async (request) => {
    const show = findShow(request.params.id);
    // A manual rescan re-hashes every file, which is the recovery path for a
    // content change that preserved size and mtime.
    const record = await scanner.scanShowNow(show.id, SCAN_TRIGGER.MANUAL, { rehash: true });
    return { ok: true, scan: record, show: presentShow(shows.get(show.id)) };
  });

  fastify.post('/rescan', async () => {
    const record = await scanner.scanAllNow(SCAN_TRIGGER.MANUAL, { rehash: false });
    return { ok: true, scan: record };
  });

  /* ------------------------------------------------------------------ cover */

  fastify.post('/shows/:id/cover', async (request) => {
    const show = findShow(request.params.id);
    const file = await request.file();
    if (!file) throw badRequest('No image was uploaded.', 'no_file');

    const tmpPath = join(config.tempDir, `cover-${newId()}`);
    try {
      await pipeline(file.file, createWriteStream(tmpPath));
      if (file.file.truncated) {
        throw payloadTooLarge(
          `That image is larger than the ${config.maxUploadSizeMb} MB upload limit.`,
          'file_too_large',
        );
      }
      const filename = await covers.saveUpload(shows.dirFor(show), tmpPath);
      const inspected = await covers.inspect(join(shows.dirFor(show), filename));
      shows.setSystemFields(show.id, {
        cover_filename: filename,
        cover_width: inspected.width,
        cover_height: inspected.height,
        cover_format: inspected.format,
        cover_mtime: inspected.mtime,
      });
      feeds.invalidate(show.id);
      return { show: presentShow(shows.get(show.id)) };
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

  /** The optional one-click artwork fix from spec §10.2. */
  fastify.post('/shows/:id/cover/normalize', async (request) => {
    const show = findShow(request.params.id);
    if (!show.cover_filename) throw badRequest('This show has no cover art to resize yet.', 'no_cover');

    const result = await covers.normalise(shows.dirFor(show), show.cover_filename);
    shows.setSystemFields(show.id, {
      cover_filename: result.filename,
      cover_width: result.after.width,
      cover_height: result.after.height,
      cover_format: result.after.format,
      cover_mtime: result.after.mtime,
    });
    feeds.invalidate(show.id);
    return {
      show: presentShow(shows.get(show.id)),
      before: { width: result.before.width, height: result.before.height },
      after: { width: result.after.width, height: result.after.height },
    };
  });

  /* ---------------------------------------------------------------- uploads */

  fastify.get('/shows/:id/episodes', async (request) => {
    const show = findShow(request.params.id);
    return { episodes: episodes.listByShow(show.id).map((e) => presentEpisode(e, show)) };
  });

  /**
   * Browser upload (spec §11.4). Streams to a staging file inside `/data` and
   * only then renames into the show folder — same filesystem, so the move is
   * atomic and a failed upload can never be mistaken for a complete episode.
   */
  fastify.post('/shows/:id/upload', async (request) => {
    const show = findShow(request.params.id);
    if (show.status === SHOW_STATUS.FOLDER_MISSING) {
      throw conflict('This show’s folder is missing, so files cannot be added to it.', 'folder_missing');
    }

    const showDir = shows.dirFor(show);
    const accepted = [];
    const rejected = [];

    for await (const part of request.files()) {
      const original = sanitiseUploadFilename(part.filename);
      if (!original) {
        rejected.push({ filename: part.filename ?? '(unnamed)', message: 'That file has no usable name.' });
        part.file.resume();
        continue;
      }
      if (!isSupportedAudioFile(original)) {
        rejected.push({
          filename: original,
          message: `SelfPod doesn't serve that file type. Supported audio: ${SUPPORTED_EXTENSIONS_LABEL}.`,
        });
        part.file.resume();
        continue;
      }

      const target = await uniqueTarget(showDir, original);
      const tmpPath = join(config.tempDir, `upload-${newId()}`);
      try {
        await pipeline(part.file, createWriteStream(tmpPath));
        if (part.file.truncated) {
          await unlink(tmpPath).catch(() => {});
          rejected.push({
            filename: original,
            message: `That file is larger than the ${config.maxUploadSizeMb} MB upload limit. Drop it straight into \`${showDir}\` over SMB/NFS instead.`,
          });
          continue;
        }
        // Not a plain rename: the staging directory and the show folder are often
        // on different filesystems, which is the normal NAS layout.
        await moveIntoPlace(tmpPath, join(showDir, target));
        accepted.push({ filename: target, mimeType: audioMimeType(target) });
      } catch (err) {
        await unlink(tmpPath).catch(() => {});
        request.log.error({ err, filename: original }, 'upload failed');
        rejected.push({
          filename: original,
          message: `That upload could not be saved: ${err.message}`,
        });
      }
    }

    // Scan straight away so the user isn't waiting for the next scheduled pass.
    if (accepted.length) await scanner.scanShowNow(show.id, SCAN_TRIGGER.UPLOAD);

    return {
      accepted,
      rejected,
      show: presentShow(shows.get(show.id), { includeEpisodes: true }),
    };
  });
}

/** Never silently overwrite an existing episode file: "name (2).mp3" instead. */
async function uniqueTarget(dir, filename) {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let candidate = filename;
  let counter = 2;
  for (;;) {
    try {
      await stat(join(dir, candidate));
    } catch {
      return candidate;
    }
    candidate = `${stem} (${counter})${ext}`;
    counter += 1;
    if (counter > 500) return `${stem}-${Date.now()}${ext}`;
  }
}

function isTrue(value) {
  return value === true || value === 'true' || value === '1' || value === 'on' || value === 'yes';
}
