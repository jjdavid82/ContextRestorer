import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { ExtractionFailuresRepo } from '../src/repos/extractionFailures.js';

let db: Database;
let repo: ExtractionFailuresRepo;

const seedEvent = (id: string): void => {
  db.prepare(
    `INSERT INTO events (event_id, source, source_event_id, thread_key, occurred_at, ingested_at, payload_json)
     VALUES (?, 'slack', ?, 'C1:1', 1000, 1000, '{}')`,
  ).run(id, id);
};

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new ExtractionFailuresRepo(db);
  seedEvent('e1');
  seedEvent('e2');
});

afterEach(() => {
  db.close();
});

describe('ExtractionFailuresRepo', () => {
  it('counts up from 1 and returns the running total', () => {
    expect(repo.record('e1', 100)).toBe(1);
    expect(repo.record('e1', 200)).toBe(2);
    expect(repo.record('e1', 300)).toBe(3);
  });

  it('tracks each event independently', () => {
    repo.record('e1', 100);
    repo.record('e1', 110);
    repo.record('e2', 120);

    expect(repo.attempts('e1')).toBe(2);
    expect(repo.attempts('e2')).toBe(1);
  });

  it('reports 0 attempts for an event that has never failed', () => {
    expect(repo.attempts('e1')).toBe(0);
  });

  it('keeps first_at and advances last_at', () => {
    repo.record('e1', 100);
    repo.record('e1', 500);

    const row = db
      .prepare(`SELECT first_at, last_at FROM extraction_failures WHERE event_id = 'e1'`)
      .get() as { first_at: number; last_at: number };
    expect(row).toEqual({ first_at: 100, last_at: 500 });
  });

  describe('listRecent', () => {
    it('returns events failed in the window, most-recent last_at first', () => {
      repo.record('e1', 1_000);
      repo.record('e2', 2_000);
      repo.record('e2', 3_000); // e2's last_at advances to 3_000

      expect(repo.listRecent(1_500, 10)).toEqual([
        { eventId: 'e2', attempts: 2, lastAt: 3_000 },
      ]);
    });

    it('honours the limit and is empty on a clean table', () => {
      expect(repo.listRecent(0, 10)).toEqual([]);
      repo.record('e1', 100);
      repo.record('e2', 200);
      expect(repo.listRecent(0, 1)).toEqual([{ eventId: 'e2', attempts: 1, lastAt: 200 }]);
    });
  });
});
