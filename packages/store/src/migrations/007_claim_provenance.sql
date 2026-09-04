-- ============ Per-claim provenance (P0, deterministic-first) ============
--
-- `briefings.mode` says how a RUN went: 'llm' or 'template'. Under P0 that is
-- the wrong granularity, because a single briefing is legitimately mixed — the
-- background pre-computer may have written prose for four of seven deltas
-- before the user pressed the button, and the synchronous path fills the rest
-- deterministically.
--
-- That mixed state is not new. `appendTemplateRemainder` already produces it
-- today when the model dies mid-stream and the template tops the briefing up;
-- the briefing then reports ONE mode for a page that has both kinds of claim on
-- it. This column makes the page describable.
--
-- 'template' is the DEFAULT because under P0 it is the normal case: a claim
-- rendered from a stored state delta with no inference. Prose is the addition.
--
-- The backfill below is the opposite way round, and deliberately so: every row
-- that exists when this migration runs was written by the pre-P0 pipeline,
-- where the generator wrote claims only on the LLM path and the template
-- renderer only on the fallback path. `briefings.mode` is therefore an accurate
-- description of existing rows even though it will stop being one for new rows.

ALTER TABLE briefing_claims
  ADD COLUMN produced_by TEXT NOT NULL DEFAULT 'template';

UPDATE briefing_claims
   SET produced_by = 'llm'
 WHERE briefing_id IN (SELECT briefing_id FROM briefings WHERE mode = 'llm');

-- The synchronous path asks "does prose already exist for this delta?" on every
-- request, so the lookup is on the hot path and wants an index.
CREATE INDEX IF NOT EXISTS idx_briefing_claims_delta_produced
  ON briefing_claims(delta_id, produced_by);
