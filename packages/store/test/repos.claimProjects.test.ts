/**
 * `ClaimProjectsRepo` — per-claim project labels (migrations 010-012).
 *
 * Run against a real `openDb(':memory:')` + `migrate`, like every other repo
 * test here, so the foreign keys, the CHECK and the primary key are the real
 * ones. `openDb` sets `foreign_keys = ON`, which is what makes the parent-row
 * cases below meaningful rather than decorative.
 *
 * The load-bearing case is `survives a new briefing`: labels were keyed
 * `(briefing_id, artifact_id)` until migration 012, which meant every Refresh
 * blanked the user's dropdowns. That test is the regression guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate, BriefingsRepo, ClaimProjectsRepo, GraphRepo } from '../src/index.js';

let db: Database;
let repo: ClaimProjectsRepo;
let briefings: BriefingsRepo;
let graph: GraphRepo;

const NOW = 1_700_000_000_000;
const ARTIFACT = 'artifact-1';

/** A `briefings` row for provenance — `briefing_id` is still a real FK. */
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
  it('reports no labels before anything is filed', () => {
    expect(repo.listAll()).toEqual([]);
  });

  it('set then list round-trips one label', () => {
    const briefingId = makeBriefing('b1');
    const projectId = makeProject('Migration');

    repo.setProject(ARTIFACT, projectId, NOW, 'user', briefingId);

    expect(repo.listAll()).toEqual([
      { artifactId: ARTIFACT, projectId, briefingId, taggedAt: NOW, origin: 'user' },
    ]);
  });

  it('SURVIVES A NEW BRIEFING — the bug migration 012 exists to fix', () => {
    // Every Refresh mints a new briefing id. Before 012 the label was keyed on
    // it, so the dropdown went blank and the user re-filed the same thread over
    // and over (observed: one artifact, five rows, five briefings).
    const first = makeBriefing('b1');
    const projectId = makeProject('Migration');
    repo.setProject(ARTIFACT, projectId, NOW, 'user', first);

    makeBriefing('b2'); // the Refresh

    const tags = repo.listAll();
    expect(tags).toHaveLength(1);
    expect(tags[0]?.projectId).toBe(projectId);
  });

  it('re-filing the same thread REPLACES the label rather than duplicating it', () => {
    const briefingId = makeBriefing('b1');
    const first = makeProject('Migration');
    const second = makeProject('Pilot');

    repo.setProject(ARTIFACT, first, NOW, 'user', briefingId);
    repo.setProject(ARTIFACT, second, NOW + 5_000, 'user', briefingId);

    const tags = repo.listAll();
    expect(tags).toHaveLength(1);
    expect(tags[0]?.projectId).toBe(second);
    expect(tags[0]?.taggedAt).toBe(NOW + 5_000);
  });

  it('null clears a label, and clearing an unfiled thread is a no-op', () => {
    const projectId = makeProject('Migration');

    repo.setProject(ARTIFACT, projectId, NOW);
    repo.setProject(ARTIFACT, null, NOW);
    expect(repo.listAll()).toEqual([]);

    // The dropdown's "No project" option must be idempotent.
    expect(() => repo.setProject('never-filed', null, NOW)).not.toThrow();
    expect(repo.listAll()).toEqual([]);
  });

  it('listForProject spans briefings — the filter control read', () => {
    const first = makeBriefing('b1');
    const second = makeBriefing('b2');
    const migration = makeProject('Migration');
    const pilot = makeProject('Pilot');

    repo.setProject('a1', migration, NOW, 'user', first);
    repo.setProject('a2', migration, NOW + 1_000, 'user', second);
    repo.setProject('a3', pilot, NOW + 2_000, 'user', second);

    // Newest first, so a filtered view leads with the most recent filing.
    expect(repo.listForProject(migration).map((t) => t.artifactId)).toEqual(['a2', 'a1']);
    expect(repo.listForProject(pilot).map((t) => t.artifactId)).toEqual(['a3']);
  });

  it('defaults a hand-set label to origin "user"', () => {
    const projectId = makeProject('Migration');
    repo.setProject(ARTIFACT, projectId, NOW);
    expect(repo.listAll()[0]?.origin).toBe('user');
  });

  it('records an auto-detected label as origin "auto"', () => {
    const projectId = makeProject('Migration');
    expect(repo.suggestProject(ARTIFACT, projectId, NOW)).toBe(true);
    expect(repo.listAll()[0]?.origin).toBe('auto');
  });

  it('a suggestion NEVER overwrites a label already on the thread', () => {
    // Detection re-runs on every briefing load; this is what stops it from
    // re-asserting itself over the user's own filing.
    const chosen = makeProject('Migration');
    const guessed = makeProject('Pilot');

    repo.setProject(ARTIFACT, chosen, NOW);
    expect(repo.suggestProject(ARTIFACT, guessed, NOW + 1_000)).toBe(false);

    const tag = repo.listAll()[0];
    expect(tag?.projectId).toBe(chosen);
    expect(tag?.origin).toBe('user');
    expect(tag?.taggedAt).toBe(NOW);
  });

  it('a suggestion does not overwrite an EARLIER suggestion either', () => {
    const first = makeProject('Migration');
    const second = makeProject('Pilot');

    expect(repo.suggestProject(ARTIFACT, first, NOW)).toBe(true);
    expect(repo.suggestProject(ARTIFACT, second, NOW + 1_000)).toBe(false);
    expect(repo.listAll()[0]?.projectId).toBe(first);
  });

  it('a user choice overwrites a suggestion, and takes over its origin', () => {
    const guessed = makeProject('Migration');
    const chosen = makeProject('Pilot');

    repo.suggestProject(ARTIFACT, guessed, NOW);
    repo.setProject(ARTIFACT, chosen, NOW + 1_000);

    const tag = repo.listAll()[0];
    expect(tag?.projectId).toBe(chosen);
    // Correcting a guess makes the row the user's own statement, not a guess.
    expect(tag?.origin).toBe('user');
  });

  it('rejects an origin outside user/auto (the CHECK bites)', () => {
    const projectId = makeProject('Migration');
    expect(() =>
      db
        .prepare(
          `INSERT INTO claim_projects (artifact_id, project_id, briefing_id, tagged_at, origin)
           VALUES (?, ?, NULL, ?, 'guessed')`,
        )
        .run(ARTIFACT, projectId, NOW),
    ).toThrow();
  });

  it('refuses a label pointing at a project that does not exist (FK bites)', () => {
    expect(() => repo.setProject(ARTIFACT, 'no-such-project', NOW)).toThrow();
  });

  it('deleting a project takes its labels with it', () => {
    const projectId = makeProject('Migration');
    repo.setProject(ARTIFACT, projectId, NOW);

    // ON DELETE CASCADE: a label with no project is not a meaningful row.
    db.prepare('DELETE FROM projects WHERE project_id = ?').run(projectId);

    expect(repo.listAll()).toEqual([]);
  });

  it('KEEPS the label when the briefing it was filed in is deleted', () => {
    // ON DELETE SET NULL, unlike the project FK: retention purging an old
    // briefing must not discard the user's filing of the underlying thread.
    const briefingId = makeBriefing('b1');
    const projectId = makeProject('Migration');
    repo.setProject(ARTIFACT, projectId, NOW, 'user', briefingId);

    db.prepare('DELETE FROM briefings WHERE briefing_id = ?').run(briefingId);

    const tag = repo.listAll()[0];
    expect(tag?.projectId).toBe(projectId);
    expect(tag?.briefingId).toBeNull();
  });
});
