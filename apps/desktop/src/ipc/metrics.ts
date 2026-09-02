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
import { readTraceMetrics } from '@cr/observability';
import type { LocalMetrics } from '../preload.cjs';

/** Invoke channel serving the whole local metrics view. */
export const DEBUG_METRICS_CHANNEL = 'debug:metrics';

/** How many trace day-files one call reads. Matches the panel's stated window. */
export const METRICS_TRACE_DAYS = 7;

/** The `AiCallsRepo` slice this module reads. Read-only, by construction. */
export interface AiCallStatsReader {
  layerStats(): { layer: number; calls: number; meanLatencyMs: number }[];
  outcomeStats(): { layer: number; outcome: string; calls: number }[];
}

/** The `BriefingsRepo` slice this module reads. */
export interface BriefingStatsReader {
  latencyStats(): { count: number; p50Ms: number | null; p95Ms: number | null };
  reEntryStats(): { count: number; p50Ms: number | null; p95Ms: number | null };
}

export interface MetricsHandlerDeps {
  aiCalls: AiCallStatsReader;
  briefings: BriefingStatsReader;
  /** Directory holding `trace-YYYY-MM-DD.jsonl`; `<userData>/logs` in production. */
  logsDir: string;
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
});

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
