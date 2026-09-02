import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { ExtractionsRepo, type NewExtraction } from '../src/repos/extractions.js';

let db: Database;
let repo: ExtractionsRepo;

const EVENT_ID = 'e1';

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new ExtractionsRepo(db);

  // extractions.event_id is a real FK and foreign_keys is ON, so the event must exist.
  db.prepare(
    `INSERT INTO events (event_id, source, source_event_id, thread_key, occurred_at, ingested_at, payload_json)
     VALUES (?, 'slack', 's1', 'C1:1', 1000, 1000, '{}')`,
  ).run(EVENT_ID);
});

afterEach(() => {
  db.close();
});

const makeExtraction = (over: Partial<NewExtraction> = {}): NewExtraction => ({
  eventId: EVENT_ID,
  class: 'decision',
  confidence: 0.87,
  participants: ['p1', 'p2'],
  artifacts: ['a1'],
  model: 'llama3',
  promptVersion: 'v1',
  createdAt: 1_000,
  ...over,
});

describe('ExtractionsRepo', () => {
  it('round-trips participants and artifacts as arrays, not raw JSON strings', () => {
    repo.insert(makeExtraction({ participants: ['p1', 'p2', 'p3'], artifacts: ['a1', 'a2'] }));

    const found = repo.listByEvent(EVENT_ID);

    expect(found).toHaveLength(1);
    const e = found[0];
    expect(e?.participants).toEqual(['p1', 'p2', 'p3']);
    expect(e?.artifacts).toEqual(['a1', 'a2']);
    expect(Array.isArray(e?.participants)).toBe(true);
    expect(Array.isArray(e?.artifacts)).toBe(true);
    expect(e?.class).toBe('decision');
    expect(e?.confidence).toBeCloseTo(0.87);
    expect(e?.promptVersion).toBe('v1');
  });

  it('mints an extraction_id when the caller does not supply one', () => {
    repo.insert(makeExtraction());

    const [e] = repo.listByEvent(EVENT_ID);
    expect(e?.extractionId).toBeTruthy();
    expect(typeof e?.extractionId).toBe('string');
  });

  it('honours a caller-supplied extraction_id and finds it by id', () => {
    repo.insert(makeExtraction({ extractionId: 'x1' }));

    const e = repo.getById('x1');
    expect(e?.extractionId).toBe('x1');
    expect(e?.eventId).toBe(EVENT_ID);
    expect(e?.participants).toEqual(['p1', 'p2']);
  });

  it('returns undefined from getById for an unknown id', () => {
    expect(repo.getById('does-not-exist')).toBeUndefined();
  });

  it('returns every extraction for an event, oldest first', () => {
    repo.insert(makeExtraction({ extractionId: 'x2', createdAt: 2_000, promptVersion: 'v2' }));
    repo.insert(makeExtraction({ extractionId: 'x1', createdAt: 1_000, promptVersion: 'v1' }));

    const ids = repo.listByEvent(EVENT_ID).map((e) => e.extractionId);
    expect(ids).toEqual(['x1', 'x2']);
  });

  it('returns an empty array for an event with no extractions', () => {
    expect(repo.listByEvent('unknown-event')).toEqual([]);
  });

  it('handles empty id arrays', () => {
    repo.insert(makeExtraction({ extractionId: 'x1', participants: [], artifacts: [] }));

    const e = repo.getById('x1');
    expect(e?.participants).toEqual([]);
    expect(e?.artifacts).toEqual([]);
  });
});
