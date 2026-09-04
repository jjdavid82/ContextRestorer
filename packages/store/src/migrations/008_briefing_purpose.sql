-- ============ Briefing purpose (P0, background pre-computation) ============
--
-- Under deterministic-first, model-written prose is produced by a BACKGROUND
-- pass and read back by a later request. That pass has to write its claims
-- somewhere, and `briefing_claims.briefing_id` is a NOT NULL foreign key — so
-- pre-computation necessarily creates `briefings` rows that no user ever saw.
--
-- Those rows must not enter the metrics. `latencyStats()` is the aggregate the
-- local metrics view reports as briefing latency, and AC-1 is a claim about how
-- long A USER WAITED. A background run that took four minutes with nobody
-- watching is not a four-minute wait, and letting it into that distribution
-- would corrupt the one number this whole change exists to move — in the
-- flattering direction, which is worse than useless.
--
-- 'delivered' is the default so every existing row keeps its current meaning
-- and every existing query keeps its current answer.

ALTER TABLE briefings
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'delivered';

-- `latencyStats()` filters on it, and the pre-computer asks "which deltas still
-- need prose?" against it on every cycle.
CREATE INDEX IF NOT EXISTS idx_briefings_purpose ON briefings(purpose);
