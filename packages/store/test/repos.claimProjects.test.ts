/**
 * `ClaimProjectsRepo` — per-claim project LABELS (migration 010).
 *
 * Run against a real `openDb(':memory:')` + `migrate`, like every other repo
 * test here, so the foreign keys and the composite primary key are the real
 * ones. `openDb` sets `foreign_keys = ON`, which is what makes the parent-row
 * cases below meaningful rather than decorative.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate, BriefingsRepo, ClaimProjectsRepo, GraphRepo } from '../src/index.js';

let db: Database;
let repo: ClaimProjectsRepo;
let briefings: BriefingsRepo;
let graph: GraphRepo;

const NOW = 1_700_000_000_000;

/** A `briefings` row to hang labels off — `briefing_id` is a real FK. */
function makeBriefing(id: string): string {
  briefings.create({
    briefingId: id,
    windowStart: NOW - 86_400_000,
    windowEnd: NOW,
    generatedAt: NOW,
    mode: 'template',
    narrativePath: `briefings/${id}.md`,
    deltaIds: [],
    threadsStillProcessing: 0,
  });
  return id;
}

function makeProject(name: string): string {
  return graph.declareProject({ name, origin: 'declared' }).projectId;
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new ClaimProjectsRepo(db);
  briefings = new BriefingsRepo(db);
  graph = new GraphRepo(db);
});

afterEach(() => {
  db.close();
});

describe('ClaimProjectsRepo', () => {
  it('reports no labels for a briefing nobody has tagged', () => {
    const briefingId = makeBriefing('b1');
    expect(repo.listForBriefing(briefingId)).toEqual([]);
  });

  it('set then list round-trips one label', () => {
    const briefingId = makeBriefing('b1');
    const projectId = makeProject('Migration');

    repo.setProject(briefingId, 'artifact-1', projectId, NOW);

    expect(repo.listForBriefing(briefingId)).toEqual([
      { briefingId, artifactId: 'artifact-1', projectId, taggedAt: NOW },
    ]);
  });

  it('re-tagging the same row REPLACES the project rather than duplicating it', () => {
    const briefingId = makeBriefing('b1');
    const first = makeProject('Migration');
    const second = makeProject('Pilot');

    repo.setProject(briefingId, 'artifact-1', first, NOW);
    repo.setProject(briefingId, 'artifact-1', second, NOW + 5_000);

    const tags = repo.listForBriefing(briefingId);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.projectId).toBe(second);
    // `tagged_at` moves to when the user last said it — the label is an edit,
    // not an append-only judgement like feedback.
    expect(tags[0]?.taggedAt).toBe(NOW + 5_000);
  });

  it('null clears a label, and clearing an untagged row is a no-op', () => {
    const briefingId = makeBriefing('b1');
    const projectId = makeProject('Migration');

    repo.setProject(briefingId, 'artifact-1', projectId, NOW);
    repo.setProject(briefingId, 'artifact-1', null, NOW);
    expect(repo.listForBriefing(briefingId)).toEqual([]);

    // The dropdown's "No project" option must be idempotent: choosing it twice,
    // or on a row that was never tagged, is not an error.
    expect(() => repo.setProject(briefingId, 'never-tagged', null, NOW)).not.toThrow();
    expect(repo.listForBriefing(briefingId)).toEqual([]);
  });

  it('scopes labels per briefing — the same artifact can be filed differently in each', () => {
    const first = makeBriefing('b1');
    const second = makeBriefing('b2');
    const migration = makeProject('Migration');
    const pilot = makeProject('Pilot');

    repo.setProject(first, 'artifact-1', migration, NOW);
    repo.setProject(second, 'artifact-1', pilot, NOW);

    expect(repo.listForBriefing(first).map((t) => t.projectId)).toEqual([migration]);
    expect(repo.listForBriefing(second).map((t) => t.projectId)).toEqual([pilot]);
  });

  it('listForProject spans briefings — the read the future filter needs', () => {
    const first = makeBriefing('b1');
    const second = makeBriefing('b2');
    const migration = makeProject('Migration');
    const pilot = makeProject('Pilot');

    repo.setProject(first, 'artifact-1', migration, NOW);
    repo.setProject(second, 'artifact-2', migration, NOW + 1_000);
    repo.setProject(second, 'artifact-3', pilot, NOW + 2_000);

    // Newest first, so a filtered view leads with the most recent labelling.
    expect(repo.listForProject(migration).map((t) => t.artifactId)).toEqual([
      'artifact-2',
      'artifact-1',
    ]);
    expect(repo.listForProject(pilot).map((t) => t.artifactId)).toEqual(['artifact-3']);
  });

  it('refuses a label pointing at a project that does not exist (FK bites)', () => {
    const briefingId = makeBriefing('b1');
    expect(() => repo.setProject(briefingId, 'artifact-1', 'no-such-project', NOW)).toThrow();
  });

  it('deleting a project takes its labels with it, leaving the briefing intact', () => {
    const briefingId = makeBriefing('b1');
    const projectId = makeProject('Migration');
    repo.setProject(briefingId, 'artifact-1', projectId, NOW);

    // ON DELETE CASCADE, unlike migration 006's SET NULL: a label with no
    // project is not a meaningful row, whereas a channel with no tag is.
    db.prepare('DELETE FROM projects WHERE project_id = ?').run(projectId);

    expect(repo.listForBriefing(briefingId)).toEqual([]);
    expect(
      db.prepare('SELECT briefing_id FROM briefings WHERE briefing_id = ?').get(briefingId),
    ).toBeDefined();
  });
});
