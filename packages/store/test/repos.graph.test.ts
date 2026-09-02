import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { Artifact, Person } from '@cr/core';
import { openDb, migrate } from '../src/index.js';
import { GraphRepo } from '../src/repos/graph.js';

let db: Database;
let repo: GraphRepo;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new GraphRepo(db);
});

const makeArtifact = (over: Partial<Artifact> = {}): Artifact => ({
  artifactId: 'a1',
  source: 'slack',
  kind: 'thread',
  externalRef: 'https://slack.example/C1/p1',
  title: 'Deploy plan',
  state: null,
  ownerId: 'U1',
  firstSeenAt: 1_000,
  lastSeenAt: 1_000,
  ...over,
});

const makePerson = (over: Partial<Person> = {}): Person => ({
  personId: 'p1',
  displayName: 'Ada',
  emailHash: 'hash-a',
  isSelf: false,
  ...over,
});

describe('GraphRepo.upsertArtifact', () => {
  it('sets firstSeenAt and lastSeenAt to the same value on insert', () => {
    repo.upsertArtifact(makeArtifact({ firstSeenAt: 1_000, lastSeenAt: 1_000 }));

    const stored = repo.getArtifact('a1');
    expect(stored?.firstSeenAt).toBe(1_000);
    expect(stored?.lastSeenAt).toBe(1_000);
  });

  it('advances lastSeenAt but never rewrites firstSeenAt', () => {
    repo.upsertArtifact(makeArtifact({ firstSeenAt: 1_000, lastSeenAt: 1_000 }));

    // A later sighting: the connector re-reports the artifact with a fresh
    // firstSeenAt it has no business overwriting.
    repo.upsertArtifact(
      makeArtifact({ firstSeenAt: 5_000, lastSeenAt: 5_000, title: 'Deploy plan (v2)' }),
    );

    const stored = repo.getArtifact('a1');
    expect(stored?.firstSeenAt).toBe(1_000); // unchanged
    expect(stored?.lastSeenAt).toBe(5_000); // advanced
    expect(stored?.title).toBe('Deploy plan (v2)'); // mutable field refreshed

    const n = db.prepare(`SELECT COUNT(*) AS n FROM artifacts`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('does not rewind lastSeenAt for an out-of-order older sighting', () => {
    repo.upsertArtifact(makeArtifact({ firstSeenAt: 1_000, lastSeenAt: 5_000 }));
    repo.upsertArtifact(makeArtifact({ firstSeenAt: 1_000, lastSeenAt: 2_000 }));

    expect(repo.getArtifact('a1')?.lastSeenAt).toBe(5_000);
  });
});

describe('GraphRepo.getArtifact', () => {
  it('returns undefined for an unknown id', () => {
    const result = repo.getArtifact('nonexistent-id');
    expect(result).toBeUndefined();
    expect(result).not.toBeNull();
  });
});

describe('GraphRepo.upsertPerson', () => {
  it('round-trips isSelf per person', () => {
    repo.upsertPerson(makePerson({ personId: 'p1', displayName: 'Ada', isSelf: true }));
    repo.upsertPerson(makePerson({ personId: 'p2', displayName: 'Grace', isSelf: false }));

    const selves = db.prepare(`SELECT person_id FROM people WHERE is_self = 1`).all() as {
      person_id: string;
    }[];
    expect(selves).toEqual([{ person_id: 'p1' }]);

    expect(repo.getPerson('p1')?.isSelf).toBe(true);
    expect(repo.getPerson('p2')?.isSelf).toBe(false);
  });

  it('updates an existing person in place', () => {
    repo.upsertPerson(makePerson({ personId: 'p1', displayName: 'Ada', emailHash: 'hash-a' }));
    repo.upsertPerson(makePerson({ personId: 'p1', displayName: 'Ada L.', emailHash: 'hash-b' }));

    const n = db.prepare(`SELECT COUNT(*) AS n FROM people`).get() as { n: number };
    expect(n.n).toBe(1);
    expect(repo.getPerson('p1')).toMatchObject({ displayName: 'Ada L.', emailHash: 'hash-b' });
  });
});

describe('GraphRepo.declareProject', () => {
  it("persists a project with origin 'declared'", () => {
    const project = repo.declareProject({ name: 'Migration', origin: 'declared' });

    expect(project.origin).toBe('declared');
    expect(project.stakesWeight).toBe(1.0); // default
    expect(project.projectId).toBeTruthy();
    expect(project.declaredAt).toBeGreaterThan(0);

    const stored = repo.getProject(project.projectId);
    expect(stored).toMatchObject({ name: 'Migration', origin: 'declared', stakesWeight: 1.0 });
  });

  it('honours an explicit stakesWeight', () => {
    const project = repo.declareProject({ name: 'Migration', origin: 'declared', stakesWeight: 2.5 });
    expect(repo.getProject(project.projectId)?.stakesWeight).toBe(2.5);
  });

  it("throws for any origin other than 'declared', writing nothing (X-2)", () => {
    expect(() => repo.declareProject({ name: 'Guessed', origin: 'inferred' })).toThrow(/X-2/);

    const n = db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});
