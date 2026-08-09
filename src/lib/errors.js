/**
 * Errors carry a message that is safe and sensible to show a user directly —
 * the API contract (spec §14) promises `error.message` is displayable, so no
 * raw exception text ever reaches it.
 */
export class AppError extends Error {
  constructor(message, { code = 'error', status = 400, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

export const badRequest = (message, code = 'bad_request') =>
  new AppError(message, { code, status: 400 });

export const unauthorized = (message = 'Please sign in to continue.', code = 'unauthorized') =>
  new AppError(message, { code, status: 401 });

export const forbidden = (message, code = 'forbidden') =>
  new AppError(message, { code, status: 403 });

export const notFound = (message = 'Not found.', code = 'not_found') =>
  new AppError(message, { code, status: 404 });

export const conflict = (message, code = 'conflict') =>
  new AppError(message, { code, status: 409 });

export const payloadTooLarge = (message, code = 'payload_too_large') =>
  new AppError(message, { code, status: 413 });

export const unprocessable = (message, code = 'validation_failed', fields = undefined) => {
  const err = new AppError(message, { code, status: 422 });
  if (fields) err.fields = fields;
  return err;
};

export const unavailable = (message, code = 'unavailable') =>
  new AppError(message, { code, status: 503 });

/**
 * Turns a filesystem error into a sentence a homelab user can act on, naming the
 * UID the app actually runs as and the exact path (spec §11.5, §13.1). This is
 * the single most important error-message helper in the app: every permission
 * failure the hand-rolled prototype hit was invisible until a podcast app broke.
 */
export function describeFsError(err, { path, uid, gid } = {}) {
  const who =
    uid === undefined
      ? 'SelfPod'
      : `SelfPod is running as UID ${uid}${gid === undefined ? '' : `, GID ${gid}`}`;
  const where = path ? ` \`${path}\`` : '';

  switch (err?.code) {
    case 'EACCES':
    case 'EPERM':
      return `Permission denied reading${where}. ${who}; check that this user can read files there. Adjust PUID/PGID to match the owner of your files, or fix the share's permissions — SelfPod never changes permissions on your files itself.`;
    case 'ENOENT':
      return `${where.trim() || 'That path'} no longer exists on disk.`;
    case 'EISDIR':
      return `Expected a file but found a directory at${where}.`;
    case 'ENOTDIR':
      return `Expected a directory but found a file at${where}.`;
    case 'EROFS':
      return `The filesystem at${where} is read-only. SelfPod needs write access to /data to store its database.`;
    case 'ENOSPC':
      return `No space left on the device holding${where}.`;
    case 'EMFILE':
    case 'ENFILE':
      return 'Too many open files. This usually means the host limit on file handles is too low for the number of files being watched.';
    case 'ENOTEMPTY':
      return `The directory${where} is not empty.`;
    // SQLite reports a permission problem as "unable to open database file"
    // rather than EACCES, and that is nearly always what it means, so it gets the
    // same actionable guidance instead of a generic message.
    case 'SQLITE_CANTOPEN':
      return `SelfPod could not open or create its database at${where}. ${who}; that user needs read and write access to the folder holding it. Set PUID/PGID to match the owner of that folder, or grant that user access — SelfPod never changes permissions itself.`;
    case 'SQLITE_READONLY':
      return `SelfPod's database at${where} is read-only. ${who}; that user needs write access. Check PUID/PGID and the folder's permissions.`;
    default:
      return `Could not read${where}: ${err?.message ?? 'unknown error'}.`;
  }
}
