import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createChallenge, createState } from '../src/oauth/pkce.js';

describe('PKCE', () => {
  it('produces a >= 43 char verifier whose S256 challenge is BASE64URL(SHA256(verifier))', () => {
    const { verifier, challenge, method } = createChallenge();

    expect(method).toBe('S256');
    // RFC 7636 §4.1 minimum length.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    // URL-safe alphabet only: no '+', '/' or '=' padding.
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);

    const expected = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(challenge).toBe(expected);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('produces a different verifier on every call', () => {
    const a = createChallenge();
    const b = createChallenge();

    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });

  it('createState returns at least 32 bytes of entropy, and a fresh value each call', () => {
    const state = createState();

    expect(Buffer.from(state, 'base64url').byteLength).toBeGreaterThanOrEqual(32);
    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(createState()).not.toBe(state);
  });
});
