import type { Database } from 'better-sqlite3';
import { newId, type AiCall } from '@cr/core';

/** Raw `ai_calls` row shape as returned by better-sqlite3. */
interface AiCallRow {
  call_id: string;
  trace_id: string;
  layer: number;
  model: string;
  prompt_version: string;
  latency_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  outcome: string;
  created_at: number;
}

/** 1 = extraction, 2 = synthesis, 3 = briefing generation. */
export type AiLayer = 1 | 2 | 3;

export interface LogAiCallInput {
  traceId: string;
  layer: AiLayer;
  model: string;
  promptVersion: string;
  latencyMs: number;
  /** Absent when the provider did not report usage (e.g. a timeout). */
  tokensIn?: number;
  tokensOut?: number;
  /** e.g. 'ok', 'timeout', 'parse_error', 'fallback'. */
  outcome: string;
}

/** One layer's call volume and mean latency, for the local metrics view. */
export interface AiLayerStat {
  layer: number;
  calls: number;
  /** Mean `latency_ms`, rounded. 0 only when every call reported 0. */
  meanLatencyMs: number;
}

/** Call count for one `(layer, outcome)` pair. */
export interface AiOutcomeStat {
  layer: number;
  outcome: string;
  calls: number;
}

function toAiCall(row: AiCallRow): AiCall {
  return {
    callId: row.call_id,
    traceId: row.trace_id,
    layer: row.layer,
    model: row.model,
    promptVersion: row.prompt_version,
    latencyMs: row.latency_ms,
    // Columns are nullable (usage is not always reported) but the domain type
    // is not; unreported usage reads back as 0 rather than leaking null.
    tokensIn: row.tokens_in ?? 0,
    tokensOut: row.tokens_out ?? 0,
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}

/**
 * Append-only audit trail of every model invocation (NFR-8).
 *
 * Grouping is by `traceId`, not by call: one briefing fans out into many
 * Layer-1/2/3 calls, and the question worth answering after a bad briefing is
 * "what did the whole pipeline do for this run", not "what did call #47 do".
 * Failures are logged too — an `outcome` of 'timeout' or 'fallback' is the
 * evidence that explains a template-mode briefing.
 */
export class AiCallsRepo {
  constructor(private db: Database) {}

  /** Record one completed (or failed) model call. */
  log(input: LogAiCallInput): AiCall {
    const callId = newId();
    const tokensIn = input.tokensIn ?? null;
    const tokensOut = input.tokensOut ?? null;
    const createdAt = Date.now();

    this.db
      .prepare(
        `INSERT INTO ai_calls
           (call_id, trace_id, layer, model, prompt_version, latency_ms,
            tokens_in, tokens_out, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        callId,
        input.traceId,
        input.layer,
        input.model,
        input.promptVersion,
        input.latencyMs,
        tokensIn,
        tokensOut,
        input.outcome,
        createdAt,
      );

    return {
      callId,
      traceId: input.traceId,
      layer: input.layer,
      model: input.model,
      promptVersion: input.promptVersion,
      latencyMs: input.latencyMs,
      tokensIn: tokensIn ?? 0,
      tokensOut: tokensOut ?? 0,
      outcome: input.outcome,
      createdAt,
    };
  }

  /**
   * Per-layer call count and mean latency (Task 4.4, step 4).
   *
   * The aggregation is SQL's rather than the caller's so the whole table is
   * never materialised in JS: this is the query behind a settings-page panel on
   * a database that grows with every model call the app has ever made.
   *
   * `meanLatencyMs` is rounded to a whole millisecond — sub-millisecond
   * precision on an average of network calls is noise dressed as detail. Layers
   * with no calls are ABSENT rather than reported as zero rows, so "layer 3 has
   * never run" and "layer 3 runs instantly" cannot be confused.
   */
  layerStats(): AiLayerStat[] {
    const rows = this.db
      .prepare(
        `SELECT layer,
                COUNT(*)         AS calls,
                AVG(latency_ms)  AS mean_latency_ms
           FROM ai_calls
          GROUP BY layer
          ORDER BY layer ASC`,
      )
      .all() as { layer: number; calls: number; mean_latency_ms: number | null }[];

    return rows.map((row) => ({
      layer: row.layer,
      calls: row.calls,
      meanLatencyMs: Math.round(row.mean_latency_ms ?? 0),
    }));
  }

  /**
   * Call counts per `(layer, outcome)` (Task 4.4, step 4).
   *
   * Kept separate from {@link layerStats} and deliberately NOT collapsed into an
   * "errors" number: this table's outcome vocabulary is layer-specific
   * (`schema_fail`, `not_meaningful`, `all_claims_dropped`, …) and deciding
   * which of those count as failures is a judgement that belongs in whatever is
   * reading them, not baked into a repo method. `not_meaningful`, for instance,
   * is the single most common Layer-2 outcome and is a success.
   */
  outcomeStats(): AiOutcomeStat[] {
    const rows = this.db
      .prepare(
        `SELECT layer, outcome, COUNT(*) AS calls
           FROM ai_calls
          GROUP BY layer, outcome
          ORDER BY layer ASC, calls DESC, outcome ASC`,
      )
      .all() as { layer: number; outcome: string; calls: number }[];

    return rows.map((row) => ({ layer: row.layer, outcome: row.outcome, calls: row.calls }));
  }

  /** Every call recorded under one trace, oldest first. */
  listByTrace(traceId: string): AiCall[] {
    const rows = this.db
      .prepare(
        `SELECT call_id, trace_id, layer, model, prompt_version, latency_ms,
                tokens_in, tokens_out, outcome, created_at
           FROM ai_calls
          WHERE trace_id = ?
          ORDER BY created_at ASC`,
      )
      .all(traceId) as AiCallRow[];

    return rows.map(toAiCall);
  }
}
