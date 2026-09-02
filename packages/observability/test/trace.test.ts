import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@cr/core';
import { startTrace } from '../src/trace.js';

/** 2025-03-04T05:06:07.008Z — fixed so the JSONL filename is assertable. */
const T0 = Date.UTC(2025, 2, 4, 5, 6, 7, 8);
const EXPECTED_FILE = 'trace-2025-03-04.jsonl';

let logsDir: string;

beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), 'cr-trace-'));
});

afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true });
});

/** Reads the JSONL sink back as non-empty lines. */
const readLines = (file = EXPECTED_FILE): string[] =>
  readFileSync(join(logsDir, file), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);

describe('startTrace', () => {
  it('returns a trace with a stable id', () => {
    const trace = startTrace(new FakeClock(T0), logsDir);

    expect(trace.id).toBeTruthy();
    expect(trace.id).toBe(trace.id);
    expect(startTrace(new FakeClock(T0), logsDir).id).not.toBe(trace.id);
  });

  it('records startMs and endMs for a span from the injected clock', () => {
    const clock = new FakeClock(T0);
    const trace = startTrace(clock, logsDir);

    const handle = trace.span('retrieval');
    clock.advance(120);
    handle.end();

    trace.finish();

    const entry = JSON.parse(readLines()[0] as string) as {
      spans: { name: string; startMs: number; endMs: number | null }[];
    };
    expect(entry.spans).toHaveLength(1);
    expect(entry.spans[0]).toMatchObject({ name: 'retrieval', startMs: T0, endMs: T0 + 120 });
  });

  it('leaves endMs null for a span that was never ended', () => {
    const clock = new FakeClock(T0);
    const trace = startTrace(clock, logsDir);
    trace.span('generation');
    clock.advance(50);
    trace.finish();

    const entry = JSON.parse(readLines()[0] as string) as { spans: { endMs: number | null }[] };
    expect(entry.spans[0]?.endMs).toBeNull();
  });
});

describe('trace.finish', () => {
  it('appends exactly one JSON line to trace-YYYY-MM-DD.jsonl', () => {
    const trace = startTrace(new FakeClock(T0), logsDir);
    trace.span('assembly').end();
    trace.finish();

    const lines = readLines();
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0] as string) as { traceId: string; spans: unknown[] };
    expect(entry.traceId).toBe(trace.id);
    expect(entry.spans).toHaveLength(1);
  });

  it('creates the logs directory if it does not exist', () => {
    const nested = join(logsDir, 'deep', 'logs');
    const trace = startTrace(new FakeClock(T0), nested);
    trace.finish();

    const lines = readFileSync(join(nested, EXPECTED_FILE), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] as string) as { traceId: string }).traceId).toBe(trace.id);
  });

  it('appends rather than overwrites when two traces share a day', () => {
    const a = startTrace(new FakeClock(T0), logsDir);
    const b = startTrace(new FakeClock(T0), logsDir);
    a.finish();
    b.finish();

    const ids = readLines().map((l) => (JSON.parse(l) as { traceId: string }).traceId);
    expect(ids).toEqual([a.id, b.id]);
  });

  it('derives the filename from the UTC date of the trace start', () => {
    // 23:30 UTC on 2025-03-04 — a local-time implementation would roll the date.
    const trace = startTrace(new FakeClock(Date.UTC(2025, 2, 4, 23, 30)), logsDir);
    trace.finish();

    expect(readLines(EXPECTED_FILE)).toHaveLength(1);
  });
});

describe('nested spans', () => {
  it('attributes parentId to the currently open span', () => {
    const clock = new FakeClock(T0);
    const trace = startTrace(clock, logsDir);

    const outer = trace.span('generation');
    clock.advance(5);
    const inner = trace.span('firstToken');
    clock.advance(5);
    inner.end();
    outer.end();

    trace.finish();

    const entry = JSON.parse(readLines()[0] as string) as {
      spans: { id: string; name: string; parentId: string | null }[];
    };
    const a = entry.spans.find((s) => s.name === 'generation');
    const b = entry.spans.find((s) => s.name === 'firstToken');

    expect(a?.parentId).toBeNull();
    expect(b?.parentId).toBe(a?.id);
  });

  it('gives sequential (non-overlapping) spans a null parentId', () => {
    const trace = startTrace(new FakeClock(T0), logsDir);
    trace.span('retrieval').end();
    trace.span('assembly').end();
    trace.finish();

    const entry = JSON.parse(readLines()[0] as string) as { spans: { parentId: string | null }[] };
    expect(entry.spans.map((s) => s.parentId)).toEqual([null, null]);
  });
});

describe('OI-1 stageTimings', () => {
  it('reports elapsed ms for each recorded stage', () => {
    const clock = new FakeClock(T0);
    const trace = startTrace(clock, logsDir);

    const retrieval = trace.span('retrieval');
    clock.advance(100);
    retrieval.end();

    const assembly = trace.span('assembly');
    clock.advance(200);
    assembly.end();

    const generation = trace.span('generation');
    clock.advance(50);
    const firstToken = trace.span('firstToken');
    clock.advance(300);
    firstToken.end();
    generation.end();

    const citation = trace.span('citation');
    clock.advance(25);
    citation.end();

    expect(trace.stageTimings()).toEqual({
      retrievalMs: 100,
      assemblyMs: 200,
      firstTokenMs: 300,
      generationMs: 350,
      citationMs: 25,
    });
  });

  it('omits stages that were never recorded', () => {
    const clock = new FakeClock(T0);
    const trace = startTrace(clock, logsDir);

    const retrieval = trace.span('retrieval');
    clock.advance(10);
    retrieval.end();

    const timings = trace.stageTimings();
    expect(timings).toEqual({ retrievalMs: 10 });
    expect('assemblyMs' in timings).toBe(false);
    expect('generationMs' in timings).toBe(false);
    expect(Object.keys(timings)).toEqual(['retrievalMs']);
  });

  it('omits a stage whose span is still open, and ignores non-stage spans', () => {
    const clock = new FakeClock(T0);
    const trace = startTrace(clock, logsDir);

    trace.span('generation'); // never ended
    const other = trace.span('embedding'); // not a known stage
    clock.advance(15);
    other.end();

    expect(trace.stageTimings()).toEqual({});
  });
});
