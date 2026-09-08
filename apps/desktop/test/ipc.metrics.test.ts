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
import { AiCallsRepo, BriefingsRepo, ExtractionFailuresRepo, migrate, openDb } from '@cr/store';

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
let extractionFailures: ExtractionFailuresRepo;
let logsDir: string;

/** Fixed "now" for the activity window; comfortably after every fixture time. */
const NOW = Date.UTC(2025, 2, 5, 0, 0, 0);

beforeEach(() => {
  handle.mockClear();
  db = openDb(':memory:');
  migrate(db);
  aiCalls = new AiCallsRepo(db);
  briefings = new BriefingsRepo(db);
  extractionFailures = new ExtractionFailuresRepo(db);
  logsDir = mkdtempSync(join(tmpdir(), 'cr-ipc-metrics-'));
});

afterEach(() => {
  db.close();
  rmSync(logsDir, { recursive: true, force: true });
});

const deps = () => ({ aiCalls, briefings, extractionFailures, logsDir, nowMs: NOW });

/** Insert an `ai_calls` row with an explicit `created_at`. */
const logAt = (createdAt: number, layer: 1 | 2 | 3, outcome: string): void => {
  db.prepare(
    `INSERT INTO ai_calls
       (call_id, trace_id, layer, model, prompt_version, latency_ms,
        tokens_in, tokens_out, outcome, created_at)
     VALUES (?, ?, ?, 'm', 'v1', 1, NULL, NULL, ?, ?)`,
  ).run(`c-${createdAt}-${outcome}`, `t-${createdAt}`, layer, outcome, createdAt);
};

/** Seed an event so `extraction_failures` can reference it, then record a failure. */
const recordWriteoff = (eventId: string, at: number): void => {
  db.prepare(
    `INSERT INTO events (event_id, source, source_event_id, thread_key, occurred_at, ingested_at, payload_json)
     VALUES (?, 'slack', ?, 'C1:1', 1000, 1000, '{}')`,
  ).run(eventId, eventId);
  extractionFailures.record(eventId, at);
};

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
    expect(metrics.lastBriefingAt).toBe(GENERATED_AT);
  });

  it('reports lastBriefingAt as null until a briefing exists', () => {
    expect(collectLocalMetrics(deps()).lastBriefingAt).toBeNull();
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
    const metrics = collectLocalMetrics({
      aiCalls,
      briefings,
      extractionFailures,
      logsDir: join(logsDir, 'missing'),
      nowMs: NOW,
    });

    expect(metrics.available).toBe(true);
    expect(metrics.reason).toBeUndefined();
    expect(metrics.layers).toEqual([]);
    expect(metrics.gateDrops).toEqual([]);
    expect(metrics.tracesRead).toBe(0);
    expect(metrics.recentActivity).toEqual([]);
  });

  it('never throws: a failing reader degrades to available: false with a reason', () => {
    const broken = {
      aiCalls: {
        layerStats: () => {
          throw new Error('database is locked');
        },
        outcomeStats: () => [],
        listRecentNotable: () => [],
      },
      briefings,
      extractionFailures,
      logsDir,
    };

    const metrics = collectLocalMetrics(broken);

    // A metrics panel must never be the thing that breaks the settings page.
    expect(metrics.available).toBe(false);
    expect(metrics.reason).toContain('database is locked');
    expect(metrics.layers).toEqual([]);
    expect(metrics.recentActivity).toEqual([]);
  });
});

describe('collectLocalMetrics — recent activity feed', () => {
  it('is empty on a healthy install', () => {
    log(1, 100, 'ok');
    expect(collectLocalMetrics(deps()).recentActivity).toEqual([]);
  });

  it('surfaces failed model calls, template fallbacks, write-offs and gate drops, newest first', () => {
    // A failed Layer 1 call and a benign non-write (the latter must NOT appear).
    logAt(NOW - 60_000, 1, 'schema_fail');
    logAt(NOW - 50_000, 2, 'not_meaningful');

    // Two events Layer 1 gave up on → one aggregated row.
    recordWriteoff('e1', NOW - 40_000);
    recordWriteoff('e2', NOW - 30_000);

    // A template-mode briefing.
    const b = briefings.create({
      windowStart: NOW - 86_400_000,
      windowEnd: NOW,
      generatedAt: NOW - 20_000,
      mode: 'llm',
      narrativePath: '/b.md',
      deltaIds: [],
      threadsStillProcessing: 0,
    });
    briefings.markTemplateMode(b.briefingId);

    // A citation-gate injection drop, via a real trace line.
    writeBriefingTrace({ outcome: 'ok', gateDrops: { injection_pattern: 1 } });

    const feed = collectLocalMetrics(deps()).recentActivity;

    expect(feed.map((e) => ({ kind: e.kind, severity: e.severity, count: e.count }))).toEqual([
      { kind: 'template_fallback', severity: 'info', count: 1 },
      { kind: 'extraction_writeoff', severity: 'info', count: 2 },
      { kind: 'model_error', severity: 'info', count: 1 },
      { kind: 'gate_injection', severity: 'attention', count: 1 },
    ]);
    // Descending by time.
    expect(feed.map((e) => e.atMs)).toEqual([...feed.map((e) => e.atMs)].sort((a, b) => b - a));
  });

  it('excludes events older than the 7-day window', () => {
    logAt(NOW - 8 * 24 * 60 * 60 * 1_000, 1, 'error');
    expect(collectLocalMetrics(deps()).recentActivity).toEqual([]);
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
