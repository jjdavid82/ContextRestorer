import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { newId, systemClock, type Clock } from '@cr/core';
import { safeLog } from './safeLog.js';

/** One timed segment of a run. `endMs` stays null until `.end()` is called. */
export interface Span {
  name: string;
  startMs: number;
  endMs: number | null;
  parentId: string | null;
  id: string;
}

/** Handle returned by `Trace.span()` — the only way to close a span. */
export interface SpanHandle {
  end(): void;
}

/**
 * Per-stage elapsed times for the OI-1 45s sync budget.
 *
 * Every key is optional on purpose: a stage that never ran (or never finished)
 * is *absent*, not zero. A zero would be indistinguishable from "instant" and
 * would quietly corrupt any latency attribution built on top of this.
 */
export interface StageTimings {
  retrievalMs?: number;
  assemblyMs?: number;
  firstTokenMs?: number;
  generationMs?: number;
  citationMs?: number;
}

/**
 * Non-timing facts about a run: the decision that started it, the counts that
 * describe what it did, the reason it ended.
 *
 * Spans answer "how long did each stage take"; annotations answer "and what
 * actually happened". Task 4.4 needs the second question answered for two facts
 * that had nowhere else to live — citation-gate DROPS by reason, and SEC-5
 * redaction counts — because `ai_calls`' columns are fixed and adding one is a
 * migration. See {@link Trace.annotate}.
 */
export type Annotations = Record<string, unknown>;

export interface Trace {
  id: string;
  span(name: string): SpanHandle;
  /**
   * Attach non-timing facts to this trace. Shallow-merged, last write wins, so
   * a run can annotate its decision up front and its outcome at the end.
   *
   * Every value passes through {@link safeLog} on the way out (SEC-7): free-text
   * keys are dropped, email-shaped substrings are hashed, person ids are hashed.
   * That is what makes it safe to hand this method model-adjacent data such as a
   * dropped claim's reason breakdown.
   */
  annotate(fields: Annotations): void;
  /** The redacted annotation set, as it will be written. Never the raw input. */
  annotations(): Annotations;
  /** Appends exactly one JSON line to `<logsDir>/trace-YYYY-MM-DD.jsonl`. */
  finish(): void;
  stageTimings(): StageTimings;
}

/** Optional wiring for {@link startTrace}. */
export interface StartTraceOptions {
  /**
   * Adopt a caller-supplied correlation id instead of minting one (NFR-8).
   *
   * One briefing fans out across three layers, each of which writes its own
   * `ai_calls` rows; the only thing that can later stitch those rows back into
   * "what the pipeline did for this run" is a shared `trace_id`. A layer that
   * always mints its own id makes that join impossible, so the id has to be
   * threadable from outside. A blank string is treated as absent rather than
   * used, because an empty `trace_id` would silently group every such run
   * together.
   */
  id?: string;
}

/** Span name -> `StageTimings` key. Exact matches only; unknown names ignored. */
const STAGE_KEYS = {
  retrieval: 'retrievalMs',
  assembly: 'assemblyMs',
  firstToken: 'firstTokenMs',
  generation: 'generationMs',
  citation: 'citationMs',
} as const satisfies Record<string, keyof StageTimings>;

/** UTC calendar date, `YYYY-MM-DD` — log files roll on UTC midnight, not local. */
const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Starts a trace. Time comes from the injected `Clock` (NFR: nothing calls
 * `Date.now()` directly) so tests can assert exact durations with a `FakeClock`.
 *
 * @param clock   time source; defaults to `systemClock`.
 * @param logsDir directory for the JSONL sink; relative paths resolve against
 *                `process.cwd()`. Tests should pass an absolute temp dir.
 * @param options {@link StartTraceOptions.id} to adopt a caller-supplied
 *                correlation id.
 */
export function startTrace(
  clock: Clock = systemClock,
  logsDir = 'logs',
  options: StartTraceOptions = {},
): Trace {
  // A supplied id wins; a blank one does not (see `StartTraceOptions.id`).
  const id = options.id !== undefined && options.id !== '' ? options.id : newId();
  const startedAtMs = clock.now();
  const spans: Span[] = [];
  /**
   * Raw, unredacted annotations. Redaction happens at the two exits
   * (`annotations()` and `finish()`) rather than here, so `safeLog` is applied
   * exactly once to any given value — hashing an already-hashed person id would
   * still be deterministic, but it would no longer match the digest every other
   * log line carries for that person.
   */
  let annotated: Annotations = {};
  /**
   * Stack of spans opened but not yet ended. The top of the stack is the parent
   * of the next span opened. Sufficient for sequential/nested instrumentation;
   * genuinely concurrent span graphs are out of scope.
   */
  const open: Span[] = [];

  const span = (name: string): SpanHandle => {
    const parent = open[open.length - 1];
    const record: Span = {
      id: newId(),
      name,
      startMs: clock.now(),
      endMs: null,
      parentId: parent ? parent.id : null,
    };

    spans.push(record);
    open.push(record);

    let ended = false;
    return {
      end(): void {
        // Idempotent: a double `.end()` must not overwrite the first timing or
        // corrupt the open-span stack.
        if (ended) return;
        ended = true;
        record.endMs = clock.now();

        // Remove by identity rather than popping, so an out-of-order `.end()`
        // still leaves the remaining open spans parented correctly.
        const i = open.lastIndexOf(record);
        if (i !== -1) open.splice(i, 1);
      },
    };
  };

  const stageTimings = (): StageTimings => {
    const out: StageTimings = {};

    for (const s of spans) {
      const key = STAGE_KEYS[s.name as keyof typeof STAGE_KEYS];
      // Skip non-stage spans, unfinished spans, and duplicates (first wins).
      if (key === undefined || s.endMs === null || out[key] !== undefined) continue;
      out[key] = s.endMs - s.startMs;
    }

    return out;
  };

  const annotate = (fields: Annotations): void => {
    annotated = { ...annotated, ...fields };
  };

  const annotations = (): Annotations => safeLog(annotated);

  const finish = (): void => {
    const dir = resolve(logsDir);
    mkdirSync(dir, { recursive: true });

    // SEC-7 is enforced on the WHOLE record, not just on the annotations, and at
    // the last possible moment. Span names are code-authored constants today,
    // but "today" is not a guarantee, and this file is read by humans and shipped
    // in bug reports — a single scrub of everything about to be persisted is the
    // only version of this that stays true as callers are added.
    const line = JSON.stringify(
      safeLog({
        traceId: id,
        startedAtMs,
        finishedAtMs: clock.now(),
        stageTimings: stageTimings(),
        annotations: annotated,
        spans,
      }),
    );

    // Append-only, newline-terminated: one trace per line, safe to tail/parse.
    appendFileSync(join(dir, `trace-${utcDate(startedAtMs)}.jsonl`), `${line}\n`, 'utf8');
  };

  return { id, span, annotate, annotations, finish, stageTimings };
}
