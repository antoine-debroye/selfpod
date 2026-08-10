import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proof that a reply came from *this* SelfPod.
 *
 * The reachability check needs to distinguish "my public address reaches me" from
 * "my public address reaches something that also runs SelfPod" — an old container
 * still listening, or a second install on the same hostname. That misconfiguration
 * is the most confusing of all, because every page looks healthy while subscribers
 * are served someone else's feeds.
 *
 * Echoing a nonce cannot establish this: every SelfPod would echo it just as
 * happily. The answer must be something only this install can compute, so it is an
 * HMAC under a key derived from the session secret. The derivation keeps that secret
 * from ever directly signing caller-supplied input, and the MAC output is safe to
 * publish — it reveals nothing about the key.
 */
const DERIVATION_LABEL = 'selfpod:reachability-proof:v1';

function deriveKey(sessionSecret) {
  // A missing secret should not throw on a public endpoint; an unusable key simply
  // produces a proof that never matches, which reads as "not this instance".
  return createHmac('sha256', String(sessionSecret ?? '')).update(DERIVATION_LABEL).digest();
}

/** The value /health returns alongside the nonce. */
export function signPing(sessionSecret, ping) {
  return createHmac('sha256', deriveKey(sessionSecret)).update(String(ping)).digest('hex');
}

/** Constant-time comparison of a returned proof against the expected one. */
export function pingMatches(sessionSecret, ping, pong) {
  if (typeof pong !== 'string') return false;
  const expected = Buffer.from(signPing(sessionSecret, ping), 'utf8');
  const actual = Buffer.from(pong, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
