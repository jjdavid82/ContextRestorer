import { createHash, randomBytes } from 'node:crypto';

/**
 * A PKCE (RFC 7636) verifier/challenge pair.
 *
 * The `verifier` is kept in memory by the desktop main process and sent only on the
 * token-exchange leg; the `challenge` is what travels through the browser on the
 * authorize leg. Only S256 is supported — `plain` is deliberately not offered (SEC-2).
 */
export interface PkceChallenge {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** RFC 7636 §4.1 allows 43–128 chars; 32 random bytes base64url-encode to exactly 43. */
const VERIFIER_BYTES = 32;

/** CSRF `state` entropy. 32 bytes is well past the 128-bit floor. */
const STATE_BYTES = 32;

/**
 * Creates a fresh, cryptographically random PKCE verifier and its S256 challenge.
 *
 * `challenge = BASE64URL(SHA256(ASCII(verifier)))` — base64url is unpadded with
 * `+`→`-` and `/`→`_`, which is exactly what Node's `'base64url'` encoding produces.
 */
export function createChallenge(): PkceChallenge {
  const verifier = randomBytes(VERIFIER_BYTES).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

/**
 * Creates a single-use CSRF `state` value for an authorize request.
 *
 * The caller must compare the value echoed back on the loopback callback against
 * this exact string before exchanging the authorization code.
 */
export function createState(): string {
  return randomBytes(STATE_BYTES).toString('base64url');
}
