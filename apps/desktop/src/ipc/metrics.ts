/**
 * `debug:metrics` — the local metrics view (Task 4.4, step 4).
 *
 * One read-only channel behind one settings-page panel. It answers five
 * questions an operator (which here means the developer, or a user filing a bug)
 * cannot otherwise answer without a SQL client and a text editor:
 *
 *   1. per-layer call count and mean latency          → `ai_calls`
 *   2. briefing latency P50/P95                       → `briefings.total_ms`
 *   3. time-to-re-entry (NFR-10)                      → `briefings.caught_up_at`
 *   4. citation-gate drop counts BY REASON            → `trace-*.jsonl`
 *   5. SEC-5 redaction counts and kinds               → `trace-*.jsonl`
 *
 * ### Why a new channel rather than extending `briefing:metrics`
 *
 * `briefing:metrics` (`ipc/feedback.ts`) takes a list of briefing ids and
 * returns one row per briefing: it is the FR-11 completion surface, argument-
 * driven and per-row. This is an argument-free, whole-install aggregate that
 * reads two tables and a log directory. Folding the second into the first would
 * mean one channel with two unrelated request shapes and two unrelated
 * authorities, and would drag a trace-log reader into the module whose header
 * documents that it deliberately contains no such thing (AC-9).
 *
 * ### Why the gate drops come from the trace log, not from `ai_calls`
 *
 * `ai_calls` has ten fixed columns and no room for a per-reason map; adding one
 * is an additive migration for a debugging panel. The trace log already carries
 * the breakdown under the same `trace_id` the rows are keyed by — see
 * `@cr/observability`'s `traceLog.ts`. The one genuinely scalar consequence DID
 * go into `ai_calls`: the outcome `all_claims_dropped`, which appears in
 * `outcomes` below.
 *
 * ### It is a debugging surface, and it is shaped like one
 *
 * No formatting, no thresholds, no colour, no opinion about which numbers are
 * bad. Every field is a raw count or a raw millisecond value, and the renderer
 * prints them in a table. Nothing throws out of the handler — a metrics panel
 * that can crash the settings page is worse than no panel.
 */
import { ipcMain } from 'electron';
import { readTraceEvents, readTraceMetrics, type TraceEvent } from '@cr/observability';
import type { ActivityEvent, LocalMetrics } from '../preload.cjs';

/** Invoke channel serving the whole local metrics view. */
export const DEBUG_METRICS_CHANNEL = 'debug:metrics';

/** How many trace day-files one call reads. Matches the panel's stated window. */
export const METRICS_TRACE_DAYS = 7;

/** The window the "recent activity" feed covers. Matches {@link METRICS_TRACE_DAYS}. */
export const ACTIVITY_WINDOW_MS = METRICS_TRACE_DAYS * 24 * 60 * 60 * 1_000;

/** Cap on events returned in `recentActivity`. A feed, not a log. */
const ACTIVITY_LIMIT = 25;

/** `ai_calls.outcome` values the feed renders as a failed processing step. */
const FAILURE_OUTCOMES = new Set(['error', 'stream_error', 'budget_exceeded', 'schema_fail']);

/** The `AiCallsRepo` slice this module reads. Read-only, by construction. */
export interface AiCallStatsReader {
  layerStats(): { layer: number; calls: number; meanLatencyMs: number }[];
  outcomeStats(): { layer: number; outcome: string; calls: number }[];
  listRecentNotable(
    sinceMs: number,
    limit: number,
  ): { layer: number; outcome: string; createdAt: number }[];
}

/** The `BriefingsRepo` slice this module reads. */
export interface BriefingStatsReader {
  latencyStats(): { count: number; p50Ms: number | null; p95Ms: number | null };
  reEntryStats(): { count: number; p50Ms: number | null; p95Ms: number | null };
  recentTemplateFallbacks(sinceMs: number, limit: number): { briefingId: string; generatedAt: number }[];
  lastDeliveredAt(): number | null;
}

/** The `ExtractionFailuresRepo` slice this module reads. */
export interface ExtractionFailureReader {
  listRecent(sinceMs: number, limit: number): { eventId: string; attempts: number; lastAt: number }[];
}

export interface MetricsHandlerDeps {
  aiCalls: AiCallStatsReader;
  briefings: BriefingStatsReader;
  extractionFailures: ExtractionFailureReader;
  /** Directory holding `trace-YYYY-MM-DD.jsonl`; `<userData>/logs` in production. */
  logsDir: string;
  /** Wall-clock now, for the activity window's lower bound. Injectable for tests. */
  nowMs?: number;
}

/** An empty view, used when a read fails. `available: false` says so honestly. */
const unavailable = (reason: string): LocalMetrics => ({
  available: false,
  reason,
  layers: [],
  outcomes: [],
  briefingLatency: { count: 0, p50Ms: null, p95Ms: null },
  reEntry: { count: 0, p50Ms: null, p95Ms: null },
  gateDrops: [],
  redactedClaims: 0,
  redactionCount: 0,
  redactionKinds: [],
  triggers: { total: 0, byReason: [], byOutcome: [] },
  tracesRead: 0,
  unparseableTraceLines: 0,
  recentActivity: [],
  lastBriefingAt: null,
});

/** `TraceEvent.kind` → the wire `ActivityEvent.kind` and its severity. */
const TRACE_KIND: Record<TraceEvent['kind'], { kind: ActivityEvent['kind']; severity: ActivityEvent['severity'] }> = {
  gate_injection: { kind: 'gate_injection', severity: 'attention' },
  gate_drops: { kind: 'gate_drops', severity: 'info' },
  thread_parked: { kind: 'thread_parked', severity: 'attention' },
  noise_skipped: { kind: 'noise_skipped', severity: 'info' },
};

/**
 * Assemble the "recent activity" feed from the three places a user-relevant
 * failure or discard is recorded: the trace log (citation-gate drops, parked
 * threads, noise sweeps), `ai_calls` (a model call that failed), and the two
 * store tables that outlive a single run (`extraction_failures`, template-mode
 * `briefings`).
 *
 * Never throws — a thrown reader is caught by {@link collectLocalMetrics} and
 * turns the whole view `available: false`, which is the honest outcome.
 */
function buildRecentActivity(deps: MetricsHandlerDeps, sinceMs: number): ActivityEvent[] {
  const out: ActivityEvent[] = [];

  // Trace-derived: gate drops, parked threads. Noise sweeps are folded into one
  // row so a chatty pre-filter cannot flood the feed.
  let noiseCount = 0;
  let noiseAtMs = 0;
  for (const ev of readTraceEvents(deps.logsDir, { sinceMs, days: METRICS_TRACE_DAYS, limit: 500 })) {
    if (ev.kind === 'noise_skipped') {
      noiseCount += ev.count;
      noiseAtMs = Math.max(noiseAtMs, ev.atMs);
      continue;
    }
    const map = TRACE_KIND[ev.kind];
    out.push({ atMs: ev.atMs, kind: map.kind, severity: map.severity, count: ev.count });
  }
  if (noiseCount > 0) {
    out.push({ atMs: noiseAtMs, kind: 'noise_skipped', severity: 'info', count: noiseCount });
  }

  // A model call that actually failed (not a benign non-write like `not_meaningful`).
  for (const call of deps.aiCalls.listRecentNotable(sinceMs, ACTIVITY_LIMIT)) {
    if (!FAILURE_OUTCOMES.has(call.outcome)) continue;
    out.push({ atMs: call.createdAt, kind: 'model_error', severity: 'info', count: 1 });
  }

  // Events Layer 1 gave up on — persisted, so aggregate to one row.
  const writeoffs = deps.extractionFailures.listRecent(sinceMs, 200);
  if (writeoffs.length > 0) {
    out.push({
      atMs: Math.max(...writeoffs.map((w) => w.lastAt)),
      kind: 'extraction_writeoff',
      severity: 'info',
      count: writeoffs.length,
    });
  }

  // Briefings that fell back to the template renderer.
  for (const b of deps.briefings.recentTemplateFallbacks(sinceMs, ACTIVITY_LIMIT)) {
    out.push({ atMs: b.generatedAt, kind: 'template_fallback', severity: 'info', count: 1 });
  }

  return out.sort((a, b) => b.atMs - a.atMs).slice(0, ACTIVITY_LIMIT);
}

/** `Record<string, number>` → a sorted array, because the bridge clones plainly. */
const asRows = (counts: Record<string, number>): { key: string; count: number }[] =>
  Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

/**
 * Collect the whole view. Pure apart from the reads; never throws.
 *
 * Exported separately from the registration so tests can drive it without
 * Electron — the same split every other handler in this directory uses.
 */
export function collectLocalMetrics(deps: MetricsHandlerDeps): LocalMetrics {
  try {
    const trace = readTraceMetrics(deps.logsDir, { days: METRICS_TRACE_DAYS });
    const sinceMs = (deps.nowMs ?? Date.now()) - ACTIVITY_WINDOW_MS;

    return {
      available: true,
      layers: deps.aiCalls.layerStats(),
      outcomes: deps.aiCalls.outcomeStats(),
      briefingLatency: deps.briefings.latencyStats(),
      reEntry: deps.briefings.reEntryStats(),
      gateDrops: asRows(trace.gateDropsByReason),
      redactedClaims: trace.redactedClaims,
      redactionCount: trace.redactionCount,
      redactionKinds: trace.redactionKinds,
      triggers: {
        total: trace.layer2Triggers,
        byReason: asRows(trace.triggersByReason),
        byOutcome: asRows(trace.triggersByOutcome),
      },
      tracesRead: trace.tracesRead,
      unparseableTraceLines: trace.unparseableLines,
      recentActivity: buildRecentActivity(deps, sinceMs),
      lastBriefingAt: deps.briefings.lastDeliveredAt(),
    };
  } catch (error) {
    // A metrics panel must never be the thing that breaks settings.
    console.error('[metrics] collect failed', error);
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Register `debug:metrics`.
 *
 * Not `async`: every value is produced in the same turn the invoke arrives.
 */
export function registerMetricsHandlers(deps: MetricsHandlerDeps): void {
  ipcMain.handle(DEBUG_METRICS_CHANNEL, (): LocalMetrics => collectLocalMetrics(deps));
}
