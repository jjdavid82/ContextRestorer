import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { DeltasRepo, type NewStateDelta } from '../src/repos/deltas.js';

let db: Database;
let repo: DeltasRepo;

const THREAD = 'C1:1';

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new DeltasRepo(db);
});

afterEach(() => {
  db.close();
});

const makeDelta = (over: Partial<NewStateDelta> = {}): NewStateDelta => ({
  threadKey: THREAD,
  artifactId: null,
  summary: 'the team chose Postgres over DynamoDB',
  kind: 'decision',
  confidence: 0.9,
  sourceEventIds: ['e1'],
  citationArtifactIds: ['a1'],
  model: 'llama3',
  promptVersion: 'v1',
  createdAt: 1_000,
  ...over,
});

describe('DeltasRepo.append — D-6 versioning', () => {
  it('writes version 1 with supersedes = null on a thread with no prior delta', () => {
    const written = repo.append(makeDelta());

    expect(written.version).toBe(1);
    expect(written.supersedes).toBeNull();
    expect(written.threadKey).toBe(THREAD);

    // …and the same is true of what actually landed on disk, not just the return value.
    const persisted = repo.chainFor(THREAD);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.version).toBe(1);
    expect(persisted[0]?.supersedes).toBeNull();
    expect(persisted[0]?.deltaId).toBe(written.deltaId);
  });

  it('writes version 3 superseding the v2 delta when the latest version is 2', () => {
    repo.append(makeDelta({ summary: 'v1', createdAt: 1_000 }));
    const v2 = repo.append(makeDelta({ summary: 'v2', createdAt: 2_000 }));

    const v3 = repo.append(makeDelta({ summary: 'v3', kind: 'reversal', createdAt: 3_000 }));

    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
    expect(v3.supersedes).toBe(v2.deltaId);
  });

  it('serializes two back-to-back appends on the same thread into versions 1 then 2', () => {
    // Two synthesis workers finishing on the same thread at the same moment are
    // serialized by SQLite's writer lock; because `append` re-reads the latest
    // version *inside* the transaction, the second one must observe the first.
    // If the read were outside the transaction both would compute version 1 and
    // one delta would be silently lost (or trip UNIQUE(thread_key, version)).
    const first = repo.append(makeDelta({ summary: 'worker A', createdAt: 1_000 }));
    const second = repo.append(makeDelta({ summary: 'worker B', createdAt: 1_001 }));

    expect([first.version, second.version]).toEqual([1, 2]);
    expect(second.supersedes).toBe(first.deltaId);
    expect(first.deltaId).not.toBe(second.deltaId);

    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM state_deltas WHERE thread_key = ? AND version = 1`)
      .get(THREAD) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('keeps per-thread version counters independent', () => {
    const a = repo.append(makeDelta({ threadKey: 'C1:1' }));
    const b = repo.append(makeDelta({ threadKey: 'C2:9' }));

    expect(a.version).toBe(1);
    expect(b.version).toBe(1);
    expect(b.supersedes).toBeNull();
  });

  it('round-trips the JSON id arrays as arrays, not raw strings', () => {
    repo.append(
      makeDelta({ sourceEventIds: ['e1', 'e2'], citationArtifactIds: ['a1', 'a2', 'a3'] }),
    );

    const [delta] = repo.chainFor(THREAD);
    expect(delta?.sourceEventIds).toEqual(['e1', 'e2']);
    expect(delta?.citationArtifactIds).toEqual(['a1', 'a2', 'a3']);
  });
});

describe('DeltasRepo.currentForWindow', () => {
  it('returns only the tip of a supersedes chain, not the superseded version', () => {
    const v1 = repo.append(makeDelta({ summary: 'shipping Friday', createdAt: 1_000 }));
    const v2 = repo.append(
      makeDelta({ summary: 'slipped to Monday', kind: 'reversal', createdAt: 2_000 }),
    );
    expect(v2.supersedes).toBe(v1.deltaId);

    const current = repo.currentForWindow(0, 10_000);

    expect(current).toHaveLength(1);
    expect(current[0]?.deltaId).toBe(v2.deltaId);
    expect(current[0]?.version).toBe(2);
    expect(current.map((d) => d.deltaId)).not.toContain(v1.deltaId);
  });

  it('bounds the window as [start, end) — end is exclusive', () => {
    repo.append(makeDelta({ threadKey: 'T:in', createdAt: 5_000 }));
    repo.append(makeDelta({ threadKey: 'T:on-end', createdAt: 6_000 }));
    repo.append(makeDelta({ threadKey: 'T:before', createdAt: 4_999 }));

    const keys = repo.currentForWindow(5_000, 6_000).map((d) => d.threadKey);

    expect(keys).toEqual(['T:in']);
  });
});

describe('DeltasRepo.chainFor', () => {
  it('returns the full ordered history so a briefing can narrate a reversal', () => {
    repo.append(makeDelta({ summary: 'shipping Friday', createdAt: 1_000 }));
    repo.append(makeDelta({ summary: 'slipped to Monday', kind: 'reversal', createdAt: 2_000 }));

    const chain = repo.chainFor(THREAD);

    expect(chain.map((d) => d.version)).toEqual([1, 2]);
    expect(chain.map((d) => d.summary)).toEqual(['shipping Friday', 'slipped to Monday']);
    expect(chain[1]?.supersedes).toBe(chain[0]?.deltaId);
  });

  it('returns an empty array for a thread that has never been synthesized', () => {
    expect(repo.chainFor('never-seen')).toEqual([]);
  });
});
