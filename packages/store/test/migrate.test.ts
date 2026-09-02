import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDb, migrate, currentSchemaVersion } from '../src/index.js';

/** Every table in the v1 DDL (§4.2), plus the migration bookkeeping table. */
const EXPECTED_TABLES = [
  'events',
  'artifacts',
  'people',
  'projects',
  'relationships',
  'extractions',
  'state_deltas',
  'pending_items',
  'synthesis_watermark',
  'briefings',
  'briefing_claims',
  'feedback',
  'briefing_schedules',
  'ai_calls',
  'schema_version',
] as const;

const tableNames = (db: Database): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
    (r) => r.name,
  );

describe('migrate — schema v1', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates every table in the v1 DDL on a fresh db', () => {
    migrate(db);
    const names = tableNames(db);
    for (const expected of EXPECTED_TABLES) {
      expect(names, `missing table: ${expected}`).toContain(expected);
    }
  });

  it('creates the derived current_state_deltas view', () => {
    migrate(db);
    const view = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='view' AND name='current_state_deltas'`)
      .get();
    expect(view).toBeDefined();
  });

  it('reports version 0 before any migration has run', () => {
    expect(currentSchemaVersion(db)).toBe(0);
  });

  it('records a schema_version row with a max version > 0', () => {
    migrate(db);

    const rows = db.prepare(`SELECT version FROM schema_version`).all() as { version: number }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);

    const max = (
      db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as { version: number }
    ).version;
    expect(max).toBeGreaterThan(0);
    expect(currentSchemaVersion(db)).toBe(max);
  });

  it('is idempotent — a second run neither throws nor re-applies', () => {
    migrate(db);
    const before = db
      .prepare(`SELECT version, applied_at FROM schema_version ORDER BY version`)
      .all();

    expect(() => migrate(db)).not.toThrow();

    const after = db
      .prepare(`SELECT version, applied_at FROM schema_version ORDER BY version`)
      .all();
    expect(after).toEqual(before);

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM schema_version`).get() as { n: number }
    ).n;
    expect(count).toBe(before.length);
  });
});

describe('openDb — pragmas', () => {
  it('has foreign_keys ON', () => {
    const db = openDb(':memory:');
    try {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rejects a briefing_claim citing a non-existent artifact', () => {
    const db = openDb(':memory:');
    try {
      migrate(db);
      db.prepare(
        `INSERT INTO briefings
           (briefing_id, window_start, window_end, generated_at, mode, narrative_path, delta_ids_json)
         VALUES ('b1', 0, 1000, 1000, 'llm', '/tmp/b1.md', '[]')`,
      ).run();

      expect(() =>
        db
          .prepare(
            `INSERT INTO briefing_claims
               (claim_id, briefing_id, ordinal, section, text, citation_artifact_id)
             VALUES ('c1', 'b1', 1, 'summary', 'a claim', 'does-not-exist')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });

  it('reads back journal_mode = wal for a file-backed db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-store-'));
    const file = join(dir, 'test.db');
    const db = openDb(file);
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
