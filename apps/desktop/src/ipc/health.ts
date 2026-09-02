/**
 * `health:sources` push wiring (Task 1.7).
 *
 * `health:sources` is a **send**, not an invoke: the preload subscribes with
 * `ipcRenderer.on` and the main process pushes. So there is deliberately no
 * `ipcMain.handle('health:sources')` here — registering one would be dead code
 * the renderer never calls.
 *
 * How the pushes are timed: `Poller` exposes a `health()` *getter* and no
 * cycle-completion hook (`onEvents` only fires on a successful cycle that
 * produced events, so it would miss exactly the failures the user needs to see).
 * The honest integration point is therefore a short periodic snapshot. The push
 * is unconditional rather than change-gated on purpose — `lagMs` is computed
 * against `now`, so it advances continuously and a "send only on change" filter
 * would fire every tick anyway while adding a diff nobody can rely on.
 */
import type { BrowserWindow } from 'electron';
import type { PollSourceKind, Poller, SourceHealth as PollerSourceHealth } from '@cr/ingest';
import type { Source, SourceHealth } from '../preload.cjs';

export type { SourceHealth };

/** The `send` channel name; must match the preload's `subscribe()` call exactly. */
export const HEALTH_CHANNEL = 'health:sources';

/** How often the poller's health is snapshotted and pushed. */
const DEFAULT_PUSH_INTERVAL_MS = 5_000;

/** Source order in the pushed array — stable so the UI's rows never reshuffle. */
const SOURCES: readonly PollSourceKind[] = ['slack', 'gmail'];

/**
 * Map the poller's vocabulary onto the renderer's.
 *
 * The two are deliberately different alphabets and the collapse is lossy in one
 * direction only:
 *
 * - `backoff` → `degraded`: transient failure, still retrying, nothing for the
 *   user to do.
 * - `rate_limited` → `rate-limited`: kept distinct (R-5). Folding throttling into
 *   `degraded` is precisely the mistake that leaves a user staring at a stale
 *   briefing with no idea the provider is holding us off.
 * - `auth_error` and `never_synced` → `disconnected`: both mean "no usable data
 *   is flowing and only the user can fix it", which is the one action the status
 *   strip needs to prompt.
 */
function toRendererStatus(status: PollerSourceHealth['status']): SourceHealth['status'] {
  switch (status) {
    case 'ok':
      return 'ok';
    case 'rate_limited':
      return 'rate-limited';
    case 'backoff':
      return 'degraded';
    default:
      return 'disconnected';
  }
}

/**
 * Project a `Poller.health()` snapshot onto the renderer's `SourceHealth[]`.
 *
 * Pure, and the only place the two health vocabularies meet — see `test/health.test.ts`.
 *
 * `retryAfter` is never populated: `Poller` keeps `nextDelayMs` private and
 * exposes no "next attempt at" value, so there is nothing truthful to put there.
 * Inventing a deadline would be worse than omitting an optional field.
 */
export function toHealthPayload(
  health: Record<PollSourceKind, PollerSourceHealth>,
): SourceHealth[] {
  return SOURCES.map((source) => {
    const entry = health[source];
    return {
      // `PollSourceKind` and the preload's `Source` are the same two literals;
      // the cast documents that rather than hiding a widening.
      source: source as Source,
      status: toRendererStatus(entry.status),
      lagMs: entry.lagMs,
    };
  });
}

export interface HealthPushOptions {
  /** Snapshot cadence in ms. Defaults to 5s. */
  intervalMs?: number;
  /**
   * Called with every payload that is pushed to the renderer, before the send.
   * `main.ts` uses this to drive the tray, so the tray and the window can never
   * disagree about what the sources are doing.
   */
  onHealth?: (health: SourceHealth[]) => void;
}

/**
 * Start pushing `health:sources` to `win` and return a stop function.
 *
 * Must be called AFTER the window exists (unlike the OAuth handlers). Sends
 * immediately, then on every interval tick, and again whenever the renderer
 * finishes a (re)load — a reloaded renderer would otherwise show an empty status
 * strip until the next tick.
 *
 * @returns Disposer; call it on quit so the timer does not outlive the window.
 */
export function registerHealthHandlers(
  win: BrowserWindow,
  poller: Poller,
  options: HealthPushOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_PUSH_INTERVAL_MS;

  const push = (): void => {
    const payload = toHealthPayload(poller.health());
    options.onHealth?.(payload);
    // The window survives `close` (it only hides), but guard anyway: a send to a
    // destroyed webContents throws, and this runs on a bare timer with no caller
    // to catch it.
    if (win.isDestroyed()) return;
    win.webContents.send(HEALTH_CHANNEL, payload);
  };

  const timer = setInterval(push, intervalMs);
  // A status-strip refresh must never be the reason the process stays alive.
  timer.unref();

  win.webContents.on('did-finish-load', push);
  push();

  return () => {
    clearInterval(timer);
    if (!win.isDestroyed()) win.webContents.removeListener('did-finish-load', push);
  };
}
