/**
 * The 90-day raw-event purge, on a timer (NFR retention).
 *
 * `purgeRawEventsOlderThan` was written and tested in Phase 0 and never called,
 * so `config.retention.rawEventDays` named a promise nothing kept: raw Slack and
 * Gmail payloads accumulated for the life of the install. This is the call site.
 *
 * ### Cadence
 *
 * Once shortly after startup, then every 24 hours. Chained one-shot timers
 * rather than `setInterval`, matching `BriefingScheduleRunner`: the purge is
 * cheap but not instant on a large `events` table, and an interval would queue
 * the next run behind a slow one and then fire them back to back.
 *
 * The startup run is *delayed*, not immediate. A purge competes with the
 * extraction sweep and the first poll cycle for the same SQLite handle, and
 * nothing about a 90-day cutoff is urgent to the second — an install that has
 * been closed for a month is no worse for waiting another minute.
 *
 * ### Why it evicts vectors too
 *
 * A purge that removed the message text and left its embedding behind would
 * age out the readable half of the data and keep the identifying half, which is
 * not what the retention promise says. `RawEventPurge.vectorEventIds` names
 * exactly the rows to evict; see `retention.ts` for why the ids are collected
 * inside the same transaction as the delete.
 *
 * Derived state is untouched by design: `state_deltas`, `briefings` and the
 * graph carry the user's actual memory, already redacted and summarized, and
 * are what the product exists to preserve.
 */
import { retentionCutoffMs } from '@cr/store';
import type { RawEventPurge } from '@cr/store';

/** Milliseconds between purge runs once the first one has settled. */
export const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Delay before the first run of the process's life. Long enough for the
 * startup extraction sweep and first poll to get their statements in.
 */
export const PURGE_STARTUP_DELAY_MS = 60_000;

export interface RetentionPurgeDeps {
  /** `purgeRawEventsOlderThan(db, cutoffMs)`, bound to the live handle. */
  purge(cutoffMs: number): RawEventPurge;
  /**
   * LanceDB eviction for the purged ids. Optional: a host whose vector gate
   * failed should still age out SQLite rather than skip retention entirely.
   */
  evictVectors?: (eventIds: string[]) => Promise<number>;
  /** `config.retention.rawEventDays`. */
  rawEventDays: number;
  clock: { now(): number };
  /** Injectable for tests; defaults to the global timers. */
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  /** Startup delay override, so a test need not wait a minute. */
  startupDelayMs?: number;
  /** Interval override, same reason. */
  intervalMs?: number;
}

/** What one run did. Returned for logging and for tests to assert on. */
export interface RetentionPurgeRun {
  /** Rows removed from `events`. */
  rowsDeleted: number;
  /**
   * Vectors evicted. `null` when no vector store was wired or the eviction
   * threw — distinct from `0`, which means "nothing to evict".
   */
  vectorsDeleted: number | null;
  /** The cutoff used, epoch ms. */
  cutoffMs: number;
}

/**
 * Run the purge once. Never rejects: retention is a background promise, and a
 * failure has to be loud in the log without taking down the timer that will
 * try again tomorrow.
 */
export async function runRetentionPurge(deps: RetentionPurgeDeps): Promise<RetentionPurgeRun> {
  // Same rule the Settings panel reports against (`ipc/privacy.ts` calls the
  // same function), so "300 messages are past that point" and what this
  // deletes cannot disagree.
  const cutoffMs = retentionCutoffMs(deps.clock.now(), deps.rawEventDays);

  let purged: RawEventPurge;
  try {
    purged = deps.purge(cutoffMs);
  } catch (error) {
    // The transaction rolled back and the append-only trigger is back on
    // (`retention.ts`), so nothing is half-purged.
    console.error('[retention] purge failed; nothing was removed', error);
    return { rowsDeleted: 0, vectorsDeleted: null, cutoffMs };
  }

  if (purged.rowsDeleted === 0) {
    // The common case on a young install. Not logged: a daily "removed 0 rows"
    // line is noise in a log the Diagnostics panel reads.
    return { rowsDeleted: 0, vectorsDeleted: 0, cutoffMs };
  }

  let vectorsDeleted: number | null = null;
  if (deps.evictVectors !== undefined) {
    try {
      vectorsDeleted = await deps.evictVectors(purged.vectorEventIds);
    } catch (error) {
      // The SQLite half already committed. Reported rather than retried: the
      // ids are gone from `events`, so the next run cannot re-derive them, and
      // a leftover vector is a disclosed imperfection rather than a silent one.
      console.error(
        `[retention] purged ${purged.rowsDeleted} event(s) but could not evict their vectors`,
        error,
      );
    }
  }

  console.info(
    `[retention] purged ${purged.rowsDeleted} raw event(s) older than ` +
      `${deps.rawEventDays} days` +
      (vectorsDeleted === null ? '' : `, and ${vectorsDeleted} vector chunk(s)`),
  );

  return { rowsDeleted: purged.rowsDeleted, vectorsDeleted, cutoffMs };
}

/**
 * Start the purge loop.
 *
 * @returns Disposer; call it on quit. Cancels the pending timer and lets an
 *   in-flight run finish, the same contract the poller and the schedule runner
 *   use.
 */
export function startRetentionPurge(deps: RetentionPurgeDeps): () => void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  const interval = deps.intervalMs ?? PURGE_INTERVAL_MS;

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const arm = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimer(() => {
      void runRetentionPurge(deps).then(
        () => arm(interval),
        // `runRetentionPurge` never rejects, but an unhandled rejection inside
        // a timer callback would take the main process down, so the arm is
        // unconditional rather than trusting that.
        () => arm(interval),
      );
    }, delayMs);
    // Never keep the process alive solely to age out old rows.
    timer.unref?.();
  };

  arm(deps.startupDelayMs ?? PURGE_STARTUP_DELAY_MS);

  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
}
