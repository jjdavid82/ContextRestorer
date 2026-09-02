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
 * Neither function touches LanceDB or the filesystem. `deleteEverything`
 * instead *reports* what still needs erasing outside SQLite, so the caller can
 * finish the job with `VectorStore.deleteByEventIds` and `fs.unlink`.
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
  'briefings',
  // Pending items reference state_deltas and artifacts.
  'pending_items',
  // state_deltas references artifacts and itself (`supersedes`).
  'state_deltas',
  // Extractions reference events; both must precede their parents.
  'extractions',
  'events',
  // Graph tables, now unreferenced.
  'relationships',
  'people',
  'projects',
  'artifacts',
  // Standalone tables with no inbound foreign keys.
  'ai_calls',
  'synthesis_watermark',
  'briefing_schedules',
  'slack_selected_channels',
];

/**
 * Purge raw events older than `cutoffMs` (NFR: 90-day retention on raw
 * payloads). Returns the number of rows removed.
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
 * The caller remains responsible for evicting the corresponding LanceDB chunks
 * (`VectorStore.deleteByEventIds`); this function is SQLite-only.
 */
export function purgeRawEventsOlderThan(db: Database, cutoffMs: number): number {
  const tx = db.transaction((): number => {
    db.exec('DROP TRIGGER IF EXISTS events_no_delete');
    try {
      // Children before parents: extractions point at the events being purged.
      db.prepare(
        `DELETE FROM extractions
          WHERE event_id IN (SELECT event_id FROM events WHERE occurred_at < ?)`,
      ).run(cutoffMs);

      return db.prepare('DELETE FROM events WHERE occurred_at < ?').run(cutoffMs).changes;
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
  /**
   * Every `events.event_id` that existed immediately before the wipe. Pass to
   * `VectorStore.deleteByEventIds` to evict the embedded chunks; the vectors
   * are derived from raw payloads and are just as identifying.
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
 * @returns event ids for the vector store and narrative paths for the filesystem.
 */
export function deleteEverything(db: Database): DeleteEverythingResult {
  const tx = db.transaction((): DeleteEverythingResult => {
    // 1. Collect the out-of-SQLite manifest while the rows still exist.
    const eventRows = db.prepare('SELECT event_id FROM events').all() as { event_id: string }[];
    const pathRows = db
      .prepare('SELECT DISTINCT narrative_path FROM briefings')
      .all() as { narrative_path: string }[];

    const manifest: DeleteEverythingResult = {
      vectorEventIds: eventRows.map((row) => row.event_id),
      narrativePaths: pathRows.map((row) => row.narrative_path),
    };

    // 2. Stand down the append-only guards for the duration of the wipe.
    db.exec('DROP TRIGGER IF EXISTS events_no_update');
    db.exec('DROP TRIGGER IF EXISTS events_no_delete');
    db.exec('DROP TRIGGER IF EXISTS deltas_no_update');

    try {
      // 3. Empty every table, children before parents (see DELETE_ORDER).
      for (const table of DELETE_ORDER) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      return manifest;
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
