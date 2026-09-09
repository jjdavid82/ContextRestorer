import type { Database, Statement } from 'better-sqlite3';

/**
 * Companion to {@link ExtractionsRepo} for the recovery sweep's termination
 * condition (`009_extraction_gate.sql`).
 *
 * `EventsRepo.listUnextracted()` defines "needs extraction" as "no `extractions`
 * row", and the sweep re-offers every match on every pass. That is right for a
 * transient failure but wrong for an event this (model, prompt) pair cannot
 * classify: it is re-offered forever, and `WatermarkRepo.due()`'s quiet-window
 * gate holds its whole thread out of synthesis for as long as it has no row.
 *
 * Layer 1 calls {@link record} each time the model RESPONDS but does not
 * classify the event — never on a transport error, which is the transient case
 * that should keep retrying. When the count reaches Layer 1's cap the extractor
 * writes a terminal `noise` row and the event leaves both the sweep queue and
 * the gate. Rows here are kept as the audit trail; re-examining a written-off
 * event means clearing this row and its terminal `extractions` row by hand.
 */
export class ExtractionFailuresRepo {
  private readonly stmtRecord: Statement<[string, number, number], unknown>;
  private readonly stmtGet: Statement<[string], { attempts: number }>;

  constructor(private readonly db: Database) {
    this.stmtRecord = this.db.prepare(
      `INSERT INTO extraction_failures (event_id, attempts, first_at, last_at)
         VALUES (?, 1, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         attempts = attempts + 1,
         last_at  = excluded.last_at`,
    );
    this.stmtGet = this.db.prepare<[string], { attempts: number }>(
      `SELECT attempts FROM extraction_failures WHERE event_id = ?`,
    );
  }

  /**
   * Record one model-responded-but-unclassified attempt for `eventId` and
   * return the running total (1 on the first call).
   */
  record(eventId: string, now: number): number {
    this.stmtRecord.run(eventId, now, now);
    return this.stmtGet.get(eventId)?.attempts ?? 1;
  }

  /** Attempts recorded so far, or 0 for an event that has never failed. */
  attempts(eventId: string): number {
    return this.stmtGet.get(eventId)?.attempts ?? 0;
  }

  /**
   * Events with a failed attempt in `[sinceMs, now]`, most-recent first
   * (Diagnostics "recent activity").
   *
   * Keyed on `last_at`, not `first_at`: a written-off event that failed again
   * inside the window is still "recently" a problem. The caller renders these as
   * an aggregate ("N messages couldn't be read"), so `limit` bounds the read but
   * the count the panel shows may come from a wider query.
   */
  listRecent(sinceMs: number, limit: number): { eventId: string; attempts: number; lastAt: number }[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, attempts, last_at
           FROM extraction_failures
          WHERE last_at >= ?
          ORDER BY last_at DESC
          LIMIT ?`,
      )
      .all(sinceMs, limit) as { event_id: string; attempts: number; last_at: number }[];

    return rows.map((row) => ({
      eventId: row.event_id,
      attempts: row.attempts,
      lastAt: row.last_at,
    }));
  }
}

export default ExtractionFailuresRepo;
