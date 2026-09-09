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
import { MAX_BATCH_EVENTS, type DebounceScheduler, type DebounceConfig } from '@cr/ai';
import type { AiCallsRepo, EventsRepo, WatermarkRepo } from '@cr/store';

/**
 * How many recent Layer-1 calls the ETA averages over.
 *
 * Small on purpose. The estimate is about this machine's speed right now, and a
 * long window would keep quoting the pace of a backlog that has since drained
 * (or of a model the user has since changed).
 */
export const ETA_LATENCY_SAMPLE = 10;

/** The `send` channel name; must match the preload's `subscribe()` call exactly. */
export const PIPELINE_STATUS_CHANNEL = 'pipeline:status';

/** A snapshot of pending work across Layer 1 and Layer 2. */
export interface PipelineStatus {
  /** Ingested events with no `extractions` row yet — Layer 1's work list. */
  extractionBacklog: number;
  /**
   * Threads whose D-7 quiet window or hard cap has already elapsed, so they
   * will be picked up on the debounce scheduler's next tick (at most 30s).
   * Excludes threads already being synthesized (`synthesisInFlight`) and
   * threads the scheduler has parked after exhausting `maxAttempts` — those
   * will not be picked up on the next tick (or any tick), so counting them as
   * "queued" would never resolve.
   *
   * A thread whose clocks have elapsed but that still has recently-ingested
   * events awaiting Layer 1 is NOT due either (`WatermarkRepo`'s `DUE_SQL`
   * gates firing on extraction), so it is not counted here; it is already
   * visible in `extractionBacklog`, which is the honest place for it — the
   * thread is waiting on the model, not on the clock.
   */
  synthesisDue: number;
  /** Threads Layer 2 is synthesizing at this exact moment. */
  synthesisInFlight: number;
  /**
   * Threads the scheduler has parked — due by the clock, extraction finished,
   * but `maxAttempts` synthesis attempts all failed, so it has stopped retrying.
   * Nothing clears this without a fresh event on the thread (or manual repair),
   * so it is the one pipeline number that means "a human should look", which is
   * why the rail surfaces it separately from `synthesisDue`.
   */
  parkedThreads: number;
  /**
   * Roughly how long the current extraction backlog will take to clear, in
   * milliseconds — `null` when there is no backlog, or when there is not yet
   * enough measured evidence to say (F2).
   *
   * `null` is load-bearing and is NOT "soon": a first-run user has no completed
   * Layer-1 calls to average, and inventing a number for them is exactly the
   * false promise this field exists to replace. The renderer shows the count
   * alone until an estimate is earned.
   *
   * Estimated as `ceil(backlog / MAX_BATCH_EVENTS) × recent mean call latency`,
   * because Layer 1 batches a thread's events into one model call. It is an
   * order-of-magnitude answer to "is this minutes or hours", which is the
   * question a new user actually has, and it is deliberately not presented as
   * more precise than that.
   */
  extractionEtaMs: number | null;
}

export interface PipelineStatusDeps {
  events: Pick<EventsRepo, 'countUnextracted'>;
  watermarks: Pick<WatermarkRepo, 'due'>;
  scheduler: Pick<DebounceScheduler, 'pending'>;
  /**
   * Measured Layer-1 latency, for {@link PipelineStatus.extractionEtaMs}.
   *
   * Optional: a host wired without it reports `null`, which the renderer already
   * has to handle for the first-run case.
   */
  aiCalls?: Pick<AiCallsRepo, 'recentMeanLatencyMs'>;
  /** `config.debounce` — the quiet-window/hard-cap thresholds `due()` needs. */
  debounce: DebounceConfig;
  /** The scheduler's park threshold — `DEFAULT_MAX_ATTEMPTS` in production. */
  maxAttempts: number;
  clock: Clock;
}

/**
 * Compute one snapshot. Pure aside from the reads, so it is unit-testable
 * without a `BrowserWindow` — same split as `toHealthPayload` in `health.ts`.
 */
export function computePipelineStatus(deps: PipelineStatusDeps): PipelineStatus {
  const inFlight = new Set(deps.scheduler.pending);
  const dueNow = deps.watermarks
    .due(deps.clock.now(), { debounce: deps.debounce })
    .filter((thread) => !inFlight.has(thread.threadKey));

  const backlog = deps.events.countUnextracted();

  return {
    extractionBacklog: backlog,
    extractionEtaMs: estimateExtractionEta(backlog, deps.aiCalls),
    // Queued = due and still within the retry budget.
    synthesisDue: dueNow.filter((t) => t.attempts < deps.maxAttempts).length,
    synthesisInFlight: inFlight.size,
    // Parked = due but out of retries. Read from `attempts` rather than the
    // scheduler's in-memory set so a thread parked in a previous run still
    // counts before this process's scheduler has ticked.
    parkedThreads: dueNow.filter((t) => t.attempts >= deps.maxAttempts).length,
  };
}

/**
 * Turn a backlog into a wall-clock estimate, or `null` when it cannot be
 * honestly estimated.
 *
 * Exported for tests: this is the one piece of arithmetic in this module a
 * regression could quietly get wrong by an order of magnitude.
 */
export function estimateExtractionEta(
  backlog: number,
  aiCalls?: Pick<AiCallsRepo, 'recentMeanLatencyMs'>,
): number | null {
  if (backlog <= 0) return null;
  if (aiCalls === undefined) return null;

  let meanMs: number | null;
  try {
    meanMs = aiCalls.recentMeanLatencyMs(1, ETA_LATENCY_SAMPLE);
  } catch (error) {
    // A status strip must not fail over its own optional garnish.
    console.error('[pipeline] extraction ETA lookup failed', error);
    return null;
  }
  if (meanMs === null || meanMs <= 0) return null;

  // Layer 1 sends up to `MAX_BATCH_EVENTS` events per model call, so the
  // backlog costs calls, not events. Ceil: a partial batch still costs a call.
  return Math.ceil(backlog / MAX_BATCH_EVENTS) * meanMs;
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
