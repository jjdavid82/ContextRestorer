/**
 * `debug:metrics` tests (Task 4.4, step 4) — `src/ipc/metrics.ts`.
 *
 * Real `AiCallsRepo`/`BriefingsRepo` over `openDb(':memory:')` + `migrate`, and
 * real trace files on disk, for the same reason `ipc.feedback.test.ts` uses the
 * real repos: every claim here is a claim about what the store and the log
 * actually hold, and a stub would prove nothing about either.
 *
 * `metrics.ts` imports `ipcMain` at module scope, which does not exist outside a
 * running Electron process — same `vi.mock('electron', …)` + dynamic-import
 * pattern as the other IPC tests in this directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { FakeClock } from '@cr/core';
import { startTrace } from '@cr/observability';
import { AiCallsRepo, BriefingsRepo, migrate, openDb } from '@cr/store';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const { DEBUG_METRICS_CHANNEL, collectLocalMetrics, registerMetricsHandlers } = await import(
  '../src/ipc/metrics.js'
);

const T0 = Date.UTC(2025, 2, 4, 5, 6, 7, 8);
const GENERATED_AT = 1_700_000_000_000;

let db: Database;
let aiCalls: AiCallsRepo;
let briefings: BriefingsRepo;
let logsDir: string;

beforeEach(() => {
  handle.mockClear();
  db = openDb(':memory:');
  migrate(db);
  aiCalls = new AiCallsRepo(db);
  briefings = new BriefingsRepo(db);
  logsDir = mkdtempSync(join(tmpdir(), 'cr-ipc-metrics-'));
});

afterEach(() => {
  db.close();
  rmSync(logsDir, { recursive: true, force: true });
});

const deps = () => ({ aiCalls, briefings, logsDir });

const log = (layer: 1 | 2 | 3, latencyMs: number, outcome: string): void => {
  aiCalls.log({
    traceId: `t-${layer}-${outcome}-${latencyMs}`,
    layer,
    model: 'test-model',
    promptVersion: 'v1',
    latencyMs,
    outcome,
  });
};

/** Write one briefing trace line through the real writer. */
const writeBriefingTrace = (annotations: Record<string, unknown>): void => {
  const trace = startTrace(new FakeClock(T0), logsDir);
  trace.span('citation').end();
  trace.annotate({ event: 'briefing', layer: 3, ...annotations });
  trace.finish();
};

describe('collectLocalMetrics', () => {
  it('reports per-layer counts and mean latency from ai_calls', () => {
    log(1, 100, 'ok');
    log(1, 200, 'schema_fail');
    log(3, 5_000, 'ok');

    const metrics = collectLocalMetrics(deps());

    expect(metrics.available).toBe(true);
    expect(metrics.layers).toEqual([
      { layer: 1, calls: 2, meanLatencyMs: 150 },
      { layer: 3, calls: 1, meanLatencyMs: 5_000 },
    ]);
    expect(metrics.outcomes).toEqual([
      { layer: 1, outcome: 'ok', calls: 1 },
      { layer: 1, outcome: 'schema_fail', calls: 1 },
      { layer: 3, outcome: 'ok', calls: 1 },
    ]);
  });

  it('reports briefing latency and NFR-10 time-to-re-entry', () => {
    const briefing = briefings.create({
      windowStart: GENERATED_AT - 86_400_000,
      windowEnd: GENERATED_AT,
      generatedAt: GENERATED_AT,
      mode: 'llm',
      narrativePath: '/briefings/b1.md',
      deltaIds: [],
      threadsStillProcessing: 0,
    });
    briefings.recordTimings(briefing.briefingId, 900, 4_200);
    briefings.markCaughtUp(briefing.briefingId, GENERATED_AT + 90_000);

    const metrics = collectLocalMetrics(deps());

    expect(metrics.briefingLatency).toEqual({ count: 1, p50Ms: 4_200, p95Ms: 4_200 });
    expect(metrics.reEntry).toEqual({ count: 1, p50Ms: 90_000, p95Ms: 90_000 });
  });

  it('surfaces gate drops by reason, sorted by count (Gap A)', () => {
    // The T-1 line: `injection_pattern` here means the detector fired on real
    // generated output. This is the number the panel exists to show.
    writeBriefingTrace({ outcome: 'all_claims_dropped', gateDrops: { injection_pattern: 3 } });
    writeBriefingTrace({ outcome: 'ok', gateDrops: { no_citation: 1, injection_pattern: 1 } });

    const metrics = collectLocalMetrics(deps());

    expect(metrics.gateDrops).toEqual([
      { key: 'injection_pattern', count: 4 },
      { key: 'no_citation', count: 1 },
    ]);
    expect(metrics.tracesRead).toBe(2);
  });

  it('surfaces SEC-5 redaction counts and kinds (Gap B)', () => {
    writeBriefingTrace({
      outcome: 'ok',
      redactedClaims: 2,
      redactionCount: 3,
      redactionKinds: ['email', 'aws_access_key'],
    });

    const metrics = collectLocalMetrics(deps());

    expect(metrics.redactedClaims).toBe(2);
    expect(metrics.redactionCount).toBe(3);
    expect(metrics.redactionKinds).toEqual(['aws_access_key', 'email']);
  });

  it('surfaces Layer-2 trigger decisions by condition and outcome', () => {
    for (const [reason, outcome] of [
      ['quiet', 'ok'],
      ['quiet', 'not_meaningful'],
      ['hard_cap', 'ok'],
    ] as const) {
      const trace = startTrace(new FakeClock(T0), logsDir);
      trace.span('synthesis').end();
      trace.annotate({ event: 'layer2_trigger', threadKey: 'C1:1', reason, outcome });
      trace.finish();
    }

    const metrics = collectLocalMetrics(deps());

    expect(metrics.triggers.total).toBe(3);
    expect(metrics.triggers.byReason).toEqual([
      { key: 'quiet', count: 2 },
      { key: 'hard_cap', count: 1 },
    ]);
    expect(metrics.triggers.byOutcome).toEqual([
      { key: 'ok', count: 2 },
      { key: 'not_meaningful', count: 1 },
    ]);
  });

  it('reports an available-but-empty view on a fresh install', () => {
    // Distinguishable from a failed read: `available` is true and everything is
    // legitimately zero, which is what a machine that has run nothing looks like.
    const metrics = collectLocalMetrics({ aiCalls, briefings, logsDir: join(logsDir, 'missing') });

    expect(metrics.available).toBe(true);
    expect(metrics.reason).toBeUndefined();
    expect(metrics.layers).toEqual([]);
    expect(metrics.gateDrops).toEqual([]);
    expect(metrics.tracesRead).toBe(0);
  });

  it('never throws: a failing reader degrades to available: false with a reason', () => {
    const broken = {
      aiCalls: {
        layerStats: () => {
          throw new Error('database is locked');
        },
        outcomeStats: () => [],
      },
      briefings,
      logsDir,
    };

    const metrics = collectLocalMetrics(broken);

    // A metrics panel must never be the thing that breaks the settings page.
    expect(metrics.available).toBe(false);
    expect(metrics.reason).toContain('database is locked');
    expect(metrics.layers).toEqual([]);
  });
});

describe('registerMetricsHandlers', () => {
  it('registers exactly one handler, on debug:metrics', () => {
    registerMetricsHandlers(deps());

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]?.[0]).toBe(DEBUG_METRICS_CHANNEL);
    expect(DEBUG_METRICS_CHANNEL).toBe('debug:metrics');
  });

  it('serves the view synchronously and ignores any renderer-supplied argument', () => {
    log(2, 42, 'not_meaningful');
    registerMetricsHandlers(deps());

    const callback = handle.mock.calls[0]?.[1] as (event: unknown, arg: unknown) => unknown;
    // Argument-free by design: there is nothing here for a compromised renderer
    // to steer, so a hostile payload changes nothing about the answer.
    const withJunk = callback({}, { briefingIds: ['../../etc/passwd'] });
    const withNothing = callback({}, undefined);

    expect(withJunk).toEqual(withNothing);
    expect((withJunk as { layers: unknown[] }).layers).toEqual([
      { layer: 2, calls: 1, meanLatencyMs: 42 },
    ]);
  });
});
