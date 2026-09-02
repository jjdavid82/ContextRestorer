/**
 * `pipeline:status` push — a live "what is the pipeline doing right now" strip.
 *
 * Ingestion, Layer 1 extraction, and Layer 2 synthesis all run silently in the
 * background (see `createLayer12` in `main.ts`): a user who sends themselves a
 * test email and stares at the home page has no way to tell "nothing is
 * happening yet" from "something is broken" — both look identical (nothing on
 * screen changes) until a briefing eventually reflects the result, minutes
 * later. This channel exists purely to make that wait legible.
 *
 * Same push pattern as `health.ts`'s `health:sources`: a short periodic
 * snapshot, sent immediately and on every `did-finish-load`, because the
 * numbers below have no natural "changed" event to hook instead — extraction
 * and synthesis both run as a plain background sweep/tick with no
 * completion callback this module could subscribe to without inventing one.
 */
import type { BrowserWindow } from 'electron';
import type { Clock } from '@cr/core';
import type { DebounceScheduler, DebounceConfig } from '@cr/ai';
import type { EventsRepo, WatermarkRepo } from '@cr/store';

/** The `send` channel name; must match the preload's `subscribe()` call exactly. */
export const PIPELINE_STATUS_CHANNEL = 'pipeline:status';

/** A snapshot of pending work across Layer 1 and Layer 2. */
export interface PipelineStatus {
  /** Ingested events with no `extractions` row yet — Layer 1's work list. */
  extractionBacklog: number;
  /**
   * Threads whose D-7 quiet window or hard cap has already elapsed, so they
   * will be picked up on the debounce scheduler's next tick (at most 30s).
   * Excludes threads already being synthesized (`synthesisInFlight`).
   */
  synthesisDue: number;
  /** Threads Layer 2 is synthesizing at this exact moment. */
  synthesisInFlight: number;
}

export interface PipelineStatusDeps {
  events: Pick<EventsRepo, 'countUnextracted'>;
  watermarks: Pick<WatermarkRepo, 'due'>;
  scheduler: Pick<DebounceScheduler, 'pending'>;
  /** `config.debounce` — the quiet-window/hard-cap thresholds `due()` needs. */
  debounce: DebounceConfig;
  clock: Clock;
}

/**
 * Compute one snapshot. Pure aside from the reads, so it is unit-testable
 * without a `BrowserWindow` — same split as `toHealthPayload` in `health.ts`.
 */
export function computePipelineStatus(deps: PipelineStatusDeps): PipelineStatus {
  const inFlight = new Set(deps.scheduler.pending);
  const due = deps.watermarks
    .due(deps.clock.now(), { debounce: deps.debounce })
    .filter((thread) => !inFlight.has(thread.threadKey));

  return {
    extractionBacklog: deps.events.countUnextracted(),
    synthesisDue: due.length,
    synthesisInFlight: inFlight.size,
  };
}

export interface PipelineStatusPushOptions {
  /** Snapshot cadence in ms. Defaults to 5s, matching `health:sources`. */
  intervalMs?: number;
}

/**
 * Start pushing `pipeline:status` to `win` and return a stop function.
 *
 * Must be called AFTER the window exists (unlike the OAuth handlers) — same
 * contract as `registerHealthHandlers`.
 *
 * @returns Disposer; call it on quit so the timer does not outlive the window.
 */
export function registerPipelineStatusPush(
  win: BrowserWindow,
  deps: PipelineStatusDeps,
  options: PipelineStatusPushOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 5_000;

  const push = (): void => {
    // The window survives `close` (it only hides), but guard anyway: a send to
    // a destroyed webContents throws, and this runs on a bare timer with no
    // caller to catch it.
    if (win.isDestroyed()) return;
    win.webContents.send(PIPELINE_STATUS_CHANNEL, computePipelineStatus(deps));
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
