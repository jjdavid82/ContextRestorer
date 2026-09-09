-- ============ Where a claim's project label came from ============
--
-- Migration 011 stored WHICH project a briefing row is filed under. This stores
-- WHO decided: `'user'` for a label the user picked from the dropdown, `'auto'`
-- for one `detectProject()` derived by finding the project's name in the source
-- text.
--
-- The distinction is not cosmetic. X-2 allows inference to SUGGEST and forbids
-- it to DECIDE, and the whole reason `suggestProjects.ts` is safe under that
-- rule is that its output is visibly a suggestion. An auto label stored
-- indistinguishably from a user's own filing would quietly convert a guess into
-- a stated declaration — and the "filter briefings by project" follow-up would
-- then report matched-by-name rows as if the user had filed them there.
--
-- 'user' is the default so every row written before this migration keeps its
-- current meaning: those were all typed by hand.
--
-- A CHECK rather than a lookup table: two values, both written by code in this
-- repo, and a third would be a code change anyway. Same reasoning as
-- `briefings.purpose` (migration 008), which is also an unconstrained TEXT
-- column in practice — this one is tightened because a typo'd origin would
-- silently mis-attribute authorship rather than just mis-file a metric.

ALTER TABLE claim_projects
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'auto'));

-- The read behind "show me what I filed myself" / "show me what was guessed",
-- and the one a future filter needs in order to weight them differently.
CREATE INDEX IF NOT EXISTS idx_claim_projects_origin ON claim_projects(origin);
