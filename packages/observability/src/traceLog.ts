/**
 * Reading the trace log back (Task 4.4, step 4).
 *
 * `trace.ts` writes; this file reads. It exists because the two facts Task 4.4
 * had nowhere to put — citation-gate DROPS by reason (Gap A) and SEC-5 REDACTION
 * counts (Gap B) — deliberately live in the trace annotations rather than in
 * `ai_calls`' fixed ten columns, and a fact with no reader is not observability,
 * it is a comment.
 *
 * ### Why not put them in `ai_calls` instead
 *
 * Neither fact is a scalar. "3 drops: 1 no_citation, 2 injection_pattern" is a
 * map, and `ai_calls` has no column for it; adding one means an additive
 * migration plus a JSON column that SQL cannot usefully aggregate anyway. The
 * trace file is append-only JSONL that already carries the `trace_id` those rows
 * are keyed by, so the join exists without a schema change. What DID go into
 * `ai_calls` is the one genuinely scalar consequence: the outcome
 * `'all_claims_dropped'`, which is the queryable flag saying "read this trace".
 *
 * ### Reading policy
 *
 * Deliberately forgiving. This is a debugging surface for a local app, reading
 * files that may be mid-write (the log is append-only and unlocked), truncated
 * by a crash, or absent entirely because nothing has run yet. Every one of those
 * is a normal state, so a malformed line is COUNTED and skipped rather than
 * thrown — but it is counted, because "the log is unreadable" is itself a fact
 * the panel should be able to show instead of silently reporting zeros.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** `Record<string, number>` accumulated from a trace annotation. */
export type CountsByKey = Record<string, number>;

/** Aggregate of every trace line read. Counts only; never any content. */
export interface TraceLogMetrics {
  /** Trace lines that parsed. */
  tracesRead: number;
  /** Lines that did not parse, or parsed to something other than an object. */
  unparseableLines: number;
  /** Files consulted, newest first. */
  filesRead: string[];
  /** Layer-3 briefing traces seen. */
  briefingCount: number;
  /**
   * Gap A: total claims withheld by the citation gate, per `DropReason`.
   * `injection_pattern` here is the T-1 detector actually having fired.
   */
  gateDropsByReason: CountsByKey;
  /** Accepted claims that had at least one value redacted (SEC-5, Gap B). */
  redactedClaims: number;
  /** Total values redacted across accepted claims. */
  redactionCount: number;
  /** Detector kinds that fired at least once, e.g. `email`, `aws_access_key`. */
  redactionKinds: string[];
  /** Layer-2 trigger traces seen. */
  layer2Triggers: number;
  /** Triggers by fired condition: `quiet` / `hard_cap`. */
  triggersByReason: CountsByKey;
  /** Triggers by what the synthesis did: `ok` / `not_meaningful` / `error` / … */
  triggersByOutcome: CountsByKey;
  /** Briefing traces by `ai_calls.outcome`, including `all_claims_dropped`. */
  briefingsByOutcome: CountsByKey;
}

/** Options for {@link readTraceMetrics}. */
export interface ReadTraceMetricsOptions {
  /**
   * How many day-files to read, newest first. Default 7.
   *
   * A cap rather than "all of them": the log is append-only and never rotated
   * by this code, so an install that has been running for a year would otherwise
   * make the settings panel read the whole year to render one table.
   */
  days?: number;
  /** Cap on lines read per file. Default 20 000. Same reasoning as `days`. */
  maxLinesPerFile?: number;
}

const DEFAULT_DAYS = 7;
const DEFAULT_MAX_LINES = 20_000;

const emptyMetrics = (): TraceLogMetrics => ({
  tracesRead: 0,
  unparseableLines: 0,
  filesRead: [],
  briefingCount: 0,
  gateDropsByReason: {},
  redactedClaims: 0,
  redactionCount: 0,
  redactionKinds: [],
  layer2Triggers: 0,
  triggersByReason: {},
  triggersByOutcome: {},
  briefingsByOutcome: {},
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Add `by` to `key`, creating the key if this is its first occurrence.
 *
 * A non-positive `by` creates nothing. That is the whole point: these maps
 * follow the same rule as `StageTimings` — a key that is present means the thing
 * actually happened — so a hand-edited (or zero-valued) count must not conjure a
 * `no_citation: 0` row into a panel that reads every present key as an event.
 */
function bump(into: CountsByKey, key: unknown, by = 1): void {
  if (typeof key !== 'string' || key === '' || by <= 0) return;
  into[key] = (into[key] ?? 0) + by;
}

/** A finite, non-negative number, or 0. Guards against a hand-edited log. */
function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Trace files in `logsDir`, newest first.
 *
 * Sorted by NAME, which for `trace-YYYY-MM-DD.jsonl` is the same as sorting by
 * date and does not cost a `stat` per file. Returns `[]` when the directory does
 * not exist — an install that has generated nothing yet is not an error.
 */
export function listTraceFiles(logsDir: string): string[] {
  try {
    return readdirSync(resolve(logsDir))
      .filter((name) => name.startsWith('trace-') && name.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Aggregate the trace log.
 *
 * Never throws: a missing directory, an unreadable file and a truncated line all
 * degrade to (respectively) an empty result, a skipped file and a counted
 * `unparseableLines`.
 */
export function readTraceMetrics(
  logsDir: string,
  options: ReadTraceMetricsOptions = {},
): TraceLogMetrics {
  const metrics = emptyMetrics();
  const kinds = new Set<string>();
  const maxLines = options.maxLinesPerFile ?? DEFAULT_MAX_LINES;

  for (const file of listTraceFiles(logsDir).slice(0, options.days ?? DEFAULT_DAYS)) {
    let text: string;
    try {
      text = readFileSync(join(resolve(logsDir), file), 'utf8');
    } catch {
      continue; // deleted or locked between the listing and the read
    }
    metrics.filesRead.push(file);

    const lines = text.split('\n').filter((line) => line.length > 0);
    for (const line of lines.slice(0, maxLines)) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        metrics.unparseableLines += 1;
        continue;
      }
      if (!isPlainObject(entry)) {
        metrics.unparseableLines += 1;
        continue;
      }

      metrics.tracesRead += 1;
      const annotations = entry['annotations'];
      if (!isPlainObject(annotations)) continue;

      switch (annotations['event']) {
        case 'briefing': {
          metrics.briefingCount += 1;
          bump(metrics.briefingsByOutcome, annotations['outcome']);

          const drops = annotations['gateDrops'];
          if (isPlainObject(drops)) {
            for (const [reason, count] of Object.entries(drops)) {
              bump(metrics.gateDropsByReason, reason, asCount(count));
            }
          }

          metrics.redactedClaims += asCount(annotations['redactedClaims']);
          metrics.redactionCount += asCount(annotations['redactionCount']);
          const seen = annotations['redactionKinds'];
          if (Array.isArray(seen)) {
            for (const kind of seen) if (typeof kind === 'string' && kind !== '') kinds.add(kind);
          }
          break;
        }
        case 'layer2_trigger': {
          metrics.layer2Triggers += 1;
          bump(metrics.triggersByReason, annotations['reason']);
          bump(metrics.triggersByOutcome, annotations['outcome']);
          break;
        }
        default:
          break;
      }
    }
  }

  metrics.redactionKinds = [...kinds].sort();
  return metrics;
}
