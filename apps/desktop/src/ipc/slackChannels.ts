/**
 * `slack:listAvailable` / `slack:getSelected` / `slack:setSelected` — the
 * channel-selector settings surface (closes Task 1.7's gap: until a selection
 * exists, `VaultBackedSlackClient` in `main.ts` has no channel to poll and
 * every Slack cycle fails loudly).
 *
 * `slack:listAvailable` makes a LIVE `conversations.list` call rather than
 * reading anything cached: channel membership changes on Slack's side, not
 * this app's, and a stale list would let the user "select" a channel the
 * token can no longer see. It requires a connected Slack token; when there is
 * none, it degrades to `{ ok: false, reason: 'not_connected' }` rather than an
 * empty list, so the settings page can tell "no channels" apart from "you
 * haven't connected Slack yet".
 *
 * `slack:getSelected` / `slack:setSelected` are pure store reads/writes and
 * never touch the network.
 *
 * As everywhere else in this directory: nothing throws out of an
 * `ipcMain.handle` callback, and every argument is re-validated here — the
 * preload's checks are a convenience gate, not the trust boundary.
 */
import { ipcMain } from 'electron';
import { SlackClient, type SlackChannelSummary, type TokenVault } from '@cr/ingest';
import type { SelectedSlackChannel } from '@cr/store';
import type { OkResult } from '../preload.cjs';

/** Invoke channel returning the live, currently-visible Slack channels. */
export const LIST_AVAILABLE_CHANNEL = 'slack:listAvailable';

/** Invoke channel returning the persisted selection. */
export const GET_SELECTED_CHANNEL = 'slack:getSelected';

/** Invoke channel that replaces the persisted selection. */
export const SET_SELECTED_CHANNEL = 'slack:setSelected';

/** `slack:listAvailable` result. */
export interface AvailableChannelsResult {
  ok: boolean;
  /** Present only when `ok` is true. */
  channels?: SlackChannelSummary[];
  /** Present only when `ok` is false, e.g. `not_connected`, `internal_error`. */
  reason?: string;
}

/**
 * The slice of `SlackChannelsRepo` these handlers use.
 *
 * Structural, so the real repo satisfies it with no adapter and a test can
 * pass a hand-rolled store.
 */
export interface SlackChannelStore {
  list(): SelectedSlackChannel[];
  setSelected(
    channels: ReadonlyArray<{ channelId: string; name: string; projectId?: string | null }>,
    now: number,
  ): void;
}

/**
 * Rebuilds `belongs_to` edges after a selection is saved (A-2).
 *
 * Injected rather than imported so this module keeps no `@cr/store` runtime
 * dependency beyond types, matching how every other handler here is wired. When
 * absent the selection still saves — it simply does not backfill, which is the
 * pre-A-2 behaviour.
 */
export type RelinkProjects = (channels: readonly SelectedSlackChannel[]) => void;

export interface SlackChannelsHandlerDeps {
  /** Read for the live token; `undefined`/absent means Slack was never connected. */
  vault: TokenVault;
  /** `SlackChannelsRepo` in production. */
  channels: SlackChannelStore;
  /** Injected time source for `added_at`; nothing here calls `Date.now()`. */
  clock: { now(): number };
  /**
   * FR-5/FR-8 stakes linking, run after a successful save. Optional; see
   * {@link RelinkProjects}.
   */
  relinkProjects?: RelinkProjects;
}

/** One entry of a parsed selection. `projectId` follows the repo's tri-state. */
export interface ParsedChannelSelection {
  channelId: string;
  name: string;
  /** Absent = leave the tag alone; `null` = clear it; string = set it (A-2). */
  projectId?: string | null;
}

/**
 * Narrow the renderer-supplied selection. `null` means "not a channel list".
 *
 * `projectId` is optional and tri-state, mirroring
 * `SlackChannelsRepo.setSelected`: a payload that omits it entirely — which is
 * what the plain checkbox save sends — must not read as "clear every tag".
 * Anything present but not a string or `null` is a malformed payload and
 * rejects the whole selection, same as a bad `channelId`.
 */
export function parseSelection(arg: unknown): ReadonlyArray<ParsedChannelSelection> | null {
  const candidate = (arg as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(candidate)) return null;

  const parsed: ParsedChannelSelection[] = [];
  for (const entry of candidate) {
    const row = entry as { channelId?: unknown; name?: unknown; projectId?: unknown } | null;
    if (row === null || typeof row !== 'object') return null;
    if (typeof row.channelId !== 'string' || row.channelId === '') return null;
    if (typeof row.name !== 'string' || row.name === '') return null;

    if (row.projectId === undefined) {
      parsed.push({ channelId: row.channelId, name: row.name });
      continue;
    }
    if (row.projectId !== null && (typeof row.projectId !== 'string' || row.projectId === '')) {
      return null;
    }
    parsed.push({ channelId: row.channelId, name: row.name, projectId: row.projectId });
  }
  return parsed;
}

/**
 * `slack:listAvailable` body.
 *
 * A fresh `SlackClient` per call, matching `VaultBackedSlackClient`'s own
 * pattern of never holding a token across calls: the vault is the single
 * source of truth for whether Slack is connected right now.
 */
export async function listAvailableChannels(
  deps: SlackChannelsHandlerDeps,
): Promise<AvailableChannelsResult> {
  try {
    const stored = await deps.vault.load('slack');
    if (stored === undefined) return { ok: false, reason: 'not_connected' };

    const client = new SlackClient({ token: stored.accessToken });
    const channels = await client.listChannels();
    return { ok: true, channels };
  } catch (error) {
    console.error('[slackChannels] listAvailable failed', error);
    return { ok: false, reason: 'internal_error' };
  }
}

/** `slack:getSelected` body. Degrades a failed read to an empty list. */
export function getSelectedChannels(deps: SlackChannelsHandlerDeps): SelectedSlackChannel[] {
  try {
    return deps.channels.list();
  } catch (error) {
    console.error('[slackChannels] getSelected failed', error);
    return [];
  }
}

/** `slack:setSelected` body. */
export function setSelectedChannels(arg: unknown, deps: SlackChannelsHandlerDeps): OkResult {
  const parsed = parseSelection(arg);
  if (parsed === null) return { ok: false, reason: 'invalid_selection' };

  try {
    deps.channels.setSelected(parsed, deps.clock.now());
  } catch (error) {
    console.error('[slackChannels] setSelected failed', error);
    return { ok: false, reason: 'internal_error' };
  }

  // A-2: project the new tags onto `belongs_to` edges, including for threads
  // already ingested. Deliberately AFTER the save has committed and outside its
  // try: a relink failure must not report the selection as unsaved — the
  // selection IS saved, and the next save (or app start) rebuilds the links
  // anyway, since `rebuildProjectLinks` is idempotent.
  if (deps.relinkProjects !== undefined) {
    try {
      deps.relinkProjects(deps.channels.list());
    } catch (error) {
      console.error('[slackChannels] project relink failed; selection was still saved', error);
    }
  }

  return { ok: true };
}

/**
 * Register the three channel-selector channels. Safe to call before any
 * window exists — none of them needs a `BrowserWindow`.
 */
export function registerSlackChannelsHandlers(deps: SlackChannelsHandlerDeps): void {
  ipcMain.handle(LIST_AVAILABLE_CHANNEL, (): Promise<AvailableChannelsResult> =>
    listAvailableChannels(deps),
  );
  ipcMain.handle(GET_SELECTED_CHANNEL, (): SelectedSlackChannel[] => getSelectedChannels(deps));
  ipcMain.handle(SET_SELECTED_CHANNEL, (_event, arg: unknown): OkResult =>
    setSelectedChannels(arg, deps),
  );
}
