-- ============ Claim → project labels (per-briefing categorisation) ============
--
-- A LABEL, not a ranking input. Migration 006 hangs projects off the CHANNEL and
-- materialises `belongs_to` edges that `ranker.ts`/`retrieval.ts` read; this table
-- deliberately does none of that. The user asked to tag individual briefing rows
-- so the results can be filtered by project later, and a label that silently
-- started re-weighting future briefings would be a different feature wearing the
-- same control.
--
-- Kept in its OWN table rather than as a column on `briefing_claims` for two
-- reasons. First, `briefing_claims` rows are written by the generator, and a
-- user-authored tag does not belong in an append-only, model-written row.
-- Second — and decisively — the renderer has no `briefing_claims.claim_id`: the
-- `briefing:chunk` payload carries none, so `claimIdOf()` returns
-- `citation.artifactId` and `claim:drilldown` resolves that as an ARTIFACT id
-- (see `apps/desktop/src/ipc/claim.ts`'s header). This table is therefore keyed
-- the way the UI can actually address a row today.
--
-- CONSEQUENCE OF THAT KEY, stated plainly: one artifact can back several
-- distinct claims in the same briefing (see `claimKey` in `BriefingView.tsx`).
-- Those claims share one tag. Tagging one of them tags its siblings. That is the
-- honest cost of labelling with the only stable handle on the wire; when the
-- chunk payload grows a real claim id, this table's `artifact_id` becomes that
-- id and the ambiguity goes away.
--
-- Scoped by `briefing_id` so the same artifact can carry different labels in
-- different briefings — a thread's relevance to a project is a judgement about
-- one briefing's context, not a permanent property of the artifact.

CREATE TABLE claim_projects (
  briefing_id TEXT NOT NULL REFERENCES briefings(briefing_id) ON DELETE CASCADE,
  -- An `artifacts.artifact_id` today. No FK: a chunk can cite an artifact that
  -- retention has since purged, and a label outliving its artifact should read
  -- as an untagged row, not fail the insert.
  artifact_id TEXT NOT NULL,
  -- ON DELETE CASCADE, unlike migration 006's SET NULL: there the row is a
  -- polling subscription that must survive losing its tag, here the row IS the
  -- tag and has no meaning without a project.
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  tagged_at INTEGER NOT NULL,
  PRIMARY KEY (briefing_id, artifact_id)
) WITHOUT ROWID;

-- The read the briefing view issues on every load: "which of this briefing's
-- rows are already tagged?", answered from the primary key.

-- The forward-looking half of the request ("so I can filter the results"):
-- every claim ever tagged with one project, across briefings.
CREATE INDEX IF NOT EXISTS idx_claim_projects_project ON claim_projects(project_id);
