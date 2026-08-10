import { realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { isSafeFilename } from './slug.js';

/**
 * Resolves a filename inside a directory and proves the result really is inside it.
 *
 * A prefix check on the *joined* path is not enough, because a symlink makes a path
 * that looks contained point anywhere on the host. `/data/shows` is typically a
 * network share on a NAS, so anyone who can write to that share — over SMB, or as
 * another account on the box — could otherwise drop in
 *
 *     innocent.m4a -> /etc/shadow
 *
 * and read it through the feed, which is usually published to the internet. That
 * turns "can write to a shared folder" into "can read the host's files remotely",
 * so the real path is resolved and checked.
 *
 * The directory itself is resolved too, and compared against *its* real path rather
 * than against `/data/shows`. That deliberately keeps a legitimate arrangement
 * working — a whole show folder symlinked to another dataset, which is a normal NAS
 * layout — while still refusing a link that escapes the folder it appears to be in.
 *
 * Returns `{ path }` when the file is safe to serve, otherwise `{ reason, code }`.
 * The reason is for the *owner's* benefit — "this is a symlink pointing out of the
 * folder" and "this file is gone" need very different explanations in the access log.
 * Every reason produces the same 404 to the requester, so the response still cannot
 * be used to probe the filesystem.
 */
export async function resolveContained(directory, filename) {
  if (!isSafeFilename(filename)) return { reason: 'unsafe_name', code: null };

  let realDir;
  try {
    realDir = await realpath(directory);
  } catch (err) {
    return { reason: 'no_directory', code: err?.code ?? null };
  }

  let realFile;
  try {
    realFile = await realpath(join(realDir, filename));
  } catch (err) {
    // Missing, a broken symlink, or unreadable. The code tells them apart, and
    // "permission denied" deserves a different sentence from "not there".
    return { reason: 'missing', code: err?.code ?? null };
  }

  // The trailing separator matters: without it, `/data/shows/rock` would appear to
  // contain `/data/shows/rock-archive`.
  if (!isContained(realDir, realFile)) return { reason: 'escapes', code: null };

  // Belt and braces: the lexical path must agree too, so a filename that survived
  // `isSafeFilename` but still contains traversal cannot slip through.
  const lexical = resolve(join(realDir, filename));
  if (lexical !== realFile && !lexical.startsWith(realDir + sep)) {
    return { reason: 'escapes', code: null };
  }

  return { path: realFile };
}

/** Synchronous-friendly variant of the containment question, for a resolved pair. */
export function isContained(realDir, realFile) {
  if (typeof realDir !== 'string' || typeof realFile !== 'string') return false;
  const base = realDir.endsWith(sep) ? realDir : realDir + sep;
  return realFile === realDir || realFile.startsWith(base);
}
