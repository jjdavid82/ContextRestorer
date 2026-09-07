/**
 * Layer-2 trigger: the D-7 debounce scheduler.
 *
 * A conversation should produce ONE state delta per burst, not one per message.
 * Two clocks per thread decide when that burst is over, and either can fire:
 *
 *   - the **quiet window**, measured from the thread's last event, so a
 *     conversation is synthesized once it settles;
 *   - the **hard cap**, measured from the OLDEST unsynthesized event, so a
 *     thread that never goes quiet still checkpoints instead of starving.
 *
 * Both clocks live in SQLite (`synthesis_watermark`), not in this object. That
 * is deliberate and load-bearing: an in-memory timer would reset on every
 * relaunch, so a busy thread's hard cap would never expire on a machine that is
 * restarted a few times a day. This class is therefore disposable — throw an
 * instance away, build a new one against the same `WatermarkRepo`, and the
 * trigger state resumes exactly where it was.
 *
 * The scheduler never calls `touch()`. Arming the clocks is ingest's job;
 * re-arming them is `markSynthesized()`'s job. If this class touched watermarks
 * it would push `last_event_at` forward and silently defeat the quiet window.
 *
 * ### The decision log (Task 4.4)
 *
 * A trigger that cannot be explained afterwards is indistinguishable from a bug,
 * so every fired thread mints a {@link Trace} and records, in one JSON line:
 * which condition fired (`quiet` / `hard_cap`), how quiet or how backed up the
 * thread was in milliseconds, how many events were on it, and — once the cycle
 * settles — what the synthesis actually DID (a delta, `{meaningful: false}`, or
 * an error). Before this, the hook reported only `reason`, and "success" meant
 * "resolved", which is the same word for "wrote a delta" and "decided there was
 * nothing to say" — the two outcomes an operator most needs to tell apart.
 *
 * The trigger's `traceId` is passed to `onSynthesize`, which is what puts the
 * Layer-2 `ai_calls` row under the same `trace_id` as the decision (NFR-8).
 */

import type { AppConfig, Clock } from '@cr/core';
import { startTrace, type Trace } from '@cr/observability';
import type { WatermarkRepo } from '@cr/store';
import type { SynthesisOutcome } from './synthesize.js';

/** Per-source debounce thresholds — the `debounce` slice of {@link AppConfig}. */
export type DebounceConfig = AppConfig['debounce'];

/** Why a thread fired: it went quiet, or it hit the hard cap while still busy. */
export type FireReason = 'quiet' | 'hard_cap';

/**
 * What one fired synthesis actually did (Task 4.4, requirement 3).
 *
 * Deliberately {@link SynthesisOutcome}'s own vocabulary rather than a
 * scheduler-local one, because it is also the vocabulary written to
 * `ai_calls.outcome` by Layer 2 — a decision trace that used different words
 * for the same events could not be joined against the audit trail, which is
 * most of the point of recording it.
 *
 * The three cases the checkpoint names map to:
 *   - a delta was written  → `'ok'`
 *   - `{meaningful: false}` → `'not_meaningful'`
 *   - the synthesis threw  → `'error'`
 *
 * `'unreported'` is the honest answer when the injected `onSynthesize` returns
 * `void` (it is allowed to). It says "this cycle succeeded and declined to say
 * what it did" rather than mislabelling it as a delta.
 */
export type TriggerOutcome = SynthesisOutcome | 'unreported';

/**
 * Observability hook payload. Purely informational; the scheduler ignores it.
 *
 * `fire` is emitted when the decision is made; `success`/`failure` when the
 * cycle it started settles. The decision fields (`reason`, `eventCount`) are
 * repeated on the terminal records on purpose: a reader that only keeps terminal
 * events still has the whole story — which condition fired, how busy the thread
 * was, and what came of it — in ONE record, without having to join back to the
 * `fire` that preceded it.
 */
export type SchedulerTrace =
  | {
      event: 'fire';
      /** Correlation id for this trigger; Layer 2's `ai_calls` rows carry it. */
      traceId: string;
      threadKey: string;
      source: string;
      reason: FireReason;
      /** Events on the thread, or `null` when no counter is wired (never 0). */
      eventCount: number | null;
      at: number;
    }
  | {
      event: 'success';
      traceId: string;
      threadKey: string;
      source: string;
      reason: FireReason;
      eventCount: number | null;
      outcome: TriggerOutcome;
      at: number;
    }
  | {
      event: 'failure';
      traceId: string;
      threadKey: string;
      source: string;
      reason: FireReason;
      eventCount: number | null;
      outcome: 'error';
      attempts: number;
      error: unknown;
    }
  | { event: 'degraded'; threadKey: string; attempts: number };

export interface DebounceSchedulerDeps {
  /** Injected time source — nothing here may call `Date.now()` (testability). */
  clock: Clock;
  config: DebounceConfig;
  /** Durable trigger state. Must be backed by the app's real database. */
  watermarks: WatermarkRepo;
  /**
   * Performs the synthesis. Rejecting counts as a failed attempt.
   *
   * `traceId` is the correlation id this trigger minted; passing it through to
   * `Layer2Synthesizer.synthesize(threadKey, traceId)` is what puts the layer-2
   * `ai_calls` row under the same `trace_id` as the trigger that caused it
   * (NFR-8). Returning the {@link SynthesisOutcome} is optional and additive: a
   * callback that still returns `Promise<void>` is assignable unchanged, and its
   * cycles are traced as `'unreported'`.
   */
  onSynthesize: (threadKey: string, traceId: string) => Promise<SynthesisOutcome | void>;
  /** Consecutive failures after which a thread is parked. Default 3. */
  maxAttempts?: number;
  /**
   * Wall-clock time (epoch ms) Layer 1 extraction began running in this
   * process — a fixed value, not a getter, since it does not move.
   *
   * Passed straight through to {@link WatermarkRepo.due}, where it suppresses
   * the hard-cap "Layer 1 has stalled" escape hatch until a full hard cap has
   * elapsed since it. Without it, the first `tick()` after the app is
   * (re)launched reads its own downtime — nothing extracted lately because
   * nothing was running — as a stalled Layer 1 and disarms the entire
   * unextracted backlog with no context, on slow hardware within ~90s.
   *
   * Omitted (most tests, and any caller with no separate extraction stage) =
   * `0`: the escape hatch is trusted immediately, exactly as before this
   * existed.
   */
  layer1ActiveSince?: number;
  onTrace?: (trace: SchedulerTrace) => void;
  /**
   * Events currently on a thread, for the decision trace only.
   *
   * Injected as a function rather than taken as an `EventsRepo` because this
   * number is diagnostic: the scheduler must not gain a second store dependency
   * (and a second way to be wrong about what "due" means) to report it. Omit it
   * and `eventCount` is traced as `null` — absent, not zero.
   */
  countThreadEvents?: (threadKey: string) => number;
  /**
   * Directory for the per-trigger trace JSONL sink (`trace-YYYY-MM-DD.jsonl`).
   *
   * Omitted = no file is written, but a `traceId` is still minted and still
   * flows through `onSynthesize`. Opt-in rather than defaulted to `'logs'`
   * because this class is constructed all over the test suite, and a default
   * would have every one of those runs append to `<cwd>/logs`.
   */
  logsDir?: string;
}

/**
 * Consecutive failed/no-context attempts after which a thread is parked.
 *
 * Exported so the OI-1 "still processing" count (`WatermarkRepo.countPendingSynthesis`)
 * can exclude threads the scheduler has already given up on — a thread parked
 * here is no longer "in progress" in any sense the disclosure should imply.
 *
 * Set well above 3: `tick()` runs every 30s, so a `no_context` outcome — which
 * fires whenever Layer 1 extraction for the thread's newest event is still
 * running when the quiet window elapses — must survive at least one full
 * extraction call before parking. A single Layer 1 call on `qwen2.5:14b` has
 * been observed at 70-110s even with no backlog; a `maxAttempts` of 3 (a
 * ~90s retry window) parks a thread whose extraction is still legitimately in
 * flight, permanently hiding content that was never actually broken. 10
 * attempts (~5 minutes) gives enough headroom to absorb a queued extraction or
 * two before concluding the thread can never gain context.
 */
export const DEFAULT_MAX_ATTEMPTS = 10;

/** One thread that fired on this tick, with the decision that fired it. */
interface FiredThread {
  threadKey: string;
  source: string;
  reason: FireReason;
  eventCount: number | null;
  trace: Trace;
}

export class DebounceScheduler {
  /**
   * Same-process re-entrancy guard, NOT a durability mechanism.
   *
   * `tick()` runs every 30s while a synthesis can take much longer, so without
   * this the second tick would see a still-due thread (its watermark is only
   * cleared on success) and start a duplicate generation. Cross-process safety
   * is not in scope: there is exactly one scheduler in the main process.
   */
  private readonly inFlight = new Set<string>();

  private readonly maxAttempts: number;

  private readonly layer1ActiveSince: number;

  constructor(private readonly deps: DebounceSchedulerDeps) {
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.layer1ActiveSince = deps.layer1ActiveSince ?? 0;
  }

  /** Threads currently being synthesized by this instance (diagnostics/tests). */
  get pending(): readonly string[] {
    return [...this.inFlight];
  }

  /**
   * One scheduling pass: called once at startup and every 30s thereafter.
   *
   * Resolves when every synthesis it started has settled. Never rejects — a
   * failing thread is accounted for and skipped, because one poison thread must
   * not take down the interval that drives every other thread.
   */
  async tick(): Promise<void> {
    const now = this.deps.clock.now();
    // The quiet/hard-cap arithmetic deliberately lives in the repo's single
    // indexed query rather than being re-derived here: two implementations of
    // the same predicate is exactly how this feature goes subtly wrong.
    const due = this.deps.watermarks.due(
      now,
      { debounce: this.deps.config },
      this.layer1ActiveSince,
    );

    const running: Array<Promise<void>> = [];

    for (const { threadKey } of due) {
      if (this.inFlight.has(threadKey)) continue;

      const wm = this.deps.watermarks.get(threadKey);
      if (wm === undefined) continue; // Deleted between the two reads.

      if (wm.attempts >= this.maxAttempts) {
        // Parked, not forgotten: it stays due in the database, and health
        // reporting (a later task) surfaces it. Retrying forever would burn the
        // whole synthesis budget on a thread that cannot succeed.
        this.deps.onTrace?.({ event: 'degraded', threadKey, attempts: wm.attempts });
        continue;
      }

      const reason: FireReason =
        now - wm.lastEventAt >= this.deps.config[wm.source].quietWindowMs ? 'quiet' : 'hard_cap';
      const eventCount = this.countEvents(threadKey);

      // One trace per TRIGGER, not per tick: the question this log answers is
      // "why did this thread synthesize, and what came of it", and a tick that
      // fires four threads has four independent answers.
      const trace = startTrace(this.deps.clock, this.deps.logsDir ?? '');
      trace.annotate({
        event: 'layer2_trigger',
        threadKey,
        source: wm.source,
        reason,
        eventCount,
        attempts: wm.attempts,
        quietForMs: now - wm.lastEventAt,
        backloggedForMs: wm.oldestUnsynthAt === null ? null : now - wm.oldestUnsynthAt,
        firedAt: now,
      });

      // Claimed synchronously, before the first `await` inside `run`, so a
      // re-entrant `tick()` cannot observe an unclaimed but already-firing thread.
      this.inFlight.add(threadKey);
      this.deps.onTrace?.({
        event: 'fire',
        traceId: trace.id,
        threadKey,
        source: wm.source,
        reason,
        eventCount,
        at: now,
      });
      running.push(this.run({ threadKey, source: wm.source, reason, eventCount, trace }));
    }

    await Promise.all(running);
  }

  /** Runs one thread's synthesis and records the outcome. Never rejects. */
  private async run(fired: FiredThread): Promise<void> {
    const { threadKey, source, reason, eventCount, trace } = fired;
    const span = trace.span('synthesis');

    try {
      // The trigger's id is handed down so Layer 2's `ai_calls` row lands under
      // the same `trace_id` as the decision that caused it (NFR-8).
      const reported = await this.deps.onSynthesize(threadKey, trace.id);
      span.end();

      // A `void`-returning callback is legal and traced honestly — see
      // `TriggerOutcome`. Anything else is Layer 2's own outcome vocabulary.
      const outcome: TriggerOutcome = typeof reported === 'string' ? reported : 'unreported';

      // `no_context` is not a decision, unlike `'ok'` and `'not_meaningful'`:
      // retrieval had nothing citable to show the model, most often because
      // Layer 1 extraction for the thread's newest event had not finished
      // embedding it yet when the quiet window fired. Marking the watermark
      // synthesized here would permanently settle a thread that was never
      // actually looked at — the embedding lands moments later, but nothing
      // re-triggers synthesis for it without a fresh event on the same
      // thread. Treated like a thrown error instead: left armed so `due()`
      // finds it again on the next tick, and counted against the retry
      // budget so a thread that can NEVER gain context (rather than one that
      // merely raced ahead of extraction) still parks instead of retrying
      // every 30s forever.
      if (outcome === 'no_context') {
        this.deps.watermarks.incrementAttempts(threadKey);
        const attempts = this.deps.watermarks.get(threadKey)?.attempts ?? 0;
        const at = this.deps.clock.now();

        trace.annotate({ outcome, wroteDelta: false, attempts });
        this.deps.onTrace?.({
          event: 'success',
          traceId: trace.id,
          threadKey,
          source,
          reason,
          eventCount,
          outcome,
          at,
        });
        return;
      }

      // Re-read the clock: synthesis is slow, and the watermark should record
      // when the cycle finished rather than when the tick began.
      const at = this.deps.clock.now();
      // `null` = "fully caught up as far as this layer knows". The scheduler has
      // no visibility into events that landed mid-synthesis; the Layer-2
      // synthesis routine, which knows which events it consumed, is what will
      // later pass a carried-over timestamp here instead.
      this.deps.watermarks.markSynthesized(threadKey, at, null);
      // A success clears the failure history, otherwise old failures would
      // accumulate across unrelated bursts and retire a healthy thread.
      this.deps.watermarks.resetAttempts(threadKey);

      trace.annotate({ outcome, wroteDelta: outcome === 'ok', settledAt: at });
      this.deps.onTrace?.({
        event: 'success',
        traceId: trace.id,
        threadKey,
        source,
        reason,
        eventCount,
        outcome,
        at,
      });
    } catch (error) {
      span.end();
      // No `markSynthesized`: the watermark is left armed so the thread stays
      // due and is retried on a later tick.
      this.deps.watermarks.incrementAttempts(threadKey);
      const attempts = this.deps.watermarks.get(threadKey)?.attempts ?? 0;

      // `String(error)` rather than the error object: the trace file is JSON, and
      // `JSON.stringify(new Error(...))` is `{}`. A message is greppable; an
      // empty object is not. Stacks are deliberately omitted — they carry
      // absolute paths and no information a message and a thread key lack.
      trace.annotate({ outcome: 'error', wroteDelta: false, attempts, error: String(error) });
      this.deps.onTrace?.({
        event: 'failure',
        traceId: trace.id,
        threadKey,
        source,
        reason,
        eventCount,
        outcome: 'error',
        attempts,
        error,
      });
    } finally {
      this.inFlight.delete(threadKey);
      // Exactly one JSON line per trigger, written on both paths. Skipped
      // entirely when no `logsDir` was configured — see the dep's doc comment.
      if (this.deps.logsDir !== undefined) trace.finish();
    }
  }

  /**
   * The thread's event count, or `null` when no counter is wired.
   *
   * Never throws: this number exists to explain a decision, and a diagnostic
   * that can abort the decision it describes is worse than a missing one.
   */
  private countEvents(threadKey: string): number | null {
    const count = this.deps.countThreadEvents;
    if (count === undefined) return null;
    try {
      return count(threadKey);
    } catch (error) {
      console.error('[layer2/scheduler] event count failed', threadKey, error);
      return null;
    }
  }
}
