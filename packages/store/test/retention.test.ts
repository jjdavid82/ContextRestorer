import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { purgeRawEventsOlderThan, deleteEverything } from '../src/retention.js';

let db: Database;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});

afterEach(() => {
  db.close();
});

/** Names of the append-only triggers that must survive every privileged write. */
const APPEND_ONLY_TRIGGERS = ['deltas_no_update', 'events_no_delete', 'events_no_update'];

/** Trigger names currently registered in the schema, sorted for stable compare. */
function triggerNames(): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * Assert the guards are not merely *listed* in `sqlite_master` but actually
 * *fire*. A recreated-but-broken trigger would pass a name check while leaving
 * the source of truth mutable, so both halves are checked together.
 */
function expectAppendOnlyEnforced(eventId: string): void {
  expect(triggerNames()).toEqual(APPEND_ONLY_TRIGGERS);
  expect(() =>
    db.prepare(`UPDATE events SET actor_id = 'x' WHERE event_id = ?`).run(eventId),
  ).toThrow(/append-only/);
  expect(() => db.prepare(`DELETE FROM events WHERE event_id = ?`).run(eventId)).toThrow(
    /append-only/,
  );
}

function insertEvent(eventId: string, occurredAt: number): void {
  db.prepare(
    `INSERT INTO events
       (event_id, source, source_event_id, thread_key, occurred_at, ingested_at, payload_json)
     VALUES (?, 'slack', ?, 'C1:1', ?, ?, '{}')`,
  ).run(eventId, `s-${eventId}`, occurredAt, occurredAt);
}

function insertArtifact(artifactId: string): void {
  db.prepare(
    `INSERT INTO artifacts
       (artifact_id, source, kind, external_ref, title, state, owner_id, first_seen_at, last_seen_at)
     VALUES (?, 'slack', 'thread', 'https://slack/x', 't', 'open', 'p1', 1000, 1000)`,
  ).run(artifactId);
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

describe('purgeRawEventsOlderThan — 90-day retention (NFR)', () => {
  it('deletes events older than the cutoff and leaves newer events untouched', () => {
    insertEvent('old', 1_000);
    insertEvent('new', 5_000);

    const purged = purgeRawEventsOlderThan(db, 3_000);

    expect(purged).toBe(1);
    const remaining = db.prepare(`SELECT event_id FROM events`).all() as { event_id: string }[];
    expect(remaining.map((r) => r.event_id)).toEqual(['new']);
  });

  it('treats the cutoff as exclusive — an event exactly at the cutoff is kept', () => {
    insertEvent('at-cutoff', 3_000);

    expect(purgeRawEventsOlderThan(db, 3_000)).toBe(0);
    expect(countRows('events')).toBe(1);
  });

  it('cascades to extractions so the purge is not blocked by a dangling FK', () => {
    insertEvent('old', 1_000);
    insertEvent('new', 5_000);
    db.prepare(
      `INSERT INTO extractions
         (extraction_id, event_id, class, confidence, participants_json, artifacts_json,
          model, prompt_version, created_at)
       VALUES ('x-old', 'old', 'decision', 0.9, '[]', '[]', 'm', 'v1', 1000),
              ('x-new', 'new', 'decision', 0.9, '[]', '[]', 'm', 'v1', 5000)`,
    ).run();

    expect(purgeRawEventsOlderThan(db, 3_000)).toBe(1);

    const kept = db.prepare(`SELECT extraction_id FROM extractions`).all() as {
      extraction_id: string;
    }[];
    expect(kept.map((r) => r.extraction_id)).toEqual(['x-new']);
  });

  it('leaves derived state (state_deltas) alone — only raw payloads expire', () => {
    insertEvent('old', 1_000);
    db.prepare(
      `INSERT INTO state_deltas
         (delta_id, thread_key, version, summary, kind, confidence,
          source_event_ids_json, citation_artifact_ids_json, model, prompt_version, created_at)
       VALUES ('d1', 'C1:1', 1, 'chose Postgres', 'decision', 0.9, '["old"]', '[]', 'm', 'v1', 1000)`,
    ).run();

    purgeRawEventsOlderThan(db, 3_000);

    expect(countRows('events')).toBe(0);
    expect(countRows('state_deltas')).toBe(1);
  });

  it('STILL enforces append-only after a purge — the guards are put back', () => {
    // The most important assertion in this file. A purge that forgot to
    // recreate `events_no_delete` would silently downgrade the source of truth
    // from an append-only log to an ordinary mutable table, and every other
    // test in the suite would keep passing.
    insertEvent('old', 1_000);
    insertEvent('new', 5_000);

    purgeRawEventsOlderThan(db, 3_000);

    expectAppendOnlyEnforced('new');
  });

  it('keeps the guards intact across repeated purges', () => {
    insertEvent('a', 1_000);
    insertEvent('b', 2_000);
    insertEvent('c', 9_000);

    purgeRawEventsOlderThan(db, 1_500);
    expect(triggerNames()).toEqual(APPEND_ONLY_TRIGGERS);

    purgeRawEventsOlderThan(db, 2_500);
    expect(triggerNames()).toEqual(APPEND_ONLY_TRIGGERS);

    purgeRawEventsOlderThan(db, 2_500); // no-op run, must not double-create
    expect(countRows('events')).toBe(1);

    expectAppendOnlyEnforced('c');
  });

  it('is atomic and self-healing when the delete throws mid-transaction', () => {
    // Force a failure *after* the DROP TRIGGER has executed by making the very
    // next `db.prepare` throw. Two properties must hold afterwards:
    //   (a) the error propagates (a silently swallowed purge is worse than a
    //       loud one — the caller must know retention did not run), and
    //   (b) the append-only guard is back, both listed and firing.
    //
    // better-sqlite3's `db.transaction()` wrapper rolls back when the wrapped
    // function throws, and the `finally` block runs *before* the throw
    // propagates out of that function — so the CREATE TRIGGER executes inside
    // the doomed transaction and is rolled back together with the DROP. The
    // net effect is the original trigger, never removed at the catalog level,
    // is still there. Verified below rather than assumed.
    insertEvent('old', 1_000);
    insertEvent('new', 5_000);

    const mutable = db as unknown as Record<'prepare', unknown>;
    const realPrepare = mutable.prepare;
    mutable.prepare = () => {
      throw new Error('simulated disk failure');
    };

    try {
      expect(() => purgeRawEventsOlderThan(db, 3_000)).toThrow(/simulated disk failure/);
    } finally {
      mutable.prepare = realPrepare;
    }

    expect(db.inTransaction).toBe(false);
    // Nothing was purged: the whole transaction rolled back.
    expect(countRows('events')).toBe(2);
    expectAppendOnlyEnforced('new');

    // …and the very next purge still works normally.
    expect(purgeRawEventsOlderThan(db, 3_000)).toBe(1);
    expectAppendOnlyEnforced('new');
  });
});

/** Every table `deleteEverything` is required to empty. */
const USER_DATA_TABLES = [
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
];

/** Populate at least one FK-valid row in every user-data table. */
function seedEverything(): void {
  insertArtifact('a1');
  insertEvent('e1', 1_000);
  insertEvent('e2', 5_000);

  db.prepare(
    `INSERT INTO people (person_id, display_name, email_hash, is_self)
     VALUES ('p1', 'Dana', 'hash', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO projects (project_id, name, origin, stakes_weight, declared_at)
     VALUES ('proj1', 'Apollo', 'declared', 2.0, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO relationships (from_id, rel, to_id, confidence)
     VALUES ('p1', 'owns', 'proj1', 0.9)`,
  ).run();
  db.prepare(
    `INSERT INTO extractions
       (extraction_id, event_id, class, confidence, participants_json, artifacts_json,
        model, prompt_version, created_at)
     VALUES ('x1', 'e1', 'decision', 0.9, '["p1"]', '["a1"]', 'm', 'v1', 1000)`,
  ).run();

  // A two-link supersedes chain, so the self-referencing FK is exercised.
  db.prepare(
    `INSERT INTO state_deltas
       (delta_id, thread_key, artifact_id, version, supersedes, summary, kind, confidence,
        source_event_ids_json, citation_artifact_ids_json, model, prompt_version, created_at)
     VALUES ('d1', 'C1:1', 'a1', 1, NULL, 'shipping Friday', 'decision', 0.9,
             '["e1"]', '["a1"]', 'm', 'v1', 1000),
            ('d2', 'C1:1', 'a1', 2, 'd1', 'slipped to Monday', 'reversal', 0.8,
             '["e2"]', '["a1"]', 'm', 'v1', 2000)`,
  ).run();

  db.prepare(
    `INSERT INTO pending_items
       (pending_id, delta_id, description, confidence, citation_artifact_id, status, created_at)
     VALUES ('pi1', 'd2', 'confirm the new date', 0.6, 'a1', 'open', 2000)`,
  ).run();
  db.prepare(
    `INSERT INTO synthesis_watermark
       (thread_key, source, oldest_unsynth_at, last_event_at, last_synthesized_at, attempts)
     VALUES ('C1:1', 'slack', 1000, 5000, NULL, 0)`,
  ).run();

  db.prepare(
    `INSERT INTO briefings
       (briefing_id, window_start, window_end, generated_at, mode, narrative_path,
        delta_ids_json, threads_still_processing)
     VALUES ('b1', 0, 10000, 10000, 'llm', '/data/narratives/b1.md', '["d2"]', 0),
            ('b2', 10000, 20000, 20000, 'template', '/data/narratives/b2.md', '["d2"]', 1),
            ('b3', 20000, 30000, 30000, 'llm', '/data/narratives/b1.md', '[]', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO briefing_claims
       (claim_id, briefing_id, ordinal, section, text, citation_artifact_id, delta_id)
     VALUES ('c1', 'b1', 1, 'decisions', 'the date slipped', 'a1', 'd2')`,
  ).run();
  db.prepare(
    `INSERT INTO feedback (feedback_id, briefing_id, claim_id, verdict, note, created_at)
     VALUES ('f1', 'b1', 'c1', 'relevant', NULL, 11000)`,
  ).run();
  db.prepare(
    `INSERT INTO briefing_schedules
       (schedule_id, cadence, hour_local, minute_local, weekday, enabled, created_at)
     VALUES ('s1', 'weekdays', 8, 30, NULL, 1, 1000)`,
  ).run();
  db.prepare(
    `INSERT INTO ai_calls
       (call_id, trace_id, layer, model, prompt_version, latency_ms, tokens_in, tokens_out,
        outcome, created_at)
     VALUES ('ac1', 'tr1', 1, 'm', 'v1', 120, 10, 20, 'ok', 1000)`,
  ).run();
}

describe('deleteEverything — right to delete (SEC-8)', () => {
  it('empties every user-data table', () => {
    seedEverything();
    for (const table of USER_DATA_TABLES) {
      expect(countRows(table), `${table} should be seeded`).toBeGreaterThan(0);
    }

    deleteEverything(db);

    for (const table of USER_DATA_TABLES) {
      expect(countRows(table), `${table} should be empty after deleteEverything`).toBe(0);
    }
  });

  it('returns the event ids the caller must evict from the vector store', () => {
    seedEverything();

    const { vectorEventIds } = deleteEverything(db);

    expect([...vectorEventIds].sort()).toEqual(['e1', 'e2']);
  });

  it('returns the distinct narrative paths the caller must unlink from disk', () => {
    seedEverything(); // b1 and b3 deliberately share a narrative path

    const { narrativePaths } = deleteEverything(db);

    expect([...narrativePaths].sort()).toEqual([
      '/data/narratives/b1.md',
      '/data/narratives/b2.md',
    ]);
  });

  it('leaves the append-only triggers in place and enforcing', () => {
    seedEverything();

    deleteEverything(db);

    expect(triggerNames()).toEqual(APPEND_ONLY_TRIGGERS);

    // Re-ingest after the wipe, then confirm the guards actually bite again —
    // an erased database must come back append-only, not merely non-empty.
    insertEvent('fresh', 20_000);
    expectAppendOnlyEnforced('fresh');
    expect(() => db.prepare(`UPDATE state_deltas SET summary = 'x'`).run()).not.toThrow(); // no rows
  });

  it('preserves the schema itself — tables, indexes, the view and schema_version', () => {
    seedEverything();
    const versionBefore = countRows('schema_version');

    deleteEverything(db);

    // The migration ledger must survive, or the next migrate() would try to
    // re-apply 001_initial.sql against a schema that already exists.
    expect(countRows('schema_version')).toBe(versionBefore);
    expect(versionBefore).toBeGreaterThan(0);

    const view = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'current_state_deltas'`)
      .get();
    expect(view).toBeDefined();

    // The wiped database is still usable: a fresh insert round-trips.
    insertArtifact('a-new');
    insertEvent('e-new', 30_000);
    expect(countRows('events')).toBe(1);
  });

  it('is a no-op that still reports an empty manifest on an already-empty database', () => {
    const result = deleteEverything(db);

    expect(result).toEqual({ vectorEventIds: [], narrativePaths: [] });
    expect(triggerNames()).toEqual(APPEND_ONLY_TRIGGERS);
  });
});
