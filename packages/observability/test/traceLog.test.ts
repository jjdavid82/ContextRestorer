/**
 * Reading the trace log back (Task 4.4, step 4) — `src/traceLog.ts`.
 *
 * Written against REAL files on disk rather than a string fixture, because every
 * failure mode this reader has to survive is a filesystem one: a directory that
 * does not exist yet, a file that is half-written, a line truncated by a crash.
 *
 * The happy-path cases build their input with `startTrace` + `annotate` +
 * `finish` rather than hand-writing JSON, so the reader is checked against the
 * writer's actual output. A hand-written fixture would keep passing after a
 * change to the trace format, which is the one thing it must not do.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@cr/core';
import { startTrace } from '../src/trace.js';
import { listTraceFiles, readTraceMetrics } from '../src/traceLog.js';

const T0 = Date.UTC(2025, 2, 4, 5, 6, 7, 8);

let logsDir: string;

beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), 'cr-tracelog-'));
});

afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true });
});

/** Write one briefing-shaped trace line. */
function writeBriefingTrace(annotations: Record<string, unknown>, atMs = T0): void {
  const trace = startTrace(new FakeClock(atMs), logsDir);
  trace.span('citation').end();
  trace.annotate({ event: 'briefing', layer: 3, ...annotations });
  trace.finish();
}

/** Write one Layer-2 trigger-shaped trace line. */
function writeTriggerTrace(annotations: Record<string, unknown>, atMs = T0): void {
  const trace = startTrace(new FakeClock(atMs), logsDir);
  trace.span('synthesis').end();
  trace.annotate({ event: 'layer2_trigger', threadKey: 'C1:1', ...annotations });
  trace.finish();
}

describe('readTraceMetrics — Gap A: gate drops by reason', () => {
  it('sums the per-reason breakdown across several briefings', () => {
    writeBriefingTrace({
      outcome: 'ok',
      gateDrops: { no_citation: 2, injection_pattern: 1 },
    });
    writeBriefingTrace({
      outcome: 'all_claims_dropped',
      gateDrops: { injection_pattern: 3, not_in_context: 1 },
    });

    const metrics = readTraceMetrics(logsDir);

    expect(metrics.briefingCount).toBe(2);
    expect(metrics.gateDropsByReason).toEqual({
      no_citation: 2,
      injection_pattern: 4,
      not_in_context: 1,
    });
    // The queryable half of Gap A is visible here too, for cross-checking
    // against the same counts in `ai_calls`.
    expect(metrics.briefingsByOutcome).toEqual({ ok: 1, all_claims_dropped: 1 });
  });

  it('reports an empty breakdown when nothing has ever been dropped', () => {
    writeBriefingTrace({ outcome: 'ok', gateDrops: {} });

    const metrics = readTraceMetrics(logsDir);

    expect(metrics.briefingCount).toBe(1);
    expect(metrics.gateDropsByReason).toEqual({});
  });
});

describe('readTraceMetrics — Gap B: SEC-5 redaction counts', () => {
  it('sums counts and unions the detector kinds', () => {
    writeBriefingTrace({
      outcome: 'ok',
      redactedClaims: 1,
      redactionCount: 2,
      redactionKinds: ['aws_access_key', 'email'],
    });
    writeBriefingTrace({
      outcome: 'ok',
      redactedClaims: 2,
      redactionCount: 3,
      redactionKinds: ['email'],
    });

    const metrics = readTraceMetrics(logsDir);

    expect(metrics.redactedClaims).toBe(3);
    expect(metrics.redactionCount).toBe(5);
    // A kind is a kind however often it fires; the magnitude is the count's job.
    expect(metrics.redactionKinds).toEqual(['aws_access_key', 'email']);
  });
});

describe('readTraceMetrics — D-7 trigger decisions', () => {
  it('counts triggers by fired condition and by synthesis outcome', () => {
    writeTriggerTrace({ reason: 'quiet', outcome: 'ok' });
    writeTriggerTrace({ reason: 'quiet', outcome: 'not_meaningful' });
    writeTriggerTrace({ reason: 'hard_cap', outcome: 'ok' });
    writeTriggerTrace({ reason: 'quiet', outcome: 'error' });

    const metrics = readTraceMetrics(logsDir);

    expect(metrics.layer2Triggers).toBe(4);
    expect(metrics.triggersByReason).toEqual({ quiet: 3, hard_cap: 1 });
    expect(metrics.triggersByOutcome).toEqual({ ok: 2, not_meaningful: 1, error: 1 });
  });

  it('keeps briefing and trigger traces apart in one mixed file', () => {
    writeTriggerTrace({ reason: 'quiet', outcome: 'ok' });
    writeBriefingTrace({ outcome: 'ok', gateDrops: { no_citation: 1 } });

    const metrics = readTraceMetrics(logsDir);

    expect(metrics.tracesRead).toBe(2);
    expect(metrics.briefingCount).toBe(1);
    expect(metrics.layer2Triggers).toBe(1);
    expect(metrics.gateDropsByReason).toEqual({ no_citation: 1 });
  });
});

describe('readTraceMetrics — resilience', () => {
  it('returns an empty result for a directory that does not exist', () => {
    const metrics = readTraceMetrics(join(logsDir, 'never-created'));

    expect(metrics.tracesRead).toBe(0);
    expect(metrics.filesRead).toEqual([]);
    expect(metrics.gateDropsByReason).toEqual({});
    // An install that has generated nothing is not an error state.
    expect(metrics.unparseableLines).toBe(0);
  });

  it('counts a truncated line instead of throwing, and keeps reading', () => {
    writeBriefingTrace({ outcome: 'ok', gateDrops: { no_citation: 1 } });
    // A crash mid-append leaves exactly this: a partial line, then more lines.
    writeFileSync(
      join(logsDir, 'trace-2025-03-04.jsonl'),
      '{"traceId":"half-writ',
      { flag: 'a', encoding: 'utf8' },
    );
    writeFileSync(join(logsDir, 'trace-2025-03-04.jsonl'), '\n', { flag: 'a', encoding: 'utf8' });
    writeBriefingTrace({ outcome: 'ok', gateDrops: { injection_pattern: 1 } });

    const metrics = readTraceMetrics(logsDir);

    expect(metrics.unparseableLines).toBe(1);
    expect(metrics.tracesRead).toBe(2);
    expect(metrics.gateDropsByReason).toEqual({ no_citation: 1, injection_pattern: 1 });
  });

  it('ignores files that are not trace logs', () => {
    writeBriefingTrace({ outcome: 'ok' });
    writeFileSync(join(logsDir, 'app.log'), 'not json at all\n', 'utf8');
    writeFileSync(join(logsDir, 'trace-notes.txt'), 'also not\n', 'utf8');

    const metrics = readTraceMetrics(logsDir);

    expect(metrics.filesRead).toEqual(['trace-2025-03-04.jsonl']);
    expect(metrics.unparseableLines).toBe(0);
  });

  it('reads the newest day-files first and stops at the day cap', () => {
    writeBriefingTrace({ outcome: 'ok', gateDrops: { no_citation: 1 } }, Date.UTC(2025, 2, 1));
    writeBriefingTrace({ outcome: 'ok', gateDrops: { no_citation: 1 } }, Date.UTC(2025, 2, 2));
    writeBriefingTrace({ outcome: 'ok', gateDrops: { no_citation: 1 } }, Date.UTC(2025, 2, 3));

    expect(listTraceFiles(logsDir)).toEqual([
      'trace-2025-03-03.jsonl',
      'trace-2025-03-02.jsonl',
      'trace-2025-03-01.jsonl',
    ]);

    const capped = readTraceMetrics(logsDir, { days: 2 });
    expect(capped.filesRead).toEqual(['trace-2025-03-03.jsonl', 'trace-2025-03-02.jsonl']);
    expect(capped.gateDropsByReason).toEqual({ no_citation: 2 });
  });

  it('ignores a hand-edited negative or non-numeric count', () => {
    // The log is a plain text file a user can open; a nonsense value must not
    // corrupt a total or produce a negative claim count in the panel.
    writeFileSync(
      join(logsDir, 'trace-2025-03-04.jsonl'),
      `${JSON.stringify({
        traceId: 't1',
        annotations: {
          event: 'briefing',
          gateDrops: { no_citation: -5, injection_pattern: 'lots' },
          redactionCount: -3,
        },
        spans: [],
      })}\n`,
      'utf8',
    );

    const metrics = readTraceMetrics(logsDir);

    expect(metrics.gateDropsByReason).toEqual({});
    expect(metrics.redactionCount).toBe(0);
    expect(metrics.tracesRead).toBe(1);
  });
});
