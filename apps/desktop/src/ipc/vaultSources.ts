/**
 * The ingest sources the app holds OAuth credentials for, and the one question
 * more than one IPC handler asks about them: "which are currently connected?".
 *
 * `onboarding:status` (`projects.ts`) and `privacy:stats` (`privacy.ts`) both
 * report a `connectedSources` list, and both had their own copy of the source
 * array and the `vault.load(source) !== undefined` loop. When the source set
 * grows, or the "an unreadable vault entry counts as not connected" rule needs
 * adjusting, it should change in exactly one place.
 */
import type { SourceId } from '@cr/core';

/** The sources whose credentials the vault can hold, in display order. */
export const VAULT_SOURCES: readonly SourceId[] = ['slack', 'gmail'];

/** The single vault capability {@link connectedSources} needs. */
export interface CredentialReader {
  load(source: SourceId): Promise<unknown>;
}

/**
 * Which of {@link VAULT_SOURCES} currently hold a usable, non-revoked
 * credential.
 *
 * A vault entry that cannot be decrypted counts as "not connected" — that is
 * what the user has to act on anyway — and one unreadable line item never fails
 * the whole check.
 */
export async function connectedSources(vault: CredentialReader): Promise<SourceId[]> {
  const connected: SourceId[] = [];
  for (const source of VAULT_SOURCES) {
    try {
      if ((await vault.load(source)) !== undefined) connected.push(source);
    } catch {
      // Unreadable vault entry → reported as not connected.
    }
  }
  return connected;
}
