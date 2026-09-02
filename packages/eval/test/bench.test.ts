/**
 * Task 5.3 — the latency benchmark's pure logic, tested with NO Ollama call.
 *
 * `runBench()` itself cannot be unit-tested: it is a real 14B model, a real
 * LanceDB and tens of minutes by construction. Everything that decides what the
 * benchmark *reports*, though, is pure, and those are the parts that can lie:
 *
 *   - {@link nearestRankPercentile} — the statistic itself. It must be the SAME
 *     nearest-rank arithmetic as `BriefingsRepo.percentiles` (Task 4.4), or the
 *     P95 printed by the benchmark and the P95 shown in the app's metrics view
 *     would be two different numbers with one name.
 *   - {@link summarize} — which samples feed which metric. A `no_context` run
 *     made no model call, and letting its ~1 ms into the `totalMs` distribution
 *     would be the single most flattering possible bug.
 *   - {@link evaluateAc1} — the PASS/FAIL verdict, including the case that has no
 *     data at all, which must be neither.
 *   - {@link attributeSlowestRun} — "which stage dominates a slow run", and the
 *     fact that `firstTokenMs` is a SUB-span of `generationMs` and must never be
 *     added to it.
 *   - {@link renderBenchTable} — the honesty banners. A reduced sample that
 *     rendered like a full one would be a Task 5.1/5.2 discipline failure with
 *     nicer formatting.
 *
 * Every expected value below is computed by hand in the comment beside it.
 */

import { describe, expect, it } from 'vitest';
import type { PendingItem } from '@cr/core';
import type { StageTimings } from '@cr/observability';
import {
  AC1_FIRST_TOKEN_P95_MS,
  AC1_TOTAL_P95_MS,
  ATTRIBUTABLE_STAGES,
  BENCH_METRICS,
  DEFAULT_BRIEFING_COUNT,
  attributeSlowestRun,
  buildSyntheticCorpus,
  evaluateAc1,
  firstPaintPendingItems,
  nearestRankPercentile,
  percentilesOf,
  renderBenchTable,
  rollingWindows,
  summarize,
  type BenchResult,
  type BenchSample,
} from '../src/bench.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface SampleOverrides {
  index?: number;
  firstPaintMs?: number;
  totalMs?: number;
  timings?: StageTimings;
  noContext?: boolean;
  partial?: boolean;
  outcome?: string;
  sawFirstToken?: boolean;
}

/** One synthetic sample. Defaults are deliberately boring, not realistic. */
function sample(overrides: SampleOverrides = {}): BenchSample {
  return {
    index: overrides.index ?? 1,
    windowStart: 1_000,
    windowEnd: 2_000,
    firstPaintMs: overrides.firstPaintMs ?? 1,
    firstPaintItems: 3,
    totalMs: overrides.totalMs ?? 1_000,
    timings: overrides.timings ?? {},
    outcome: overrides.outcome ?? (overrides.noContext === true ? 'no_context' : 'ok'),
    claimsAccepted: 4,
    claimsDropped: 0,
    partial: overrides.partial ?? false,
    threadsStillProcessing: 0,
    sawFirstToken:
      overrides.sawFirstToken ??
      (overrides.noContext !== true && (overrides.timings?.firstTokenMs ?? undefined) !== undefined),
    noContext: overrides.noContext ?? false,
  };
}

/** A `BenchResult` around a hand-built sample set, with the aggregates derived. */
function resultOf(samples: BenchSample[], failureMessages: string[] = []): BenchResult {
  const measured = samples.filter((entry) => !entry.noContext);
  return {
    perStagePercentiles: summarize(samples),
    n: measured.length,
    failures: failureMessages.length,
    emptyWindows: samples.length - measured.length,
    attempted: samples.length + failureMessages.length,
    failureMessages,
    samples,
    slowest: attributeSlowestRun(samples),
    partialRuns: measured.filter((entry) => entry.partial).length,
    noTokenRuns: measured.filter((entry) => !entry.sawFirstToken).length,
    corpus: {
      ingestedEvents: 3000,
      threads: 160,
      extractedEvents: 24,
      synthesizedThreads: 8,
      extractionFailures: 0,
      synthesisFailures: 0,
      deltas: 6,
      pendingItems: 5,
      periodStart: 0,
      periodEnd: 5 * 24 * 3_600_000,
      windowWidthMs: 48 * 3_600_000,
    },
    environment: {
      chatModel: 'qwen2.5:14b',
      embedModel: 'nomic-embed-text',
      ollamaBaseUrl: 'http://localhost:11434',
      generationBudgetMs: 30_000,
      retrievalBudgetMs: 5_000,
      retrievalTopK: 40,
      promptVersions: 'layer1=v1, layer2=v1, layer3=v1',
    },
    notes: [],
    generatedAt: 1_700_000_000_000,
  };
}

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

describe('nearestRankPercentile', () => {
  it('matches BriefingsRepo.percentiles: index = ceil(f × n) − 1', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // p50: ceil(0.5 × 10) − 1 = 4 → sorted[4] = 5. NOT 5.5 — no interpolation.
    expect(nearestRankPercentile(values, 0.5)).toBe(5);
    // p95: ceil(0.95 × 10) − 1 = 9 → sorted[9] = 10.
    expect(nearestRankPercentile(values, 0.95)).toBe(10);
  });

  it('sorts its input rather than trusting the caller', () => {
    // Samples arrive in run order, which is not sorted order.
    expect(nearestRankPercentile([9, 1, 5, 3, 7], 0.5)).toBe(5); // ceil(2.5)−1 = 2 → 5
    expect(nearestRankPercentile([9, 1, 5, 3, 7], 0.95)).toBe(9); // ceil(4.75)−1 = 4 → 9
  });

  it('does not mutate the caller’s array', () => {
    const values = [3, 1, 2];
    nearestRankPercentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });

  it('is a real observation for a small sample: P95 of 6 runs is the slowest one', () => {
    const six = [10, 20, 30, 40, 50, 60];
    // ceil(0.95 × 6) − 1 = ceil(5.7) − 1 = 5 → 60. This is exactly why the
    // report calls a small-n P95 a weak upper bound.
    expect(nearestRankPercentile(six, 0.95)).toBe(60);
    expect(nearestRankPercentile(six, 0.5)).toBe(30); // ceil(3)−1 = 2 → 30
  });

  it('returns null for an empty sample and for one that is entirely non-finite', () => {
    expect(nearestRankPercentile([], 0.5)).toBeNull();
    expect(nearestRankPercentile([Number.NaN, Number.POSITIVE_INFINITY], 0.95)).toBeNull();
  });

  it('reports a single observation as both P50 and P95', () => {
    expect(nearestRankPercentile([42], 0.5)).toBe(42);
    expect(nearestRankPercentile([42], 0.95)).toBe(42);
  });

  it('clamps fractions outside [0, 1] instead of indexing off the end', () => {
    expect(nearestRankPercentile([1, 2, 3], 1.5)).toBe(3);
    expect(nearestRankPercentile([1, 2, 3], -1)).toBe(1);
  });
});

describe('percentilesOf', () => {
  it('carries the observation count next to the percentiles (RO-2)', () => {
    expect(percentilesOf([5, 1, 3])).toEqual({ count: 3, p50: 3, p95: 5 });
  });

  it('reports no data as null, never as 0 — 0 ms is a real latency', () => {
    expect(percentilesOf([])).toEqual({ count: 0, p50: null, p95: null });
  });

  it('excludes non-finite observations from the count', () => {
    expect(percentilesOf([1, Number.NaN, 3])).toEqual({ count: 2, p50: 1, p95: 3 });
  });
});

// ---------------------------------------------------------------------------
// summarize — which samples feed which metric
// ---------------------------------------------------------------------------

describe('summarize', () => {
  const samples = [
    sample({
      index: 1,
      firstPaintMs: 2,
      totalMs: 40_000,
      timings: {
        retrievalMs: 900,
        assemblyMs: 10,
        firstTokenMs: 8_000,
        generationMs: 38_000,
        citationMs: 40,
      },
    }),
    sample({
      index: 2,
      firstPaintMs: 4,
      totalMs: 60_000,
      timings: {
        retrievalMs: 1_100,
        assemblyMs: 12,
        firstTokenMs: 12_000,
        generationMs: 58_000,
        citationMs: 60,
      },
    }),
  ];

  it('reports every metric it advertises', () => {
    const stats = summarize(samples);
    expect(Object.keys(stats).sort()).toEqual([...BENCH_METRICS].sort());
  });

  it('computes each metric from its own observations', () => {
    const stats = summarize(samples);
    // n = 2 → p50 index ceil(1)−1 = 0 (the smaller), p95 index ceil(1.9)−1 = 1.
    expect(stats.totalMs).toEqual({ count: 2, p50: 40_000, p95: 60_000 });
    expect(stats.firstTokenMs).toEqual({ count: 2, p50: 8_000, p95: 12_000 });
    expect(stats.firstPaintMs).toEqual({ count: 2, p50: 2, p95: 4 });
    expect(stats.retrievalMs).toEqual({ count: 2, p50: 900, p95: 1_100 });
    expect(stats.citationMs).toEqual({ count: 2, p50: 40, p95: 60 });
  });

  it('EXCLUDES a no_context run from every LLM metric', () => {
    // A run that made no model call is ~1 ms of SQLite. Counting it would drag
    // the P50 of `totalMs` toward zero while claiming to describe the LLM path.
    const withEmpty = [...samples, sample({ index: 3, totalMs: 3, noContext: true })];
    const stats = summarize(withEmpty);
    expect(stats.totalMs.count).toBe(2);
    expect(stats.totalMs.p50).toBe(40_000);
    expect(stats.generationMs.count).toBe(2);
  });

  it('INCLUDES a no_context run in first paint, which does not depend on the model', () => {
    const withEmpty = [
      ...samples,
      sample({ index: 3, firstPaintMs: 9, totalMs: 3, noContext: true }),
    ];
    expect(summarize(withEmpty).firstPaintMs).toEqual({ count: 3, p50: 4, p95: 9 });
  });

  it('keeps a token-less run in totalMs but EXCLUDES it from firstTokenMs', () => {
    // The real numbers from the first bench run: three of twenty iterations hit
    // undici's 300s header timeout with `outcome: 'error'`, and `generate()`
    // ends the `firstToken` span in a `finally` — so the span recorded a
    // 305-second wait for a token that never arrived. Those three WERE the P95
    // of `firstTokenMs`. The user really waited, so `totalMs` keeps them.
    const withDeath = [
      ...samples,
      sample({
        index: 3,
        totalMs: 305_459,
        outcome: 'error',
        sawFirstToken: false,
        timings: { retrievalMs: 119, assemblyMs: 1, firstTokenMs: 305_337, generationMs: 305_337 },
      }),
    ];
    const stats = summarize(withDeath);
    expect(stats.firstTokenMs.count).toBe(2);
    expect(stats.firstTokenMs.p95).toBe(12_000);
    expect(stats.totalMs.count).toBe(3);
    expect(stats.totalMs.p95).toBe(305_459);
    // The generation span is still a real elapsed generation attempt.
    expect(stats.generationMs.count).toBe(3);
  });

  it('reports an absent stage as no data rather than as 0 ms', () => {
    // A run where the model never produced a token has no `firstTokenMs` — the
    // trace omits the key rather than writing 0 (see `StageTimings`).
    const noToken = [sample({ index: 1, totalMs: 90_000, timings: { retrievalMs: 500 } })];
    const stats = summarize(noToken);
    expect(stats.firstTokenMs).toEqual({ count: 0, p50: null, p95: null });
    expect(stats.retrievalMs.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-1 verdicts
// ---------------------------------------------------------------------------

describe('evaluateAc1', () => {
  it('passes both thresholds when both P95s are inside them', () => {
    const checks = evaluateAc1(
      resultOf([
        sample({ totalMs: 30_000, timings: { firstTokenMs: 2_000 } }),
        sample({ index: 2, totalMs: 45_000, timings: { firstTokenMs: 4_500 } }),
      ]),
    );
    expect(checks.map((check) => check.status)).toEqual(['PASS', 'PASS']);
    expect(checks[0]?.measuredP95).toBe(45_000);
    expect(checks[0]?.count).toBe(2);
    expect(checks[1]?.measuredP95).toBe(4_500);
  });

  it('fails the total threshold on the P95, not on the median', () => {
    // Nineteen fast runs and one slow one: nearest-rank P95 over n=20 is the
    // 19th value, so a single 61s outlier does NOT fail it, but two do.
    const fast = Array.from({ length: 19 }, (_unused, i) =>
      sample({ index: i + 1, totalMs: 10_000, timings: { firstTokenMs: 1_000 } }),
    );
    const oneSlow = evaluateAc1(
      resultOf([...fast, sample({ index: 20, totalMs: 61_000, timings: { firstTokenMs: 1_000 } })]),
    );
    expect(oneSlow[0]?.measuredP95).toBe(10_000);
    expect(oneSlow[0]?.status).toBe('PASS');

    const twoSlow = evaluateAc1(
      resultOf([
        ...fast.slice(0, 18),
        sample({ index: 19, totalMs: 61_000, timings: { firstTokenMs: 1_000 } }),
        sample({ index: 20, totalMs: 62_000, timings: { firstTokenMs: 1_000 } }),
      ]),
    );
    expect(twoSlow[0]?.measuredP95).toBe(61_000);
    expect(twoSlow[0]?.status).toBe('FAIL');
  });

  it('treats the threshold as strict: exactly 60000 ms is a FAIL', () => {
    const checks = evaluateAc1(
      resultOf([
        sample({ totalMs: AC1_TOTAL_P95_MS, timings: { firstTokenMs: AC1_FIRST_TOKEN_P95_MS } }),
      ]),
    );
    expect(checks.map((check) => check.status)).toEqual(['FAIL', 'FAIL']);
  });

  it('reports an unmeasured metric as NO DATA — neither PASS nor FAIL', () => {
    // The model never produced a token, so there is no first-token latency. A
    // PASS here would be a claim the run cannot support; a FAIL would accuse it
    // of something that was not measured.
    const checks = evaluateAc1(resultOf([sample({ totalMs: 20_000, timings: {} })]));
    expect(checks[0]?.status).toBe('PASS');
    expect(checks[1]?.status).toBe('NO DATA');
    expect(checks[1]?.measuredP95).toBeNull();
    expect(checks[1]?.count).toBe(0);
  });

  it('reports NO DATA for both metrics when nothing was measured at all', () => {
    const checks = evaluateAc1(resultOf([], ['run #1: connect ECONNREFUSED']));
    expect(checks.map((check) => check.status)).toEqual(['NO DATA', 'NO DATA']);
  });

  it('states the AC-1 thresholds the plan specifies', () => {
    expect(AC1_TOTAL_P95_MS).toBe(60_000);
    expect(AC1_FIRST_TOKEN_P95_MS).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

describe('attributeSlowestRun', () => {
  it('names the slowest run and its dominant stage', () => {
    const attribution = attributeSlowestRun([
      sample({ index: 1, totalMs: 12_000, timings: { retrievalMs: 500, generationMs: 11_000 } }),
      sample({
        index: 2,
        totalMs: 50_000,
        timings: { retrievalMs: 30_000, assemblyMs: 20, generationMs: 19_000, citationMs: 30 },
      }),
    ]);
    expect(attribution?.sampleIndex).toBe(2);
    expect(attribution?.stage).toBe('retrievalMs');
    expect(attribution?.stageMs).toBe(30_000);
    // 50000 − (30000 + 20 + 19000 + 30) = 950
    expect(attribution?.unattributedMs).toBe(950);
  });

  it('never adds firstTokenMs to the sum — it is a sub-span of generationMs', () => {
    // generation 40000 CONTAINS firstToken 9000. Attributing both would produce
    // a 49000 ms sum against a 41000 ms run and a nonsensical remainder.
    const attribution = attributeSlowestRun([
      sample({
        index: 1,
        totalMs: 41_000,
        timings: { retrievalMs: 800, assemblyMs: 10, firstTokenMs: 9_000, generationMs: 40_000, citationMs: 40 },
      }),
    ]);
    expect(attribution?.stage).toBe('generationMs');
    expect(attribution?.unattributedMs).toBe(150); // 41000 − 40850
    expect(ATTRIBUTABLE_STAGES).not.toContain('firstTokenMs');
  });

  it('clamps the remainder at 0 rather than reporting negative time', () => {
    // The spans are measured with the injected clock, `totalMs` with
    // `performance.now()`; a sub-ms disagreement must not render as "−1 ms".
    const attribution = attributeSlowestRun([
      sample({ index: 1, totalMs: 1_000, timings: { generationMs: 1_001 } }),
    ]);
    expect(attribution?.unattributedMs).toBe(0);
  });

  it('ignores no_context runs — those are not slow runs, they are absent ones', () => {
    const attribution = attributeSlowestRun([
      sample({ index: 1, totalMs: 5_000, timings: { generationMs: 4_000 } }),
      sample({ index: 2, totalMs: 900_000, noContext: true }),
    ]);
    expect(attribution?.sampleIndex).toBe(1);
  });

  it('returns null when there is nothing to attribute', () => {
    expect(attributeSlowestRun([])).toBeNull();
    expect(attributeSlowestRun([sample({ noContext: true })])).toBeNull();
  });

  it('reports a run with no closed stage span as having no dominant stage', () => {
    const attribution = attributeSlowestRun([sample({ index: 1, totalMs: 700, timings: {} })]);
    expect(attribution?.stage).toBeNull();
    expect(attribution?.stageMs).toBeNull();
    expect(attribution?.unattributedMs).toBe(700);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('renderBenchTable', () => {
  const twenty = Array.from({ length: DEFAULT_BRIEFING_COUNT }, (_unused, i) =>
    sample({
      index: i + 1,
      firstPaintMs: 1,
      totalMs: 35_000 + i * 100,
      timings: {
        retrievalMs: 800,
        assemblyMs: 5,
        firstTokenMs: 3_000,
        generationMs: 34_000,
        citationMs: 30,
      },
    }),
  );

  it('states n, and every percentile next to its observation count', () => {
    const table = renderBenchTable(resultOf(twenty));
    expect(table).toContain('**n = 20 briefing generation(s) measured**');
    expect(table).toContain('| Metric | Observations | P50 | P95 |');
    expect(table).toContain('First paint');
    expect(table).toContain('First token');
    // P95 of totalMs over 20 samples: index ceil(19)−1 = 18 → 35000 + 1800.
    expect(table).toContain('36,800 ms');
  });

  it('renders the AC-1 verdicts with their sample size', () => {
    const table = renderBenchTable(resultOf(twenty));
    expect(table).toContain('| AC-1 |');
    expect(table).toContain('20 run(s)');
    expect(table).toContain('PASS');
  });

  it('renders a FAIL when the measured P95 misses the threshold', () => {
    const slow = twenty.map((entry) =>
      sample({ index: entry.index, totalMs: 90_000, timings: { firstTokenMs: 25_000 } }),
    );
    const table = renderBenchTable(resultOf(slow));
    expect(table).toContain('FAIL');
    expect(table).not.toContain('| PASS |');
  });

  it('BANNERS a reduced sample instead of letting it read like a full run', () => {
    const table = renderBenchTable(resultOf(twenty.slice(0, 6)));
    expect(table).toContain('REDUCED SAMPLE');
    expect(table).toContain('measured 6');
    expect(table).toContain('n = 6 briefing generation(s) measured');
  });

  it('does not banner a full 20-briefing run', () => {
    expect(renderBenchTable(resultOf(twenty))).not.toContain('REDUCED SAMPLE');
  });

  it('says plainly when nothing was measured, rather than printing an AC-1 pass', () => {
    const table = renderBenchTable(resultOf([], ['run #1: fetch failed', 'run #2: fetch failed']));
    expect(table).toContain('NOTHING WAS MEASURED');
    expect(table).toContain('NO DATA');
    expect(table).toContain('run #1: fetch failed');
    expect(table).not.toContain('| PASS |');
  });

  it('discloses budget-truncated runs, so a capped P95 is not read as a fast model', () => {
    const truncated = twenty.map((entry) =>
      sample({
        index: entry.index,
        totalMs: 31_000,
        partial: true,
        outcome: 'budget_exceeded',
        timings: { firstTokenMs: 4_000, generationMs: 30_010 },
      }),
    );
    const table = renderBenchTable(resultOf(truncated));
    expect(table).toContain('TRUNCATED by');
    expect(table).toContain('budgets.generationMs');
  });

  it('reports the corpus split so "3000 events" cannot read as "3000 extractions"', () => {
    const table = renderBenchTable(resultOf(twenty));
    expect(table).toContain('Events ingested');
    expect(table).toContain('Events extracted (real Layer 1, 1 chat call each) | 24');
    expect(table).toContain('is NOT `events extracted`');
  });

  it('renders operator notes ABOVE the table, as a precondition for reading it', () => {
    const table = renderBenchTable({
      ...resultOf(twenty),
      notes: ['another eval job was streaming on the same Ollama instance'],
    });
    expect(table).toContain('**Conditions this run was measured under:**');
    expect(table).toContain('- another eval job was streaming on the same Ollama instance');
    expect(table.indexOf('another eval job')).toBeLessThan(table.indexOf('| Metric |'));
  });

  it('labels the generation numbers a lower bound, given the smaller seeded prompt', () => {
    expect(renderBenchTable(resultOf(twenty))).toContain('LOWER BOUND');
  });

  it('discloses runs that produced no token, and why they are excluded', () => {
    const table = renderBenchTable(
      resultOf([
        ...twenty.slice(0, 18),
        sample({ index: 19, totalMs: 305_000, outcome: 'error', sawFirstToken: false, timings: { firstTokenMs: 304_900 } }),
        sample({ index: 20, totalMs: 321_000, outcome: 'error', sawFirstToken: false, timings: { firstTokenMs: 320_900 } }),
      ]),
    );
    expect(table).toContain('produced **no token at all**');
    expect(table).toContain('2 of 20 measured run(s)');
  });

  it('discloses seeding calls that were skipped after a retry', () => {
    const withLosses = resultOf(twenty);
    const table = renderBenchTable({
      ...withLosses,
      corpus: { ...withLosses.corpus, extractionFailures: 3, synthesisFailures: 1 },
    });
    expect(table).toContain('Seeding calls skipped after a retry | 3 Layer 1, 1 Layer 2');
  });

  it('warns that generation contains first token and must not be summed with it', () => {
    expect(renderBenchTable(resultOf(twenty))).toContain('CONTAINS `first token`');
  });

  it('states that first paint is not a substitute for first token', () => {
    expect(renderBenchTable(resultOf(twenty))).toContain('not** an AC-1 row');
  });
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

describe('rollingWindows', () => {
  const start = 0;
  const end = 5 * 24 * 3_600_000; // 5 days
  const width = 48 * 3_600_000;

  it('produces `count` windows, the first at the start and the last at the end', () => {
    const windows = rollingWindows(start, end, width, 20);
    expect(windows).toHaveLength(20);
    expect(windows[0]?.windowStart).toBe(start);
    expect(windows[19]?.windowEnd).toBe(end);
  });

  it('rolls forward and overlaps, so consecutive briefings share most deltas', () => {
    const windows = rollingWindows(start, end, width, 20);
    for (let i = 1; i < windows.length; i += 1) {
      const previous = windows[i - 1];
      const current = windows[i];
      expect(current?.windowStart).toBeGreaterThan(previous?.windowStart ?? -1);
      // Overlap: the new window starts before the previous one ended.
      expect(current?.windowStart).toBeLessThan(previous?.windowEnd ?? 0);
      expect((current?.windowEnd ?? 0) - (current?.windowStart ?? 0)).toBeLessThanOrEqual(width);
    }
  });

  it('uses the whole period for a single window', () => {
    expect(rollingWindows(start, end, width, 1)).toEqual([{ windowStart: start, windowEnd: end }]);
  });

  it('never exceeds the period, even for an over-wide request', () => {
    for (const window of rollingWindows(start, end, end * 3, 4)) {
      expect(window.windowStart).toBeGreaterThanOrEqual(start);
      expect(window.windowEnd).toBeLessThanOrEqual(end);
    }
  });

  it('returns nothing for a non-positive count', () => {
    expect(rollingWindows(start, end, width, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Synthetic corpus
// ---------------------------------------------------------------------------

describe('buildSyntheticCorpus', () => {
  const periodStart = 1_700_000_000_000;
  const periodEnd = periodStart + 5 * 24 * 3_600_000;
  const options = {
    eventCount: 300,
    signalThreadCount: 8,
    eventsPerSignalThread: 3,
    periodStart,
    periodEnd,
  };

  it('splits the requested count into bulk and signal tiers', () => {
    const corpus = buildSyntheticCorpus(options);
    expect(corpus.signal).toHaveLength(24);
    expect(corpus.bulk).toHaveLength(276);
    expect(corpus.bulk.length + corpus.signal.length).toBe(300);
    expect(corpus.signalThreadKeys).toHaveLength(8);
  });

  it('keeps every event inside the seeded period', () => {
    for (const event of [...buildSyntheticCorpus(options).bulk, ...buildSyntheticCorpus(options).signal]) {
      expect(event.occurredAt).toBeGreaterThanOrEqual(periodStart);
      expect(event.occurredAt).toBeLessThan(periodEnd);
    }
  });

  it('uses both sources in both tiers', () => {
    const corpus = buildSyntheticCorpus(options);
    expect(new Set(corpus.bulk.map((event) => event.source))).toEqual(new Set(['slack', 'gmail']));
    expect(new Set(corpus.signal.map((event) => event.source))).toEqual(new Set(['slack', 'gmail']));
  });

  it('mints unique source event ids, so ingestion is not deduplicating the corpus away', () => {
    // AC-10 idempotency is keyed on `(source, source_event_id)`; a colliding
    // generator would silently seed a far smaller store than the report claims.
    const corpus = buildSyntheticCorpus(options);
    const keys = [...corpus.bulk, ...corpus.signal].map(
      (event) => `${event.source}:${event.sourceEventId}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is deterministic, so two runs are comparable', () => {
    const a = buildSyntheticCorpus(options);
    const b = buildSyntheticCorpus(options);
    expect(a.bulk).toEqual(b.bulk);
    expect(a.signal).toEqual(b.signal);
  });

  it('declares exactly one self, so obligations can land on the user (FR-4)', () => {
    const selves = buildSyntheticCorpus(options).people.filter((person) => person.isSelf);
    expect(selves).toHaveLength(1);
  });

  it('spaces the signal threads so every rolling window contains one', () => {
    const corpus = buildSyntheticCorpus(options);
    const windows = rollingWindows(periodStart, periodEnd, 48 * 3_600_000, 20);
    for (const window of windows) {
      const inWindow = corpus.signal.filter(
        (event) => event.occurredAt >= window.windowStart && event.occurredAt < window.windowEnd,
      );
      // Otherwise the briefing would be a `no_context` no-op, which measures
      // nothing at all.
      expect(inWindow.length).toBeGreaterThan(0);
    }
  });

  it('addresses the decision event to the self person, so a pending item is derivable', () => {
    const corpus = buildSyntheticCorpus(options);
    const self = corpus.people.find((person) => person.isSelf);
    const decisions = corpus.signal.filter((event) => event.text.includes('decision —'));
    expect(decisions.length).toBe(8);
    for (const event of decisions) {
      expect(event.text).toContain(self?.displayName ?? '');
      expect(event.text.toLowerCase()).toContain('please');
    }
  });

  it('still seeds a decision and an ask with only TWO events per signal thread', () => {
    // A busy machine may only afford 2 Layer 1 calls per thread; if the decision
    // line were last, such a run would seed no delta at all and the whole
    // benchmark would collapse into `no_context` no-ops.
    const lean = buildSyntheticCorpus({ ...options, eventsPerSignalThread: 2 });
    expect(lean.signal).toHaveLength(16);
    const decisions = lean.signal.filter((event) => event.text.includes('decision —'));
    expect(decisions).toHaveLength(8);
    for (const threadKey of lean.signalThreadKeys) {
      expect(lean.signal.filter((event) => event.threadKey === threadKey)).toHaveLength(2);
    }
  });

  it('spreads the bulk tier across many threads', () => {
    const corpus = buildSyntheticCorpus({ ...options, eventCount: 3000 });
    // 2976 bulk events at ~18 per thread, plus the 8 signal threads.
    expect(corpus.threadCount).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// First paint (Task 3.5's ranking, mirrored)
// ---------------------------------------------------------------------------

describe('firstPaintPendingItems', () => {
  const item = (overrides: Partial<PendingItem>): PendingItem => ({
    pendingId: 'p1',
    deltaId: 'd1',
    description: 'confirm the on-call rota',
    confidence: 0.8,
    citationArtifactId: 'artifact-1',
    status: 'open',
    createdAt: 1_000,
    resolvedAt: null,
    ...overrides,
  });

  it('orders by stakes × confidence, highest first', () => {
    const items = [
      item({ pendingId: 'low', citationArtifactId: 'a-low', confidence: 0.9 }),
      item({ pendingId: 'high', citationArtifactId: 'a-high', confidence: 0.5 }),
    ];
    const ranked = firstPaintPendingItems(
      { listOpen: () => items },
      {
        relatedIds: (fromId) => (fromId === 'a-high' ? ['proj-high'] : ['proj-low']),
        getProject: (id) => ({ stakesWeight: id === 'proj-high' ? 5 : 1 }),
      },
    );
    // high: 5 × 0.5 = 2.5 beats low: 1 × 0.9 = 0.9
    expect(ranked.map((entry) => entry.pendingId)).toEqual(['high', 'low']);
  });

  it('falls back to confidence-then-oldest with no graph', () => {
    const items = [
      item({ pendingId: 'newer', confidence: 0.5, createdAt: 2_000 }),
      item({ pendingId: 'older', confidence: 0.5, createdAt: 1_000 }),
      item({ pendingId: 'sure', confidence: 0.99, createdAt: 9_000 }),
    ];
    const ranked = firstPaintPendingItems({ listOpen: () => items });
    expect(ranked.map((entry) => entry.pendingId)).toEqual(['sure', 'older', 'newer']);
  });

  it('keeps a zero-stakes item rather than hiding an obligation', () => {
    // Retrieval EXCLUDES zero-stakes chunks; first paint must not. An
    // outstanding obligation on the user is still outstanding.
    const ranked = firstPaintPendingItems(
      { listOpen: () => [item({ pendingId: 'muted' })] },
      { relatedIds: () => ['proj'], getProject: () => ({ stakesWeight: 0 }) },
    );
    expect(ranked.map((entry) => entry.pendingId)).toEqual(['muted']);
  });

  it('handles an uncited item without consulting the graph', () => {
    let calls = 0;
    const ranked = firstPaintPendingItems(
      { listOpen: () => [item({ citationArtifactId: null })] },
      {
        relatedIds: () => {
          calls += 1;
          return [];
        },
        getProject: () => undefined,
      },
    );
    expect(ranked).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it('is a total order — the pending id breaks a full tie', () => {
    const items = [
      item({ pendingId: 'b', createdAt: 1_000 }),
      item({ pendingId: 'a', createdAt: 1_000 }),
    ];
    expect(firstPaintPendingItems({ listOpen: () => items }).map((entry) => entry.pendingId)).toEqual(
      ['a', 'b'],
    );
  });

  it('returns an empty list for an empty inbox', () => {
    expect(firstPaintPendingItems({ listOpen: () => [] })).toEqual([]);
  });
});
