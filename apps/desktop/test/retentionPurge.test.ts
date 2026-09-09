/**
 * The 90-day purge loop — `apps/desktop/src/scheduler/retentionPurge.ts`.
 *
 * Timers are injected rather than faked with `vi.useFakeTimers()`, matching
 * `briefingSchedule.test.ts`: the module chains one-shot timeouts, and driving
 * the chain by hand makes "the next run is armed only after the previous one
 * settled" an assertion instead of a timing hope.
 *
 * The properties under test are the ones that make the retention promise real:
 * the cutoff is derived from config rather than hardcoded, the vector half is
 * driven off the manifest, and a failure in either half does not stop tomorrow's
 * run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PURGE_INTERVAL_MS,
  PURGE_STARTUP_DELAY_MS,
  runRetentionPurge,
  startRetentionPurge,
  type RetentionPurgeDeps,
} from '../src/scheduler/retentionPurge.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

/** A hand-driven timer queue: `arm` records, `fire` runs the pending callback. */
function makeTimers() {
  const armed: Array<{ fn: () => void; ms: number }> = [];
  const cleared: number[] = [];
  let nextId = 1;
  const ids = new Map<object, number>();

  const setTimer = (fn: () => void, ms: number): NodeJS.Timeout => {
    const handle = { unref: () => handle } as unknown as NodeJS.Timeout;
    ids.set(handle as unknown as object, nextId++);
    armed.push({ fn, ms });
    return handle;
  };
  const clearTimer = (handle: NodeJS.Timeout): void => {
    cleared.push(ids.get(handle as unknown as object) ?? -1);
  };

  return {
    armed,
    cleared,
    setTimer,
    clearTimer,
    /** Run the most recently armed callback. */
    async fire(): Promise<void> {
      const next = armed[armed.length - 1];
      if (next === undefined) throw new Error('no timer armed');
      next.fn();
      // The callback kicks off an async chain before re-arming; two
      // microtask flushes is enough for `runRetentionPurge` to settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function makeDeps(overrides: Partial<RetentionPurgeDeps> = {}): RetentionPurgeDeps {
  return {
    purge: () => ({ rowsDeleted: 0, vectorEventIds: [] }),
    rawEventDays: 90,
    clock: { now: () => NOW },
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('runRetentionPurge', () => {
  it('purges at now minus rawEventDays, from config rather than a constant', async () => {
    const purge = vi.fn(() => ({ rowsDeleted: 0, vectorEventIds: [] }));

    await runRetentionPurge(makeDeps({ purge, rawEventDays: 30 }));

    expect(purge).toHaveBeenCalledWith(NOW - 30 * DAY_MS);
  });

  it('evicts exactly the vectors the purge manifest named', async () => {
    const evictVectors = vi.fn(async (ids: string[]) => ids.length);
    const deps = makeDeps({
      purge: () => ({ rowsDeleted: 2, vectorEventIds: ['e-1', 'e-2'] }),
      evictVectors,
    });

    const run = await runRetentionPurge(deps);

    expect(evictVectors).toHaveBeenCalledWith(['e-1', 'e-2']);
    expect(run).toEqual({ rowsDeleted: 2, vectorsDeleted: 2, cutoffMs: NOW - 90 * DAY_MS });
  });

  it('skips the vector call entirely when nothing was purged', async () => {
    // The common case on a young install, and the reason this path is silent:
    // a daily "removed 0 rows" line is noise in the log Diagnostics reads.
    const evictVectors = vi.fn(async () => 0);

    const run = await runRetentionPurge(makeDeps({ evictVectors }));

    expect(evictVectors).not.toHaveBeenCalled();
    expect(run.rowsDeleted).toBe(0);
    expect(console.info).not.toHaveBeenCalled();
  });

  it('reports rather than throws when the SQLite purge fails', async () => {
    const deps = makeDeps({
      purge: () => {
        throw new Error('database is locked');
      },
    });

    // Never rejects: a rejection inside the timer callback would take the main
    // process down, and retention has to survive to try again tomorrow.
    await expect(runRetentionPurge(deps)).resolves.toEqual({
      rowsDeleted: 0,
      vectorsDeleted: null,
      cutoffMs: NOW - 90 * DAY_MS,
    });
    expect(console.error).toHaveBeenCalled();
  });

  it('keeps the committed SQLite purge when the vector eviction fails, and says so', async () => {
    const deps = makeDeps({
      purge: () => ({ rowsDeleted: 4, vectorEventIds: ['e-1'] }),
      evictVectors: async () => {
        throw new Error('lance table locked');
      },
    });

    const run = await runRetentionPurge(deps);

    // `rowsDeleted` stands — that half committed. `vectorsDeleted: null` is the
    // disclosure, distinct from `0`, which would claim there was nothing to do.
    expect(run.rowsDeleted).toBe(4);
    expect(run.vectorsDeleted).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it('reports null vectors when no vector store is wired at all', async () => {
    const run = await runRetentionPurge(
      makeDeps({ purge: () => ({ rowsDeleted: 1, vectorEventIds: ['e-1'] }) }),
    );

    expect(run.vectorsDeleted).toBeNull();
  });
});

describe('startRetentionPurge', () => {
  it('arms the first run on a delay, not immediately', async () => {
    const timers = makeTimers();
    const purge = vi.fn(() => ({ rowsDeleted: 0, vectorEventIds: [] }));

    startRetentionPurge(makeDeps({ purge, ...timers }));

    // A purge competes with the startup extraction sweep for the same SQLite
    // handle, and nothing about a 90-day cutoff is urgent to the second.
    expect(purge).not.toHaveBeenCalled();
    expect(timers.armed).toHaveLength(1);
    expect(timers.armed[0]?.ms).toBe(PURGE_STARTUP_DELAY_MS);
  });

  it('re-arms at the daily interval after each run settles', async () => {
    const timers = makeTimers();
    const purge = vi.fn(() => ({ rowsDeleted: 0, vectorEventIds: [] }));
    startRetentionPurge(makeDeps({ purge, ...timers }));

    await timers.fire();

    expect(purge).toHaveBeenCalledTimes(1);
    expect(timers.armed).toHaveLength(2);
    expect(timers.armed[1]?.ms).toBe(PURGE_INTERVAL_MS);

    await timers.fire();

    expect(purge).toHaveBeenCalledTimes(2);
    expect(timers.armed[2]?.ms).toBe(PURGE_INTERVAL_MS);
  });

  it('re-arms even after a run that failed', async () => {
    const timers = makeTimers();
    const purge = vi.fn(() => {
      throw new Error('database is locked');
    });
    startRetentionPurge(makeDeps({ purge, ...timers }));

    await timers.fire();

    // One bad day must not end retention for the life of the process.
    expect(timers.armed).toHaveLength(2);
    expect(timers.armed[1]?.ms).toBe(PURGE_INTERVAL_MS);
  });

  it('stops re-arming once disposed', async () => {
    const timers = makeTimers();
    const purge = vi.fn(() => ({ rowsDeleted: 0, vectorEventIds: [] }));
    const stop = startRetentionPurge(makeDeps({ purge, ...timers }));

    await timers.fire();
    expect(timers.armed).toHaveLength(2);

    stop();
    expect(timers.cleared).toHaveLength(1);

    // A tick already in the queue when `stop()` ran must not schedule another.
    await timers.fire();
    expect(timers.armed).toHaveLength(2);
  });

  it('honours the interval override so a test need not wait a day', () => {
    const timers = makeTimers();
    startRetentionPurge(makeDeps({ ...timers, startupDelayMs: 5, intervalMs: 10 }));

    expect(timers.armed[0]?.ms).toBe(5);
  });
});
