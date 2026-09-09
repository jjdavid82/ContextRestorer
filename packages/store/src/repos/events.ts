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
  private readonly stmtCountByThread: Database.Statement<[string]>;
  private readonly stmtWindow: Database.Statement<[number, number]>;
  private readonly stmtCountUnextracted: Database.Statement<[]>;
  private readonly stmtUnextractedThreadCounts: Database.Statement<[]>;
  private readonly stmtListUnextracted: Database.Statement<[number]>;
  private readonly stmtNewestByPrefix: Database.Statement<[string, string]>;
  private readonly stmtNewestBySource: Database.Statement<[string]>;
  private readonly stmtThreadExtractionState: Database.Statement<[string]>;

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

    this.stmtCountByThread = this.db.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE thread_key = ?`,
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

    // Per-thread unextracted counts, for the Layer-1 call estimate. Layer 1
    // batches per thread, so the number of model calls the backlog costs is
    // `SUM(ceil(threadCount / batchSize))`, not `total / batchSize`.
    this.stmtUnextractedThreadCounts = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM events e
        WHERE NOT EXISTS (SELECT 1 FROM extractions x WHERE x.event_id = e.event_id)
        GROUP BY e.thread_key`,
    );

    // Same predicate as the count above, returning the rows themselves. SQLite
    // treats a negative LIMIT as "no limit", which is how the unbounded call is
    // expressed without a second prepared statement.
    //
    // NEWEST first, which reverses the original ordering. See
    // {@link listUnextracted} for why: draining oldest-first is the right shape
    // for a queue and the wrong shape for this product.
    this.stmtListUnextracted = this.db.prepare(
      `SELECT * FROM events e
       WHERE NOT EXISTS (SELECT 1 FROM extractions x WHERE x.event_id = e.event_id)
       ORDER BY occurred_at DESC, event_id DESC
       LIMIT ?`,
    );

    // A half-open `thread_key` range, not `LIKE 'prefix%'`: LIKE is
    // case-insensitive by default and cannot use `idx_events_thread`; a range
    // can. Both bounds are computed by the caller.
    this.stmtNewestByPrefix = this.db.prepare(
      `SELECT MAX(occurred_at) AS m FROM events WHERE thread_key >= ? AND thread_key < ?`,
    );

    this.stmtNewestBySource = this.db.prepare(
      `SELECT MAX(occurred_at) AS m FROM events WHERE source = ?`,
    );

    // LEFT JOIN, not a NOT EXISTS pair: one index-driven pass over the thread's
    // events answers all three counts, and `idx_events_thread` plus
    // `idx_extractions_event` (migration 009) make it a lookup rather than a scan.
    this.stmtThreadExtractionState = this.db.prepare(
      // COALESCE, not decoration: `SUM` over zero rows is NULL, so an unknown
      // thread would otherwise return `unextracted: null` behind a `number`
      // type — and `null === 0` is false, which would quietly route Layer 2's
      // terminal-empty decision the wrong way.
      `SELECT COUNT(*) AS events,
              COALESCE(SUM(CASE WHEN x.event_id IS NULL THEN 1 ELSE 0 END), 0) AS unextracted,
              COALESCE(
                SUM(CASE WHEN x.class IS NOT NULL AND x.class <> 'noise' THEN 1 ELSE 0 END),
                0
              ) AS signal
         FROM events e
         LEFT JOIN extractions x ON x.event_id = e.event_id
        WHERE e.thread_key = ?`,
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

  /**
   * How many events are on one conversation.
   *
   * The count-only counterpart of {@link listByThread}: the Layer 2 scheduler
   * wants this number for a diagnostic trace field and nothing else, so it must
   * not pay to materialise and JSON-parse every payload. Hits `idx_events_thread`.
   */
  countByThread(threadKey: string): number {
    const row = this.stmtCountByThread.get(threadKey) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Events whose `occurredAt` falls in the half-open interval `[start, end)`. */
  listWindow(start: number, end: number): Event[] {
    return (this.stmtWindow.all(start, end) as EventRow[]).map(fromRow);
  }

  /**
   * Newest `occurred_at` among events whose `thread_key` starts with `prefix`,
   * or `null` when there are none.
   *
   * The poller keeps its resume cursors only in memory, so every source falls
   * back to a bounded backfill window on restart. This lets a connector resume
   * a cursor-less fetch from the last event it actually stored instead — closing
   * the gap between "app was closed" and "backfill window" without paging a
   * whole channel's history.
   *
   * `prefix` MUST include the key's delimiter (`"C123:"`, not `"C123"`): the
   * upper bound is the prefix with its final character bumped by one, so a
   * trailing `:` becomes `;` and the range covers exactly the keys under that
   * channel — never a neighbour like `C1234:…`.
   */
  newestOccurredAtByThreadPrefix(prefix: string): number | null {
    const last = prefix.charCodeAt(prefix.length - 1);
    const hi = prefix.slice(0, -1) + String.fromCharCode(last + 1);
    const row = this.stmtNewestByPrefix.get(prefix, hi) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  /**
   * Newest `occurred_at` across all events from `source`, or `null` when there
   * are none. The whole-source counterpart of {@link
   * newestOccurredAtByThreadPrefix} — for Gmail, which has one mailbox and no
   * per-conversation resume point, this is what lets a cursor-less sync resume
   * from real data instead of the fixed backfill window (see `GmailClient`).
   */
  newestOccurredAtBySource(source: string): number | null {
    const row = this.stmtNewestBySource.get(source) as { m: number | null } | undefined;
    return row?.m ?? null;
  }

  /**
   * Layer-1 progress for ONE thread: how many events it has, how many are still
   * unextracted, and how many carry a class other than `noise`.
   *
   * Exists so Layer 2 can tell its two kinds of empty apart. Retrieval returning
   * no chunks for a thread has two causes with opposite lifetimes: extraction is
   * still in flight (transient — a chunk is coming), or every event on the
   * thread was classified `noise` and therefore contributed no chunk at all
   * (`layer1/extract.ts` only embeds non-noise events), which is permanent. The
   * scheduler used to retry both for its whole budget and then park the thread,
   * reporting a summarization failure for a conversation that simply had nothing
   * in it.
   *
   * `unextracted === 0` is the load-bearing half, and it settles the question on
   * its own: `extractEvent` upserts the chunk BEFORE writing the `extractions`
   * row, so once every event on a thread has a row, every chunk that thread will
   * ever have is already in the vector store. `signal` is reported alongside
   * because it is the same query and it lets the caller say *why* the thread is
   * empty rather than only that it is.
   */
  threadExtractionState(threadKey: string): {
    events: number;
    unextracted: number;
    signal: number;
  } {
    const row = this.stmtThreadExtractionState.get(threadKey) as
      | { events: number; unextracted: number; signal: number }
      | undefined;
    return row ?? { events: 0, unextracted: 0, signal: 0 };
  }

  /** How many events still have no Layer-1 extraction — the ingestion backlog. */
  countUnextracted(): number {
    const row = this.stmtCountUnextracted.get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Roughly how many Layer-1 **model calls** the current extraction backlog
   * costs — `SUM(ceil(threadUnextracted / batchSize))` over every thread that
   * has unextracted events.
   *
   * `countUnextracted() / batchSize` is wrong for a real mailbox: Layer 1
   * batches a *thread's* events into one call (`extractThread`), so 400 events
   * scattered across 300 threads is ~300 calls, not 100, and an ETA built on
   * the event count alone understates the wait by the fan-out.
   *
   * Still an estimate: it counts structural-noise events the pre-filter drops
   * for free, so it can overstate a noise-heavy backlog — the safe direction
   * for a "how long will this take" number.
   *
   * @param batchSize - `MAX_BATCH_EVENTS` from `@cr/ai`, passed in so the store
   *   keeps no dependency on the extractor. Values `< 1` are treated as `1`.
   */
  unextractedModelCallEstimate(batchSize: number): number {
    const size = Math.max(1, Math.trunc(batchSize));
    const rows = this.stmtUnextractedThreadCounts.all() as Array<{ cnt: number }>;
    let calls = 0;
    for (const { cnt } of rows) calls += Math.ceil(cnt / size);
    return calls;
  }

  /**
   * The events behind {@link countUnextracted}, **newest first** — the work list
   * for Layer 1 and for the periodic recovery sweep.
   *
   * "Needs extraction" is defined solely as "has no row in `extractions`". That
   * is what makes the sweep self-healing: an event whose extraction failed the
   * schema check (no row written) or whose worker crashed mid-flight is
   * indistinguishable from one that was never attempted, and both are correctly
   * re-queued.
   *
   * ### Why newest-first, against the obvious instinct
   *
   * This used to be oldest-first, "so a backlog drains in the order the user
   * experienced it" — the right shape for a queue, and the wrong one for this
   * product. Layer 1 costs ~21s per event of backfill on the shipped model, so a
   * first connect with a real mailbox behind it takes HOURS before anything is
   * briefable, and oldest-first spends every one of those hours on the mail the
   * user cares about least. A returning user asks "what happened while I was
   * out"; newest-first is what makes that window answerable in minutes.
   *
   * This is a THREAD-selection order, not a within-thread reading order. Each
   * `extractions` row is written independently, and `WatermarkRepo`'s `DUE_SQL`
   * holds a thread out of synthesis until EVERY event on it has a row — so a
   * thread cannot be summarized from a partial read of itself. But the model
   * DOES read a thread's events in sequence during batched Layer-1 extraction,
   * so `Layer1Extractor.extractThread` re-sorts each thread's slice back into
   * `(occurred_at, event_id)` order before prompting: this ordering decides
   * which threads are reached first, not how any one of them is read.
   *
   * @param limit - Maximum rows to return. Omit for all of them.
   */
  listUnextracted(limit?: number): Event[] {
    // A `limit` of 0 means 0 rows; only an absent limit means "everything".
    const bound = limit === undefined ? -1 : Math.max(0, Math.trunc(limit));
    return (this.stmtListUnextracted.all(bound) as EventRow[]).map(fromRow);
  }
}
