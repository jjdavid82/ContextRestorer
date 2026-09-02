/**
 * Completion-signal and feedback tests (Task 3.7) — `src/ipc/feedback.ts`.
 *
 * These run against a REAL `FeedbackRepo`/`BriefingsRepo` over `openDb(':memory:')`
 * + `migrate`, not hand-rolled stores. Every claim under test is a claim about
 * what the DATABASE ends up holding — that a verdict row exists, that
 * `caught_up_at` did NOT move on the second tap, that `caught_up_at -
 * generated_at` is what the metrics view reports — and a fake store would prove
 * none of it. In particular, the idempotency test is only meaningful against the
 * real `markCaughtUp`, whose UPDATE is unconditional: a stub that "remembered"
 * the first value would test the stub.
 *
 * `feedback.ts` imports `ipcMain` at module scope, which does not exist outside a
 * running Electron process — same `vi.mock('electron', …)` + dynamic-import
 * pattern as `ipc.claim.test.ts`/`ipc.briefing.test.ts`.
 *
 * The four numbered requirements of the task map onto the four `describe` blocks
 * below, in order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { BriefingsRepo, FeedbackRepo, migrate, openDb } from '@cr/store';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const {
  CAUGHT_UP_CHANNEL,
  CLAIM_VERDICTS_CHANNEL,
  METRICS_CHANNEL,
  MAX_CLAIM_IDS,
  MAX_METRICS_IDS,
  MAX_NOTE_CHARS,
  SUBMIT_CHANNEL,
  briefingMetrics,
  claimVerdicts,
  markBriefingCaughtUp,
  parseClaimIdsArg,
  parseFeedbackArg,
  parseMetricsArg,
  registerFeedbackHandlers,
  submitFeedback,
} = await import('../src/ipc/feedback.js');

type FeedbackModule = typeof import('../src/ipc/feedback.js');
type Deps = Parameters<FeedbackModule['submitFeedback']>[1];

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let db: Database;
let briefings: BriefingsRepo;
let feedback: FeedbackRepo;

/**
 * A clock the test drives by hand.
 *
 * The idempotency case needs the second call to arrive at a DEMONSTRABLY later
 * instant than the first — with `Date.now()` the two calls can land in the same
 * millisecond, and an overwrite would be invisible.
 */
function fakeClock(start: number): { now(): number; set(at: number): void } {
  let current = start;
  return {
    now: () => current,
    set: (at: number) => {
      current = at;
    },
  };
}

const GENERATED_AT = 1_700_000_000_000;

/** A briefing row exactly as Layer 3 would have written it, still uncaught-up. */
function seedBriefing(briefingId: string, generatedAt = GENERATED_AT): string {
  briefings.create({
    briefingId,
    windowStart: generatedAt - 86_400_000,
    windowEnd: generatedAt,
    generatedAt,
    mode: 'llm',
    narrativePath: `briefings/${briefingId}.md`,
    deltaIds: [],
    threadsStillProcessing: 0,
  });
  return briefingId;
}

/** Read `caught_up_at` straight out of SQLite, bypassing every repo helper. */
function rawCaughtUpAt(briefingId: string): number | null {
  const row = db
    .prepare(`SELECT caught_up_at FROM briefings WHERE briefing_id = ?`)
    .get(briefingId) as { caught_up_at: number | null } | undefined;
  return row?.caught_up_at ?? null;
}

function makeDeps(clock: { now(): number } = fakeClock(GENERATED_AT + 60_000)): Deps {
  return { feedback, briefings, clock };
}

beforeEach(() => {
  handle.mockReset();
  db = openDb(':memory:');
  migrate(db);
  briefings = new BriefingsRepo(db);
  feedback = new FeedbackRepo(db);
});

afterEach(() => {
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Requirement 1 — `feedback:submit` persists, in well under a second (AC-9)  */
/* -------------------------------------------------------------------------- */

describe('feedback:submit (AC-9)', () => {
  it('persists a claim-level verdict and returns ok', () => {
    const briefingId = seedBriefing('brief-1');

    const result = submitFeedback(
      { briefingId, claimId: 'artifact-7', verdict: 'relevant' },
      makeDeps(),
    );

    expect(result).toEqual({ ok: true });

    const stored = feedback.listForBriefing(briefingId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      briefingId,
      claimId: 'artifact-7',
      verdict: 'relevant',
    });
  });

  it('completes in under 1s of measured wall-clock time', () => {
    const briefingId = seedBriefing('brief-timed');
    const deps = makeDeps();

    // MEASURED, not merely awaited: AC-9 is a latency requirement, and a test
    // that only asserted `ok` would pass just as happily if this handler grew a
    // synchronous network call. `performance.now()` brackets the real call.
    const started = performance.now();
    const result = submitFeedback({ briefingId, verdict: 'missed' }, deps);
    const elapsedMs = performance.now() - started;

    expect(result.ok).toBe(true);
    // AC-9's literal bound. A local prepared INSERT lands in low single-digit
    // milliseconds; 1000ms is the requirement, and being three orders of
    // magnitude inside it is the point.
    expect(elapsedMs).toBeLessThan(1000);
    expect(feedback.listForBriefing(briefingId)).toHaveLength(1);
  });

  it('accepts briefing-level feedback with no claimId (FR-7 "I missed something")', () => {
    // This is the exact payload `apps/ui/components/FeedbackControls.tsx` sends
    // when `claimId` is undefined: the key is ABSENT, not `claimId: undefined`.
    const briefingId = seedBriefing('brief-2');

    expect(submitFeedback({ briefingId, verdict: 'missed' }, makeDeps())).toEqual({ ok: true });
    expect(feedback.listForBriefing(briefingId)[0]?.claimId).toBeNull();
  });

  it('rejects an unknown verdict without writing a row', () => {
    const briefingId = seedBriefing('brief-3');

    const result = submitFeedback({ briefingId, verdict: 'excellent' }, makeDeps());

    expect(result).toEqual({ ok: false, reason: 'invalid_feedback' });
    expect(feedback.listForBriefing(briefingId)).toHaveLength(0);
  });

  it('rejects a present-but-empty claimId rather than storing a dangling row', () => {
    const briefingId = seedBriefing('brief-4');

    expect(submitFeedback({ briefingId, claimId: '', verdict: 'wrong' }, makeDeps())).toEqual({
      ok: false,
      reason: 'invalid_feedback',
    });
    expect(feedback.listForBriefing(briefingId)).toHaveLength(0);
  });

  it('truncates an over-long note instead of dropping the verdict', () => {
    const briefingId = seedBriefing('brief-5');
    const note = 'x'.repeat(MAX_NOTE_CHARS + 500);

    expect(submitFeedback({ briefingId, verdict: 'wrong', note }, makeDeps())).toEqual({ ok: true });
    expect(feedback.listForBriefing(briefingId)[0]?.note).toHaveLength(MAX_NOTE_CHARS);
  });

  it('parses the two shapes FeedbackControls actually sends', () => {
    expect(parseFeedbackArg({ briefingId: 'b', verdict: 'missed' })).toEqual({
      briefingId: 'b',
      verdict: 'missed',
    });
    expect(parseFeedbackArg({ briefingId: 'b', claimId: 'c', verdict: 'irrelevant' })).toEqual({
      briefingId: 'b',
      claimId: 'c',
      verdict: 'irrelevant',
    });
    expect(parseFeedbackArg(null)).toBeNull();
    expect(parseFeedbackArg({ verdict: 'relevant' })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 2 — `briefing:caughtUp` stamps once, and only once             */
/* -------------------------------------------------------------------------- */

describe('briefing:caughtUp (FR-11)', () => {
  it('sets caught_up_at on the first call', () => {
    const briefingId = seedBriefing('brief-cu-1');
    const clock = fakeClock(GENERATED_AT + 90_000);

    const result = markBriefingCaughtUp({ briefingId }, makeDeps(clock));

    expect(result.ok).toBe(true);
    expect(result.caughtUpAt).toBe(GENERATED_AT + 90_000);
    expect(rawCaughtUpAt(briefingId)).toBe(GENERATED_AT + 90_000);
  });

  it('is IDEMPOTENT: a double-tap at a LATER clock keeps the first timestamp', () => {
    const briefingId = seedBriefing('brief-cu-2');
    const clock = fakeClock(GENERATED_AT + 120_000);
    const deps = makeDeps(clock);

    const first = markBriefingCaughtUp({ briefingId }, deps);
    expect(first.caughtUpAt).toBe(GENERATED_AT + 120_000);

    // The user double-taps — or React re-fires the effect, or a stale window
    // re-sends — an hour later. `BriefingsRepo.markCaughtUp` would happily
    // overwrite; the handler must not let it.
    clock.set(GENERATED_AT + 3_720_000);
    const second = markBriefingCaughtUp({ briefingId }, deps);

    expect(second.ok).toBe(true);
    expect(second.caughtUpAt).toBe(GENERATED_AT + 120_000);
    // Read back from the raw column, not from the response: the response could
    // be right while the row was silently rewritten.
    expect(rawCaughtUpAt(briefingId)).toBe(GENERATED_AT + 120_000);
    expect(briefings.getById(briefingId)?.caughtUpAt).toBe(GENERATED_AT + 120_000);

    // And the metric it feeds must not have inflated either — the whole reason
    // idempotency matters here.
    expect(second.timeToReEntryMs).toBe(120_000);
  });

  it('stays idempotent across many taps', () => {
    const briefingId = seedBriefing('brief-cu-3');
    const clock = fakeClock(GENERATED_AT + 5_000);
    const deps = makeDeps(clock);

    markBriefingCaughtUp({ briefingId }, deps);
    for (let tap = 1; tap <= 5; tap += 1) {
      clock.set(GENERATED_AT + 5_000 + tap * 60_000);
      expect(markBriefingCaughtUp({ briefingId }, deps).caughtUpAt).toBe(GENERATED_AT + 5_000);
    }
    expect(rawCaughtUpAt(briefingId)).toBe(GENERATED_AT + 5_000);
  });

  it('reports an unknown briefing instead of throwing', () => {
    // `markCaughtUp` throws for a missing row; a stale renderer holding an id
    // across a retention purge is not a crash.
    expect(markBriefingCaughtUp({ briefingId: 'never-existed' }, makeDeps())).toEqual({
      ok: false,
      reason: 'unknown_briefing',
    });
  });

  it('rejects a malformed argument', () => {
    expect(markBriefingCaughtUp({ briefingId: '' }, makeDeps())).toEqual({
      ok: false,
      reason: 'invalid_id',
    });
    expect(markBriefingCaughtUp(null, makeDeps())).toEqual({ ok: false, reason: 'invalid_id' });
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 3 — time-to-re-entry is caught_up_at − generated_at (NFR-10)   */
/* -------------------------------------------------------------------------- */

describe('time-to-re-entry (NFR-10)', () => {
  it('returns caught_up_at − generated_at on the caughtUp response', () => {
    const briefingId = seedBriefing('brief-ttr-1');
    const clock = fakeClock(GENERATED_AT + 247_000);

    const result = markBriefingCaughtUp({ briefingId }, makeDeps(clock));

    expect(result.timeToReEntryMs).toBe(247_000);
    // Pinned against the repo's own computation, which is the single definition
    // of the metric.
    expect(briefings.timeToReEntryMs(briefingId)).toBe(247_000);
  });

  it('omits the metric for a briefing that was never caught up', () => {
    const briefingId = seedBriefing('brief-ttr-2');
    expect(briefings.timeToReEntryMs(briefingId)).toBeNull();
    expect(briefingMetrics({ briefingIds: [briefingId] }, makeDeps())[0]?.timeToReEntryMs).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4 — a reachable metrics view                                   */
/* -------------------------------------------------------------------------- */

describe('briefing:metrics (NFR-10 view)', () => {
  it('reports time-to-re-entry for several briefings, in request order', () => {
    const clock = fakeClock(0);
    const deps = makeDeps(clock);

    seedBriefing('m-1', 1_000_000);
    seedBriefing('m-2', 2_000_000);
    seedBriefing('m-3', 3_000_000); // deliberately left open

    clock.set(1_030_000);
    markBriefingCaughtUp({ briefingId: 'm-1' }, deps);
    clock.set(2_500_000);
    markBriefingCaughtUp({ briefingId: 'm-2' }, deps);

    const metrics = briefingMetrics({ briefingIds: ['m-2', 'm-1', 'm-3'] }, deps);

    expect(metrics).toEqual([
      { briefingId: 'm-2', generatedAt: 2_000_000, caughtUpAt: 2_500_000, timeToReEntryMs: 500_000 },
      { briefingId: 'm-1', generatedAt: 1_000_000, caughtUpAt: 1_030_000, timeToReEntryMs: 30_000 },
      { briefingId: 'm-3', generatedAt: 3_000_000, caughtUpAt: null, timeToReEntryMs: null },
    ]);
  });

  it('omits unknown ids rather than inventing rows for them', () => {
    seedBriefing('m-known', 500_000);

    const metrics = briefingMetrics({ briefingIds: ['m-known', 'm-purged'] }, makeDeps());

    expect(metrics.map((m) => m.briefingId)).toEqual(['m-known']);
  });

  it('answers an empty request with an empty report, and a malformed one too', () => {
    expect(briefingMetrics({ briefingIds: [] }, makeDeps())).toEqual([]);
    expect(briefingMetrics(null, makeDeps())).toEqual([]);
    expect(briefingMetrics({ briefingIds: 'brief-1' }, makeDeps())).toEqual([]);
  });

  it('de-duplicates and caps the requested id list', () => {
    expect(parseMetricsArg({ briefingIds: ['a', 'a', 'b', '', 7] })).toEqual(['a', 'b']);
    const many = Array.from({ length: MAX_METRICS_IDS + 50 }, (_v, i) => `id-${i}`);
    expect(parseMetricsArg({ briefingIds: many })).toHaveLength(MAX_METRICS_IDS);
  });
});

/* -------------------------------------------------------------------------- */
/* feedback:claimVerdicts — replay across restarts and across briefings       */
/* -------------------------------------------------------------------------- */

describe('feedback:claimVerdicts', () => {
  it('reports the verdict already on file for each claim, across different briefings', () => {
    const briefingA = seedBriefing('brief-a');
    const briefingB = seedBriefing('brief-b');
    submitFeedback({ briefingId: briefingA, claimId: 'art-1', verdict: 'relevant' }, makeDeps());
    // The SAME underlying claim resurfaces in a later briefing under a fresh id
    // — the verdict must still be found, not scoped to `briefingA`.
    submitFeedback({ briefingId: briefingB, claimId: 'art-2', verdict: 'wrong' }, makeDeps());

    expect(claimVerdicts({ claimIds: ['art-1', 'art-2', 'art-unasked'] }, makeDeps())).toEqual({
      'art-1': 'relevant',
      'art-2': 'wrong',
    });
  });

  it('reports the newest verdict when the user changed their mind', () => {
    const briefingId = seedBriefing('brief-c');
    const clock = fakeClock(GENERATED_AT);
    submitFeedback({ briefingId, claimId: 'art-1', verdict: 'irrelevant' }, makeDeps(clock));
    clock.set(GENERATED_AT + 1_000);
    submitFeedback({ briefingId, claimId: 'art-1', verdict: 'relevant' }, makeDeps(clock));

    expect(claimVerdicts({ claimIds: ['art-1'] }, makeDeps())).toEqual({ 'art-1': 'relevant' });
  });

  it('omits claims with no feedback and tolerates a malformed argument', () => {
    expect(claimVerdicts({ claimIds: [] }, makeDeps())).toEqual({});
    expect(claimVerdicts(null, makeDeps())).toEqual({});
    expect(claimVerdicts({ claimIds: 'art-1' }, makeDeps())).toEqual({});
  });

  it('de-duplicates and caps the requested id list', () => {
    expect(parseClaimIdsArg({ claimIds: ['a', 'a', 'b', '', 7] })).toEqual(['a', 'b']);
    const many = Array.from({ length: MAX_CLAIM_IDS + 50 }, (_v, i) => `id-${i}`);
    expect(parseClaimIdsArg({ claimIds: many })).toHaveLength(MAX_CLAIM_IDS);
  });

  it('degrades a storage fault to an empty map instead of a rejected invoke', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: Deps['feedback'] = {
      submit: () => ({ feedbackId: 'x' }),
      verdictsForClaims: () => {
        throw new Error('database is locked');
      },
    };

    expect(claimVerdicts({ claimIds: ['art-1'] }, { ...makeDeps(), feedback: broken })).toEqual({});
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('routes an invoke through to the store', () => {
    const briefingId = seedBriefing('brief-wired');
    submitFeedback({ briefingId, claimId: 'art-1', verdict: 'relevant' }, makeDeps());
    registerFeedbackHandlers(makeDeps());

    const callback = handle.mock.calls.find((call) => call[0] === CLAIM_VERDICTS_CHANNEL)?.[1] as (
      event: unknown,
      arg: unknown,
    ) => Record<string, string>;

    expect(callback({}, { claimIds: ['art-1'] })).toEqual({ 'art-1': 'relevant' });
  });
});

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

describe('registerFeedbackHandlers', () => {
  it('registers exactly the four channels the preload allowlists', () => {
    registerFeedbackHandlers(makeDeps());

    expect(handle.mock.calls.map((call) => call[0] as string)).toEqual([
      SUBMIT_CHANNEL,
      CAUGHT_UP_CHANNEL,
      METRICS_CHANNEL,
      CLAIM_VERDICTS_CHANNEL,
    ]);
    expect(SUBMIT_CHANNEL).toBe('feedback:submit');
    expect(CAUGHT_UP_CHANNEL).toBe('briefing:caughtUp');
    expect(METRICS_CHANNEL).toBe('briefing:metrics');
    expect(CLAIM_VERDICTS_CHANNEL).toBe('feedback:claimVerdicts');
  });

  it('routes an invoke through to the store', () => {
    const briefingId = seedBriefing('brief-wired');
    registerFeedbackHandlers(makeDeps());

    const submitHandler = handle.mock.calls.find((call) => call[0] === SUBMIT_CHANNEL)?.[1] as (
      event: unknown,
      arg: unknown,
    ) => { ok: boolean };

    expect(submitHandler({}, { briefingId, verdict: 'relevant' })).toEqual({ ok: true });
    expect(feedback.listForBriefing(briefingId)).toHaveLength(1);
  });
});
