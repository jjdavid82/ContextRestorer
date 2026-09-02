-- ============ D-7: `oldest_unsynth_at` must be nullable ============
--
-- 001 declared `synthesis_watermark.oldest_unsynth_at INTEGER NOT NULL`, but the
-- debounce protocol needs a three-state column, not a two-state one:
--
--   NULL  → the thread is fully caught up; nothing is waiting on synthesis.
--   value → epoch ms of the OLDEST event not yet synthesized, which is what the
--           30-minute hard cap is measured from.
--
-- `WatermarkRepo.markSynthesized(threadKey, at, null)` clears the column at the
-- end of a synthesis cycle so that the next `touch()` can stamp a *fresh* start
-- for the hard cap. With NOT NULL in force that write aborts, and the only ways
-- around it are a sentinel (0 / -1) that every reader must remember to special
-- case, or deleting the row (which would throw away `last_synthesized_at`).
-- Both are worse than widening the column, and the domain type in @cr/core
-- already declares `oldestUnsynthAt: number | null`.
--
-- SQLite cannot drop a NOT NULL constraint with ALTER TABLE, so this is the
-- standard 12-step table rebuild. No other table references synthesis_watermark,
-- so there are no foreign keys to repoint.

CREATE TABLE synthesis_watermark_new (
  thread_key            TEXT PRIMARY KEY,
  source                TEXT NOT NULL,
  oldest_unsynth_at     INTEGER,           -- NULL = caught up; else drives the hard cap
  last_event_at         INTEGER NOT NULL,  -- drives the quiet window
  last_synthesized_at   INTEGER,
  attempts              INTEGER NOT NULL DEFAULT 0
);

INSERT INTO synthesis_watermark_new
  (thread_key, source, oldest_unsynth_at, last_event_at, last_synthesized_at, attempts)
SELECT thread_key, source, oldest_unsynth_at, last_event_at, last_synthesized_at, attempts
FROM synthesis_watermark;

DROP TABLE synthesis_watermark;
ALTER TABLE synthesis_watermark_new RENAME TO synthesis_watermark;

-- The scheduler scans by due-ness on every tick; keep that scan off a full sort.
CREATE INDEX idx_watermark_due ON synthesis_watermark(last_event_at);
