import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import type { SourceId } from '@cr/core';

export type { SourceId };

/** OAuth material for one provider. `expiresAt` is epoch milliseconds. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

/**
 * Structural stand-in for Electron's `safeStorage`.
 *
 * Taking this as a constructor dependency (instead of `import { safeStorage } from 'electron'`)
 * keeps the vault unit-testable under plain Node while the desktop main process passes the
 * real OS-keychain-backed module.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** On-disk shape: one encrypted JSON object holding every connected source. */
type VaultContents = Partial<Record<SourceId, OAuthTokens>>;

/** Owner read/write only. */
const FILE_MODE = 0o600;

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Encrypted-at-rest store for OAuth tokens (SEC-2, SEC-3).
 *
 * Everything is held in a single OS-encrypted blob; there is no plaintext fallback and no
 * partial-plaintext mode. If the OS keychain is unavailable the vault refuses to operate
 * rather than degrading.
 */
export class TokenVault {
  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly filePath: string,
  ) {}

  /** Encrypts and persists `tokens` for `source`, preserving any other source's entry. */
  async store(source: SourceId, tokens: OAuthTokens): Promise<void> {
    this.assertEncryptionAvailable();
    const all = await this.readAll();
    all[source] = tokens;
    await this.writeAll(all);
  }

  /** Returns the stored tokens for `source`, or `undefined` if absent / no vault yet. */
  async load(source: SourceId): Promise<OAuthTokens | undefined> {
    const all = await this.readAll();
    return all[source];
  }

  /**
   * Forgets `source`. When it was the last entry the vault file is deleted outright, so a
   * disconnected app leaves no empty-but-present token file behind (SEC-3).
   */
  async revoke(source: SourceId): Promise<void> {
    const all = await this.readAll();
    if (all[source] === undefined) return;
    delete all[source];

    if (Object.keys(all).length === 0) {
      try {
        await unlink(this.filePath);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      return;
    }

    this.assertEncryptionAvailable();
    await this.writeAll(all);
  }

  private assertEncryptionAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      // SEC-2: refuse rather than degrade. No plaintext fallback, ever.
      throw new Error('OS keychain unavailable — refusing to store OAuth tokens unencrypted');
    }
  }

  /** Decrypts the whole vault, or `{}` when the file does not exist yet. */
  private async readAll(): Promise<VaultContents> {
    let blob: Buffer;
    try {
      blob = await readFile(this.filePath);
    } catch (err) {
      if (isEnoent(err)) return {};
      throw err;
    }

    // Only assert availability once we know there is ciphertext that needs decrypting.
    this.assertEncryptionAvailable();

    const json = this.safeStorage.decryptString(blob);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('token vault is corrupt: expected a JSON object');
    }
    return parsed as VaultContents;
  }

  private async writeAll(all: VaultContents): Promise<void> {
    const blob = this.safeStorage.encryptString(JSON.stringify(all));
    await writeFile(this.filePath, blob, { mode: FILE_MODE });
    // `mode` only applies at creation, so re-assert it on rewrites. POSIX only: on Windows
    // chmod merely toggles the read-only bit and ACLs govern access instead.
    if (process.platform !== 'win32') {
      await chmod(this.filePath, FILE_MODE);
    }
  }
}
