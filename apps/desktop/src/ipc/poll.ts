/**
 * `poll:refresh` — force a source's next poll cycle now, on user request.
 *
 * The poller fetches each source every `polling.<source>.intervalMs` (5 min by
 * default), and a source that has been failing is backed off further. When the
 * user has just done something they expect to show up — sent themselves a test
 * mail, been @-mentioned in Slack — waiting out that interval with no way to say
 * "look now" reads as the app being broken. This channel is that lever: it calls
 * `Poller.pollNow(source)`, which forgets the backoff and schedules a cycle at
 * delay 0 (the same primitive `oauth:connect` uses after a successful connect).
 *
 * **The rate limit lives here, not in the poller and not in the renderer.**
 *
 * - Not in the poller: `pollNow` is a mechanism ("poll this source now"), and
 *   its one existing caller (a fresh OAuth connect) must never be throttled.
 *   Adding a user-facing cooldown there would entangle two unrelated policies.
 * - Not in the renderer: the disabled button is a convenience. A compromised
 *   renderer — or just a reloaded one that lost its timer — can call this
 *   channel in a loop, and Slack/Gmail rate limits are exactly what a loop of
 *   forced polls would walk into. This handler is the trust boundary.
 *
 * Each source may be refreshed at most once per {@link MANUAL_REFRESH_COOLDOWN_MS}.
 * A call inside that window is answered `{ ok: false, reason: 'cooldown',
 * retryAfterMs }` — never an exception: nothing throws out of an `ipcMain.handle`
 * callback (a rejection reaches the renderer as an opaque "Error invoking remote
 * method …" with a main-process stack pasted in), exactly as the OAuth, schedule
 * and external handlers do.
 *
 * `retryAfterMs` is returned on success too (the full cooldown), so the renderer
 * can disable its button for the right duration without hard-coding the value,
 * and a renderer that reloaded mid-cooldown learns the remaining time from its
 * first rejected click.
 */
import { ipcMain } from 'electron';
import type { PollSourceKind, Poller } from '@cr/ingest';

/** The invoke channel name. Must match `preload.cts`'s allowlist exactly. */
export const REFRESH_CHANNEL = 'poll:refresh';

/**
 * Minimum gap between two manual refreshes of the same source.
 *
 * An in-code constant rather than config, matching `health.ts`'s
 * `DEFAULT_PUSH_INTERVAL_MS` and `oauth.ts`'s `SLACK_REDIRECT_PORT` /
 * `REFRESH_SKEW_MS`: it is a guard-rail value, not a user preference. 60s is
 * well under the 5-minute poll interval, and a user tapping it every 60s stops
 * the moment they stop tapping.
 */
export const MANUAL_REFRESH_COOLDOWN_MS = 60_000;

/** Result shape returned to the renderer; mirrored in `preload.cts`. */
export interface PollRefreshResult {
  ok: boolean;
  /** Cause when `ok` is false: `invalid_source`, `cooldown`, or `internal_error`. */
  reason?: string;
  /**
   * Milliseconds until this source may be manually refreshed again. Present on
   * `ok: true` (the full cooldown) and on `ok: false, reason: 'cooldown'` (what
   * remains of it); absent otherwise.
   */
  retryAfterMs?: number;
}

export interface PollHandlerDeps {
  /** `Poller` in production — narrowed to the one method this needs. */
  poller: Pick<Poller, 'pollNow'>;
  /** Injected time source; nothing here calls `Date.now()` directly. */
  clock: { now(): number };
  /** Cooldown override for tests. Defaults to {@link MANUAL_REFRESH_COOLDOWN_MS}. */
  cooldownMs?: number;
}

/**
 * Narrow the renderer-supplied argument to a source kind.
 *
 * Re-validated here rather than trusted from the preload — a compromised
 * renderer controls what it sends.
 *
 * @returns The source, or `null` when the argument is not `{ source: 'slack' |
 *   'gmail' }`.
 */
export function parsePollSource(arg: unknown): PollSourceKind | null {
  const source: unknown = (arg as { source?: unknown } | null)?.source;
  return source === 'slack' || source === 'gmail' ? source : null;
}

/**
 * The `poll:refresh` body.
 *
 * `lastAcceptedAt` is owned by the caller ({@link registerPollHandlers} keeps
 * one per registration) so this function stays a pure decision given its inputs
 * — the tests drive it directly with a fresh map per case.
 *
 * A `pollNow` that throws does NOT record the timestamp: the poll never
 * happened, so the user should be able to try again immediately rather than
 * being locked out for a minute by a failure that was ours.
 */
export function requestManualRefresh(
  arg: unknown,
  deps: PollHandlerDeps,
  lastAcceptedAt: Map<PollSourceKind, number>,
): PollRefreshResult {
  const source = parsePollSource(arg);
  if (source === null) return { ok: false, reason: 'invalid_source' };

  const cooldownMs = deps.cooldownMs ?? MANUAL_REFRESH_COOLDOWN_MS;
  const now = deps.clock.now();
  const prev = lastAcceptedAt.get(source);

  if (prev !== undefined && now - prev < cooldownMs) {
    return { ok: false, reason: 'cooldown', retryAfterMs: cooldownMs - (now - prev) };
  }

  try {
    deps.poller.pollNow(source);
  } catch (error) {
    console.error(`[poll] manual refresh of ${source} failed`, error);
    return { ok: false, reason: 'internal_error' };
  }

  lastAcceptedAt.set(source, now);
  return { ok: true, retryAfterMs: cooldownMs };
}

/**
 * Register `poll:refresh`. Safe to call before any window exists — the handler
 * needs no `BrowserWindow`.
 *
 * The per-source cooldown state is a closure-local `Map`: one registration, one
 * app run, one set of timers.
 */
export function registerPollHandlers(deps: PollHandlerDeps): void {
  const lastAcceptedAt = new Map<PollSourceKind, number>();
  ipcMain.handle(REFRESH_CHANNEL, (_event, arg: unknown): PollRefreshResult =>
    requestManualRefresh(arg, deps, lastAcceptedAt),
  );
}
