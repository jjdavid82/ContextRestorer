/**
 * The latency benchmark (Task 5.3) — the ONLY place AC-1 is measured.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES, AND WHY IT IS NOT THE EVAL HARNESS
 *
 * `harness.ts` (Task 5.1) grades briefing QUALITY and says so in its own module
 * comment: it pins the clock inside each fixture's window, which makes every
 * latency it records exactly 0 and makes the §7.8 generation budget unable to
 * elapse. This module is the other half. It runs the same real pipeline, but with
 * a LIVE clock over the part that matters, and it grades nothing — it only times.
 *
 * Two numbers are the point (AC-1):
 *
 *   - **P95 total < 60s** — end-to-end `BriefingGenerator.generate()`.
 *   - **P95 first token < 5s** — how long until the first LLM token arrives.
 *
 * and one number is deliberately kept APART from them:
 *
 *   - **first paint** — how long until the user has something real on screen.
 *
 * ### First paint is measured separately, on purpose
 *
 * In this product "first paint" is not "first token". Task 3.5's
 * `briefing:pending` handler is the first-paint path: one prepared SELECT over
 * `pending_items`, a stakes-weighted sort, a projection — no embedding, no
 * retrieval, no model client anywhere in scope. First TOKEN is a different event
 * on a different path: a 14B model prompt-evaluating several thousand tokens of
 * retrieved context.
 *
 * Deriving one from the other would hide a real regression in either direction:
 * a first-paint path that started doing I/O would be invisible behind a slow
 * model, and a model that got 10× slower would be invisible behind a 1 ms SELECT.
 * So `firstPaintMs` is its own timed call against the real repos
 * ({@link firstPaintPendingItems}), and `firstTokenMs` comes from the LLM run's
 * own `firstToken` span. They are reported as two rows and are never averaged
 * together.
 *
 * ### The generator is called DIRECTLY, not through `generateWithFallback`
 *
 * A template-mode briefing takes milliseconds because no model runs. If the
 * fallback chain silently swapped one in — Ollama busy, preflight flapping — the
 * "P95 total" number would be a measurement of SQLite, published under a heading
 * that claims it is a measurement of the LLM path. That is the single easiest way
 * for this benchmark to lie, so the fallback is not in the loop at all:
 * {@link runBench} calls `BriefingGenerator.generate` and an iteration that
 * throws is SKIPPED, counted in {@link BenchResult.failures}, and reported.
 *
 * ### What is real here
 *
 *   - `IngestionPipeline`  — normalize → redact (SEC-4) → persist → graph → D-7
 *   - `Layer1Extractor`    — real Ollama chat call + real embedding per event
 *   - `Layer2Synthesizer`  — real Ollama chat call per thread, real retrieval
 *   - `RetrievalService`   — real LanceDB, real `nomic-embed-text` embeddings
 *   - `BriefingGenerator`  — real streamed generation, real `CitationGate`
 *   - SQLite               — real file-backed database with the real migrations
 *
 * ### Two deliberate departures from production
 *
 * 1. **`DebounceScheduler` is skipped**, exactly as in `harness.ts` and for the
 *    same reason: the scheduler's job is to decide *when* a quiet thread is ready
 *    (a 5-minute quiet window, a 30-minute hard cap), and waiting those out in
 *    wall-clock time would test the scheduler rather than the thing being timed.
 *    `synthesize()` is the same call the scheduler makes.
 *
 * 2. **The clock is pinned while SEEDING, then goes live before any timing.**
 *    `DeltasRepo.currentForWindow()` filters on `created_at`, so a delta stamped
 *    with the wall clock lands in a single instant and every historical window
 *    would be empty. {@link BenchClock} is pinned to each thread's own event
 *    times during Layer 1/Layer 2 so the seeded deltas are spread realistically
 *    across the 5-day period, and then switched to live — `goLive()` — before the
 *    first `generate()` call. Everything timed in this module is timed against
 *    `Date.now()` and `performance.now()`; nothing that produces an AC-1 number
 *    runs under a frozen clock.
 *
 * ### Why Layer 1 does not run over all `eventCount` events
 *
 * `Layer1Extractor` is one chat call per event. At the ~10-25s per call this
 * hardware delivers, extracting 3000 events is *weeks* of local inference — and
 * it would not change what is being measured, because what Layer 3 consumes is
 * chunks and deltas, not raw rows. So the corpus is seeded in two tiers:
 *
 *   - **bulk** — `eventCount` events through the real ingestion pipeline. Real
 *     `events`, `artifacts` and `sync_watermarks` rows, so retrieval's
 *     post-filters, the graph stakes lookups and the OI-1 backlog count all run
 *     against a realistically sized store rather than an empty one.
 *   - **signal** — `signalThreadCount × eventsPerSignalThread` decision-shaped
 *     events that additionally go through real Layer 1 and real Layer 2, so there
 *     are real `state_deltas` and real `pending_items` in every window. Without
 *     them `forBriefing` would be an empty-window no-op and the benchmark would
 *     be timing nothing.
 *
 * Both tiers are reported ({@link BenchResult.corpus}) so nobody can read "3000
 * events" as "3000 extractions".
 * ---------------------------------------------------------------------------
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { newId, type AppConfig, type Clock, type PendingItem, type Person } from '@cr/core';
import { IngestionPipeline, type RawSourceEvent } from '@cr/ingest';
import {
  AiCallsRepo,
  BriefingsRepo,
  DeltasRepo,
  EventsRepo,
  ExtractionsRepo,
  GraphRepo,
  PendingItemsRepo,
  WatermarkRepo,
  migrate,
  openDb,
  openVectors,
  type VectorStore,
} from '@cr/store';
import {
  BriefingGenerator,
  CitationGate,
  Layer1Extractor,
  Layer2Synthesizer,
  RetrievalService,
  createOllamaClient,
  type OllamaClient,
} from '@cr/ai';
import type { StageTimings } from '@cr/observability';

// ---------------------------------------------------------------------------
// AC-1 thresholds
// ---------------------------------------------------------------------------

/** AC-1: P95 end-to-end briefing latency must be under 60 seconds. */
export const AC1_TOTAL_P95_MS = 60_000;

/** AC-1: P95 time-to-first-token must be under 5 seconds. */
export const AC1_FIRST_TOKEN_P95_MS = 5_000;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Every metric this benchmark reports, in the order the table renders them.
 *
 * `firstPaintMs` and `totalMs` are measured by this module with
 * `performance.now()`; the other five are the OI-1 stage timings the trace
 * already records inside `BriefingGenerator.generate()` (Tasks 3.4 / 4.4) and are
 * read from `BriefingGenerationResult.timings` rather than re-derived, so the
 * benchmark and the JSONL trace can never disagree about a run.
 */
export const BENCH_METRICS = [
  'firstPaintMs',
  'firstTokenMs',
  'totalMs',
  'retrievalMs',
  'assemblyMs',
  'generationMs',
  'citationMs',
] as const;

export type BenchMetric = (typeof BENCH_METRICS)[number];

/**
 * The four stages whose durations partition an LLM run's wall clock.
 *
 * `firstTokenMs` is deliberately absent: the `firstToken` span is opened INSIDE
 * the `generation` span (see `generate.ts`), so it is a sub-interval of
 * `generationMs` and adding it to a sum would double-count. Attribution
 * ({@link attributeSlowestRun}) uses this list for exactly that reason.
 */
export const ATTRIBUTABLE_STAGES = [
  'retrievalMs',
  'assemblyMs',
  'generationMs',
  'citationMs',
] as const;

export type AttributableStage = (typeof ATTRIBUTABLE_STAGES)[number];

/** Human-readable label per metric, used by {@link renderBenchTable}. */
const METRIC_LABELS: Record<BenchMetric, string> = {
  firstPaintMs: 'First paint — pending items, NO model call',
  firstTokenMs: 'First token — LLM stream (runs that produced one)',
  totalMs: 'Total — `generate()` end to end',
  retrievalMs: '↳ stage: retrieval',
  assemblyMs: '↳ stage: prompt assembly',
  generationMs: '↳ stage: generation (streamed)',
  citationMs: '↳ stage: citation gate + persist',
};

/**
 * A latency distribution.
 *
 * `p50`/`p95` are `null` — never 0 — when nothing was observed, and `count`
 * always travels with them. This mirrors `BriefingsRepo.DurationStats` exactly
 * (Task 4.4): 0 ms is a real, achievable latency, so it must not double as "no
 * data", and a percentile without its sample size is the RO-2 failure. It also
 * matters concretely here: a run in which the model produced no token at all has
 * no `firstTokenMs`, and reporting that as `0` would turn an AC-1 FAIL into a
 * spectacular PASS.
 */
export interface Percentiles {
  /** Observations the percentiles were computed from. */
  count: number;
  p50: number | null;
  p95: number | null;
}

/**
 * Nearest-rank percentile over an unordered sample. `null` when empty.
 *
 * Nearest-rank, not interpolated, and the SAME arithmetic as
 * `BriefingsRepo.percentiles` (`packages/store/src/repos/briefings.ts`, Task
 * 4.4): `index = min(len - 1, ceil(fraction × len) - 1)`, clamped at 0. Reused
 * rather than reinvented so that the P95 this benchmark prints and the P95 the
 * store's own metrics view prints are the same statistic on the same data. With
 * 20 observations an interpolated P95 would be a number no run supports; every
 * value here is traceable to one real briefing.
 *
 * @param values - Sample; not mutated (a copy is sorted).
 * @param fraction - e.g. `0.95`. Values outside `[0, 1]` are clamped.
 */
export function nearestRankPercentile(
  values: readonly number[],
  fraction: number,
): number | null {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return null;

  const sorted = [...usable].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, fraction));
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(clamped * sorted.length) - 1));
  return sorted[index] as number;
}

/** P50 and P95 of one sample, with the sample size attached. */
export function percentilesOf(values: readonly number[]): Percentiles {
  const usable = values.filter((value) => Number.isFinite(value));
  return {
    count: usable.length,
    p50: nearestRankPercentile(usable, 0.5),
    p95: nearestRankPercentile(usable, 0.95),
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Bulk corpus size — events pushed through the real ingestion pipeline.
 *
 * **3000.** The plan asks for "order of a few thousand events" over a 5-day,
 * 2-source window, and 3000 is the low end of a genuinely heavy week: ~600
 * items/day across Slack and Gmail for one person. It is chosen for the property
 * that matters to a latency number — that nothing being timed is running against
 * an empty table. `events`, `artifacts` and `sync_watermarks` all carry thousands
 * of rows, so the graph lookups retrieval does per candidate chunk, the OI-1
 * `countPendingSynthesis()` scan and the D-6 window read are all doing real work.
 *
 * Ingestion itself involves NO model call, which is why this tier can be this
 * large; see the module comment for the two-tier split.
 */
export const DEFAULT_EVENT_COUNT = 3000;

/** Briefings to generate. **20**, as the plan specifies. */
export const DEFAULT_BRIEFING_COUNT = 20;

/**
 * Threads that get real Layer 1 + Layer 2 treatment. **8.**
 *
 * Each costs `eventsPerSignalThread` Layer 1 chat calls plus one Layer 2 chat
 * call, so this number is the seeding cost. Eight threads spread evenly across
 * five days means every rolling briefing window (see {@link DEFAULT_WINDOW_WIDTH_MS})
 * contains two or three of them — enough for `forBriefing` to rank and for the
 * prompt to be a realistic size, without spending an hour of inference before
 * the first measurement.
 */
export const DEFAULT_SIGNAL_THREAD_COUNT = 8;

/** Events per signal thread. **3** — a question, a status, then a decision + an ask. */
export const DEFAULT_EVENTS_PER_SIGNAL_THREAD = 3;

/** The seeded period: 5 days, per the plan's "realistic 5-day, 2-source window". */
export const SEEDED_PERIOD_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Width of each briefing window. **48 hours.**
 *
 * Windows are rolled forward across the 5-day period, so at 48h they OVERLAP —
 * which is the realistic case (a user who checks in daily after a long weekend
 * re-reads part of yesterday) and which also means consecutive briefings see
 * different-but-not-disjoint delta sets. A window narrower than the gap between
 * seeded signal threads would produce empty briefings, which measure nothing.
 */
export const DEFAULT_WINDOW_WIDTH_MS = 48 * 60 * 60 * 1000;

export interface BenchRunOptions {
  /** Bulk events through the real pipeline. Default {@link DEFAULT_EVENT_COUNT}. */
  eventCount?: number;
  /** Briefings to time. Default {@link DEFAULT_BRIEFING_COUNT}. */
  briefingCount?: number;
  config: AppConfig;
  /** Overrides `config.model.ollamaBaseUrl`. Must be loopback (SEC-6). */
  ollamaBaseUrl?: string;
  /** Threads given real Layer 1 + Layer 2. Default {@link DEFAULT_SIGNAL_THREAD_COUNT}. */
  signalThreadCount?: number;
  /** Events per signal thread. Default {@link DEFAULT_EVENTS_PER_SIGNAL_THREAD}. */
  eventsPerSignalThread?: number;
  /** Briefing window width. Default {@link DEFAULT_WINDOW_WIDTH_MS}. */
  windowWidthMs?: number;
  /**
   * Operator notes about the conditions this run was measured under, rendered
   * with the numbers.
   *
   * Exists because the most important fact about a local latency measurement is
   * usually not in the process's own reach: whether something ELSE was using the
   * GPU. A briefing that took 106s on a machine already streaming another job's
   * eval is not the same measurement as 106s on an idle machine, and nothing in
   * this module can detect the difference. The operator can, so there is a place
   * to say it — attached to the table rather than left in a terminal scrollback.
   */
  notes?: readonly string[];
  /** Progress hook, so a CLI can say something during a multi-minute run. */
  onProgress?: (progress: BenchProgress) => void;
}

/** Phase of a bench run, for {@link BenchProgress}. */
export type BenchPhase =
  | 'seed:ingest'
  | 'seed:layer1'
  | 'seed:layer2'
  | 'briefing'
  | 'briefing:failed';

export interface BenchProgress {
  phase: BenchPhase;
  /** 1-based position within the phase, when the phase has steps. */
  index?: number;
  total?: number;
  message: string;
}

/** One timed iteration. Everything the report says is derived from these. */
export interface BenchSample {
  /** 1-based iteration number. */
  index: number;
  windowStart: number;
  windowEnd: number;
  /**
   * `performance.now()` around the first-paint read — `pending_items` +
   * stakes-weighted sort, the Task 3.5 path. NO model call is involved.
   */
  firstPaintMs: number;
  /** Open obligations the first-paint read returned. */
  firstPaintItems: number;
  /**
   * `performance.now()` around `BriefingGenerator.generate()`.
   *
   * The externally observed wall clock, not the sum of the stage spans: the gap
   * between them is real work (persistence, the narrative file, the `ai_calls`
   * row) and hiding it inside a tidy sum would understate what the user waits.
   */
  totalMs: number;
  /** The five OI-1 stage timings, as the trace measured them. */
  timings: StageTimings;
  /** Layer-3 `ai_calls` outcome for this run. */
  outcome: string;
  claimsAccepted: number;
  claimsDropped: number;
  /** §7.8: generation was cut short by `budgets.generationMs`. */
  partial: boolean;
  /** OI-1 backlog disclosure at request time. */
  threadsStillProcessing: number;
  /**
   * True when a token actually arrived from the model.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS EXISTS — it changes the AC-1 first-token number.
   *
   * `BriefingGenerator` ends the `firstToken` span in a `finally`, and says so:
   * "When no token ever arrived this records how long we waited for one." That is
   * the right thing for an operator diagnosing a dead model, and the wrong thing
   * for a time-to-first-token percentile — a run that waited 305 seconds and then
   * died is not a 305-second first token, it is a run with NO first token, and
   * pooling the two publishes a latency for an event that never happened.
   *
   * The first real run of this benchmark made the distinction concrete: 3 of 20
   * runs hit undici's 300s header timeout with `outcome: 'error'`, and those
   * three were the entire P95 of `firstTokenMs`. They are now excluded from that
   * metric (and counted in {@link BenchResult.noTokenRuns}) while remaining in
   * `totalMs`, because the user really did wait that long.
   *
   * Derived from `outcome === 'error'`, which `generate.ts` sets exactly when the
   * stream threw before any token (`outcome = sawToken ? 'stream_error' :
   * 'error'`). The one case this cannot see is a stream that ended NORMALLY
   * having yielded nothing; the generator reports no flag for it, and it would
   * appear here as a token-bearing run with a tiny `firstTokenMs`.
   * ---------------------------------------------------------------------------
   */
  sawFirstToken: boolean;
  /**
   * True when the run made NO model call because nothing in the window was
   * citable (`outcome: 'no_context'`).
   *
   * Such a run is excluded from every LLM latency distribution — it is a ~1 ms
   * measurement of SQLite, and letting it into the `totalMs` sample would drag a
   * P50 down while claiming to describe the model path.
   */
  noContext: boolean;
}

/** Which stage dominated a run, and how much of its wall clock is unaccounted for. */
export interface StageAttribution {
  /** {@link BenchSample.index} of the run this describes. */
  sampleIndex: number;
  totalMs: number;
  /** The slowest of {@link ATTRIBUTABLE_STAGES}, or `null` when none reported. */
  stage: AttributableStage | null;
  stageMs: number | null;
  /**
   * `totalMs` minus the four attributable stages.
   *
   * Not noise to be discarded: it is claim persistence, the narrative write, the
   * `ai_calls` row and the trace flush. A large value here means the answer to
   * "why was that slow" is not in the stage timings at all, which is worth
   * knowing rather than rounding away.
   */
  unattributedMs: number;
}

/** One AC-1 threshold, its measured value, and the verdict. */
export interface Ac1Check {
  criterion: 'AC-1';
  label: string;
  metric: BenchMetric;
  thresholdMs: number;
  /** `null` when the metric had no observations at all. */
  measuredP95: number | null;
  /** Observations behind `measuredP95` (RO-2: never quote one without the other). */
  count: number;
  /**
   * `'NO DATA'` is a distinct verdict from `'FAIL'`, on purpose. A metric with no
   * observations has not been shown to fail — it has not been measured, and
   * reporting either PASS or FAIL for it would be a claim the run cannot support.
   */
  status: 'PASS' | 'FAIL' | 'NO DATA';
}

/** What was actually seeded, so `eventCount` cannot be read as `extractionCount`. */
export interface BenchCorpus {
  /** Events ingested through the real `IngestionPipeline`. */
  ingestedEvents: number;
  /** Distinct thread keys across the whole corpus. */
  threads: number;
  /** Events that additionally went through real Layer 1 (one chat call each). */
  extractedEvents: number;
  /** Threads that additionally went through real Layer 2 (one chat call each). */
  synthesizedThreads: number;
  /**
   * Seeding calls that failed twice and were skipped.
   *
   * Reported rather than swallowed: a corpus that lost half its extractions to
   * Ollama timeouts is a smaller corpus than the one the table's `extractedEvents`
   * row would otherwise imply, and the generation timings measured against it are
   * correspondingly optimistic.
   */
  extractionFailures: number;
  synthesisFailures: number;
  /** `state_deltas` tips that existed when benchmarking started. */
  deltas: number;
  /** Open `pending_items` that existed when benchmarking started. */
  pendingItems: number;
  periodStart: number;
  periodEnd: number;
  windowWidthMs: number;
}

/** Facts a latency number is only interpretable against. */
export interface BenchEnvironment {
  chatModel: string;
  embedModel: string;
  ollamaBaseUrl: string;
  /** `budgets.generationMs` — the §7.8 cap that truncates a long generation. */
  generationBudgetMs: number;
  /** `budgets.retrievalMs` / `retrieval.budgetMs`, whichever bites first. */
  retrievalBudgetMs: number;
  retrievalTopK: number;
  promptVersions: string;
}

export interface BenchResult {
  perStagePercentiles: Record<BenchMetric, Percentiles>;
  /**
   * Briefings actually measured: iterations whose LLM path ran to a result.
   *
   * Excludes iterations counted in {@link failures} (threw) and
   * {@link emptyWindows} (`no_context`, no model call made). Per-metric
   * observation counts are in each {@link Percentiles.count} and may be SMALLER
   * than this — a run that produced no token has no `firstTokenMs`.
   */
  n: number;
  /** Iterations that errored/timed out and were skipped. */
  failures: number;
  /** Iterations that made no model call because nothing was citable. */
  emptyWindows: number;
  /** Iterations attempted. `= n + failures + emptyWindows`. */
  attempted: number;
  /** Error message per failed iteration, in order. */
  failureMessages: string[];
  /** Every timed iteration, LLM runs and `no_context` runs alike. */
  samples: BenchSample[];
  /** Attribution for the slowest measured run. `null` when nothing was measured. */
  slowest: StageAttribution | null;
  /** Runs the §7.8 generation budget truncated. */
  partialRuns: number;
  /**
   * Measured runs in which the model never produced a token (`outcome: 'error'`).
   *
   * Counted in `totalMs`, excluded from `firstTokenMs`. See
   * {@link BenchSample.sawFirstToken} for why publishing their wait as a
   * first-token latency would be a fabrication.
   */
  noTokenRuns: number;
  corpus: BenchCorpus;
  environment: BenchEnvironment;
  /** {@link BenchRunOptions.notes}, verbatim. */
  notes: string[];
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// AC-1 verdicts and attribution (pure — unit-tested without Ollama)
// ---------------------------------------------------------------------------

/**
 * The two AC-1 thresholds, evaluated against the measured P95s.
 *
 * Strictly `<`, matching the plan's wording ("P95 total < 60s, P95 first token
 * < 5s"). An unmeasured metric is `'NO DATA'`, never PASS — see
 * {@link Ac1Check.status}.
 */
export function evaluateAc1(result: BenchResult): Ac1Check[] {
  const check = (
    metric: 'totalMs' | 'firstTokenMs',
    label: string,
    thresholdMs: number,
  ): Ac1Check => {
    const stats = result.perStagePercentiles[metric];
    const measuredP95 = stats.p95;
    return {
      criterion: 'AC-1',
      label,
      metric,
      thresholdMs,
      measuredP95,
      count: stats.count,
      status:
        measuredP95 === null ? 'NO DATA' : measuredP95 < thresholdMs ? 'PASS' : 'FAIL',
    };
  };

  return [
    check('totalMs', 'Briefing generation, end to end (P95)', AC1_TOTAL_P95_MS),
    check('firstTokenMs', 'Time to first LLM token (P95)', AC1_FIRST_TOKEN_P95_MS),
  ];
}

/**
 * The slowest measured run, and which stage dominated it.
 *
 * "Which stage dominates a slow run" is the question a P95 cannot answer: 58s
 * spent waiting for the model and 58s spent waiting for LanceDB call for
 * completely different fixes. `no_context` runs are excluded — they are not slow
 * runs, they are runs that did not happen.
 */
export function attributeSlowestRun(samples: readonly BenchSample[]): StageAttribution | null {
  const measured = samples.filter((sample) => !sample.noContext);
  if (measured.length === 0) return null;

  const slowest = measured.reduce((worst, sample) =>
    sample.totalMs > worst.totalMs ? sample : worst,
  );

  let stage: AttributableStage | null = null;
  let stageMs: number | null = null;
  let attributed = 0;

  for (const key of ATTRIBUTABLE_STAGES) {
    const value = slowest.timings[key];
    if (value === undefined) continue;
    attributed += value;
    if (stageMs === null || value > stageMs) {
      stage = key;
      stageMs = value;
    }
  }

  return {
    sampleIndex: slowest.index,
    totalMs: slowest.totalMs,
    stage,
    stageMs,
    // Clamped at 0: the four spans are measured with the injected clock while
    // `totalMs` uses `performance.now()`, and a sub-millisecond disagreement
    // between the two must not render as a negative remainder.
    unattributedMs: Math.max(0, slowest.totalMs - attributed),
  };
}

/** Collect one metric's observations across every sample that reported it. */
function samplesFor(samples: readonly BenchSample[], metric: BenchMetric): number[] {
  const values: number[] = [];
  for (const sample of samples) {
    if (metric === 'firstPaintMs') {
      // The first-paint path has nothing to do with the model, so it is measured
      // (and reported) even for a window the model never ran on.
      values.push(sample.firstPaintMs);
      continue;
    }
    // Every other metric describes the LLM path; a run that made no model call
    // contributes nothing to it. See `BenchSample.noContext`.
    if (sample.noContext) continue;
    if (metric === 'totalMs') {
      // A run that died waiting for the model still cost the user that wait, so
      // it belongs in the end-to-end distribution even though it produced no
      // first token. See `BenchSample.sawFirstToken`.
      values.push(sample.totalMs);
      continue;
    }
    // The `firstToken` span on a token-less run measures a wait for something
    // that never arrived; it is not a time-to-first-token.
    if (metric === 'firstTokenMs' && !sample.sawFirstToken) continue;
    const value = sample.timings[metric];
    if (value !== undefined) values.push(value);
  }
  return values;
}

/** Build the full percentile table from raw samples. Pure; unit-tested. */
export function summarize(samples: readonly BenchSample[]): Record<BenchMetric, Percentiles> {
  const out = {} as Record<BenchMetric, Percentiles>;
  for (const metric of BENCH_METRICS) {
    out[metric] = percentilesOf(samplesFor(samples, metric));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `1234.567` → `1235`. Latency below 1 ms is reported as `<1`. */
function ms(value: number | null): string {
  if (value === null) return '—';
  if (value > 0 && value < 1) return '<1';
  return Math.round(value).toLocaleString('en-US');
}

/**
 * The markdown block written to the report and printed to stdout.
 *
 * Every percentile is rendered next to the number of observations behind it, and
 * the AC-1 verdicts restate their own sample size. That is the same honesty
 * discipline `report.ts` enforces for the eval: a latency percentile measured on
 * 6 briefings and one measured on 20 are different claims, and the table must not
 * let them look alike (RO-2).
 */
export function renderBenchTable(result: BenchResult): string {
  const lines: string[] = [];
  const reduced = result.n < DEFAULT_BRIEFING_COUNT;

  lines.push(
    `**n = ${result.n} briefing generation(s) measured** ` +
      `(${result.attempted} attempted, ${result.failures} failed, ` +
      `${result.emptyWindows} produced no citable context).`,
  );
  lines.push('');
  if (reduced && result.n > 0) {
    lines.push(
      `> **REDUCED SAMPLE.** The plan calls for 20 real briefing generations; this run ` +
        `measured ${result.n}. Every number below is a ${result.n}-sample measurement and ` +
        `must be quoted with that sample size. A P95 over ${result.n} observations is, by ` +
        `nearest-rank, the slowest one or two runs — it is a weak upper bound, not a ` +
        `stable percentile.`,
    );
    lines.push('');
  }
  if (result.n === 0) {
    lines.push(
      '> **NOTHING WAS MEASURED.** No briefing generation completed, so no AC-1 verdict ' +
        'can be given. The failures are listed below.',
    );
    lines.push('');
  }

  // Placed BEFORE the table: a caveat about the conditions is not a footnote to
  // the numbers, it is a precondition for reading them.
  if (result.notes.length > 0) {
    lines.push('**Conditions this run was measured under:**');
    lines.push('');
    for (const note of result.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('| Metric | Observations | P50 | P95 |');
  lines.push('|---|--:|--:|--:|');
  for (const metric of BENCH_METRICS) {
    const stats = result.perStagePercentiles[metric];
    lines.push(
      `| ${METRIC_LABELS[metric]} | ${stats.count} | ${ms(stats.p50)} ms | ${ms(stats.p95)} ms |`,
    );
  }
  lines.push('');
  lines.push(
    '_`↳ stage:` rows are the OI-1 stage spans from inside `generate()`. ' +
      '`generation` CONTAINS `first token` (the `firstToken` span is nested), so the two ' +
      'must not be added together; the four stages that do partition a run are ' +
      'retrieval + assembly + generation + citation._',
  );
  lines.push('');

  // ---- AC-1 ---------------------------------------------------------------
  lines.push('### AC-1');
  lines.push('');
  lines.push('| Criterion | Requirement | Measured P95 | Sample | Status |');
  lines.push('|---|---|--:|--:|:--:|');
  for (const check of evaluateAc1(result)) {
    lines.push(
      `| ${check.criterion} | ${check.label} < ${ms(check.thresholdMs)} ms | ` +
        `${ms(check.measuredP95)} ms | ${check.count} run(s) | ${check.status} |`,
    );
  }
  lines.push('');
  lines.push(
    '_First paint is **not** an AC-1 row and is not a substitute for first token. It is the ' +
      'Task 3.5 `briefing:pending` path — one SELECT over `pending_items`, ranked by stakes ' +
      '× confidence, with no model client in scope — measured as its own timed call. ' +
      'Reporting it as "first token" would hide a real regression in either path._',
  );
  lines.push('');

  // ---- attribution --------------------------------------------------------
  const slowest = result.slowest;
  if (slowest !== null) {
    lines.push('### Slowest run — where the time went');
    lines.push('');
    lines.push(
      `Run #${slowest.sampleIndex} took ${ms(slowest.totalMs)} ms. Dominant stage: ` +
        (slowest.stage === null
          ? '**none reported** (no stage span closed).'
          : `**${slowest.stage}** at ${ms(slowest.stageMs)} ms.`) +
        ` Unattributed (claim persistence, narrative write, \`ai_calls\` row, trace flush): ` +
        `${ms(slowest.unattributedMs)} ms.`,
    );
    lines.push('');
  }

  if (result.noTokenRuns > 0) {
    lines.push(
      `_${result.noTokenRuns} of ${result.n} measured run(s) produced **no token at all** ` +
        "(`outcome: 'error'` — the stream failed before the model emitted anything). Those " +
        'runs are counted in `Total` (the user really did wait) and EXCLUDED from ' +
        '`First token`, because the `firstToken` span on such a run measures a wait for ' +
        'something that never arrived. Publishing it as a time-to-first-token would report a ' +
        'latency for an event that did not happen._',
    );
    lines.push('');
  }

  if (result.partialRuns > 0) {
    lines.push(
      `_${result.partialRuns} of ${result.n} measured run(s) were TRUNCATED by ` +
        `\`budgets.generationMs\` = ${ms(result.environment.generationBudgetMs)} ms (§7.8). ` +
        'That is a healthy, deliberate truncation — but it also means the `totalMs` ' +
        'distribution is CAPPED by the budget rather than describing how long the model ' +
        'would have taken. A P95 total that passes AC-1 because generation was cut off at ' +
        'the budget is a pass for the product, not evidence that the model is fast._',
    );
    lines.push('');
  }

  if (result.failures > 0) {
    lines.push('### Skipped iterations');
    lines.push('');
    for (const message of result.failureMessages) lines.push(`- ${message}`);
    lines.push('');
  }

  // ---- corpus + environment ----------------------------------------------
  const corpus = result.corpus;
  lines.push('### What was measured against');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Seeded period | 5 days, 2 sources (slack + gmail) |`);
  lines.push(`| Events ingested (real \`IngestionPipeline\`) | ${corpus.ingestedEvents} |`);
  lines.push(`| Distinct threads | ${corpus.threads} |`);
  lines.push(`| Events extracted (real Layer 1, 1 chat call each) | ${corpus.extractedEvents} |`);
  lines.push(
    `| Threads synthesized (real Layer 2, 1 chat call each) | ${corpus.synthesizedThreads} |`,
  );
  if (corpus.extractionFailures > 0 || corpus.synthesisFailures > 0) {
    lines.push(
      `| Seeding calls skipped after a retry | ${corpus.extractionFailures} Layer 1, ` +
        `${corpus.synthesisFailures} Layer 2 |`,
    );
  }
  lines.push(`| \`state_deltas\` tips available | ${corpus.deltas} |`);
  lines.push(`| Open \`pending_items\` available | ${corpus.pendingItems} |`);
  lines.push(`| Briefing window width | ${Math.round(corpus.windowWidthMs / 3_600_000)} h |`);
  lines.push(`| Chat model | \`${result.environment.chatModel}\` |`);
  lines.push(`| Embedding model | \`${result.environment.embedModel}\` |`);
  lines.push(`| \`budgets.generationMs\` | ${result.environment.generationBudgetMs} |`);
  lines.push(`| \`retrieval.budgetMs\` / \`topK\` | ${result.environment.retrievalBudgetMs} / ${result.environment.retrievalTopK} |`);
  lines.push(`| Prompt versions | ${result.environment.promptVersions} |`);
  lines.push('');
  lines.push(
    '_`Events ingested` is NOT `events extracted`: Layer 1 is one chat call per event, so ' +
      'extracting the whole corpus would be weeks of local inference and would not change ' +
      'what Layer 3 consumes (chunks and deltas). The bulk tier exists so nothing being ' +
      'timed runs against an empty table; the signal tier exists so every window has real ' +
      'deltas to retrieve and rank._',
  );
  lines.push('');
  lines.push(
    '**Read the generation numbers as a LOWER BOUND.** Only extracted events have chunks in ' +
      `the vector store, so retrieval can return at most ~${corpus.extractedEvents} chunks ` +
      `against a \`topK\` of ${result.environment.retrievalTopK}. The Layer 3 prompt is ` +
      'therefore SMALLER than a briefing over a fully-extracted 5-day corpus would be, and ' +
      'prompt evaluation is the dominant term in time-to-first-token on a local 14B model. A ' +
      'production window with 40 retrieved chunks will be slower than what is measured here — ' +
      'this benchmark is not entitled to claim otherwise.',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// First paint (Task 3.5's path, measured here)
// ---------------------------------------------------------------------------

/**
 * Edge kind joining an artifact to the project whose stakes weight applies.
 * Mirrors `PROJECT_REL` in `@cr/ai`'s retrieval and in
 * `apps/desktop/src/ipc/briefing.ts` — duplicated as a literal, exactly as that
 * module does, because the first-paint path must stay free of `@cr/ai`.
 */
const PROJECT_REL = 'belongs_to';

/** Stakes weight for an item whose artifact belongs to no declared project. */
const DEFAULT_STAKES_WEIGHT = 1.0;

/** The read side of `PendingItemsRepo`. Structural, so the real repo satisfies it. */
export interface FirstPaintReader {
  listOpen(): PendingItem[];
}

/** The slice of `GraphRepo` needed to price an item's stakes. */
export interface FirstPaintStakes {
  relatedIds(fromId: string, rel: string): string[];
  getProject(projectId: string): { stakesWeight: number } | undefined;
}

/**
 * The first-paint read, timed by this benchmark.
 *
 * A faithful re-implementation of `listPending()` /
 * `rankPendingItems()` from `apps/desktop/src/ipc/briefing.ts` (Task 3.5): one
 * `listOpen()`, a stakes × confidence sort, oldest-first tie-break. It is
 * duplicated rather than imported because that module's first line is
 * `import { ipcMain } from 'electron'` — importing it here would pull Electron
 * into a Node benchmark. The duplication is ~15 lines and is stated so a reader
 * knows which file is authoritative: the IPC handler is.
 *
 * No embedding, no retrieval, no model client — and none in scope to reach for,
 * which is the same structural guarantee the handler makes.
 */
export function firstPaintPendingItems(
  pending: FirstPaintReader,
  graph?: FirstPaintStakes,
): PendingItem[] {
  const cache = new Map<string, number>();

  const stakesFor = (artifactId: string | null): number => {
    if (graph === undefined || artifactId === null || artifactId === '') {
      return DEFAULT_STAKES_WEIGHT;
    }
    const cached = cache.get(artifactId);
    if (cached !== undefined) return cached;

    let weight = DEFAULT_STAKES_WEIGHT;
    for (const projectId of graph.relatedIds(artifactId, PROJECT_REL)) {
      const project = graph.getProject(projectId);
      if (project !== undefined) {
        weight = project.stakesWeight;
        break;
      }
    }
    cache.set(artifactId, weight);
    return weight;
  };

  const scored = pending
    .listOpen()
    .map((item) => ({ item, score: stakesFor(item.citationArtifactId) * item.confidence }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.item.createdAt !== b.item.createdAt) return a.item.createdAt - b.item.createdAt;
    return a.item.pendingId < b.item.pendingId ? -1 : a.item.pendingId > b.item.pendingId ? 1 : 0;
  });

  return scored.map(({ item }) => item);
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * A clock that can be pinned (for seeding) and then set free (for timing).
 *
 * Both halves are load-bearing:
 *
 *  - **Pinned during seeding.** Layer 2 stamps `state_deltas.created_at` from the
 *    clock, and `DeltasRepo.currentForWindow()` filters on it. Under the wall
 *    clock every delta would land in one instant "now", so a briefing window over
 *    day 2 of the seeded period would be empty and Layer 3 would have nothing to
 *    retrieve, rank or say.
 *  - **Live during timing.** `BriefingGenerator` reads this clock for
 *    `generatedAt`, for the §7.8 deadline and for every trace span. A frozen
 *    clock would report every stage as 0 ms and would make the generation budget
 *    unable to elapse — which is precisely why the Task 5.1 harness cannot
 *    measure AC-1 and this module exists.
 *
 * {@link goLive} is called exactly once, after the last seeding write and before
 * the first `generate()`.
 */
export class BenchClock implements Clock {
  private pinned: number | null;

  constructor(pinnedAt: number) {
    this.pinned = pinnedAt;
  }

  now(): number {
    return this.pinned ?? Date.now();
  }

  /** Freeze at `at`. */
  pin(at: number): void {
    this.pinned = at;
  }

  /** Hand the clock back to `Date.now()`. Irreversible in practice; not enforced. */
  goLive(): void {
    this.pinned = null;
  }

  /** True once {@link goLive} has been called. */
  get live(): boolean {
    return this.pinned === null;
  }
}

// ---------------------------------------------------------------------------
// Synthetic corpus
// ---------------------------------------------------------------------------

export interface SyntheticCorpusOptions {
  /** Total events, bulk + signal. */
  eventCount: number;
  signalThreadCount: number;
  eventsPerSignalThread: number;
  /** Inclusive start of the seeded period. */
  periodStart: number;
  /** Exclusive end. Every event's `occurredAt` is strictly below this. */
  periodEnd: number;
}

export interface SyntheticCorpus {
  /** Bulk events: ingested only. */
  bulk: RawSourceEvent[];
  /** Signal events: ingested, then extracted and synthesized. */
  signal: RawSourceEvent[];
  /** Thread keys of the signal threads, in period order. */
  signalThreadKeys: string[];
  /** People to upsert before ingestion; exactly one has `isSelf`. */
  people: Person[];
  /** Distinct thread keys across both tiers. */
  threadCount: number;
}

/**
 * Deterministic PRNG (mulberry32).
 *
 * Seeded and fixed so two bench runs see the SAME corpus: a latency comparison
 * between two revisions is meaningless if the second one happened to draw
 * shorter messages. `Math.random()` would make every run's number
 * incomparable with the last one's.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed seed — see {@link mulberry32}. */
const CORPUS_SEED = 0x5f3a21;

const PEOPLE: readonly { id: string; name: string; isSelf: boolean }[] = [
  { id: 'bench:dana-ortiz', name: 'Dana Ortiz', isSelf: true },
  { id: 'bench:ben-tao', name: 'Ben Tao', isSelf: false },
  { id: 'bench:priya-raman', name: 'Priya Raman', isSelf: false },
  { id: 'bench:marcus-hale', name: 'Marcus Hale', isSelf: false },
  { id: 'bench:sofia-lindqvist', name: 'Sofia Lindqvist', isSelf: false },
  { id: 'bench:omar-fahmy', name: 'Omar Fahmy', isSelf: false },
];

const PROJECTS = ['Atlas', 'Beacon', 'Corvus', 'Delta Sync', 'Ember', 'Fathom'] as const;

/**
 * Bulk-tier message shapes: the volume a real inbox is mostly made of.
 *
 * Deliberately unremarkable. If every event looked like a decision, Layer 1 would
 * classify the whole corpus as signal and the benchmark would be measuring a
 * workload no user has. These lines exist to be rows in a realistically sized
 * store, and they are never sent to a model.
 */
const BULK_SHAPES: readonly ((project: string, actor: string, n: number) => string)[] = [
  (project, actor) => `${actor} joined the ${project} channel.`,
  (project, _actor, n) => `CI: ${project} pipeline build ${4000 + (n % 900)} finished green on main.`,
  (project, _actor, n) => `Standup: ${project} — ticket ${project.slice(0, 2).toUpperCase()}-${n} in review, nothing blocked.`,
  (project) => `Reminder: ${project} weekly sync moved to 10:30 in the shared calendar.`,
  (_project, actor) => `${actor}: thanks, that helps.`,
  (project) => `Automated digest: 3 pull requests opened against ${project} in the last hour.`,
  (project, actor, n) => `${actor}: pushed a doc update for ${project}, section ${n % 9}, no content change.`,
  (_project, actor) => `${actor}: ack`,
  (project) => `Monitoring: ${project} p99 latency steady at 180ms over the last 6h.`,
  (project, actor, n) => `${actor}: replying to the ${project} thread — ticket ${n % 400} is still assigned to me, will look after the release.`,
  (project) => `Calendar: ${project} retro is on Friday; agenda doc is in the usual folder.`,
  (project, actor, n) => `${actor}: FYI the ${project} staging box was restarted (run ${n % 50}); nothing else changed.`,
];

/**
 * Signal-tier shapes: a question, then a decision that hands an obligation to the
 * user, then a follow-up that leaves the obligation open.
 *
 * The SECOND line is the one that has to work, and it is second rather than last
 * on purpose. Layer 2 only writes a delta when it judges a thread meaningfully
 * changed state, and only writes a `pending_item` when something is genuinely
 * outstanding — so the benchmark needs threads where both are unambiguously true,
 * or `forBriefing` gets an empty window and the whole measurement collapses into
 * a `no_context` no-op that measures nothing. Putting the decision at index 1
 * means a run configured with `eventsPerSignalThread: 2` (to save seeding time on
 * a busy machine) still seeds a decision and an obligation.
 *
 * The ask is addressed to the `isSelf` person so the obligation lands on the user
 * (FR-4), which is also what gives the first-paint read something to rank.
 */
const SIGNAL_SHAPES: readonly ((project: string, self: string, actor: string) => string)[] = [
  (project, _self, actor) =>
    `${actor}: do we hold the ${project} launch for the schema migration, or ship it behind a flag? ` +
    `We need an answer today to keep the release train.`,
  (project, self, actor) =>
    `${actor}: decision — we ship ${project} behind a feature flag on Thursday and drop the launch hold. ` +
    `${self}, please update the runbook and confirm the on-call rota before Wednesday EOD.`,
  (project, self, actor) =>
    `${actor}: migration dry run for ${project} finished — 1.2M rows, 41 minutes, zero errors. ` +
    `Runbook draft is up; still waiting on ${self} to confirm the on-call rota before Thursday.`,
];

/**
 * Build the synthetic corpus.
 *
 * Shape decisions, all of which exist to make Layer 3 do real work:
 *
 *  - **Two sources, interleaved.** Slack thread keys look like `C0BENCH12`,
 *    Gmail's like `bench-thread-12@mail` — the two shapes the real normalizers
 *    produce. Both tiers use both sources.
 *  - **Timestamps spread across the whole 5 days**, with per-event jitter, so the
 *    recency decay in retrieval and the D-6 window filter both see a real
 *    distribution instead of a spike.
 *  - **Bulk events are spread over many threads** (~18 events each), which is
 *    what makes `countPendingSynthesis()` and the artifact table non-trivial.
 *  - **Signal threads are spaced evenly across the period**, so a rolling
 *    `windowWidthMs`-wide window always contains several of them. A window with
 *    no deltas produces a `no_context` briefing, which measures nothing.
 */
export function buildSyntheticCorpus(options: SyntheticCorpusOptions): SyntheticCorpus {
  const random = mulberry32(CORPUS_SEED);
  const period = Math.max(1, options.periodEnd - options.periodStart);
  const signalCount = Math.max(0, options.signalThreadCount) * Math.max(0, options.eventsPerSignalThread);
  const bulkCount = Math.max(0, options.eventCount - signalCount);

  const people = PEOPLE.map<Person>((person) => ({
    personId: person.id,
    displayName: person.name,
    emailHash: null,
    isSelf: person.isSelf,
  }));
  const self = PEOPLE.find((person) => person.isSelf) ?? PEOPLE[0];
  const selfName = self?.name ?? 'you';

  const threadKeys = new Set<string>();
  const threadKeyFor = (index: number, slack: boolean): string => {
    const key = slack ? `C0BENCH${index}` : `bench-thread-${index}@mail`;
    threadKeys.add(key);
    return key;
  };

  // ---- bulk tier ---------------------------------------------------------
  const bulkThreads = Math.max(1, Math.ceil(bulkCount / 18));
  const bulk: RawSourceEvent[] = [];
  for (let i = 0; i < bulkCount; i += 1) {
    const slack = i % 2 === 0;
    const threadIndex = i % bulkThreads;
    const actor = PEOPLE[i % PEOPLE.length] ?? self;
    const project = PROJECTS[threadIndex % PROJECTS.length] ?? 'Atlas';
    const shape = BULK_SHAPES[i % BULK_SHAPES.length];
    // Uniform across the period, jittered by up to one slot so consecutive
    // events do not land on a grid.
    const slot = (i / Math.max(1, bulkCount)) * period;
    const jitter = random() * (period / Math.max(1, bulkCount));
    const occurredAt = Math.min(
      options.periodEnd - 1,
      Math.floor(options.periodStart + slot + jitter),
    );

    bulk.push({
      source: slack ? 'slack' : 'gmail',
      sourceEventId: slack ? `${(occurredAt / 1000).toFixed(6)}-${i}` : `bench-msg-${i}`,
      threadKey: threadKeyFor(threadIndex, slack),
      actorId: actor?.id ?? 'bench:unknown',
      occurredAt,
      text: shape === undefined ? `${project} update ${i}` : shape(project, actor?.name ?? 'Someone', i),
    });
  }

  // ---- signal tier -------------------------------------------------------
  const signal: RawSourceEvent[] = [];
  const signalThreadKeys: string[] = [];
  const threads = Math.max(0, options.signalThreadCount);
  for (let t = 0; t < threads; t += 1) {
    const slack = t % 2 === 0;
    // Centred in its own even slice of the period, so N threads are N slices
    // apart and any window wider than one slice sees at least one of them.
    const centre = options.periodStart + ((t + 0.5) / threads) * period;
    const threadKey = threadKeyFor(10_000 + t, slack);
    signalThreadKeys.push(threadKey);
    const project = PROJECTS[t % PROJECTS.length] ?? 'Atlas';
    const actor = PEOPLE[(t + 1) % PEOPLE.length] ?? self;

    for (let k = 0; k < Math.max(0, options.eventsPerSignalThread); k += 1) {
      const shape = SIGNAL_SHAPES[k % SIGNAL_SHAPES.length];
      // 20 minutes apart: a conversation, not a batch import.
      const occurredAt = Math.min(
        options.periodEnd - 1,
        Math.floor(centre + k * 20 * 60 * 1000),
      );
      signal.push({
        source: slack ? 'slack' : 'gmail',
        sourceEventId: slack ? `${(occurredAt / 1000).toFixed(6)}-s${t}${k}` : `bench-signal-${t}-${k}`,
        threadKey,
        actorId: actor?.id ?? 'bench:unknown',
        occurredAt,
        text:
          shape === undefined
            ? `${project}: decision recorded.`
            : shape(project, selfName, actor?.name ?? 'Someone'),
      });
    }
  }

  return {
    bulk,
    signal,
    signalThreadKeys,
    people,
    threadCount: threadKeys.size,
  };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * `count` rolling, overlapping windows inside `[periodStart, periodEnd)`.
 *
 * The last window ends exactly at `periodEnd` and the first starts at
 * `periodStart`, with the starts spaced evenly between; at the default 48h width
 * over 5 days that is a ~3.8h step, so consecutive briefings share most of their
 * deltas and differ at the edges — the realistic case, and one that keeps every
 * window populated. A single window is the whole period.
 */
export function rollingWindows(
  periodStart: number,
  periodEnd: number,
  widthMs: number,
  count: number,
): { windowStart: number; windowEnd: number }[] {
  if (count <= 0) return [];
  const span = Math.max(1, periodEnd - periodStart);
  const width = Math.max(1, Math.min(widthMs, span));
  if (count === 1) return [{ windowStart: periodStart, windowEnd: periodEnd }];

  const step = (span - width) / (count - 1);
  return Array.from({ length: count }, (_unused, i) => {
    const windowStart = Math.floor(periodStart + i * step);
    return { windowStart, windowEnd: Math.min(periodEnd, windowStart + width) };
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Render an unknown thrown value as something a report can carry.
 *
 * `error.cause` is included because the failure this benchmark actually hits is
 * `TypeError: fetch failed`, whose entire diagnostic content
 * (`UND_ERR_HEADERS_TIMEOUT`) lives in the cause. A report that said only "fetch
 * failed" would leave an operator unable to tell a queued model from a dead one.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (cause === undefined || cause === null) return error.message;
  const causeText =
    cause instanceof Error
      ? `${(cause as { code?: string }).code ?? cause.name}: ${cause.message}`
      : String(cause);
  return `${error.message} (cause: ${causeText})`;
}

/**
 * One attempt, then one retry after a logged warning.
 *
 * Seeding runs against the same local Ollama the benchmark measures, and on a
 * busy machine a single request can sit behind another job's stream for longer
 * than undici's 300s header timeout. That is a queueing artefact, not a defect in
 * the pipeline under test, and losing the whole run to it would mean never
 * getting a number. Exactly one retry: a second failure is evidence the model is
 * genuinely unavailable, and hammering it would only lengthen the queue.
 */
async function withOneRetry<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    console.warn(`[bench] ${label} failed, retrying once: ${describe(error)}`);
    return attempt();
  }
}

/**
 * Seed a realistic 5-day corpus, then time `briefingCount` real briefings.
 *
 * Rejects only when SEEDING fails — a benchmark whose corpus never materialised
 * has nothing to measure, and reporting a P95 over an empty store would be
 * worse than failing. A failure inside the timing loop is per-iteration: it is
 * logged, counted in {@link BenchResult.failures}, and the loop continues, so one
 * Ollama hiccup twelve briefings in does not discard the eleven real
 * measurements that preceded it.
 */
export async function runBench(options: BenchRunOptions): Promise<BenchResult> {
  const eventCount = options.eventCount ?? DEFAULT_EVENT_COUNT;
  const briefingCount = options.briefingCount ?? DEFAULT_BRIEFING_COUNT;
  const signalThreadCount = options.signalThreadCount ?? DEFAULT_SIGNAL_THREAD_COUNT;
  const eventsPerSignalThread = options.eventsPerSignalThread ?? DEFAULT_EVENTS_PER_SIGNAL_THREAD;
  const windowWidthMs = options.windowWidthMs ?? DEFAULT_WINDOW_WIDTH_MS;
  const baseUrl = options.ollamaBaseUrl ?? options.config.model.ollamaBaseUrl;
  const report = options.onProgress ?? ((): void => undefined);

  // The period ENDS now, so every seeded delta's `created_at` is in the past and
  // every briefing window is a window over history — which is what a briefing is.
  const periodEnd = Date.now();
  const periodStart = periodEnd - SEEDED_PERIOD_MS;

  const corpus = buildSyntheticCorpus({
    eventCount,
    signalThreadCount,
    eventsPerSignalThread,
    periodStart,
    periodEnd,
  });

  const tmp = mkdtempSync(join(tmpdir(), 'cr-bench-'));
  let db: ReturnType<typeof openDb> | undefined;
  let vectors: VectorStore | undefined;

  try {
    // A file-backed database, not `:memory:` — a latency benchmark that measured
    // an in-memory store would report a number the product can never deliver.
    db = openDb(join(tmp, 'bench.db'));
    migrate(db);

    const events = new EventsRepo(db);
    const extractions = new ExtractionsRepo(db);
    const watermarks = new WatermarkRepo(db);
    const deltas = new DeltasRepo(db);
    const pending = new PendingItemsRepo(db);
    const briefings = new BriefingsRepo(db);
    const aiCalls = new AiCallsRepo(db);

    // Pinned inside the period while seeding; `goLive()` before any timing.
    const clock = new BenchClock(periodEnd - 1);
    const graph = new GraphRepo(db, clock);
    const gate = new CitationGate(graph);

    vectors = await openVectors(join(tmp, 'vectors'));

    const ollama: OllamaClient = createOllamaClient(
      baseUrl,
      options.config.model.chat,
      options.config.model.embed,
    );
    const embed = async (text: string): Promise<number[]> => {
      const [vector] = await ollama.embed([text]);
      if (vector === undefined || vector.length === 0) {
        throw new Error(`bench: embedding model returned no vector for a ${text.length}-char input`);
      }
      return vector;
    };

    const retrieval = new RetrievalService(vectors, graph, options.config, embed, { clock });
    const traceId = `bench-${newId().slice(0, 8)}`;

    // ---- seed: people ----------------------------------------------------
    for (const person of corpus.people) graph.upsertPerson(person);

    // ---- seed: ingest both tiers through the REAL pipeline ----------------
    report({
      phase: 'seed:ingest',
      total: corpus.bulk.length + corpus.signal.length,
      message: `ingesting ${corpus.bulk.length + corpus.signal.length} events across ${corpus.threadCount} threads`,
    });
    const pipeline = new IngestionPipeline(
      events,
      graph,
      watermarks,
      () => {
        // The durable extraction queue belongs to the desktop app; Layer 1 is
        // driven explicitly below. Same hand-off discard as `harness.ts`.
      },
      clock,
    );
    await pipeline.ingestBatch([...corpus.bulk, ...corpus.signal]);

    // ---- seed: Layer 1 over the signal tier only -------------------------
    // Driven from an explicit thread list rather than `listUnextracted()` — see
    // the module comment. `listUnextracted()` would return the whole bulk tier,
    // i.e. thousands of chat calls.
    let extractedEvents = 0;
    let extractionFailures = 0;
    const extractor = new Layer1Extractor(
      ollama,
      extractions,
      vectors,
      aiCalls,
      embed,
      options.config.model.chat,
      options.config.promptVersions.layer1,
      clock,
    );
    const signalEventTotal = corpus.signalThreadKeys.length * eventsPerSignalThread;
    for (const threadKey of corpus.signalThreadKeys) {
      for (const event of events.listByThread(threadKey)) {
        // Pinned to the event's own time: `extractions.created_at` and the
        // artifact's `last_seen_at` then describe when the thing happened.
        clock.pin(event.occurredAt + 1);
        report({
          phase: 'seed:layer1',
          index: extractedEvents + extractionFailures + 1,
          total: signalEventTotal,
          message: `${threadKey} ${event.eventId.slice(0, 8)}`,
        });
        try {
          await withOneRetry(`layer 1 on ${event.eventId}`, () =>
            extractor.extractEvent(event, traceId),
          );
          extractedEvents += 1;
        } catch (error) {
          // Skipped, counted and reported. One lost extraction costs this thread
          // one chunk; losing the whole run to a queued model costs the number.
          extractionFailures += 1;
          console.warn(`[bench] SKIPPED layer 1 on ${event.eventId}: ${describe(error)}`);
        }
      }
    }

    // ---- seed: Layer 2 per signal thread ---------------------------------
    const synthesizer = new Layer2Synthesizer(
      ollama,
      retrieval,
      deltas,
      pending,
      watermarks,
      aiCalls,
      options.config.model.chat,
      options.config.promptVersions.layer2,
      clock,
    );
    let synthesizedThreads = 0;
    let synthesisFailures = 0;
    for (const [index, threadKey] of corpus.signalThreadKeys.entries()) {
      const threadEvents = events.listByThread(threadKey);
      const last = threadEvents[threadEvents.length - 1];
      // One minute after the thread's last message: the delta's `created_at`
      // then falls inside the seeded period, close to the conversation it
      // describes, which is what makes `currentForWindow` return it for the
      // windows a user would actually ask about.
      clock.pin(Math.min(periodEnd - 1, (last?.occurredAt ?? periodEnd - 1) + 60_000));
      report({
        phase: 'seed:layer2',
        index: index + 1,
        total: corpus.signalThreadKeys.length,
        message: threadKey,
      });
      try {
        await withOneRetry(`layer 2 on ${threadKey}`, () =>
          synthesizer.synthesize(threadKey, traceId),
        );
        // The scheduler closes the cycle in production; doing it here keeps the
        // OI-1 "still processing" disclosure honest for the threads we drained.
        watermarks.markSynthesized(threadKey, clock.now(), null);
        synthesizedThreads += 1;
      } catch (error) {
        synthesisFailures += 1;
        console.warn(`[bench] SKIPPED layer 2 on ${threadKey}: ${describe(error)}`);
      }
    }

    const seededDeltas = deltas.currentForWindow(periodStart, periodEnd).length;
    const seededPending = pending.listOpen().length;

    // A benchmark over an empty store measures nothing: `forBriefing` would find
    // no citable artifact, `generate()` would short-circuit to `no_context`
    // before making a single model call, and the run would report a P95 of
    // SQLite. Fail loudly instead — this is an operator condition (the model is
    // unavailable, or Layer 2 declined every thread), not a latency result.
    if (seededDeltas === 0) {
      throw new Error(
        `bench: seeding produced no state deltas (${extractedEvents} extraction(s) ok, ` +
          `${extractionFailures} failed; ${synthesizedThreads} synthesis call(s) ok, ` +
          `${synthesisFailures} failed). There is nothing for Layer 3 to retrieve or rank, ` +
          'so no AC-1 number can be measured. Check that Ollama is reachable and not ' +
          'saturated, then re-run.',
      );
    }

    // ---- the clock goes live; everything after this is real time ----------
    clock.goLive();

    const generator = new BriefingGenerator(
      ollama,
      retrieval,
      deltas,
      briefings,
      gate,
      watermarks,
      graph,
      pending,
      aiCalls,
      options.config,
      tmp,
      options.config.model.chat,
      options.config.promptVersions.layer3,
      clock,
      { logsDir: join(tmp, 'logs') },
    );

    const windows = rollingWindows(periodStart, periodEnd, windowWidthMs, briefingCount);
    const samples: BenchSample[] = [];
    const failureMessages: string[] = [];

    for (const [index, window] of windows.entries()) {
      report({
        phase: 'briefing',
        index: index + 1,
        total: windows.length,
        message: `window ${new Date(window.windowStart).toISOString()} → ${new Date(window.windowEnd).toISOString()}`,
      });

      // ---- first paint: its own timed call, no model involved ------------
      const paintStart = performance.now();
      const painted = firstPaintPendingItems(pending, graph);
      const firstPaintMs = performance.now() - paintStart;

      // ---- the LLM path -------------------------------------------------
      // `generate` directly, NOT `generateWithFallback`: see the module comment.
      const generateStart = performance.now();
      try {
        const result = await generator.generate(window, {
          briefingId: `bench-${index + 1}-${newId().slice(0, 6)}`,
        });
        const totalMs = performance.now() - generateStart;

        samples.push({
          index: index + 1,
          windowStart: window.windowStart,
          windowEnd: window.windowEnd,
          firstPaintMs,
          firstPaintItems: painted.length,
          totalMs,
          timings: result.timings,
          outcome: result.outcome,
          claimsAccepted: result.claimsAccepted,
          claimsDropped: result.claimsDropped,
          partial: result.partial,
          threadsStillProcessing: result.threadsStillProcessing,
          // `'error'` is precisely "the stream failed before any token" — see
          // `BenchSample.sawFirstToken`.
          sawFirstToken:
            result.outcome !== 'error' &&
            result.outcome !== 'no_context' &&
            result.timings.firstTokenMs !== undefined,
          noContext: result.outcome === 'no_context',
        });
      } catch (error) {
        // Skipped, not fatal, and never silently: an Ollama timeout under a
        // busy machine is exactly the condition this benchmark runs in, and
        // discarding the whole run for it would mean never getting a number.
        const message = `run #${index + 1}: ${describe(error)}`;
        failureMessages.push(message);
        console.warn(`[bench] SKIPPED ${message}`);
        report({
          phase: 'briefing:failed',
          index: index + 1,
          total: windows.length,
          message,
        });
      }
    }

    const measured = samples.filter((sample) => !sample.noContext);

    return {
      perStagePercentiles: summarize(samples),
      n: measured.length,
      failures: failureMessages.length,
      emptyWindows: samples.length - measured.length,
      attempted: windows.length,
      failureMessages,
      samples,
      slowest: attributeSlowestRun(samples),
      partialRuns: measured.filter((sample) => sample.partial).length,
      noTokenRuns: measured.filter((sample) => !sample.sawFirstToken).length,
      corpus: {
        ingestedEvents: corpus.bulk.length + corpus.signal.length,
        threads: corpus.threadCount,
        extractedEvents,
        synthesizedThreads,
        extractionFailures,
        synthesisFailures,
        deltas: seededDeltas,
        pendingItems: seededPending,
        periodStart,
        periodEnd,
        windowWidthMs,
      },
      environment: {
        chatModel: options.config.model.chat,
        embedModel: options.config.model.embed,
        ollamaBaseUrl: baseUrl,
        generationBudgetMs: options.config.budgets.generationMs,
        retrievalBudgetMs: options.config.retrieval.budgetMs,
        retrievalTopK: options.config.retrieval.topK,
        promptVersions: [
          `layer1=${options.config.promptVersions.layer1}`,
          `layer2=${options.config.promptVersions.layer2}`,
          `layer3=${options.config.promptVersions.layer3}`,
        ].join(', '),
      },
      notes: [...(options.notes ?? [])],
      generatedAt: Date.now(),
    };
  } finally {
    // Ordered: LanceDB holds file handles inside `tmp`, so it closes before the
    // directory is removed. On Windows an open handle makes `rmSync` throw.
    if (vectors !== undefined) await vectors.close().catch(() => undefined);
    db?.close();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
