-- ============ When the scheduler gave up on a thread ============
--
-- Parking is terminal: `DUE_SQL` filters out any thread at or above
-- `maxAttempts`, only a successful synthesis clears the counter, and a thread
-- that is never offered can never succeed. `touch()` does not clear it either —
-- a new message restarts the quiet clock and nothing else. So a thread parked
-- while it held nothing but `noise` stayed invisible to Layer 2 forever, even
-- after a real message arrived on it: no delta, no obligation, nothing in the
-- briefing. Silent loss, while the Diagnostics panel promised the conversation
-- "will be picked up again automatically as the conversation continues".
--
-- Reviving on "the thread has a non-noise extraction" is not enough, and is in
-- fact worse: a genuine poison thread (repeated parse/citation/model failures)
-- usually HAS non-noise extractions — that is why it had context to send the
-- model in the first place — so it would be un-parked on the very next tick,
-- retried to exhaustion, parked, un-parked, forever. That defeats the entire
-- purpose of parking.
--
-- The question that actually distinguishes the two is temporal: did signal
-- arrive AFTER we gave up? This column is the reference point for that
-- comparison. `REVIVE_WITH_SIGNAL_SQL` revives a thread only when it holds a
-- non-noise extraction newer than its `parked_at`, so:
--
--   * an all-noise thread that later receives a real message  -> revived;
--   * a poison thread whose signal predates the park          -> stays parked;
--   * a poison thread that later receives NEW content         -> revived once,
--     earns a fresh attempt budget, and re-parks with a newer `parked_at`
--     (it cannot loop, because the reference point moves forward).
--
-- Written on the attempt that exhausts the retry budget, by the scheduler's
-- `recordFailedAttempt` — not on the following tick's park branch. That
-- ordering is load-bearing: `tick()` runs the revive BEFORE it looks at
-- anything, so a thread that crossed the cap but had not been stamped yet would
-- be un-parked by signal it already held, which is exactly the poison thread
-- the revive must leave alone. Cleared on revive and on a successful synthesis.
--
-- NULL therefore means "not parked", and the revive's comparison against NULL
-- matches nothing — so a thread with no reference point is never revived. Rows
-- that predate this column are given one by the backfill below.

ALTER TABLE synthesis_watermark
  ADD COLUMN parked_at INTEGER;

-- Backfill: rows that already burned attempts under a build with no such column
-- need a reference point, or `REVIVE_WITH_SIGNAL_SQL`'s comparison against NULL
-- would never match and they would stay parked forever — which is the exact
-- defect this migration exists to fix. "Now" is the honest answer: we do not
-- know when they were parked, and anything that arrives from here on is
-- genuinely new.
--
-- `attempts > 0` rather than a hardcoded parking threshold: `maxAttempts` is a
-- code constant (and configurable), and duplicating it in SQL is how the two
-- drift. Stamping a thread that is merely mid-retry is harmless — the revive
-- only considers threads at or above the cap, and `markParked` overwrites the
-- stamp with the real crossing time if that thread does go on to park.
UPDATE synthesis_watermark
   SET parked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE attempts > 0;
