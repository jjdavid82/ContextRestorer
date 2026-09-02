-- ============ Slack channel selector ============
--
-- Task 1.7's gap: nothing decided *which* Slack channels to poll, so every
-- Slack cycle failed loudly (see `apps/desktop/src/main.ts`'s
-- `VaultBackedSlackClient`). This table is the user's selection: the channels
-- the poller is authorized to fetch from, kept small and explicit rather than
-- "every channel the token can see" — an installed app defaults to polling
-- nothing until the user opts channels in.
--
-- `added_at` is unused by the poller (it re-reads the whole table each cycle,
-- unordered) but is kept for the settings UI, which lists selections in the
-- order they were added rather than by SQLite's page order.

CREATE TABLE IF NOT EXISTS slack_selected_channels (
  channel_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
