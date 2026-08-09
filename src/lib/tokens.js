import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Random base62 string with no modulo bias — bytes outside the largest whole
 * multiple of 62 are discarded rather than folded in.
 */
function randomBase62(length) {
  const limit = 256 - (256 % BASE62.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += BASE62[byte % BASE62.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Feed token: 22 base62 characters ≈ 130.9 bits of entropy, comfortably over
 * the 128-bit floor in spec §12.2. This is a credential — anyone holding it can
 * read that show's feed and media, so it is never logged (see plugins/log-redaction.js).
 */
export function newFeedToken() {
  return randomBase62(22);
}

/**
 * Episode / show GUIDs. Deliberately random and derived from nothing about the
 * file: deriving a GUID from a filename is what made renames look like brand new
 * episodes to podcast apps (spec §7.2).
 */
export function newId() {
  return randomUUID();
}

export function newSessionId() {
  return randomBase62(32);
}

export function newSessionSecret() {
  return randomBytes(32).toString('hex');
}

/**
 * Bootstrap admin password: readable enough to retype from a log line, random
 * enough to be safe if the operator never changes it.
 */
export function newAdminPassword() {
  return randomBase62(16);
}

/**
 * Constant-time token comparison. Both sides are hashed first so the compare
 * always runs over equal-length buffers regardless of input length.
 */
export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}
