import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenVault, type OAuthTokens, type SafeStorageLike } from '../src/oauth/vault.js';

const SLACK_TOKENS: OAuthTokens = {
  accessToken: 'xoxp-slack-access-token',
  refreshToken: 'xoxe-1-slack-refresh-token-SECRET',
  expiresAt: 1_800_000_000_000,
  scope: 'channels:history,im:history,users:read',
};

const GMAIL_TOKENS: OAuthTokens = {
  accessToken: 'ya29.gmail-access-token',
  refreshToken: '1//gmail-refresh-token-SECRET',
  expiresAt: 1_900_000_000_000,
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
};

const PREFIX = 'enc:';

/**
 * A deliberately *transforming* mock. A passthrough would make the "no plaintext on disk"
 * assertion vacuous, so this base64-wraps the payload — reversible, but nothing readable
 * survives into the raw file bytes.
 */
const makeSafeStorage = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: vi.fn(() => available),
  encryptString: vi.fn((plainText: string) =>
    Buffer.from(PREFIX + Buffer.from(plainText, 'utf8').toString('base64'), 'utf8'),
  ),
  decryptString: vi.fn((encrypted: Buffer) => {
    const raw = encrypted.toString('utf8');
    if (!raw.startsWith(PREFIX)) throw new Error('mock decrypt: not our ciphertext');
    return Buffer.from(raw.slice(PREFIX.length), 'base64').toString('utf8');
  }),
});

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-vault-'));
  filePath = join(dir, 'tokens.enc');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TokenVault (SEC-2, SEC-3)', () => {
  it('encrypts via safeStorage and writes ciphertext to the vault file', async () => {
    const safeStorage = makeSafeStorage();
    const vault = new TokenVault(safeStorage, filePath);

    await vault.store('slack', SLACK_TOKENS);

    expect(safeStorage.encryptString).toHaveBeenCalledTimes(1);
    expect(safeStorage.encryptString).toHaveBeenCalledWith(
      JSON.stringify({ slack: SLACK_TOKENS }),
    );
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).toString('utf8').startsWith(PREFIX)).toBe(true);
  });

  it('never leaves the plaintext refresh token in the raw file bytes', async () => {
    const vault = new TokenVault(makeSafeStorage(), filePath);

    await vault.store('slack', SLACK_TOKENS);
    await vault.store('gmail', GMAIL_TOKENS);

    const raw = readFileSync(filePath);
    const asUtf8 = raw.toString('utf8');
    const asLatin1 = raw.toString('latin1');

    for (const needle of [
      SLACK_TOKENS.refreshToken,
      SLACK_TOKENS.accessToken,
      GMAIL_TOKENS.refreshToken,
      GMAIL_TOKENS.accessToken,
    ]) {
      expect(asUtf8).not.toContain(needle);
      expect(asLatin1).not.toContain(needle);
      expect(raw.includes(Buffer.from(needle, 'utf8'))).toBe(false);
    }
  });

  it('refuses to store when the OS keychain is unavailable, writing nothing', async () => {
    const safeStorage = makeSafeStorage(false);
    const vault = new TokenVault(safeStorage, filePath);

    await expect(vault.store('slack', SLACK_TOKENS)).rejects.toThrow(
      /refusing to store OAuth tokens unencrypted/,
    );

    // No plaintext fallback file, no empty file, nothing at all.
    expect(existsSync(filePath)).toBe(false);
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it('does not modify an existing vault file when encryption is unavailable', async () => {
    const sentinel = 'enc:preexisting';
    writeFileSync(filePath, sentinel);
    const before = statSync(filePath).mtimeMs;

    const vault = new TokenVault(makeSafeStorage(false), filePath);
    await expect(vault.store('slack', SLACK_TOKENS)).rejects.toThrow(/refusing to store/);

    expect(readFileSync(filePath, 'utf8')).toBe(sentinel);
    expect(statSync(filePath).mtimeMs).toBe(before);
  });

  it('round-trips tokens through store/load', async () => {
    const vault = new TokenVault(makeSafeStorage(), filePath);

    await vault.store('slack', SLACK_TOKENS);

    await expect(vault.load('slack')).resolves.toEqual(SLACK_TOKENS);
  });

  it('returns undefined for an unknown source and for a missing vault file', async () => {
    const vault = new TokenVault(makeSafeStorage(), filePath);

    await expect(vault.load('gmail')).resolves.toBeUndefined();

    await vault.store('slack', SLACK_TOKENS);
    await expect(vault.load('gmail')).resolves.toBeUndefined();
  });

  it('revoke removes only the named source and leaves the others intact', async () => {
    const vault = new TokenVault(makeSafeStorage(), filePath);
    await vault.store('slack', SLACK_TOKENS);
    await vault.store('gmail', GMAIL_TOKENS);

    await vault.revoke('slack');

    await expect(vault.load('slack')).resolves.toBeUndefined();
    await expect(vault.load('gmail')).resolves.toEqual(GMAIL_TOKENS);
    expect(existsSync(filePath)).toBe(true);
  });

  it('deletes the vault file when the last entry is revoked (SEC-3)', async () => {
    const vault = new TokenVault(makeSafeStorage(), filePath);
    await vault.store('slack', SLACK_TOKENS);
    await vault.store('gmail', GMAIL_TOKENS);

    await vault.revoke('slack');
    await vault.revoke('gmail');

    // Not an empty-but-present `{}` file — gone entirely.
    expect(existsSync(filePath)).toBe(false);
    await expect(vault.load('slack')).resolves.toBeUndefined();
    await expect(vault.load('gmail')).resolves.toBeUndefined();
  });

  it('revoking a source that was never stored is a no-op', async () => {
    const vault = new TokenVault(makeSafeStorage(), filePath);

    await expect(vault.revoke('gmail')).resolves.toBeUndefined();
    expect(existsSync(filePath)).toBe(false);
  });

  // POSIX only: Windows does not map `mode` onto ACLs, so the 0o600 bits are not
  // meaningfully enforced there and asserting them would be flaky rather than useful.
  it.skipIf(process.platform === 'win32')('creates the file with mode 0o600', async () => {
    const vault = new TokenVault(makeSafeStorage(), filePath);

    await vault.store('slack', SLACK_TOKENS);

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('keeps the vault file non-world-readable after a rewrite', async () => {
    const vault = new TokenVault(makeSafeStorage(), filePath);
    await vault.store('slack', SLACK_TOKENS);
    await vault.store('gmail', GMAIL_TOKENS);

    if (process.platform === 'win32') {
      // Windows: assert only that the file exists and is readable by the owner.
      expect(existsSync(filePath)).toBe(true);
      return;
    }
    expect(statSync(filePath).mode & 0o077).toBe(0);
  });
});
