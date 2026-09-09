-- ============ Re-key claim labels to the ARTIFACT, not the briefing ============
--
-- Migrations 011/012 keyed a label `(briefing_id, artifact_id)`, on the
-- reasoning that "this thread is about project X" is a judgement about one
-- briefing's context. Real use disproved that within a day.
--
-- Every "Refresh" mints a new `briefings` row, so the key changed under the
-- user on the single most common interaction in the app: the dropdown they had
-- just set went blank, and re-setting it wrote ANOTHER row. Observed in the
-- field before this migration: one artifact carrying five labels across five
-- briefings, four of them re-statements of the same decision.
--
-- The label is a property of the thread. Filing it once must be enough, and the
-- "filter by project" view has to span briefings anyway — a per-briefing key
-- made that read a join over history rather than a lookup.
--
-- `briefing_id` survives as PROVENANCE ONLY ("where it was last set"), nullable
-- and ON DELETE SET NULL: retention purging an old briefing must not take the
-- user's filing with it, which the old CASCADE would have done.
--
-- SQLite cannot drop a column from a primary key, so this is the standard
-- rebuild-and-rename. The SELECT keeps ONE row per artifact — the newest, which
-- is the user's most recent statement and therefore the one to believe.

CREATE TABLE claim_projects_v2 (
  -- An `artifacts.artifact_id`. Still no FK: a label may outlive the artifact
  -- retention purged, and should then read as a stale row, not fail the insert.
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  briefing_id TEXT REFERENCES briefings(briefing_id) ON DELETE SET NULL,
  tagged_at INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'auto'))
) WITHOUT ROWID;

-- ONE row per artifact — the newest, which is the user's most recent statement.
-- A window function with a TOTAL ordering, not `MAX(tagged_at)` + `GROUP BY`:
-- two rows for one artifact written in the same millisecond (a rapid re-file)
-- both match `= MAX(...)`, and `GROUP BY artifact_id` then takes the bare
-- non-aggregated columns from an arbitrary one of them — so the surviving row
-- could carry `project_id` from one and `origin`/`briefing_id` from the other.
-- `briefing_id` is part of the old primary key and NOT NULL, so
-- `tagged_at DESC, briefing_id DESC` breaks every tie deterministically.
INSERT INTO claim_projects_v2 (artifact_id, project_id, briefing_id, tagged_at, origin)
SELECT artifact_id, project_id, briefing_id, tagged_at, origin
  FROM (
    SELECT cp.artifact_id, cp.project_id, cp.briefing_id, cp.tagged_at, cp.origin,
           ROW_NUMBER() OVER (
             PARTITION BY cp.artifact_id
             ORDER BY cp.tagged_at DESC, cp.briefing_id DESC
           ) AS rn
      FROM claim_projects cp
  )
 WHERE rn = 1;

DROP TABLE claim_projects;

ALTER TABLE claim_projects_v2 RENAME TO claim_projects;

-- "Every claim filed under this project", across briefings — the read the
-- filter control issues, and the reason the old per-briefing key was wrong.
CREATE INDEX IF NOT EXISTS idx_claim_projects_project ON claim_projects(project_id);
CREATE INDEX IF NOT EXISTS idx_claim_projects_origin ON claim_projects(origin);
