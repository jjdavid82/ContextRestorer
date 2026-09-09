import type { Database } from 'better-sqlite3';

/**
 * Privileged retention / erasure operations — the ONLY module in the codebase
 * permitted to drop the append-only triggers on `events` and `state_deltas`.
 *
 * `events` is the system's source of truth and is append-only *in-engine*
 * (`events_no_update` / `events_no_delete`, see `001_initial.sql`), not merely
 * by convention. Two requirements nonetheless need rows to disappear:
 *
 *   - **90-day retention (NFR).** Raw payloads age out; derived state does not.
 *   - **Right to delete (SEC-8).** The user can erase everything, on demand.
 *
 * Both are implemented here and nowhere else. Nothing outside this file may
 * import it in order to delete rows: if a second module learns how to drop
 * these triggers, "append-only" degrades from an invariant into a habit.
 *
 * Every function here follows the same discipline:
 *
 *   1. everything runs inside a single `db.transaction()`;
 *   2. the trigger is dropped, the privileged work happens, and the trigger is
 *      recreated in a `finally` — so it is restored on the success path *and*
 *      on the throw path;
 *   3. on the throw path better-sqlite3 rolls the transaction back, which also
 *      reverts the DROP, so the trigger survives either way.
 *
 * Neither function touches LanceDB or the filesystem. Both instead *report*
 * what still needs erasing outside SQLite, so the caller can finish the job
 * with `VectorStore.deleteByEventIds` and `fs.unlink`.
 */

/** SQL that (re)creates each append-only trigger, keyed by trigger name. */
const TRIGGER_SQL = {
  events_no_update: `CREATE TRIGGER events_no_update BEFORE UPDATE ON events
     BEGIN SELECT RAISE(ABORT, 'events is append-only'); END`,
  events_no_delete: `CREATE TRIGGER events_no_delete BEFORE DELETE ON events
     BEGIN SELECT RAISE(ABORT, 'events is append-only'); END`,
  deltas_no_update: `CREATE TRIGGER deltas_no_update BEFORE UPDATE ON state_deltas
     BEGIN SELECT RAISE(ABORT, 'state_deltas is append-only (D-6)'); END`,
} as const;

/**
 * Delete rows from every table, children before parents, so that no immediate
 * foreign key constraint is ever in violation at the end of a statement.
 *
 * `schema_version` is deliberately absent: erasing the user's data must not
 * erase the record of which migrations have run, or the next `migrate()` would
 * try to re-apply `001_initial.sql` against a live schema and fail.
 */
const DELETE_ORDER: readonly string[] = [
  // Briefing leaves first — both reference `briefings` / `artifacts`.
  'briefing_claims',
  'feedback',
  // Per-claim project labels (migration 013): FK to `briefings` (ON DELETE SET
  // NULL) and to `projects` (ON DELETE CASCADE), so it must be emptied before
  // both — and named here explicitly, not left to the cascade, so the "Your
  // data" panel counts what the user filed and `deleteEverything` reports it.
  'claim_projects',
  'briefings',
  // Pending items reference state_deltas and artifacts.
  'pending_items',
  // state_deltas references artifacts and itself (`supersedes`).
  'state_deltas',
  // Extractions reference events; both must precede their parents.
  'extractions',
  'events',
  // Selected channels reference `projects` (migration 006's `project_id`), so
  // they must be emptied BEFORE it. This row used to sit at the bottom of the
  // list, among the standalone tables — correct until that column existed, and
  // a foreign-key violation the moment it did.
  'slack_selected_channels',
  // Graph tables, now unreferenced.
  'relationships',
  'people',
  'projects',
  'artifacts',
  // Standalone tables with no inbound foreign keys.
  'ai_calls',
  'synthesis_watermark',
  'briefing_schedules',
];

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/**
 * The retention cutoff: events older than this have expired.
 *
 * Lives here, with the comparison it feeds, because two callers need the same
 * answer and a second copy of `now - days × 86_400_000` is a drift waiting to
 * happen — the Settings panel reports how many events are past the cutoff, and
 * the daily sweep deletes them. If those two disagree, the panel is lying about
 * a promise the app made.
 */
export function retentionCutoffMs(nowMs: number, rawEventDays: number): number {
  return nowMs - rawEventDays * DAY_MS;
}

/**
 * What one retention purge removed from SQLite, and what it left for the
 * caller — the same manifest contract as {@link DeleteEverythingResult}, for
 * the same reason: this module performs no I/O outside SQLite.
 */
export interface RawEventPurge {
  /** Rows removed from `events`. */
  rowsDeleted: number;
  /**
   * Every purged `events.event_id`. Pass to `VectorStore.deleteByEventIds`:
   * the embedded chunks are derived from the raw payloads that just expired
   * and are just as identifying, so a purge that skipped them would age out
   * the text and keep its embedding.
   *
   * Collected inside the same transaction as the DELETE rather than read
   * beforehand, because a backfill of ancient messages can land between two
   * statements — and an id missed that way names a vector nothing will ever
   * collect again, since its event row is already gone.
   */
  vectorEventIds: string[];
}

/**
 * Purge raw events older than `cutoffMs` (NFR: 90-day retention on raw
 * payloads).
 *
 * The comparison is `occurred_at < cutoffMs` — source time, not ingest time, so
 * a late-arriving backfill of ancient messages is aged out on its true age.
 *
 * Derived state (`state_deltas`, `briefings`, the graph) is intentionally left
 * behind: those rows carry the user's actual memory, already redacted and
 * summarized, and are what the product exists to preserve. Only the verbatim
 * payloads expire. `extractions.event_id` is a foreign key into `events`, so
 * any extraction whose parent event falls inside the purge window is removed
 * first; leaving it would abort the DELETE on a FK violation.
 *
 * The caller remains responsible for evicting the LanceDB chunks named in
 * {@link RawEventPurge.vectorEventIds}; this function is SQLite-only.
 */
export function purgeRawEventsOlderThan(db: Database, cutoffMs: number): RawEventPurge {
  const tx = db.transaction((): RawEventPurge => {
    db.exec('DROP TRIGGER IF EXISTS events_no_delete');
    try {
      // Named before anything is deleted — afterwards there is nothing left to
      // enumerate. Inside the transaction, so the list and the DELETE below
      // see exactly the same set of rows.
      const doomed = db
        .prepare('SELECT event_id FROM events WHERE occurred_at < ?')
        .all(cutoffMs) as { event_id: string }[];

      // Children before parents: extractions point at the events being purged.
      db.prepare(
        `DELETE FROM extractions
          WHERE event_id IN (SELECT event_id FROM events WHERE occurred_at < ?)`,
      ).run(cutoffMs);

      const rowsDeleted = db.prepare('DELETE FROM events WHERE occurred_at < ?').run(cutoffMs)
        .changes;

      return { rowsDeleted, vectorEventIds: doomed.map((row) => row.event_id) };
    } finally {
      // Recreated inside the transaction: a rollback undoes the DROP, and a
      // commit has already recreated it. Either way the trigger is never
      // left off after this function returns.
      db.exec(TRIGGER_SQL.events_no_delete);
    }
  });

  return tx();
}

/**
 * What `deleteEverything` erased from SQLite but could not erase itself — the
 * manifest the caller must act on to complete a right-to-delete request.
 */
export interface DeleteEverythingResult {
  /** Total rows removed across every table — the DELETEs' own `.changes`, not
   * a separate COUNT(*) pass (which would race a concurrent insert). */
  rowsDeleted: number;
  /**
   * Every `events.event_id` that existed immediately before the wipe. The
   * retention purge pairs this with `VectorStore.deleteByEventIds`; a full
   * right-to-delete instead clears the vector table outright
   * (`VectorStore.deleteAll`), since these ids are gone from SQLite the moment
   * this returns and an id-by-id eviction that fails partway would strand
   * embeddings nothing can ever name again.
   */
  vectorEventIds: string[];
  /**
   * Distinct `briefings.narrative_path` values that existed immediately before
   * the wipe. Each is a generated `.md` file on disk that the caller must
   * unlink; SQLite only ever stored the path, never the prose.
   */
  narrativePaths: string[];
}

/**
 * SEC-8, right to delete: remove every row of user data from SQLite in one
 * atomic transaction, and return the manifest of what lives outside SQLite.
 *
 * Scope and non-scope, both deliberate:
 *
 *   - **In scope:** every table in the schema except `schema_version`. The
 *     database is left structurally intact (tables, indexes, views and the
 *     append-only triggers all survive) and semantically empty, so the app can
 *     keep running and start ingesting afresh without a re-migration.
 *   - **Out of scope:** LanceDB and the narrative `.md` files. This function
 *     performs no I/O beyond SQLite; it reports their ids and paths instead.
 *     Mixing a filesystem unlink into a SQL transaction would create a window
 *     where a rollback leaves the database intact but the files already gone.
 *
 * The manifest is collected *before* any DELETE runs — afterwards the rows are
 * gone and there is nothing left to enumerate.
 *
 * @returns the total rows removed, plus event ids for the vector store and
 *   narrative paths for the filesystem.
 */
export function deleteEverything(db: Database): DeleteEverythingResult {
  const tx = db.transaction((): DeleteEverythingResult => {
    // 1. Collect the out-of-SQLite manifest while the rows still exist.
    const eventRows = db.prepare('SELECT event_id FROM events').all() as { event_id: string }[];
    const pathRows = db
      .prepare('SELECT DISTINCT narrative_path FROM briefings')
      .all() as { narrative_path: string }[];

    // 2. Stand down the append-only guards for the duration of the wipe.
    db.exec('DROP TRIGGER IF EXISTS events_no_update');
    db.exec('DROP TRIGGER IF EXISTS events_no_delete');
    db.exec('DROP TRIGGER IF EXISTS deltas_no_update');

    try {
      // 3. Empty every table, children before parents (see DELETE_ORDER),
      //    summing the DELETEs' own row counts — no second COUNT(*) pass, and
      //    no TOCTOU gap against a row the poller inserts mid-wipe.
      let rowsDeleted = 0;
      for (const table of DELETE_ORDER) {
        rowsDeleted += db.prepare(`DELETE FROM ${table}`).run().changes;
      }
      return {
        rowsDeleted,
        vectorEventIds: eventRows.map((row) => row.event_id),
        narrativePaths: pathRows.map((row) => row.narrative_path),
      };
    } finally {
      // 4. Restore the guards unconditionally — same reasoning as the purge:
      //    on commit these CREATEs are what the schema ends up with, and on
      //    rollback the DROPs above are reverted along with everything else.
      db.exec(TRIGGER_SQL.events_no_update);
      db.exec(TRIGGER_SQL.events_no_delete);
      db.exec(TRIGGER_SQL.deltas_no_update);
    }
  });

  return tx();
}

/**
 * What the app is currently holding, for the "Your data" settings panel — the
 * read-only half of SEC-8. A user cannot meaningfully consent to erasing
 * something they were never shown.
 *
 * Derived from {@link DELETE_ORDER} rather than from its own table list, so a
 * migration that adds a table shows up in the panel the moment it is
 * registered for deletion, and the two can never disagree about what "all of
 * it" means.
 */
export interface UserDataSummary {
  /**
   * Row count per table — every table {@link deleteEverything} empties,
   * including the ones sitting at zero, so the panel can render the whole
   * scope rather than only the populated part of it.
   */
  rowsByTable: Record<string, number>;
  /** Sum of {@link UserDataSummary.rowsByTable}. */
  totalRows: number;
  /** `MIN(events.occurred_at)`; `null` when no events are stored. */
  oldestEventAt: number | null;
  /**
   * Raw events {@link purgeRawEventsOlderThan} would remove if it ran now with
   * the caller's cutoff. Reported so the retention promise is visible as a
   * number rather than as a sentence in a README.
   */
  expiredRawEvents: number;
}

/**
 * Count what is stored, without changing any of it.
 *
 * Not privileged — it drops no trigger and opens no transaction — but it lives
 * here because it must enumerate exactly the tables {@link DELETE_ORDER} does.
 * Moving it to a repository would fork that list.
 *
 * @param rawEventCutoffMs - The retention cutoff to measure against, i.e.
 *   `now - rawEventDays × 86_400_000`. Same comparison the purge uses.
 */
export function userDataSummary(db: Database, rawEventCutoffMs: number): UserDataSummary {
  const rowsByTable: Record<string, number> = {};
  let totalRows = 0;

  for (const table of DELETE_ORDER) {
    // Table names come from the module-private DELETE_ORDER constant, never
    // from a caller, so the interpolation carries no injection surface.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    rowsByTable[table] = row.n;
    totalRows += row.n;
  }

  const oldest = db.prepare('SELECT MIN(occurred_at) AS at FROM events').get() as {
    at: number | null;
  };
  const expired = db
    .prepare('SELECT COUNT(*) AS n FROM events WHERE occurred_at < ?')
    .get(rawEventCutoffMs) as { n: number };

  return {
    rowsByTable,
    totalRows,
    oldestEventAt: oldest.at,
    expiredRawEvents: expired.n,
  };
}
