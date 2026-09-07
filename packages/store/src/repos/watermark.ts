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
  /**
   * Consecutive failed/`no_context` attempts so far. Exposed so a consumer
   * that is not the scheduler itself (the `pipeline:status` disclosure) can
   * tell a genuinely-due thread from one the scheduler will actually skip and
   * park on this very tick — `due()`'s own predicate has no opinion on
   * attempts, only on the quiet/hard-cap clocks.
   */
  attempts: number;
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
 *
 * `attempts < ?` excludes a thread the scheduler has parked (exhausted its
 * retry budget on repeated failures or `no_context` outcomes — see
 * `DebounceScheduler`). A parked thread's `oldest_unsynth_at` stays set
 * forever (only `markSynthesized` clears it, and a parked thread never
 * reaches that call), so without this the disclosure would report it as
 * "still processing" indefinitely even though nothing is or ever will be
 * working on it.
 */
const PENDING_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM synthesis_watermark WHERE oldest_unsynth_at IS NOT NULL AND attempts < ?
`;

/**
 * Due = (quiet long enough AND fully extracted)
 *    OR (backed up long enough AND not still queued behind a live Layer 1).
 *
 * The per-source thresholds are inlined as a CASE over `source` so the whole
 * scan stays a single statement; the scheduler calls this on every tick and a
 * per-thread round trip would dominate it. The bind order is listed at the end
 * of this comment, after the clauses that consume it.
 *
 * ### The Layer 1 gate on the quiet window
 *
 * The quiet-window branch additionally requires that no event on the thread is
 * still waiting for its `extractions` row. Without it the scheduler fires on a
 * thread whose events Layer 1 has not embedded yet, retrieval finds no chunks,
 * Layer 2 returns `no_context`, and `DebounceScheduler.run()` — which cannot
 * tell "nothing to say" from "nothing to read yet" — calls `markSynthesized`
 * and disarms the thread. Its content is then never synthesized until an
 * unrelated later message happens to re-arm it. Observed on a real backfill:
 * 15 of 19 Layer 2 outcomes were `no_context`, every thread ended disarmed, and
 * one was marked caught-up 30 seconds after ingesting an event that still had
 * no extraction.
 *
 * Why it bites on backfill in particular: `last_event_at` is the event's own
 * `occurred_at`, not its ingest time, so a backfilled thread is already "quiet
 * for hours" the moment it lands and is due on the very next tick — long before
 * a multi-minute Layer 1 call on local hardware can finish. The main-process
 * wiring used to compensate by making ingestion await extraction, which coupled
 * source health to model latency (see `createPipeline` in the desktop app) and
 * still could not help the backfill case.
 *
 * ### The hard cap: gated on wall-clock, not on the source clock
 *
 * Both clocks are in source time, so on a backfill `oldest_unsynth_at` is just
 * as stale as `last_event_at` and the hard cap fires immediately too — a gate on
 * the quiet branch alone would change nothing for the case that motivated it.
 * But the hard cap must not be gated the same way: its whole purpose is that a
 * thread which never settles still checkpoints instead of starving, and a
 * plain extraction gate would let a backlog — or one event the model never
 * manages to classify — hold a thread hostage indefinitely.
 *
 * So the hard-cap branch asks a different question: is this thread QUEUED behind
 * Layer 1, or has Layer 1 STALLED on it? A thread with unextracted events fires
 * on the hard cap only when both of these hold, measured in wall-clock time:
 *
 *   1. every unextracted event on the thread was ingested more than a cap ago —
 *      an event that landed seconds ago has not been failed by Layer 1, it is
 *      merely waiting its turn; and
 *   2. Layer 1 has written NO extraction at all, on any thread, within the last
 *      cap — if rows are still appearing, the queue is draining and this thread
 *      will get its turn; if nothing has appeared for a whole cap while work is
 *      outstanding, the layer is wedged and waiting longer buys nothing; AND
 *   3. Layer 1 has been running in THIS process for at least a cap. `now -
 *      layer1ActiveSince >= cap`. This is the cold-start guard: on the first
 *      tick after the app is (re)launched — or after any restart that outlasted
 *      the cap — condition (2) is trivially true because nothing has been
 *      extracted lately, for the simple reason that nothing was running. The
 *      window (2) scans, `(now - cap, now]`, then reaches back before Layer 1
 *      even started, so its emptiness proves nothing. Treating that as a stall
 *      fires the hard cap on every backlogged thread at once, each retrieves
 *      nothing, and the scheduler parks the lot with no context inside ~90s of
 *      ticks — precisely the failure this whole gate exists to prevent, moved
 *      to the relaunch boundary. `layer1ActiveSince` defaults to 0 (epoch), so
 *      a caller that does not pass it gets condition (3) satisfied always and
 *      the pre-guard behaviour exactly.
 *
 * (1) alone was tried first and is not enough: on CPU-only hardware a backfill
 * of ~1,000 events is hours of Layer 1, so every thread would have "waited a
 * cap" long before its turn came and the hard cap would have disarmed most of
 * the backlog with no context — the original failure, delayed by thirty
 * minutes. (2) is what tells a slow queue apart from a dead one; (3) is what
 * stops a just-started queue from looking dead.
 *
 * The cost of (2) is that a single event the model never manages to classify
 * would hold its own thread while Layer 1 keeps progressing elsewhere. Layer 1
 * bounds that at the source (`009_extraction_gate.sql`): after
 * `MAX_EXTRACTION_ATTEMPTS` responses that omit the event it writes a terminal
 * `unextractable:layer1` `noise` row, and the event then satisfies every
 * `NOT EXISTS extraction` clause below like any other. Firing anyway here — the
 * alternative — is precisely the silent disarm-with-nothing this gate exists to
 * stop. `ingested_at` and `created_at` are the only wall-clock timestamps
 * involved, which is why neither clause compares `occurred_at`.
 *
 * Positional binds, in order: now, slackQuiet, gmailQuiet, now, slackHardCap,
 * gmailHardCap, now, slackHardCap, gmailHardCap, now, slackHardCap, gmailHardCap,
 * now, layer1ActiveSince, slackHardCap, gmailHardCap.
 *
 * The inner `NOT EXISTS` clauses hit `extractions` by `event_id` and by
 * `created_at`, both indexed as of `009_extraction_gate.sql` — the same shape
 * `EventsRepo.countUnextracted()` runs every 5s for the status strip.
 */
const DUE_SQL = `
  SELECT ${SELECT_COLUMNS} FROM synthesis_watermark w
  WHERE w.oldest_unsynth_at IS NOT NULL
    AND ( ( (? - w.last_event_at) >= (CASE w.source WHEN 'slack' THEN ? ELSE ? END)
            AND NOT EXISTS (
              SELECT 1 FROM events e
              WHERE e.thread_key = w.thread_key
                AND NOT EXISTS (SELECT 1 FROM extractions x WHERE x.event_id = e.event_id)
            ) )
       OR ( (? - w.oldest_unsynth_at) >= (CASE w.source WHEN 'slack' THEN ? ELSE ? END)
            -- (1) nothing on this thread is still freshly queued
            AND NOT EXISTS (
              SELECT 1 FROM events e
              WHERE e.thread_key = w.thread_key
                AND e.ingested_at > (? - (CASE w.source WHEN 'slack' THEN ? ELSE ? END))
                AND NOT EXISTS (SELECT 1 FROM extractions x WHERE x.event_id = e.event_id)
            )
            -- (2) either the thread is fully extracted, or Layer 1 has STALLED:
            -- nothing extracted anywhere for a whole cap AND Layer 1 has been
            -- running in this process for at least a cap, so that silence is a
            -- stall and not just a fresh (re)launch (see clause 3 below).
            AND ( NOT EXISTS (
                    SELECT 1 FROM events e
                    WHERE e.thread_key = w.thread_key
                      AND NOT EXISTS (SELECT 1 FROM extractions x WHERE x.event_id = e.event_id)
                  )
                  OR ( NOT EXISTS (
                         SELECT 1 FROM extractions x
                         WHERE x.created_at > (? - (CASE w.source WHEN 'slack' THEN ? ELSE ? END))
                       )
                       -- (3) Layer 1 has had a full cap of wall-clock time here
                       -- to write one. Without this, the first tick after the
                       -- app is reopened reads its own downtime — nothing
                       -- extracted "lately" because nothing was running — as a
                       -- stall, and disarms the whole unextracted backlog.
                       AND (? - ?) >= (CASE w.source WHEN 'slack' THEN ? ELSE ? END) ) ) ) )
  ORDER BY w.oldest_unsynth_at ASC, w.last_event_at ASC
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
  private readonly stmtPendingCount: Statement<[number], { n: number }>;

  constructor(private readonly db: Database) {
    this.stmtTouch = this.db.prepare(TOUCH_SQL);
    this.stmtMarkSynthesized = this.db.prepare(MARK_SYNTHESIZED_SQL);
    this.stmtIncrementAttempts = this.db.prepare(INCREMENT_ATTEMPTS_SQL);
    this.stmtResetAttempts = this.db.prepare(RESET_ATTEMPTS_SQL);
    this.stmtDue = this.db.prepare<unknown[], WatermarkRow>(DUE_SQL);
    this.stmtPendingCount = this.db.prepare<[number], { n: number }>(PENDING_COUNT_SQL);
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
   *
   * `layer1ActiveSince` is the wall-clock time Layer 1 extraction began running
   * in this process (epoch ms). It only affects the hard-cap "Layer 1 has
   * stalled" escape hatch — see condition (3) in `DUE_SQL`'s comment. Omitted =
   * 0, which disables the guard (every pre-existing caller and test keeps its
   * exact behaviour); the desktop app passes its real value.
   */
  due(
    now: number,
    config: Pick<AppConfig, 'debounce'>,
    layer1ActiveSince = 0,
  ): DueThread[] {
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
        // Hard-cap clause (1): "unextracted AND ingested within the last cap".
        now,
        slack.hardCapMs,
        gmail.hardCapMs,
        // Hard-cap clause (2): "no extraction written anywhere within the last cap"...
        now,
        slack.hardCapMs,
        gmail.hardCapMs,
        // ...clause (3): "...and Layer 1 has been running here for at least a
        // cap", so a fresh launch is not misread as a stall.
        now,
        layer1ActiveSince,
        slack.hardCapMs,
        gmail.hardCapMs,
      )
      .map((row) => ({ threadKey: row.thread_key, source: row.source, attempts: row.attempts }));
  }

  /**
   * Number of threads with unsynthesized work right now — the OI-1
   * "still processing" disclosure stamped onto every briefing.
   *
   * Independent of any clock or debounce threshold: the question is "is there
   * work the briefing could not possibly include?", not "would the scheduler
   * pick this thread up on the next tick?". See {@link PENDING_COUNT_SQL}.
   *
   * @param maxAttempts - The scheduler's park threshold (`DebounceScheduler`'s
   *   `DEFAULT_MAX_ATTEMPTS` in production). Required rather than defaulted
   *   here: this repo has no opinion of its own on the retry budget, and a
   *   silent default would drift from the scheduler's real one unnoticed.
   */
  countPendingSynthesis(maxAttempts: number): number {
    return this.stmtPendingCount.get(maxAttempts)?.n ?? 0;
  }

  /** Current watermark for a thread, or `undefined` if it has never been touched. */
  get(threadKey: string): SynthesisWatermark | undefined {
    const row = this.stmtGet.get(threadKey);
    return row === undefined ? undefined : toDomain(row);
  }
}
