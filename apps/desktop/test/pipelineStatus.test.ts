import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '@cr/core';
import type { DebounceConfig } from '@cr/ai';
import type { DueThread } from '@cr/store';

// `ipc/pipelineStatus.ts` only imports `electron` for types, same defensive
// pattern as `health.test.ts`/`tray.test.ts`.
vi.mock('electron', () => ({}));

const { computePipelineStatus, estimateExtractionEta } = await import(
  '../src/ipc/pipelineStatus.js'
);

const CLOCK: Clock = { now: () => 1_700_000_000_000 };

const DEBOUNCE: DebounceConfig = {
  slack: { quietWindowMs: 300_000, hardCapMs: 1_800_000 },
  gmail: { quietWindowMs: 300_000, hardCapMs: 1_800_000 },
};

const MAX_ATTEMPTS = 3;

const due = (threadKey: string, attempts = 0): DueThread => ({ threadKey, source: 'gmail', attempts });

/**
 * `events` stub. `callEstimate` defaults to "every unextracted event is its own
 * one-event thread" — the worst case, and the one that most differs from the
 * old `total / MAX_BATCH_EVENTS`.
 */
const eventsStub = (unextracted: number, callEstimate = unextracted) => ({
  countUnextracted: () => unextracted,
  unextractedModelCallEstimate: () => callEstimate,
});

describe('computePipelineStatus', () => {
  it('reports zero across the board when nothing is outstanding', () => {
    const status = computePipelineStatus({
      events: eventsStub(0),
      watermarks: { due: () => [] },
      scheduler: { pending: [] },
      debounce: DEBOUNCE,
      maxAttempts: MAX_ATTEMPTS,
      clock: CLOCK,
    });
    expect(status).toEqual({
      extractionBacklog: 0,
      synthesisDue: 0,
      synthesisInFlight: 0,
      parkedThreads: 0,
      // No backlog means no wait to estimate. `null`, not 0 — see the field.
      extractionEtaMs: null,
    });
  });

  it('passes the extraction backlog count through verbatim', () => {
    const status = computePipelineStatus({
      events: eventsStub(7),
      watermarks: { due: () => [] },
      scheduler: { pending: [] },
      debounce: DEBOUNCE,
      maxAttempts: MAX_ATTEMPTS,
      clock: CLOCK,
    });
    expect(status.extractionBacklog).toBe(7);
  });

  it('counts a currently-synthesizing thread as in-flight, not due', () => {
    const status = computePipelineStatus({
      events: eventsStub(0),
      watermarks: { due: () => [due('t1'), due('t2')] },
      scheduler: { pending: ['t1'] },
      debounce: DEBOUNCE,
      maxAttempts: MAX_ATTEMPTS,
      clock: CLOCK,
    });
    // t1 is due AND in flight — it must be counted once, as in-flight, not twice.
    expect(status.synthesisInFlight).toBe(1);
    expect(status.synthesisDue).toBe(1);
  });

  it('excludes a parked thread (attempts >= maxAttempts) from synthesisDue', () => {
    const status = computePipelineStatus({
      events: eventsStub(0),
      watermarks: { due: () => [due('t1'), due('doomed', MAX_ATTEMPTS)] },
      scheduler: { pending: [] },
      debounce: DEBOUNCE,
      maxAttempts: MAX_ATTEMPTS,
      clock: CLOCK,
    });
    // 'doomed' is still in the raw `due()` list (its hard cap has elapsed) but
    // the scheduler will skip and park it rather than synthesize it — it must
    // not read as "queued for summarizing" alongside genuinely-due threads.
    expect(status.synthesisDue).toBe(1);
    // …it reads as parked instead — the "look at this" number.
    expect(status.parkedThreads).toBe(1);
  });

  it('does not count a parked thread as parked while it is being synthesized', () => {
    const status = computePipelineStatus({
      events: eventsStub(0),
      watermarks: { due: () => [due('retrying', MAX_ATTEMPTS)] },
      scheduler: { pending: ['retrying'] },
      debounce: DEBOUNCE,
      maxAttempts: MAX_ATTEMPTS,
      clock: CLOCK,
    });
    // A fresh event reset nothing yet, but the scheduler picked it up this tick:
    // in-flight wins, and it is neither "queued" nor "parked" right now.
    expect(status).toMatchObject({ synthesisInFlight: 1, synthesisDue: 0, parkedThreads: 0 });
  });

  it('passes the debounce config and current time through to watermarks.due', () => {
    const dueFn = vi.fn(() => []);
    computePipelineStatus({
      events: eventsStub(0),
      watermarks: { due: dueFn },
      scheduler: { pending: [] },
      debounce: DEBOUNCE,
      maxAttempts: MAX_ATTEMPTS,
      clock: CLOCK,
    });
    expect(dueFn).toHaveBeenCalledWith(CLOCK.now(), { debounce: DEBOUNCE });
  });
});

describe('estimateExtractionEta — the F2 first-run promise', () => {
  /** An `AiCallsRepo` slice returning a fixed mean, or throwing. */
  const meanOf = (value: number | null) => ({ recentMeanLatencyMs: () => value });
  /** An `EventsRepo` slice reporting a fixed model-call estimate for the backlog. */
  const callsOf = (calls: number) => ({ unextractedModelCallEstimate: () => calls });

  it('costs the backlog in model CALLS, using the per-thread estimate', () => {
    // Layer 1 batches per thread, so the number of calls comes from the store's
    // `unextractedModelCallEstimate`, not `total / MAX_BATCH_EVENTS`. A backlog
    // the store says is 300 calls at 80s each is 300 × 80s.
    expect(estimateExtractionEta(callsOf(300), meanOf(80_000))).toBe(300 * 80_000);
  });

  it('multiplies the call count by the measured mean call latency', () => {
    expect(estimateExtractionEta(callsOf(1), meanOf(80_000))).toBe(80_000);
  });

  it('is null when there is no backlog', () => {
    // Not 0: the renderer distinguishes "nothing to wait for" (no line at all)
    // from "waiting, duration unknown".
    expect(estimateExtractionEta(callsOf(0), meanOf(80_000))).toBeNull();
    expect(estimateExtractionEta(callsOf(-3), meanOf(80_000))).toBeNull();
  });

  it('is null when no latency has been measured yet — the first-run case', () => {
    // A user who has just connected has no completed Layer-1 calls, which is
    // exactly when they are staring at this. A count with no promise attached
    // is the honest answer.
    expect(estimateExtractionEta(callsOf(500), meanOf(null))).toBeNull();
  });

  it('is null when no latency source is wired at all', () => {
    expect(estimateExtractionEta(callsOf(500))).toBeNull();
  });

  it('is null rather than 0 for a nonsense measured latency', () => {
    expect(estimateExtractionEta(callsOf(500), meanOf(0))).toBeNull();
    expect(estimateExtractionEta(callsOf(500), meanOf(-1))).toBeNull();
  });

  it('degrades to null when the latency lookup throws', () => {
    const angry = {
      recentMeanLatencyMs: () => {
        throw new Error('database is locked');
      },
    };

    // A status strip must not fail over its own optional garnish.
    expect(estimateExtractionEta(callsOf(500), angry)).toBeNull();
  });

  it('degrades to null when the backlog read throws', () => {
    const angry = {
      unextractedModelCallEstimate: () => {
        throw new Error('database is locked');
      },
    };
    expect(estimateExtractionEta(angry, meanOf(80_000))).toBeNull();
  });
});
