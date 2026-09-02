import type { Database, Statement } from 'better-sqlite3';
import type { AppConfig, SourceId, SynthesisWatermark } from '@cr/core';

/** Raw `synthesis_watermark` row shape, exactly as SQLite hands it back. */
interface WatermarkRow {
  thread_key: string;
  source: string;
  oldest_unsynth_at: number | null;
  last_event_at: number;
  last_synthesized_at: number | null;
  attempts: number;
}

/** One thread the debounce scheduler should synthesize on this tick. */
export interface DueThread {
  threadKey: string;
  source: string;
}

const SELECT_COLUMNS = `
  thread_key, source, oldest_unsynth_at, last_event_at, last_synthesized_at, attempts
`;

/**
 * The whole D-7 debounce contract, expressed as one upsert.
 *
 * `last_event_at` always takes the incoming value (it is "when did this thread
 * last make a noise", so the newest touch always wins). `oldest_unsynth_at` is
 * written *only* when it is currently NULL, via COALESCE — see `touch()`.
 */
const TOUCH_SQL = `
  INSERT INTO synthesis_watermark
    (thread_key, source, oldest_unsynth_at, last_event_at, last_synthesized_at, attempts)
  VALUES (?, ?, ?, ?, NULL, 0)
  ON CONFLICT(thread_key) DO UPDATE SET
    source            = excluded.source,
    last_event_at     = excluded.last_event_at,
    oldest_unsynth_at = COALESCE(synthesis_watermark.oldest_unsynth_at, excluded.oldest_unsynth_at)
`;

const MARK_SYNTHESIZED_SQL = `
  UPDATE synthesis_watermark
  SET oldest_unsynth_at = ?, last_synthesized_at = ?
  WHERE thread_key = ?
`;

const INCREMENT_ATTEMPTS_SQL = `
  UPDATE synthesis_watermark SET attempts = attempts + 1 WHERE thread_key = ?
`;

const RESET_ATTEMPTS_SQL = `
  UPDATE synthesis_watermark SET attempts = 0 WHERE thread_key = ?
`;

/**
 * OI-1: how many threads genuinely have work that has not been synthesized yet.
 *
 * `oldest_unsynth_at IS NOT NULL` is the exact definition — `markSynthesized`
 * clears it to NULL once a thread is caught up, and `touch()` re-arms it on the
 * next event (see the COALESCE in TOUCH_SQL). Deliberately NOT the same
 * predicate as `DUE_SQL`: a thread that is backed up but has not yet gone quiet
 * is not *due* for synthesis, yet its work is still missing from the briefing,
 * which is precisely what the user is being told.
 */
const PENDING_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM synthesis_watermark WHERE oldest_unsynth_at IS NOT NULL
`;

/**
 * Due = quiet long enough, OR backed up long enough.
 *
 * The per-source thresholds are inlined as a CASE over `source` so the whole
 * scan stays a single statement; the scheduler calls this on every tick and a
 * per-thread round trip would dominate it. Positional binds, in order:
 *   now, slackQuiet, gmailQuiet, now, slackHardCap, gmailHardCap.
 */
const DUE_SQL = `
  SELECT ${SELECT_COLUMNS} FROM synthesis_watermark
  WHERE oldest_unsynth_at IS NOT NULL
    AND ( (? - last_event_at) >= (CASE source WHEN 'slack' THEN ? ELSE ? END)
       OR (? - oldest_unsynth_at) >= (CASE source WHEN 'slack' THEN ? ELSE ? END) )
  ORDER BY oldest_unsynth_at ASC, last_event_at ASC
`;

function toDomain(row: WatermarkRow): SynthesisWatermark {
  return {
    threadKey: row.thread_key,
    source: row.source as SourceId,
    oldestUnsynthAt: row.oldest_unsynth_at,
    lastEventAt: row.last_event_at,
    lastSynthesizedAt: row.last_synthesized_at,
    attempts: row.attempts,
  };
}

/**
 * Durable Layer-2 trigger state (D-7).
 *
 * Two clocks run per thread and either one can fire synthesis:
 *
 *   - the **quiet window** (5 min), measured from `last_event_at`, so a
 *     conversation is synthesized once it settles rather than per message;
 *   - the **hard cap** (30 min), measured from `oldest_unsynth_at`, so a thread
 *     that never goes quiet still gets synthesized instead of starving.
 *
 * This lives in SQLite rather than in worker memory precisely because it must
 * survive a restart: an in-memory timer that resets on relaunch would let a
 * busy thread's hard cap never expire.
 */
export class WatermarkRepo {
  private readonly stmtTouch: Statement<unknown[], unknown>;
  private readonly stmtMarkSynthesized: Statement<unknown[], unknown>;
  private readonly stmtDue: Statement<unknown[], WatermarkRow>;
  private readonly stmtGet: Statement<unknown[], WatermarkRow>;
  private readonly stmtIncrementAttempts: Statement<unknown[], unknown>;
  private readonly stmtResetAttempts: Statement<unknown[], unknown>;
  private readonly stmtPendingCount: Statement<unknown[], { n: number }>;

  constructor(private readonly db: Database) {
    this.stmtTouch = this.db.prepare(TOUCH_SQL);
    this.stmtMarkSynthesized = this.db.prepare(MARK_SYNTHESIZED_SQL);
    this.stmtIncrementAttempts = this.db.prepare(INCREMENT_ATTEMPTS_SQL);
    this.stmtResetAttempts = this.db.prepare(RESET_ATTEMPTS_SQL);
    this.stmtDue = this.db.prepare<unknown[], WatermarkRow>(DUE_SQL);
    this.stmtPendingCount = this.db.prepare<unknown[], { n: number }>(PENDING_COUNT_SQL);
    this.stmtGet = this.db.prepare<unknown[], WatermarkRow>(
      `SELECT ${SELECT_COLUMNS} FROM synthesis_watermark WHERE thread_key = ?`,
    );
  }

  /**
   * Record that `threadKey` produced an event at `eventAt`.
   *
   * On a brand-new thread both clocks start together:
   * `oldest_unsynth_at = last_event_at = eventAt`.
   *
   * On an existing thread `last_event_at` is overwritten (restarting the quiet
   * window) but `oldest_unsynth_at` is left alone. That asymmetry *is* the hard
   * cap: if every message also pushed `oldest_unsynth_at` forward, a thread with
   * a message every four minutes would have both clocks reset forever and would
   * never be synthesized at all. `oldest_unsynth_at` is only re-armed once
   * `markSynthesized()` has cleared it to NULL, which is what COALESCE encodes.
   */
  touch(threadKey: string, source: SourceId, eventAt: number): void {
    this.stmtTouch.run(threadKey, source, eventAt, eventAt);
  }

  /**
   * Close out a synthesis cycle at `at`.
   *
   * `nextUnsynthesizedAt` is the occurred-at of the oldest event that arrived
   * while synthesis was running, or `null` when the thread is fully caught up.
   * Passing `null` disarms the hard cap and lets the next `touch()` stamp a
   * fresh start; passing a timestamp keeps the cap running from that event, so
   * work that raced the synthesis pass is not silently granted a full new cap.
   *
   * `attempts` is intentionally untouched here — failure/backoff accounting is
   * the scheduler's, not the repository's.
   */
  markSynthesized(threadKey: string, at: number, nextUnsynthesizedAt: number | null): void {
    this.stmtMarkSynthesized.run(nextUnsynthesizedAt, at, threadKey);
  }

  /**
   * Record one failed synthesis attempt for `threadKey`.
   *
   * The counter is deliberately *not* touched by `markSynthesized`; the
   * scheduler owns failure accounting and calls this on a rejected synthesis so
   * a poison thread can be skipped once it exhausts its attempt budget. No-op on
   * an unknown thread key.
   */
  incrementAttempts(threadKey: string): void {
    this.stmtIncrementAttempts.run(threadKey);
  }

  /**
   * Clear the failure counter after a synthesis succeeds.
   *
   * Without this, a thread that failed twice and then recovered would carry
   * those two failures forever and be retired by a single later blip.
   */
  resetAttempts(threadKey: string): void {
    this.stmtResetAttempts.run(threadKey);
  }

  /**
   * Threads eligible for synthesis at `now`, most-backed-up first.
   *
   * A thread qualifies if it has been quiet for at least its source's
   * `quietWindowMs`, or if it has had unsynthesized work for at least its
   * source's `hardCapMs`.
   *
   * Only `debounce` is read, so the parameter is typed as that slice: callers
   * holding a full {@link AppConfig} still pass it unchanged, while the
   * scheduler — which is configured with just the debounce thresholds — does not
   * have to fabricate an entire config to ask this question.
   */
  due(now: number, config: Pick<AppConfig, 'debounce'>): DueThread[] {
    const slack = config.debounce.slack;
    const gmail = config.debounce.gmail;

    return this.stmtDue
      .all(
        now,
        slack.quietWindowMs,
        gmail.quietWindowMs,
        now,
        slack.hardCapMs,
        gmail.hardCapMs,
      )
      .map((row) => ({ threadKey: row.thread_key, source: row.source }));
  }

  /**
   * Number of threads with unsynthesized work right now — the OI-1
   * "still processing" disclosure stamped onto every briefing.
   *
   * Independent of any clock or debounce threshold: the question is "is there
   * work the briefing could not possibly include?", not "would the scheduler
   * pick this thread up on the next tick?". See {@link PENDING_COUNT_SQL}.
   */
  countPendingSynthesis(): number {
    return this.stmtPendingCount.get()?.n ?? 0;
  }

  /** Current watermark for a thread, or `undefined` if it has never been touched. */
  get(threadKey: string): SynthesisWatermark | undefined {
    const row = this.stmtGet.get(threadKey);
    return row === undefined ? undefined : toDomain(row);
  }
}
