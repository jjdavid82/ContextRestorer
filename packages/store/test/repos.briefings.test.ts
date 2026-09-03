import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { BriefingsRepo } from '../src/repos/briefings.js';
import { FeedbackRepo } from '../src/repos/feedback.js';
import { AiCallsRepo } from '../src/repos/aiCalls.js';

let db: Database;
let briefings: BriefingsRepo;
let feedback: FeedbackRepo;
let aiCalls: AiCallsRepo;

/** The one artifact every FK-satisfying claim in this file cites. */
const ARTIFACT_ID = 'a1';

const GENERATED_AT = 1_700_000_000_000;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  briefings = new BriefingsRepo(db);
  feedback = new FeedbackRepo(db);
  aiCalls = new AiCallsRepo(db);

  // Minimal valid artifact so claims have something real to cite.
  db.prepare(
    `INSERT INTO artifacts
       (artifact_id, source, kind, external_ref, title, state, owner_id, first_seen_at, last_seen_at)
     VALUES (?, 'slack', 'thread', 'https://example.test/t/1', 'T', NULL, NULL, 1000, 1000)`,
  ).run(ARTIFACT_ID);
});

function createBriefing(generatedAt = GENERATED_AT) {
  return briefings.create({
    windowStart: generatedAt - 86_400_000,
    windowEnd: generatedAt,
    generatedAt,
    mode: 'llm',
    narrativePath: '/briefings/b1.md',
    deltaIds: ['d1', 'd2'],
    threadsStillProcessing: 0,
  });
}

describe('BriefingsRepo', () => {
  it('round-trips a created briefing via getById', () => {
    const created = createBriefing();
    const loaded = briefings.getById(created.briefingId);

    expect(loaded).toEqual(created);
    expect(loaded?.deltaIds).toEqual(['d1', 'd2']);
    expect(loaded?.caughtUpAt).toBeNull();
  });

  // AC-2, structural half: a claim that cites nothing real must not be storable.
  it('addClaim throws when citationArtifactId does not exist in artifacts', () => {
    const briefing = createBriefing();

    expect(() =>
      briefings.addClaim({
        briefingId: briefing.briefingId,
        ordinal: 0,
        section: 'decisions',
        text: 'This claim cites a ghost.',
        citationArtifactId: 'does-not-exist',
      }),
    ).toThrow(/FOREIGN KEY/i);

    expect(briefings.listClaims(briefing.briefingId)).toHaveLength(0);
  });

  it('listClaims returns claims sorted by ordinal regardless of insert order', () => {
    const briefing = createBriefing();

    for (const ordinal of [2, 0, 1]) {
      briefings.addClaim({
        briefingId: briefing.briefingId,
        ordinal,
        section: 'decisions',
        text: `claim ${ordinal}`,
        citationArtifactId: ARTIFACT_ID,
      });
    }

    const claims = briefings.listClaims(briefing.briefingId);
    expect(claims.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(claims.map((c) => c.text)).toEqual(['claim 0', 'claim 1', 'claim 2']);
  });

  // NFR-10: time-to-re-entry is caught_up_at - generated_at.
  it('markCaughtUp sets caughtUpAt and timeToReEntryMs computes the delta', () => {
    const briefing = createBriefing();
    const caughtUpAt = GENERATED_AT + 90_000;

    briefings.markCaughtUp(briefing.briefingId, caughtUpAt);

    expect(briefings.getById(briefing.briefingId)?.caughtUpAt).toBe(caughtUpAt);
    expect(briefings.timeToReEntryMs(briefing.briefingId)).toBe(90_000);
  });

  it('timeToReEntryMs returns null before the briefing is marked caught up', () => {
    const briefing = createBriefing();
    expect(briefings.timeToReEntryMs(briefing.briefingId)).toBeNull();
  });

  // Migration 003 (§7.8): "cut short" is its own column, not an overloaded mode.
  it('defaults partial to false and markPartial flips it without touching mode', () => {
    const briefing = createBriefing();
    expect(briefing.partial).toBe(false);
    expect(briefings.getById(briefing.briefingId)?.partial).toBe(false);

    briefings.markPartial(briefing.briefingId);

    const loaded = briefings.getById(briefing.briefingId);
    expect(loaded?.partial).toBe(true);
    // A truncated LLM briefing is still an LLM briefing.
    expect(loaded?.mode).toBe('llm');
    // …and truncation says nothing about the input backlog.
    expect(loaded?.threadsStillProcessing).toBe(0);
  });

  it('markPartial throws for an unknown briefing id', () => {
    expect(() => briefings.markPartial('no-such-briefing')).toThrow(/no briefing with id/i);
  });

  it('accepts a caller-minted briefingId so narrative_path can name the row', () => {
    const created = briefings.create({
      briefingId: 'b-fixed',
      windowStart: GENERATED_AT - 1_000,
      windowEnd: GENERATED_AT,
      generatedAt: GENERATED_AT,
      mode: 'llm',
      narrativePath: '/briefings/b-fixed.md',
      deltaIds: [],
      threadsStillProcessing: 2,
      partial: true,
    });

    expect(created.briefingId).toBe('b-fixed');
    expect(briefings.getById('b-fixed')).toEqual(created);
    expect(briefings.getById('b-fixed')?.partial).toBe(true);
  });

  it('recordTimings persists firstTokenMs and totalMs', () => {
    const briefing = createBriefing();

    briefings.recordTimings(briefing.briefingId, 420, 3_100);

    const loaded = briefings.getById(briefing.briefingId);
    expect(loaded?.firstTokenMs).toBe(420);
    expect(loaded?.totalMs).toBe(3_100);
  });
});

describe('FeedbackRepo', () => {
  it('round-trips each of the four valid verdicts', () => {
    const briefing = createBriefing();
    const verdicts = ['relevant', 'irrelevant', 'missed', 'wrong'] as const;

    for (const verdict of verdicts) {
      const submitted = feedback.submit({ briefingId: briefing.briefingId, verdict });
      expect(submitted.verdict).toBe(verdict);
    }

    const stored = feedback.listForBriefing(briefing.briefingId);
    expect(stored).toHaveLength(4);
    expect(new Set(stored.map((f) => f.verdict))).toEqual(new Set(verdicts));
  });

  it('rejects an invalid verdict without writing a row', () => {
    const briefing = createBriefing();

    expect(() =>
      feedback.submit({
        briefingId: briefing.briefingId,
        // Simulates untyped IPC input reaching the repo.
        verdict: 'sideways' as never,
      }),
    ).toThrow(/invalid feedback verdict/i);

    expect(feedback.listForBriefing(briefing.briefingId)).toHaveLength(0);
  });
});

describe('AiCallsRepo', () => {
  // NFR-8: the observability audit trail.
  it('log writes a call that listByTrace returns', () => {
    const logged = aiCalls.log({
      traceId: 'trace-1',
      layer: 2,
      model: 'test-model',
      promptVersion: 'v3',
      latencyMs: 275,
      tokensIn: 1_200,
      tokensOut: 340,
      outcome: 'ok',
    });

    const calls = aiCalls.listByTrace('trace-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(logged);
    expect(calls[0]).toMatchObject({
      layer: 2,
      model: 'test-model',
      promptVersion: 'v3',
      latencyMs: 275,
      tokensIn: 1_200,
      tokensOut: 340,
      outcome: 'ok',
    });

    expect(aiCalls.listByTrace('other-trace')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 4.4 step 4 — the aggregates behind the local metrics view
// ---------------------------------------------------------------------------

describe('AiCallsRepo aggregates', () => {
  const log = (layer: 1 | 2 | 3, latencyMs: number, outcome: string): void => {
    aiCalls.log({
      traceId: `trace-${layer}-${outcome}`,
      layer,
      model: 'test-model',
      promptVersion: 'v1',
      latencyMs,
      outcome,
    });
  };

  it('reports per-layer call count and mean latency, rounded', () => {
    log(1, 100, 'ok');
    log(1, 101, 'ok');
    log(1, 102, 'schema_fail');
    log(3, 4_000, 'ok');

    expect(aiCalls.layerStats()).toEqual([
      { layer: 1, calls: 3, meanLatencyMs: 101 },
      { layer: 3, calls: 1, meanLatencyMs: 4_000 },
    ]);
  });

  it('omits a layer that has never run rather than reporting it as zero', () => {
    log(2, 50, 'not_meaningful');

    const stats = aiCalls.layerStats();
    expect(stats.map((s) => s.layer)).toEqual([2]);
    // "Layer 3 has never run" and "layer 3 runs instantly" must not look alike.
    expect(stats.some((s) => s.layer === 3)).toBe(false);
  });

  it('counts outcomes per layer without judging which are failures', () => {
    log(2, 10, 'not_meaningful');
    log(2, 11, 'not_meaningful');
    log(2, 12, 'uncited');
    // The Gap A outcome: queryable without a migration, because `outcome` is
    // plain TEXT with no CHECK constraint.
    log(3, 900, 'all_claims_dropped');

    expect(aiCalls.outcomeStats()).toEqual([
      { layer: 2, outcome: 'not_meaningful', calls: 2 },
      { layer: 2, outcome: 'uncited', calls: 1 },
      { layer: 3, outcome: 'all_claims_dropped', calls: 1 },
    ]);
  });

  it('reports empty aggregates on an untouched database', () => {
    expect(aiCalls.layerStats()).toEqual([]);
    expect(aiCalls.outcomeStats()).toEqual([]);
  });
});

describe('BriefingsRepo aggregates', () => {
  /** One briefing with a recorded total latency. */
  const withLatency = (generatedAt: number, totalMs: number): string => {
    const briefing = createBriefing(generatedAt);
    briefings.recordTimings(briefing.briefingId, 0, totalMs);
    return briefing.briefingId;
  };

  it('reports nearest-rank P50/P95 over recorded briefing latency', () => {
    for (let i = 1; i <= 20; i += 1) withLatency(GENERATED_AT + i, i * 100);

    // Nearest-rank, not interpolated: every reported value is a real observation.
    expect(briefings.latencyStats()).toEqual({ count: 20, p50Ms: 1_000, p95Ms: 1_900 });
  });

  it('excludes briefings that never finished, rather than counting them as zero', () => {
    withLatency(GENERATED_AT, 500);
    createBriefing(GENERATED_AT + 1); // still in flight: total_ms is NULL

    expect(briefings.latencyStats()).toEqual({ count: 1, p50Ms: 500, p95Ms: 500 });
  });

  it('reports null percentiles — not zero — when nothing qualifies', () => {
    createBriefing();

    // 0 ms is a reachable latency, so it must not double as "no data".
    expect(briefings.latencyStats()).toEqual({ count: 0, p50Ms: null, p95Ms: null });
    expect(briefings.reEntryStats()).toEqual({ count: 0, p50Ms: null, p95Ms: null });
  });

  it('reports NFR-10 time-to-re-entry over every caught-up briefing', () => {
    const a = createBriefing(GENERATED_AT);
    const b = createBriefing(GENERATED_AT + 1);
    createBriefing(GENERATED_AT + 2); // never caught up: excluded

    briefings.markCaughtUp(a.briefingId, GENERATED_AT + 60_000);
    briefings.markCaughtUp(b.briefingId, GENERATED_AT + 1 + 20_000);

    const stats = briefings.reEntryStats();
    expect(stats.count).toBe(2);
    // Nearest-rank over [20 000, 60 000]: P50 is the LOWER of the two, because
    // rank ceil(0.5 × 2) = 1 is the first observation. An interpolated P50 would
    // report 40 000 — a number neither briefing took.
    expect(stats.p50Ms).toBe(20_000);
    expect(stats.p95Ms).toBe(60_000);
    // Same definition as `timeToReEntryMs`, computed from the same two columns.
    expect(briefings.timeToReEntryMs(b.briefingId)).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// F-2 — the resume watermark behind `briefing:resumePoint`
// ---------------------------------------------------------------------------

describe('BriefingsRepo.lastAcknowledgedWindowEnd', () => {
  it('returns null when no briefing has ever been acknowledged', () => {
    createBriefing();
    createBriefing(GENERATED_AT + 1000);

    expect(briefings.lastAcknowledgedWindowEnd()).toBeNull();
  });

  it('returns the acknowledged briefing window_end, not the tap time', () => {
    const briefing = createBriefing();
    // The user reads the briefing and taps five minutes after its window closed.
    briefings.markCaughtUp(briefing.briefingId, GENERATED_AT + 300_000);

    // `window_end` (= GENERATED_AT), NOT `caught_up_at`. Starting the next
    // window at the tap time would silently skip the five minutes of activity
    // between the end of what they read and the moment they acknowledged it.
    expect(briefings.lastAcknowledgedWindowEnd()).toBe(GENERATED_AT);
  });

  it('ignores briefings the user never acknowledged', () => {
    const read = createBriefing();
    briefings.markCaughtUp(read.briefingId, GENERATED_AT + 1000);

    // A later briefing — e.g. one the FR-3 scheduler generated overnight — that
    // the user never opened. Treating it as read would drop its contents.
    createBriefing(GENERATED_AT + 86_400_000);

    expect(briefings.lastAcknowledgedWindowEnd()).toBe(GENERATED_AT);
  });

  it('reports the furthest-forward window, not the most recently acknowledged', () => {
    const far = createBriefing(GENERATED_AT + 86_400_000);
    const near = createBriefing(GENERATED_AT);

    // Acknowledged out of order: the wide window first, a back-fill second. The
    // renderer may request any window it likes, so "how far have you read?" is a
    // question about windows, not about tap order.
    briefings.markCaughtUp(far.briefingId, GENERATED_AT + 86_400_000 + 1000);
    briefings.markCaughtUp(near.briefingId, GENERATED_AT + 86_400_000 + 2000);

    expect(briefings.lastAcknowledgedWindowEnd()).toBe(GENERATED_AT + 86_400_000);
  });
});
