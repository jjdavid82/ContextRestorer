-- ============ App-level settings ============
--
-- Generic key/value store for user-facing settings that live outside
-- `config/default.json` — the config file is loaded once at process start and
-- is not meant to be edited by the app itself, but a setting a user changes
-- from inside the app (e.g. which chat model to use) needs somewhere to
-- persist across restarts. Modeled as key/value rather than one column per
-- setting so the NEXT such setting does not need its own migration.

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
