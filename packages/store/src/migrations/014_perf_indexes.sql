-- ============ Indexes for correlated / filtered reads on the hot paths ============
--
-- A `REFERENCES` clause does not create an index in SQLite (see the 009 header
-- for the same point). Each query below currently does a full table scan:
--
--  * `state_deltas(supersedes)` — the `current_state_deltas` view resolves the
--    tip of every supersedes chain with `LEFT JOIN state_deltas newer ON
--    newer.supersedes = d.delta_id`. That join runs on every briefing request
--    and every Layer 2 synthesis.
--
--  * `pending_items(status, created_at)` — `PendingRepo.listOpen()` is
--    `WHERE status = 'open' ORDER BY created_at ASC`, on every first-paint,
--    every briefing and every rank pass. The composite covers both the filter
--    and the sort.
--
--  * `ai_calls(trace_id)` — `AiCallsRepo.listByTrace`, the Diagnostics panel's
--    per-trace drill-down.
--
--  * `ai_calls(created_at)` — `AiCallsRepo.listRecentNotable`
--    (`WHERE outcome <> 'ok' AND created_at >= ?`). `ai_calls` has no retention
--    sweep, so this table grows for the life of the install.
--
--  * `extraction_failures(last_at)` — `ExtractionFailuresRepo.listRecent`
--    (`WHERE last_at >= ? ORDER BY last_at DESC`), the Diagnostics
--    "recent activity" feed.
--
-- All low-churn tables, so the write-side cost of maintaining these is small.
-- `IF NOT EXISTS` so a hand-built DB is tolerated, matching 009.

CREATE INDEX IF NOT EXISTS idx_deltas_supersedes         ON state_deltas(supersedes);
CREATE INDEX IF NOT EXISTS idx_pending_status            ON pending_items(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_calls_trace            ON ai_calls(trace_id);
CREATE INDEX IF NOT EXISTS idx_ai_calls_created_at       ON ai_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_extraction_failures_last_at ON extraction_failures(last_at);
