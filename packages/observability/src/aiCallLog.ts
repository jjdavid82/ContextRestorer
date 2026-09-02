import { systemClock, type Clock } from '@cr/core';

/**
 * One completed (or failed) model invocation, in the shape the `ai_calls` table
 * expects. Declared here rather than imported from `@cr/store` so that this
 * package stays free of any persistence dependency — see `AiCallsRepoLike`.
 */
export interface AiCallRecord {
  traceId: string;
  /** 1 = extraction, 2 = synthesis, 3 = briefing generation. */
  layer: number;
  model: string;
  promptVersion: string;
  latencyMs: number;
  /** Absent when the provider did not report usage (e.g. a timeout). */
  tokensIn?: number;
  tokensOut?: number;
  /** e.g. 'ok', 'error', 'timeout', 'parse_error', 'fallback'. */
  outcome: string;
}

/** Identifying metadata known *before* the call is made. */
export interface AiCallMeta {
  traceId: string;
  layer: number;
  model: string;
  promptVersion: string;
}

/** Called once per invocation, on both the success and the failure path. */
export type AiCallSink = (record: AiCallRecord) => void;

/**
 * Times `fn`, then hands a record to `onComplete`.
 *
 * NFR-8 wants every model call audited, *including the ones that fail* — a
 * template-mode briefing is only explainable if the timeout that caused it was
 * recorded. So the rejection path logs first and rethrows the original error
 * unchanged; callers see exactly the failure they would have seen without
 * instrumentation.
 *
 * `onComplete` is intentionally a plain callback rather than a repo: persistence
 * is the caller's concern, which keeps `@cr/observability` off the storage layer.
 */
export async function timedAiCall<T>(
  meta: AiCallMeta,
  fn: () => Promise<T>,
  onComplete: AiCallSink,
  clock: Clock = systemClock,
): Promise<T> {
  const startMs = clock.now();

  try {
    const result = await fn();
    onComplete({ ...meta, latencyMs: clock.now() - startMs, outcome: 'ok' });
    return result;
  } catch (err) {
    onComplete({ ...meta, latencyMs: clock.now() - startMs, outcome: 'error' });
    throw err;
  }
}

/**
 * Minimal structural view of `@cr/store`'s `AiCallsRepo`. Structural, not
 * imported: `@cr/observability` never takes a dependency on the storage layer,
 * but a caller that has a repo can still wire it up in one line.
 */
export interface AiCallsRepoLike {
  log(input: AiCallRecord): unknown;
}

/** Adapts a repo to the `AiCallSink` shape: `timedAiCall(m, fn, makeAiCallsRepoLogger(repo))`. */
export function makeAiCallsRepoLogger(repo: AiCallsRepoLike): AiCallSink {
  return (record) => {
    repo.log(record);
  };
}
