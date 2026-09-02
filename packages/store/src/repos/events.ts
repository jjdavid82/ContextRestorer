/**
 * Repository over the raw `events` table — the append-only source of truth.
 *
 * Two invariants shape this file:
 *
 * 1. **Idempotency (NFR-6 / AC-10).** `UNIQUE (source, source_event_id)` means a
 *    connector replaying the same item hits a constraint violation. That is the
 *    *expected* steady-state outcome of a backfill overlapping a live poll, not
 *    an error, so {@link EventsRepo.insertIfAbsent} translates it into a plain
 *    `{ inserted: false }` result instead of letting it surface as a throw.
 *
 * 2. **Append-only.** `events_no_update` / `events_no_delete` triggers abort any
 *    UPDATE or DELETE, so there is deliberately no `update` method here: a replay
 *    must leave the originally-persisted row byte-for-byte intact.
 */

import type Database from 'better-sqlite3';
import type { Event, SourceId } from '@cr/core';

/** Raw `events` row as SQLite hands it back (snake_case, no JSON parsing). */
interface EventRow {
  event_id: string;
  source: string;
  source_event_id: string;
  thread_key: string;
  actor_id: string | null;
  occurred_at: number;
  ingested_at: number;
  payload_json: string;
  redaction_count: number;
}

/** Column order shared by the INSERT statement and {@link toRow}. */
type EventInsertParams = [
  string, // event_id
  string, // source
  string, // source_event_id
  string, // thread_key
  string | null, // actor_id
  number, // occurred_at
  number, // ingested_at
  string, // payload_json
  number, // redaction_count
];

/** Domain → row. `payload` is serialized here; the DB stores redacted JSON text. */
function toRow(e: Event): EventInsertParams {
  return [
    e.eventId,
    e.source,
    e.sourceEventId,
    e.threadKey,
    e.actorId ?? null,
    e.occurredAt,
    e.ingestedAt,
    JSON.stringify(e.payload),
    e.redactionCount,
  ];
}

/** Row → domain. `actor_id` is nullable in SQL but modelled as a string. */
function fromRow(r: EventRow): Event {
  return {
    eventId: r.event_id,
    source: r.source as SourceId,
    sourceEventId: r.source_event_id,
    threadKey: r.thread_key,
    actorId: r.actor_id ?? '',
    occurredAt: r.occurred_at,
    ingestedAt: r.ingested_at,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    redactionCount: r.redaction_count,
  };
}

/** True when `err` is SQLite rejecting a duplicate `(source, source_event_id)`. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

export class EventsRepo {
  private readonly stmtInsert: Database.Statement<EventInsertParams>;
  private readonly stmtByThread: Database.Statement<[string]>;
  private readonly stmtWindow: Database.Statement<[number, number]>;
  private readonly stmtCountUnextracted: Database.Statement<[]>;
  private readonly stmtListUnextracted: Database.Statement<[number]>;

  constructor(private db: Database.Database) {
    this.stmtInsert = this.db.prepare(
      `INSERT INTO events
         (event_id, source, source_event_id, thread_key, actor_id,
          occurred_at, ingested_at, payload_json, redaction_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.stmtByThread = this.db.prepare(
      `SELECT * FROM events WHERE thread_key = ? ORDER BY occurred_at ASC, event_id ASC`,
    );

    // Half-open [start, end): `end` belongs to the *next* window, so briefings
    // over adjacent windows never double-count an event on the boundary.
    this.stmtWindow = this.db.prepare(
      `SELECT * FROM events
       WHERE occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at ASC, event_id ASC`,
    );

    this.stmtCountUnextracted = this.db.prepare(
      `SELECT COUNT(*) AS n FROM events e
       WHERE NOT EXISTS (SELECT 1 FROM extractions x WHERE x.event_id = e.event_id)`,
    );

    // Same predicate as the count above, returning the rows themselves. SQLite
    // treats a negative LIMIT as "no limit", which is how the unbounded call is
    // expressed without a second prepared statement.
    this.stmtListUnextracted = this.db.prepare(
      `SELECT * FROM events e
       WHERE NOT EXISTS (SELECT 1 FROM extractions x WHERE x.event_id = e.event_id)
       ORDER BY occurred_at ASC, event_id ASC
       LIMIT ?`,
    );
  }

  /**
   * Persist `e` unless an event with the same `(source, sourceEventId)` already
   * exists.
   *
   * Never updates: on a replay the stored row keeps its original payload, actor
   * and `ingestedAt`. Returns `{ inserted: false }` rather than throwing, so
   * callers can safely re-ingest overlapping ranges (AC-10).
   */
  insertIfAbsent(e: Event): { inserted: boolean } {
    try {
      this.stmtInsert.run(...toRow(e));
      return { inserted: true };
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { inserted: false }; // expected on replay — not an error path
      }
      throw err;
    }
  }

  /** All events on one conversation, oldest first. */
  listByThread(threadKey: string): Event[] {
    return (this.stmtByThread.all(threadKey) as EventRow[]).map(fromRow);
  }

  /** Events whose `occurredAt` falls in the half-open interval `[start, end)`. */
  listWindow(start: number, end: number): Event[] {
    return (this.stmtWindow.all(start, end) as EventRow[]).map(fromRow);
  }

  /** How many events still have no Layer-1 extraction — the ingestion backlog. */
  countUnextracted(): number {
    const row = this.stmtCountUnextracted.get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * The events behind {@link countUnextracted}, oldest first — the work list for
   * Layer 1 and for the periodic recovery sweep.
   *
   * "Needs extraction" is defined solely as "has no row in `extractions`". That
   * is what makes the sweep self-healing: an event whose extraction failed the
   * schema check (no row written) or whose worker crashed mid-flight is
   * indistinguishable from one that was never attempted, and both are correctly
   * re-queued. Ordering is oldest-first so a backlog drains in the order the
   * user experienced it.
   *
   * @param limit - Maximum rows to return. Omit for all of them.
   */
  listUnextracted(limit?: number): Event[] {
    // A `limit` of 0 means 0 rows; only an absent limit means "everything".
    const bound = limit === undefined ? -1 : Math.max(0, Math.trunc(limit));
    return (this.stmtListUnextracted.all(bound) as EventRow[]).map(fromRow);
  }
}
