-- ============ Channel → project mapping (FR-5 / FR-8 / OI-3) ============
--
-- The write path that was missing behind the whole stakes ranker.
--
-- `ranker.ts` weights a delta on a user-declared project at `wStakes` (3.0, the
-- largest weight after obligation), and `retrieval.ts` multiplies chunk scores
-- by the project's `stakes_weight`. Both read `relationships` for a `belongs_to`
-- edge from an artifact to a project. Nothing in the build ever wrote that edge,
-- so `isDeclaredProject` was false for every delta ever ranked and FR-5 degraded
-- to recency plus participation — which is why the OI-3 onboarding gate had been
-- relaxed to optional. This column is the missing half.
--
-- Why the mapping hangs off the CHANNEL rather than the artifact: the user is
-- already choosing channels in Settings, and "#platform-migration is the
-- migration project" is a statement they can make once, in advance, about a
-- container. Asking them to tag threads would be asking them to label the very
-- thing the ranking exists to save them from reading. It also keeps the
-- declaration STATED rather than inferred, which is what keeps this inside X-2.
--
-- Nullable: an untagged channel is the normal case, not an error. It simply
-- earns no stakes weight, exactly as before this migration.
--
-- ON DELETE SET NULL rather than CASCADE: deleting a project must not silently
-- unselect a channel the poller is fetching from. The channel stays; it just
-- stops carrying stakes.

ALTER TABLE slack_selected_channels
  ADD COLUMN project_id TEXT REFERENCES projects(project_id) ON DELETE SET NULL;

-- Read on every settings load and on every link rebuild, both of which filter
-- to the tagged rows.
CREATE INDEX IF NOT EXISTS idx_slack_channels_project
  ON slack_selected_channels(project_id);
