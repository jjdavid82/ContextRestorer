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

/**
 * Explicit Layer-3 template-fallback outcomes, written by
 * `layer3/template.ts`'s `renderTemplate` via `OUTCOME_BY_REASON` when the
 * whole briefing was rendered deterministically because the model was
 * unavailable.
 *
 * NOT `template`. Under P0 the deterministic briefing IS the product — every
 * delivered briefing is `mode = 'template'`, generated in single-digit
 * milliseconds with no model on the path at all — so reporting that as an
 * incident produced one identical "the model didn't respond in time" row per
 * briefing, describing a timeout that never happened on a call that was never
 * made. These three are the outcomes that mean something went wrong.
 */
const FALLBACK_OUTCOMES = new Set([
  'fallback_template_preflight',
  'fallback_template_error',
  'fallback_template_stream_error',
]);

/**
 * Layer-3 model failures where the deterministic renderer took over
 * mid-briefing. `generateWithFallback` reaches this via `appendTemplateRemainder`,
 * which writes no `ai_calls` row of its own — the generator's row keeps its
 * `error` / `stream_error` outcome. Same user-visible consequence as a
 * {@link FALLBACK_OUTCOMES} row (the briefing fell back), so the feed treats it
 * the same way. Gated on `layer === 3`: an `error` / `stream_error` at Layer 1
 * or 2 is a single failed extraction/synthesis, not a fallen-back briefing.
 */
const LAYER3_FALLBACK_OUTCOMES = new Set(['error', 'stream_error']);

/**
 * The exact `ai_calls.outcome` values the feed can render — passed to
 * `listRecentNotable` so a high-volume benign non-`ok` outcome
 * (`not_meaningful`, `no_context`) cannot fill the row budget and hide a rare
 * genuine failure.
 */
const NOTABLE_OUTCOMES: readonly string[] = [...FAILURE_OUTCOMES, ...FALLBACK_OUTCOMES];

/** The `AiCallsRepo` slice this module reads. Read-only, by construction. */
export interface AiCallStatsReader {
  layerStats(): { layer: number; calls: number; meanLatencyMs: number }[];
  outcomeStats(): { layer: number; outcome: string; calls: number }[];
  listRecentNotable(
    sinceMs: number,
    limit: number,
    outcomes?: readonly string[],
  ): { layer: number; outcome: string; createdAt: number }[];
}

/** The `BriefingsRepo` slice this module reads. */
export interface BriefingStatsReader {
  latencyStats(): { count: number; p50Ms: number | null; p95Ms: number | null };
  reEntryStats(): { count: number; p50Ms: number | null; p95Ms: number | null };
  lastDeliveredAt(): number | null;
}

/** The `ExtractionFailuresRepo` slice this module reads. */
export interface ExtractionFailureReader {
  listRecent(sinceMs: number, limit: number): { eventId: string; attempts: number; lastAt: number }[];
}

/** The one `FeedbackRepo` method the Diagnostics panel needs. */
export interface FeedbackCountReader {
  countByVerdict(sinceMs?: number): Record<string, number>;
}

export interface MetricsHandlerDeps {
  aiCalls: AiCallStatsReader;
  briefings: BriefingStatsReader;
  extractionFailures: ExtractionFailureReader;
  /**
   * Verdict counts, so the panel can show that pressing Relevant / Not
   * relevant / Wrong produced something.
   *
   * Optional: absent, the panel reports zeroes for it rather than failing the
   * whole view — the other numbers are still worth showing.
   */
  feedback?: FeedbackCountReader;
  /** Directory holding `trace-YYYY-MM-DD.jsonl`; `<userData>/logs` in production. */
  logsDir: string;
  /** Wall-clock now, for the activity window's lower bound. Injectable for tests. */
  nowMs?: number;
}

/** Verdict counts, degraded to empty rather than failing the whole panel. */
function readFeedbackCounts(reader: FeedbackCountReader | undefined): Record<string, number> {
  if (reader === undefined) return {};
  try {
    return reader.countByVerdict();
  } catch (error) {
    console.error('[metrics] feedback counts failed', error);
    return {};
  }
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
  feedbackCounts: {},
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
 * threads, noise sweeps), `ai_calls` (a model call that failed, or a briefing
 * the model was unavailable for), and `extraction_failures`.
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

  // A model call that actually failed (not a benign non-write like
  // `not_meaningful`), and separately the case where the model was missing
  // entirely and the deterministic renderer covered for it.
  for (const call of deps.aiCalls.listRecentNotable(sinceMs, ACTIVITY_LIMIT, NOTABLE_OUTCOMES)) {
    const fellBack =
      FALLBACK_OUTCOMES.has(call.outcome) ||
      (call.layer === 3 && LAYER3_FALLBACK_OUTCOMES.has(call.outcome));
    if (fellBack) {
      out.push({ atMs: call.createdAt, kind: 'briefing_fallback', severity: 'attention', count: 1 });
      continue;
    }
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
      // All-time, not windowed like `recentActivity`: the question this answers
      // is "have my verdicts been recorded at all", and a 7-day window would
      // show zero to somebody who judged a briefing last month and is checking
      // precisely because they suspect nothing was saved.
      feedbackCounts: readFeedbackCounts(deps.feedback),
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
