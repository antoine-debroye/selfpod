import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

/**
 * Content-based episode identity (spec §7.2).
 *
 * The identity key answers "is this the same audio I already know about?" —
 * independently of the filename, so renaming a file on disk updates its
 * enclosure URL without changing its GUID. Podcast apps key played state off the
 * GUID, so a filename-derived identity meant every rename duplicated the episode
 * and lost listened state.
 *
 * Full-file hashing is avoided for the common case: a multi-hour episode is
 * hundreds of megabytes and would make every scan an I/O storm on a NAS. Hashing
 * a fixed window at each end plus the exact byte length is more than unique
 * enough for a personal library. The accepted trade-off is that an edit which
 * changes only the middle of a file *and* preserves its exact size will not be
 * noticed — the manual "Rescan now" action re-hashes everything for that case.
 */

export const WINDOW_BYTES = 1024 * 1024; // 1 MiB head + 1 MiB tail
export const WHOLE_FILE_THRESHOLD = 2 * 1024 * 1024; // below this, just hash it all

/** Hash of an explicit buffer/size pair. Exposed for tests and for in-memory data. */
export function identityKeyFromParts({ head, tail, size }) {
  const hash = createHash('sha256');
  if (head?.length) hash.update(head);
  if (tail?.length) hash.update(tail);
  hash.update(String(size));
  return hash.digest('hex');
}

/**
 * Computes the identity key for a file on disk.
 * Throws on I/O errors so the caller can record a per-file scan error rather
 * than silently skipping the file.
 */
export async function computeIdentityKey(filePath, { size } = {}) {
  const fileSize = size ?? (await stat(filePath)).size;

  const handle = await open(filePath, 'r');
  try {
    if (fileSize <= WHOLE_FILE_THRESHOLD) {
      const buffer = Buffer.allocUnsafe(fileSize);
      if (fileSize > 0) await handle.read(buffer, 0, fileSize, 0);
      return identityKeyFromParts({ head: buffer, size: fileSize });
    }

    const head = Buffer.allocUnsafe(WINDOW_BYTES);
    const tail = Buffer.allocUnsafe(WINDOW_BYTES);
    await handle.read(head, 0, WINDOW_BYTES, 0);
    await handle.read(tail, 0, WINDOW_BYTES, fileSize - WINDOW_BYTES);
    return identityKeyFromParts({ head, tail, size: fileSize });
  } finally {
    await handle.close();
  }
}
