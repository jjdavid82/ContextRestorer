/**
 * `readTraceEvents` (Diagnostics redesign) — `src/traceEvents.ts`.
 *
 * Same approach as `traceLog.test.ts`: real files, happy paths built through
 * `startTrace` so the reader is checked against the writer's actual output, and
 * the filesystem failure modes exercised directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@cr/core';
import { startTrace } from '../src/trace.js';
import { readTraceEvents } from '../src/traceEvents.js';

const T0 = Date.UTC(2025, 2, 4, 5, 6, 7, 8);

let logsDir: string;

beforeEach(() => {
  logsDir = mkdtempSync(join(tmpdir(), 'cr-traceevents-'));
});

afterEach(() => {
  rmSync(logsDir, { recursive: true, force: true });
});

function writeTrace(annotations: Record<string, unknown>, atMs = T0): void {
  const trace = startTrace(new FakeClock(atMs), logsDir);
  trace.annotate(annotations);
  trace.finish();
}

describe('readTraceEvents', () => {
  it('returns an empty list when the directory does not exist', () => {
    expect(readTraceEvents(join(logsDir, 'nope'))).toEqual([]);
  });

  it('splits injection drops from other citation-gate drops', () => {
    writeTrace({
      event: 'briefing',
      layer: 3,
      gateDrops: { no_citation: 2, injection_pattern: 1, not_in_context: 1 },
    });

    const events = readTraceEvents(logsDir);
    expect(events).toEqual([
      { atMs: T0, kind: 'gate_injection', count: 1 },
      { atMs: T0, kind: 'gate_drops', count: 3 },
    ]);
  });

  it('emits nothing for a briefing whose gate dropped nothing', () => {
    writeTrace({ event: 'briefing', layer: 3, outcome: 'ok' });
    expect(readTraceEvents(logsDir)).toEqual([]);
  });

  it('surfaces a parked thread and a noise sweep', () => {
    writeTrace({ event: 'layer2_parked', threadKey: 'C1:1', attempts: 10 }, T0 + 1_000);
    writeTrace({ event: 'layer1_sweep', prefiltered: 12, schemaFail: 0, wroteOff: 0 }, T0 + 2_000);

    expect(readTraceEvents(logsDir)).toEqual([
      { atMs: T0 + 2_000, kind: 'noise_skipped', count: 12 },
      { atMs: T0 + 1_000, kind: 'thread_parked', count: 1 },
    ]);
  });

  it('omits a noise sweep that skipped nothing', () => {
    writeTrace({ event: 'layer1_sweep', prefiltered: 0 });
    expect(readTraceEvents(logsDir)).toEqual([]);
  });

  it('orders newest first and honours limit', () => {
    for (let i = 1; i <= 5; i += 1) {
      writeTrace({ event: 'layer2_parked', threadKey: `t${i}` }, T0 + i * 1_000);
    }

    const events = readTraceEvents(logsDir, { limit: 2 });
    expect(events.map((e) => e.atMs)).toEqual([T0 + 5_000, T0 + 4_000]);
  });

  it('drops events older than sinceMs', () => {
    writeTrace({ event: 'layer2_parked', threadKey: 'old' }, T0);
    writeTrace({ event: 'layer2_parked', threadKey: 'new' }, T0 + 10_000);

    const events = readTraceEvents(logsDir, { sinceMs: T0 + 5_000 });
    expect(events).toEqual([{ atMs: T0 + 10_000, kind: 'thread_parked', count: 1 }]);
  });

  it('skips malformed lines without throwing', () => {
    writeTrace({ event: 'layer2_parked', threadKey: 'ok' });
    const file = join(logsDir, `trace-2025-03-04.jsonl`);
    writeFileSync(file, '{ not json\n', { flag: 'a' });

    expect(readTraceEvents(logsDir)).toEqual([{ atMs: T0, kind: 'thread_parked', count: 1 }]);
  });
});
