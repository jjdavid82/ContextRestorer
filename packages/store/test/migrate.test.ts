import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// The stale-dist trap (found while adding migration 007)
// ---------------------------------------------------------------------------

describe('migrations directory resolution', () => {
  it('applies EVERY migration file on disk, not a stale subset', () => {
    // `dist/migrations` is a snapshot written by an explicit `cpSync` in the
    // store's build script; `tsc` does not copy .sql. When `dist/` was probed
    // first, a snapshot taken before migrations 006 and 007 existed shadowed
    // them completely — the schema silently lacked the new columns and the
    // failure surfaced far away as `no such column: produced_by`.
    //
    // This pins the property that broke: the number of applied migrations
    // equals the number of files in the SOURCE directory.
    const dir = new URL('../src/migrations/', import.meta.url);
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.sql'));

    const db = openDb(':memory:');
    try {
      migrate(db);
      // The highest applied version equals the highest file number, so a
      // shadowed migration shows up as a version behind the source tree.
      expect(currentSchemaVersion(db)).toBe(onDisk.length);
    } finally {
      db.close();
    }
  });
});

describe('010_watermark_parked_at — backfilling threads parked by an older build', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Insert a watermark row the way a build without `parked_at` would have left
   * it: attempts burned, no reference point. Written column-by-column so the
   * insert keeps working when the table gains more columns.
   */
  const seedWatermark = (threadKey: string, attempts: number): void => {
    db.prepare(
      `INSERT INTO synthesis_watermark
         (thread_key, source, oldest_unsynth_at, last_event_at, last_synthesized_at, attempts)
       VALUES (?, 'slack', 1000, 1000, NULL, ?)`,
    ).run(threadKey, attempts);
  };

  const parkedAt = (threadKey: string): number | null => {
    const row = db
      .prepare(`SELECT parked_at FROM synthesis_watermark WHERE thread_key = ?`)
      .get(threadKey) as { parked_at: number | null } | undefined;
    return row?.parked_at ?? null;
  };

  it('gives every row that had burned attempts a reference point', () => {
    // Migrate to 009 first, then seed, then let 010 run — the actual upgrade
    // path a user's existing database takes.
    migrateThrough(db, 9);
    seedWatermark('parked', 10);
    seedWatermark('mid-retry', 3);
    seedWatermark('healthy', 0);

    migrate(db);

    // Without this, the revive's comparison against NULL matches nothing and a
    // thread parked by an older build stays parked forever — which is the
    // defect the migration exists to fix.
    expect(parkedAt('parked')).not.toBeNull();
    expect(parkedAt('mid-retry')).not.toBeNull();
    // A thread that never failed is not parked and needs no reference point.
    expect(parkedAt('healthy')).toBeNull();
  });

  it('leaves a fresh install with no stamped rows', () => {
    migrate(db);

    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM synthesis_watermark WHERE parked_at IS NOT NULL`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });
});

describe('013_claim_projects_by_artifact — re-keying labels to the artifact', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('keeps ONE deterministic row per artifact when two share the newest tagged_at', () => {
    migrateThrough(db, 12);

    db.prepare(
      `INSERT INTO projects (project_id, name, origin, stakes_weight, declared_at)
       VALUES ('p-a', 'Alpha', 'declared', 1.0, 1), ('p-b', 'Beta', 'declared', 1.0, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO briefings
         (briefing_id, window_start, window_end, generated_at, mode, narrative_path,
          delta_ids_json, threads_still_processing)
       VALUES ('b-1', 0, 1, 1, 'llm', '/n/1.md', '[]', 0),
              ('b-2', 1, 2, 2, 'llm', '/n/2.md', '[]', 0)`,
    ).run();
    // A rapid re-file: the same artifact tagged in two briefings at the SAME
    // millisecond. `MAX(tagged_at)` matches both — the tie the old GROUP BY
    // resolved arbitrarily.
    db.prepare(
      `INSERT INTO claim_projects (artifact_id, project_id, briefing_id, tagged_at, origin)
       VALUES ('art-1', 'p-a', 'b-1', 5000, 'user'),
              ('art-1', 'p-b', 'b-2', 5000, 'auto')`,
    ).run();

    migrate(db);

    const rows = db
      .prepare(`SELECT artifact_id, project_id, briefing_id, origin FROM claim_projects`)
      .all() as Array<{ artifact_id: string; project_id: string; briefing_id: string; origin: string }>;
    expect(rows).toHaveLength(1);
    // `tagged_at DESC, briefing_id DESC` → 'b-2' wins, and its project/origin
    // travel together — never a mix of one row's project with another's origin.
    expect(rows[0]).toEqual({
      artifact_id: 'art-1',
      project_id: 'p-b',
      briefing_id: 'b-2',
      origin: 'auto',
    });
  });
});

/**
 * Apply only the migrations up to and including `version`, so a test can stand
 * a database up at an older schema and then observe one upgrade in isolation.
 *
 * Duplicates a little of `migrate()`'s file walk on purpose: the point is to
 * stop BEFORE the migration under test, which the real function cannot do.
 */
function migrateThrough(db: Database, version: number): void {
  const dir = join(import.meta.dirname, '..', 'src', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  for (const file of files) {
    const n = Number.parseInt(file.slice(0, 3), 10);
    if (n > version) break;
    db.exec(readFileSync(join(dir, file), 'utf8'));
    db.prepare(`INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)`).run(
      n,
      Date.now(),
    );
  }
}
