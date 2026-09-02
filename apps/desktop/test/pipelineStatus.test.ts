import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '@cr/core';
import type { DebounceConfig } from '@cr/ai';
import type { DueThread } from '@cr/store';

// `ipc/pipelineStatus.ts` only imports `electron` for types, same defensive
// pattern as `health.test.ts`/`tray.test.ts`.
vi.mock('electron', () => ({}));

const { computePipelineStatus } = await import('../src/ipc/pipelineStatus.js');

const CLOCK: Clock = { now: () => 1_700_000_000_000 };

const DEBOUNCE: DebounceConfig = {
  slack: { quietWindowMs: 300_000, hardCapMs: 1_800_000 },
  gmail: { quietWindowMs: 300_000, hardCapMs: 1_800_000 },
};

const due = (threadKey: string): DueThread =>
  ({ threadKey, source: 'gmail' }) as DueThread;

describe('computePipelineStatus', () => {
  it('reports zero across the board when nothing is outstanding', () => {
    const status = computePipelineStatus({
      events: { countUnextracted: () => 0 },
      watermarks: { due: () => [] },
      scheduler: { pending: [] },
      debounce: DEBOUNCE,
      clock: CLOCK,
    });
    expect(status).toEqual({ extractionBacklog: 0, synthesisDue: 0, synthesisInFlight: 0 });
  });

  it('passes the extraction backlog count through verbatim', () => {
    const status = computePipelineStatus({
      events: { countUnextracted: () => 7 },
      watermarks: { due: () => [] },
      scheduler: { pending: [] },
      debounce: DEBOUNCE,
      clock: CLOCK,
    });
    expect(status.extractionBacklog).toBe(7);
  });

  it('counts a currently-synthesizing thread as in-flight, not due', () => {
    const status = computePipelineStatus({
      events: { countUnextracted: () => 0 },
      watermarks: { due: () => [due('t1'), due('t2')] },
      scheduler: { pending: ['t1'] },
      debounce: DEBOUNCE,
      clock: CLOCK,
    });
    // t1 is due AND in flight — it must be counted once, as in-flight, not twice.
    expect(status.synthesisInFlight).toBe(1);
    expect(status.synthesisDue).toBe(1);
  });

  it('passes the debounce config and current time through to watermarks.due', () => {
    const dueFn = vi.fn(() => []);
    computePipelineStatus({
      events: { countUnextracted: () => 0 },
      watermarks: { due: dueFn },
      scheduler: { pending: [] },
      debounce: DEBOUNCE,
      clock: CLOCK,
    });
    expect(dueFn).toHaveBeenCalledWith(CLOCK.now(), { debounce: DEBOUNCE });
  });
});
