import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { PendingItemsRepo, type NewPendingItem } from '../src/repos/pending.js';

let db: Database;
let repo: PendingItemsRepo;

const DELTA_ID = 'd1';
const ARTIFACT_ID = 'a1';

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new PendingItemsRepo(db);

  // pending_items has real FKs to both artifacts and state_deltas, and
  // foreign_keys is ON — an uncited pending item must not be insertable.
  db.prepare(
    `INSERT INTO artifacts (artifact_id, source, kind, external_ref, first_seen_at, last_seen_at)
     VALUES (?, 'slack', 'message', 'https://slack/x', 1000, 1000)`,
  ).run(ARTIFACT_ID);
  db.prepare(
    `INSERT INTO state_deltas
       (delta_id, thread_key, version, summary, kind, confidence,
        source_event_ids_json, citation_artifact_ids_json, model, prompt_version, created_at)
     VALUES (?, 'C1:1', 1, 'we owe Dana a schema', 'decision', 0.9, '[]', '["a1"]', 'llama3', 'v1', 1000)`,
  ).run(DELTA_ID);
});

afterEach(() => {
  db.close();
});

const makePending = (over: Partial<NewPendingItem> = {}): NewPendingItem => ({
  deltaId: DELTA_ID,
  description: 'send Dana the migration plan',
  confidence: 0.8,
  citationArtifactId: ARTIFACT_ID,
  createdAt: 1_000,
  ...over,
});

describe('PendingItemsRepo.insert / listOpen', () => {
  it('defaults a new item to open and lists it', () => {
    const inserted = repo.insert(makePending());

    expect(inserted.status).toBe('open');
    expect(inserted.resolvedAt).toBeNull();
    expect(inserted.pendingId).toBeTruthy();

    const open = repo.listOpen();
    expect(open.map((p) => p.pendingId)).toContain(inserted.pendingId);
    expect(open[0]?.description).toBe('send Dana the migration plan');
    expect(open[0]?.citationArtifactId).toBe(ARTIFACT_ID);
  });

  it('honours a caller-supplied pending_id', () => {
    const inserted = repo.insert(makePending({ pendingId: 'p1' }));
    expect(inserted.pendingId).toBe('p1');
    expect(repo.getById('p1')?.description).toBe('send Dana the migration plan');
  });

  it('returns undefined from getById for an unknown id', () => {
    expect(repo.getById('does-not-exist')).toBeUndefined();
  });

  it('lists open items oldest first', () => {
    repo.insert(makePending({ pendingId: 'p2', createdAt: 2_000 }));
    repo.insert(makePending({ pendingId: 'p1', createdAt: 1_000 }));

    expect(repo.listOpen().map((p) => p.pendingId)).toEqual(['p1', 'p2']);
  });
});

describe('PendingItemsRepo.resolve', () => {
  it('drops the item out of listOpen and records status + resolvedAt', () => {
    const inserted = repo.insert(makePending({ pendingId: 'p1' }));

    repo.resolve(inserted.pendingId, 9_000);

    expect(repo.listOpen().map((p) => p.pendingId)).not.toContain('p1');
    const after = repo.getById('p1');
    expect(after?.status).toBe('resolved');
    expect(after?.resolvedAt).toBe(9_000);
  });

  it('leaves other open items alone', () => {
    repo.insert(makePending({ pendingId: 'p1', createdAt: 1_000 }));
    repo.insert(makePending({ pendingId: 'p2', createdAt: 2_000 }));

    repo.resolve('p1', 9_000);

    expect(repo.listOpen().map((p) => p.pendingId)).toEqual(['p2']);
  });
});

describe('PendingItemsRepo.dismiss', () => {
  it('drops the item out of listOpen and records status + resolvedAt', () => {
    const inserted = repo.insert(makePending({ pendingId: 'p1' }));

    repo.dismiss(inserted.pendingId, 9_500);

    expect(repo.listOpen().map((p) => p.pendingId)).not.toContain('p1');
    const after = repo.getById('p1');
    // Distinct from 'resolved' on purpose: this one was a synthesis false positive.
    expect(after?.status).toBe('dismissed');
    expect(after?.resolvedAt).toBe(9_500);
  });
});
