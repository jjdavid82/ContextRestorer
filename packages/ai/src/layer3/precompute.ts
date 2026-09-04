/**
 * Layer 3 — background prose pre-computation (P0).
 *
 * ### The inversion this completes
 *
 * `briefing:request` renders from SQLite and never touches a model, because the
 * measured LLM path was 360,920 ms end to end against a 60,000 ms bar (n=20,
 * 2026-09-03). That makes briefings fast, but on its own it would make them
 * permanently blunter: every claim would be a restatement of a
 * `state_deltas.summary`.
 *
 * This class is the other half. It runs when nobody is waiting, writes prose for
 * deltas that have none, and marks those claims `produced_by = 'llm'` so the
 * next request reuses them (`BriefingsRepo.proseByDelta`). A briefing then reads
 * as well as the work done before it was asked for — and is never slower for it.
 *
 * This is not a new principle. OI-1 already assigns extraction and synthesis to
 * background pre-computation; Layers 1 and 2 have always worked this way.
 * Layer 3 was the anomaly.
 *
 * ### What it deliberately does NOT do
 *
 * - **It does not deliver anything.** Its `briefings` rows are written with
 *   `purpose: 'precompute'` and are excluded from `latencyStats()`. AC-1 is a
 *   claim about how long a *user* waited; a four-minute background run with
 *   nobody watching is not a four-minute wait, and letting it into that
 *   distribution would move the headline number in the flattering direction.
 * - **It does not notify.** No tray badge, no OS notification. The user finds
 *   out prose exists by asking for a briefing.
 * - **It does not bypass any guardrail.** It calls the same
 *   `BriefingGenerator.generate()`, so the citation gate, T-1 wrapping, SEC-5
 *   output redaction and F-4's grounding counter all apply identically. There
 *   is no "internal" path with weaker rules.
 * - **It does not retry.** A cycle that fails leaves its deltas in the queue and
 *   the next cycle picks them up. Retrying inside a cycle would turn a dead
 *   Ollama into an unbounded loop against a local process the user may have
 *   stopped on purpose.
 */

import type { Clock } from '@cr/core';
import { systemClock } from '@cr/core';
import type { BriefingsRepo } from '@cr/store';
import type { BriefingGenerator, BriefingWindow } from './generate.js';

/** The repo capability this needs — a `Pick`, so the write surface is visible. */
export type PrecomputeBriefings = Pick<BriefingsRepo, 'deltasNeedingProse'>;

/** What one pre-computation cycle did. Returned so a caller can log or test it. */
export interface PrecomputeResult {
  /** Deltas that had no prose when the cycle started. */
  candidates: number;
  /** Claims the generator accepted and stored, all `produced_by = 'llm'`. */
  claimsWritten: number;
  /** True when the cycle ran the model; false when it found nothing to do. */
  ran: boolean;
  /** Present when the generation attempt failed. The cycle is a no-op then. */
  error?: string;
  /**
   * Present when the cycle declined to run at all (§9 Q4) — currently only
   * `'paused'`, meaning {@link PrecomputeOptions.mayRun} said no.
   *
   * Distinct from `ran: false` with no reason, which means there was simply
   * nothing to do: "we chose not to" and "there was no work" are different
   * facts about the same idle tick.
   */
  skipped?: 'paused';
}

export interface PrecomputeOptions {
  /**
   * How far back to look for deltas needing prose. Defaults to 7 days.
   *
   * Bounded rather than unbounded because prose for a three-week-old delta is
   * work nobody will read: briefing windows start where the user last caught
   * up, and a user who has not caught up in three weeks has a different problem.
   */
  lookbackMs?: number;
  /**
   * Most deltas to cover in one cycle. Defaults to 20.
   *
   * A cap, not a target. One cycle is one `generate()` call, and an unbounded
   * window would build a prompt whose evaluation time is the very cost this
   * design exists to keep off the request path — just moved, not removed.
   */
  maxDeltasPerCycle?: number;
  clock?: Clock;
  /**
   * Whether a cycle may run right now (P0 design §9 Q4).
   *
   * Injected as a predicate rather than reading Electron's `powerMonitor`
   * directly, so this package keeps no dependency on the desktop shell and a
   * test can state the answer. `main.ts` supplies the real one.
   *
   * Defaults to always-allowed, which is the correct behaviour for any host
   * that has no notion of battery — the eval harness and the tests included.
   */
  mayRun?: () => boolean;
}

const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DELTAS = 20;

export class BriefingPrecomputer {
  private readonly lookbackMs: number;
  private readonly maxDeltas: number;
  private readonly clock: Clock;
  private readonly mayRun: () => boolean;
  /** Guards against a slow cycle overlapping the next tick. */
  private running = false;

  constructor(
    private readonly generator: Pick<BriefingGenerator, 'generate'>,
    private readonly briefings: PrecomputeBriefings,
    options: PrecomputeOptions = {},
  ) {
    this.lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
    this.maxDeltas = options.maxDeltasPerCycle ?? DEFAULT_MAX_DELTAS;
    this.clock = options.clock ?? systemClock;
    this.mayRun = options.mayRun ?? ((): boolean => true);
  }

  /**
   * Run one cycle: find deltas without prose, and if there are any, generate.
   *
   * Never throws. A pre-computation failure must not disturb ingestion, the
   * debounce scheduler, or anything else sharing its tick — nothing downstream
   * is waiting on prose, so a failed cycle is a cycle that did nothing.
   *
   * Re-entrant calls are dropped rather than queued. Generation can take
   * minutes; a tick that fires meanwhile would otherwise start a second run
   * against the same deltas and both would write claims for them.
   */
  async runCycle(): Promise<PrecomputeResult> {
    if (this.running) return { candidates: 0, claimsWritten: 0, ran: false };

    // §9 Q4: sustained local inference is the most expensive thing this app
    // does, and the user never asked for it. Skipping a cycle costs blunter
    // headlines on the next briefing — never a broken one, because the request
    // path is deterministic — which makes this the cheapest restraint available.
    if (!this.mayRun()) return { candidates: 0, claimsWritten: 0, ran: false, skipped: 'paused' };

    this.running = true;

    try {
      const end = this.clock.now();
      const start = end - this.lookbackMs;

      const pending = this.briefings.deltasNeedingProse(start, end, this.maxDeltas);
      if (pending.length === 0) return { candidates: 0, claimsWritten: 0, ran: false };

      const window: BriefingWindow = { windowStart: start, windowEnd: end };
      const result = await this.generator.generate(window, { purpose: 'precompute' });

      return { candidates: pending.length, claimsWritten: result.claimsAccepted, ran: true };
    } catch (error) {
      // Left in the queue on purpose: the next cycle retries, and retrying here
      // would loop against an Ollama the user may have stopped deliberately.
      const message = error instanceof Error ? error.message : String(error);
      console.error('[layer3/precompute] cycle failed; deltas stay queued', message);
      return { candidates: 0, claimsWritten: 0, ran: false, error: message };
    } finally {
      this.running = false;
    }
  }
}
