import { constants as fsConstants } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import { MAX_PIPELINE_FILE_BYTES } from '../constants.js';
import { resolveContained } from './contained-path.js';

/**
 * Opening an episode for the advert pipeline — fingerprinting, listening, cutting.
 *
 * Every route that *serves* a file proves the path is inside the show's folder
 * before opening it (`resolveContained`), because the folder is normally an SMB
 * share that other accounts can write to. The pipeline reads the same files, and
 * used to read them by their joined path with no check at all — so a planted
 *
 *     episode.mp3 -> /dev/zero
 *
 * or a FIFO, or a symlink to a multi-gigabyte file elsewhere on the NAS, would hang
 * the unattended pass or exhaust its heap, every few minutes, for ever. This is the
 * one place the pipeline's reads go through, and it refuses three things before a
 * byte is read: a path that resolves outside the folder, anything that is not an
 * ordinary file, and anything larger than SelfPod will hold in memory.
 *
 * Refusals come back as a plain sentence naming the file, for the health banner and
 * the activity log. A file that is simply gone or unreadable is reported the quiet
 * way the pipeline always has — that is ordinary on a share — and told apart here so
 * the caller can keep doing so.
 */

/**
 * Checks an episode's file and says whether the pipeline may read it.
 *
 * @returns {Promise<{path: string, size: number, mtimeMs: number} | {refused: string, message: string, quiet: boolean}>}
 */
export async function gateEpisodeFile(directory, filename, { maxBytes = MAX_PIPELINE_FILE_BYTES } = {}) {
  const resolved = await resolveContained(directory, filename);
  if (!resolved.path) {
    if (resolved.reason === 'escapes') {
      return {
        refused: 'escapes',
        quiet: false,
        message: `“${filename}” is a link to somewhere outside the show's folder, so SelfPod will not read it.`,
      };
    }
    return {
      refused: 'unreadable',
      quiet: true,
      message: `“${filename}” could not be read${resolved.code ? ` (${resolved.code})` : ''}.`,
    };
  }

  let info;
  try {
    info = await stat(resolved.path);
  } catch (error) {
    return { refused: 'unreadable', quiet: true, message: `“${filename}” could not be read (${error.code ?? error.message}).` };
  }
  return gateInfo(info, filename, resolved.path, maxBytes);
}

/**
 * Opens a file that has already passed `gateEpisodeFile` and checks it *again* on the
 * open descriptor, so a file swapped between the check and the read — a link
 * re-pointed at a device, say — is still refused. `O_NONBLOCK` is the difference
 * between refusing a FIFO and waiting on it for ever: opening one for reading blocks
 * until something writes to it, and nothing ever will.
 */
export async function openGatedFile(path, { maxBytes = MAX_PIPELINE_FILE_BYTES } = {}) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    const verdict = gateInfo(info, path.slice(path.lastIndexOf('/') + 1), path, maxBytes);
    if (verdict.refused) {
      const error = new Error(verdict.message);
      error.code = 'refused';
      error.refused = verdict.refused;
      throw error;
    }
    return { handle, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function gateInfo(info, filename, path, maxBytes) {
  if (!info.isFile()) {
    return {
      refused: 'not_a_file',
      quiet: false,
      message: `“${filename}” is not an ordinary file (a device, a pipe or a folder), so SelfPod will not read it.`,
    };
  }
  if (info.size > maxBytes) {
    return {
      refused: 'too_large',
      quiet: false,
      message: `“${filename}” is ${formatBytes(info.size)}, more than the ${formatBytes(maxBytes)} SelfPod will read in one piece, so it was not read.`,
    };
  }
  return { path, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
