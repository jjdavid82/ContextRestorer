import { describe, it, expect } from 'vitest';
import { openDb, migrate, GraphRepo } from '@cr/store';
import { FakeClock, type PendingItem, type StateDelta } from '@cr/core';
import {
  rankDeltas,
  recencyDecay,
  scoreAndRank,
  scoreDelta,
  toRankableDelta,
  type RankableDelta,
  type RankingWeights,
} from '../src/ranker.js';

/** Fixed "now"; every fixture age hangs off it. */
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The shipped weights from `config/default.json` — the ordering FR-5 relies on. */
const WEIGHTS: RankingWeights = { wStakes: 3.0, wPendingOnMe: 5.0, wSelfParticipation: 1.5, wRecency: 0.5 };

/**
 * Build a rankable delta.
 *
 * Note what this helper *cannot* express: there is no click count, view count,
 * dwell time or feedback verdict to pass, because `RankableDelta` has no such
 * field (X-2). Every test below therefore scores on declared stakes, open
 * obligations, structural participation and age — and nothing else.
 */
function delta(deltaId: string, overrides: Partial<RankableDelta> = {}): RankableDelta {
  return {
    deltaId,
    threadKey: `thread-${deltaId}`,
    createdAt: NOW - DAY_MS,
    isDeclaredProject: false,
    hasPendingOnMe: false,
    ...overrides,
  };
}

describe('scoreDelta / rankDeltas — FR-5: stakes beat recency', () => {
  it('ranks an OLDER delta on a declared project above a NEWER one on an undeclared project', () => {
    // The headline requirement. The undeclared delta is as fresh as possible
    // (created *now*) and the declared one is a month stale, so recency is
    // maximally stacked against the outcome we require.
    const declaredOld = delta('d-declared', {
      isDeclaredProject: true,
      createdAt: NOW - 30 * DAY_MS,
    });
    const undeclaredNew = delta('d-undeclared', {
      isDeclaredProject: false,
      createdAt: NOW,
    });

    const ranked = rankDeltas([undeclaredNew, declaredOld], WEIGHTS, NOW);

    expect(ranked.map((d) => d.deltaId)).toEqual(['d-declared', 'd-undeclared']);
    expect(scoreDelta(declaredOld, WEIGHTS, NOW)).toBeGreaterThan(
      scoreDelta(undeclaredNew, WEIGHTS, NOW),
    );
  });

  it('cannot be overturned by ANY age gap: the recency term is bounded by wRecency', () => {
    // Structural, not anecdotal — the guarantee holds for every age, because the
    // most recency can ever add is `wRecency` (0.5) and stakes adds `wStakes` (3).
    const undeclaredNew = delta('d-fresh', { isDeclaredProject: false, createdAt: NOW });
    for (const ageDays of [0, 1, 7, 30, 365, 3650]) {
      const declared = delta('d-stakes', {
        isDeclaredProject: true,
        createdAt: NOW - ageDays * DAY_MS,
      });
      expect(scoreDelta(declared, WEIGHTS, NOW)).toBeGreaterThan(
        scoreDelta(undeclaredNew, WEIGHTS, NOW),
      );
    }
  });
});

describe('scoreDelta — pending obligations dominate', () => {
  it('ranks a delta with an open pending item above a same-project delta without one', () => {
    const withPending = delta('d-pending', { isDeclaredProject: true, hasPendingOnMe: true });
    const withoutPending = delta('d-quiet', { isDeclaredProject: true, hasPendingOnMe: false });

    expect(rankDeltas([withoutPending, withPending], WEIGHTS, NOW).map((d) => d.deltaId)).toEqual([
      'd-pending',
      'd-quiet',
    ]);
  });

  it('outweighs stakes AND recency together — wPendingOnMe is the largest weight', () => {
    // Undeclared, stale, no participation... but something is owed.
    const owed = delta('d-owed', {
      hasPendingOnMe: true,
      isDeclaredProject: false,
      createdAt: NOW - 60 * DAY_MS,
    });
    // Declared, brand new, heavily participated — but nothing is waiting.
    const loud = delta('d-loud', {
      hasPendingOnMe: false,
      isDeclaredProject: true,
      createdAt: NOW,
      selfParticipationCount: 50,
    });

    expect(scoreDelta(owed, WEIGHTS, NOW)).toBeGreaterThan(scoreDelta(loud, WEIGHTS, NOW));
  });
});

describe('scoreDelta — recency is only a tiebreaker', () => {
  it('orders newer first when deltas are otherwise identical', () => {
    const older = delta('d-older', { isDeclaredProject: true, createdAt: NOW - 10 * DAY_MS });
    const newer = delta('d-newer', { isDeclaredProject: true, createdAt: NOW - 1 * DAY_MS });

    expect(rankDeltas([older, newer], WEIGHTS, NOW).map((d) => d.deltaId)).toEqual([
      'd-newer',
      'd-older',
    ]);
  });

  it('separates equal-stakes deltas by no more than wRecency', () => {
    // The tiebreak is real but small: the entire spread attributable to age is
    // bounded by `wRecency`, which is what stops it becoming a ranking factor.
    const fresh = delta('d-fresh', { isDeclaredProject: true, createdAt: NOW });
    const ancient = delta('d-ancient', { isDeclaredProject: true, createdAt: NOW - 3650 * DAY_MS });

    const spread = scoreDelta(fresh, WEIGHTS, NOW) - scoreDelta(ancient, WEIGHTS, NOW);
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThanOrEqual(WEIGHTS.wRecency);
  });

  it('breaks exact ties deterministically (newer, then deltaId) even when wRecency is 0', () => {
    const noRecency: RankingWeights = { ...WEIGHTS, wRecency: 0 };
    const a = delta('aaa', { isDeclaredProject: true, createdAt: NOW - DAY_MS });
    const b = delta('bbb', { isDeclaredProject: true, createdAt: NOW - DAY_MS });
    const c = delta('ccc', { isDeclaredProject: true, createdAt: NOW });

    expect(rankDeltas([b, a, c], noRecency, NOW).map((d) => d.deltaId)).toEqual([
      'ccc',
      'aaa',
      'bbb',
    ]);
    // Same input, same output — a rerun of a briefing must not shuffle.
    expect(rankDeltas([c, b, a], noRecency, NOW).map((d) => d.deltaId)).toEqual([
      'ccc',
      'aaa',
      'bbb',
    ]);
  });

  it('treats a future createdAt as "now" rather than exploding', () => {
    const skewed = delta('d-skewed', { createdAt: NOW + 10 * DAY_MS });
    expect(scoreDelta(skewed, WEIGHTS, NOW)).toBeCloseTo(WEIGHTS.wRecency, 10);
    expect(Number.isFinite(scoreDelta(skewed, WEIGHTS, NOW))).toBe(true);
  });

  it('decays monotonically with age', () => {
    const ages = [0, DAY_MS, 7 * DAY_MS, 30 * DAY_MS];
    const decays = ages.map((age) => recencyDecay(age));
    expect(decays).toEqual([...decays].sort((a, b) => b - a));
    expect(decays[0]).toBe(1);
    expect(recencyDecay(7 * DAY_MS)).toBeCloseTo(0.5, 10);
  });
});

describe('rankDeltas — weights come from config (NFR-7)', () => {
  it('produces a DIFFERENT order when wStakes changes', () => {
    const deltas = [
      delta('d-declared-old', { isDeclaredProject: true, createdAt: NOW - 30 * DAY_MS }),
      delta('d-undeclared-new', { isDeclaredProject: false, createdAt: NOW }),
    ];

    const stakesDominant = rankDeltas(deltas, { ...WEIGHTS, wStakes: 3.0 }, NOW);
    const stakesMuted = rankDeltas(deltas, { ...WEIGHTS, wStakes: 0.1 }, NOW);

    expect(stakesDominant.map((d) => d.deltaId)).toEqual(['d-declared-old', 'd-undeclared-new']);
    // Turn the stakes weight down and recency is free to win: the ordering is a
    // function of config, not of anything baked into the code.
    expect(stakesMuted.map((d) => d.deltaId)).toEqual(['d-undeclared-new', 'd-declared-old']);
    expect(stakesMuted.map((d) => d.deltaId)).not.toEqual(stakesDominant.map((d) => d.deltaId));
  });

  it('zeroing a weight removes that factor entirely', () => {
    const declared = delta('d-declared', { isDeclaredProject: true });
    const plain = delta('d-plain', { isDeclaredProject: false });
    const off: RankingWeights = { ...WEIGHTS, wStakes: 0 };

    expect(scoreDelta(declared, off, NOW)).toBe(scoreDelta(plain, off, NOW));
  });

  it('does not mutate the input array', () => {
    const input = [delta('b'), delta('a', { isDeclaredProject: true })];
    const snapshot = input.map((d) => d.deltaId);
    rankDeltas(input, WEIGHTS, NOW);
    expect(input.map((d) => d.deltaId)).toEqual(snapshot);
  });

  it('exposes the score alongside the delta so a ranking can be explained', () => {
    const scored = scoreAndRank([delta('a'), delta('b', { hasPendingOnMe: true })], WEIGHTS, NOW);
    expect(scored[0]?.delta.deltaId).toBe('b');
    expect(scored[0]?.score).toBeGreaterThan(scored[1]?.score ?? Infinity);
  });
});

describe('self-participation is structural, not behavioural', () => {
  it('rewards being a participant, with saturating (not linear) returns', () => {
    const none = delta('d-0', { selfParticipationCount: 0 });
    const some = delta('d-1', { selfParticipationCount: 1 });
    const many = delta('d-9', { selfParticipationCount: 9 });

    const s0 = scoreDelta(none, WEIGHTS, NOW);
    const s1 = scoreDelta(some, WEIGHTS, NOW);
    const s9 = scoreDelta(many, WEIGHTS, NOW);

    expect(s1).toBeGreaterThan(s0);
    expect(s9).toBeGreaterThan(s1);
    // 9x the participation is nowhere near 9x the contribution: a chatty thread
    // must not be able to buy its way past a declared-project decision.
    expect(s9 - s0).toBeLessThan(9 * (s1 - s0));
    expect(s9 - s0).toBeLessThan(WEIGHTS.wStakes);
  });

  it('contributes nothing when the caller omits it', () => {
    const omitted = delta('d-omitted');
    const explicitZero = delta('d-zero', { selfParticipationCount: 0 });
    expect(scoreDelta(omitted, WEIGHTS, NOW)).toBe(scoreDelta(explicitZero, WEIGHTS, NOW));
  });
});

describe('X-2 — no engagement signal anywhere in the scoring inputs', () => {
  /**
   * The interface itself is the guardrail: TypeScript's structural typing means
   * "this interface has no extra fields" is not something a runtime assertion can
   * prove. What CAN be proved — and is what actually matters — is that the
   * documented fields are *sufficient*: the ranker produces a correct, complete,
   * fully-ordered result from them alone, so no future requirement can claim it
   * "needs" a click count to work.
   */
  it('scores correctly from ONLY the documented RankableDelta fields', () => {
    // Constructed field-by-field from the documented shape — nothing else exists
    // to pass, and nothing else is needed.
    const input: RankableDelta = {
      deltaId: 'delta-1',
      threadKey: 'thread-1',
      createdAt: NOW - 2 * DAY_MS,
      isDeclaredProject: true,
      hasPendingOnMe: true,
      selfParticipationCount: 3,
    };

    const expected =
      WEIGHTS.wStakes * 1 +
      WEIGHTS.wPendingOnMe * 1 +
      WEIGHTS.wSelfParticipation * (3 / 4) +
      WEIGHTS.wRecency * Math.pow(0.5, 2 / 7);

    expect(scoreDelta(input, WEIGHTS, NOW)).toBeCloseTo(expected, 10);
  });

  it('ranks a realistic mixed set from those fields alone', () => {
    const set: RankableDelta[] = [
      delta('noise', { createdAt: NOW }),
      delta('owed', { hasPendingOnMe: true, isDeclaredProject: true, createdAt: NOW - 5 * DAY_MS }),
      delta('stakes', { isDeclaredProject: true, createdAt: NOW - 20 * DAY_MS }),
      delta('mine', { selfParticipationCount: 4, createdAt: NOW - DAY_MS }),
    ];

    expect(rankDeltas(set, WEIGHTS, NOW).map((d) => d.deltaId)).toEqual([
      'owed',
      'stakes',
      'mine',
      'noise',
    ]);
  });

  it('ignores unknown extra properties even if a caller smuggles some in', () => {
    // Structural typing lets an object literal with extra keys through when it
    // is widened (as here). The defence is that scoring reads only the declared
    // fields, so a smuggled `clickCount` changes nothing.
    const clean = delta('same', { isDeclaredProject: true });
    const smuggled = { ...clean, clickCount: 9999, dwellMs: 600_000, verdict: 'relevant' };

    expect(scoreDelta(smuggled as RankableDelta, WEIGHTS, NOW)).toBe(
      scoreDelta(clean, WEIGHTS, NOW),
    );
  });
});

describe('toRankableDelta — projecting stored rows onto the ranker input', () => {
  function storedDelta(overrides: Partial<StateDelta> = {}): StateDelta {
    return {
      deltaId: 'delta-1',
      threadKey: 'thread-1',
      artifactId: 'art-1',
      version: 1,
      supersedes: null,
      summary: 'something changed',
      kind: 'decision',
      confidence: 0.9,
      sourceEventIds: ['event-1'],
      citationArtifactIds: ['art-1'],
      model: 'test',
      promptVersion: 'v1',
      createdAt: NOW - DAY_MS,
      ...overrides,
    };
  }

  function pending(status: PendingItem['status']): PendingItem {
    return {
      pendingId: `pending-${status}`,
      deltaId: 'delta-1',
      description: 'reply to Dana',
      confidence: 0.8,
      citationArtifactId: 'art-1',
      status,
      createdAt: NOW - DAY_MS,
      resolvedAt: status === 'open' ? null : NOW,
    };
  }

  function fixture() {
    const db = openDb(':memory:');
    migrate(db);
    const graph = new GraphRepo(db, new FakeClock(NOW));
    graph.upsertArtifact({
      artifactId: 'art-1',
      source: 'slack',
      kind: 'message',
      externalRef: 'https://example.invalid/art-1',
      title: null,
      state: null,
      ownerId: 'person-self',
      firstSeenAt: NOW - 10 * DAY_MS,
      lastSeenAt: NOW,
    });
    return { db, graph };
  }

  it('marks a delta whose artifact belongs to a DECLARED project', () => {
    const { db, graph } = fixture();
    const project = graph.declareProject({ name: 'Launch', origin: 'declared', stakesWeight: 2 });
    graph.relate({ fromId: 'art-1', rel: 'belongs_to', toId: project.projectId });

    const rankable = toRankableDelta(storedDelta(), { graph, selfPersonId: 'person-self' });

    expect(rankable.isDeclaredProject).toBe(true);
    // Owner counts as participation — a structural fact, not an engagement one.
    expect(rankable.selfParticipationCount).toBe(1);
    expect(rankable.deltaId).toBe('delta-1');
    db.close();
  });

  it('leaves isDeclaredProject false when the artifact belongs to no project', () => {
    const { db, graph } = fixture();
    const rankable = toRankableDelta(storedDelta(), { graph });
    expect(rankable.isDeclaredProject).toBe(false);
    expect(rankable.selfParticipationCount).toBe(0);
    db.close();
  });

  it('sets hasPendingOnMe only for OPEN pending items', () => {
    const { db, graph } = fixture();
    const base = { graph, selfPersonId: 'person-self' };

    expect(toRankableDelta(storedDelta(), { ...base, pendingItems: [pending('open')] })
      .hasPendingOnMe).toBe(true);
    expect(
      toRankableDelta(storedDelta(), {
        ...base,
        pendingItems: [pending('resolved'), pending('dismissed')],
      }).hasPendingOnMe,
    ).toBe(false);
    expect(toRankableDelta(storedDelta(), base).hasPendingOnMe).toBe(false);
    db.close();
  });

  it('counts participant edges as well as ownership', () => {
    const { db, graph } = fixture();
    graph.upsertArtifact({
      artifactId: 'art-2',
      source: 'gmail',
      kind: 'message',
      externalRef: 'https://example.invalid/art-2',
      title: null,
      state: null,
      ownerId: 'person-other',
      firstSeenAt: NOW - 10 * DAY_MS,
      lastSeenAt: NOW,
    });
    graph.relate({ fromId: 'art-2', rel: 'participant', toId: 'person-self' });

    const rankable = toRankableDelta(
      storedDelta({ citationArtifactIds: ['art-1', 'art-2'] }),
      { graph, selfPersonId: 'person-self' },
    );

    expect(rankable.selfParticipationCount).toBe(2);
    db.close();
  });
});
