-- ============ Raw Event Store — append-only, source of truth ============
CREATE TABLE events (
  event_id      TEXT PRIMARY KEY,          -- sha256(source|source_event_id) → idempotency
  source        TEXT NOT NULL,             -- 'slack' | 'gmail'
  source_event_id TEXT NOT NULL,
  thread_key    TEXT NOT NULL,             -- slack: channel:thread_ts | gmail: threadId
  actor_id      TEXT,
  occurred_at   INTEGER NOT NULL,          -- epoch ms, from source
  ingested_at   INTEGER NOT NULL,
  payload_json  TEXT NOT NULL,             -- normalized, ALREADY redacted
  redaction_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, source_event_id)         -- enforces NFR-6 idempotency at the DB level
);
CREATE INDEX idx_events_thread ON events(thread_key, occurred_at);
CREATE INDEX idx_events_window ON events(occurred_at);

-- Append-only enforced in-engine, not just by convention:
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
-- Retention (90d) and right-to-delete run through a privileged path that
-- drops the triggers inside a transaction; see store/retention.ts.

-- ============ Entity Graph ============
CREATE TABLE artifacts (
  artifact_id   TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- 'thread' | 'message' | 'email'
  external_ref  TEXT NOT NULL,             -- deep link back to Slack/Gmail
  title         TEXT,
  state         TEXT,
  owner_id      TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE TABLE people (
  person_id TEXT PRIMARY KEY, display_name TEXT, email_hash TEXT, is_self INTEGER DEFAULT 0
);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY, name TEXT NOT NULL,
  origin TEXT NOT NULL,                    -- 'declared' only in POC (FR-8; X-2 bars 'inferred')
  stakes_weight REAL NOT NULL DEFAULT 1.0,
  declared_at INTEGER
);
CREATE TABLE relationships (
  from_id TEXT NOT NULL, rel TEXT NOT NULL, to_id TEXT NOT NULL,
  confidence REAL, PRIMARY KEY (from_id, rel, to_id)
);

-- ============ Extracted events (Layer 1 output) ============
CREATE TABLE extractions (
  extraction_id TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(event_id),
  class         TEXT NOT NULL,             -- 'decision'|'question'|'status_update'|'noise'
  confidence    REAL NOT NULL,
  participants_json TEXT NOT NULL,
  artifacts_json    TEXT NOT NULL,
  model         TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- ============ StateDelta Store — append-only + versioned (D-6) ============
CREATE TABLE state_deltas (
  delta_id      TEXT PRIMARY KEY,
  thread_key    TEXT NOT NULL,
  artifact_id   TEXT REFERENCES artifacts(artifact_id),
  version       INTEGER NOT NULL,          -- 1, 2, 3 … per thread_key
  supersedes    TEXT REFERENCES state_deltas(delta_id),   -- D-6 pointer, NULL for v1
  summary       TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- 'decision'|'progress'|'reversal'|'resolution'
  confidence    REAL NOT NULL,
  source_event_ids_json TEXT NOT NULL,     -- lineage (§5.4)
  citation_artifact_ids_json TEXT NOT NULL,
  model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (thread_key, version)
);
CREATE INDEX idx_deltas_window ON state_deltas(created_at);
CREATE TRIGGER deltas_no_update BEFORE UPDATE ON state_deltas
  BEGIN SELECT RAISE(ABORT, 'state_deltas is append-only (D-6)'); END;

-- The current view is derived, never stored — the tip of each supersedes chain:
CREATE VIEW current_state_deltas AS
  SELECT d.* FROM state_deltas d
  LEFT JOIN state_deltas newer ON newer.supersedes = d.delta_id
  WHERE newer.delta_id IS NULL;

-- ============ PendingItem Store ============
CREATE TABLE pending_items (
  pending_id  TEXT PRIMARY KEY,
  delta_id    TEXT NOT NULL REFERENCES state_deltas(delta_id),
  description TEXT NOT NULL,
  confidence  REAL NOT NULL,               -- drives §7.6 confidence flagging
  citation_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  status      TEXT NOT NULL DEFAULT 'open',-- 'open'|'resolved'|'dismissed'
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);

-- ============ Layer 2 trigger state — durable across restarts (D-7) ============
CREATE TABLE synthesis_watermark (
  thread_key            TEXT PRIMARY KEY,
  source                TEXT NOT NULL,
  oldest_unsynth_at     INTEGER NOT NULL,  -- drives the 30-min hard cap
  last_event_at         INTEGER NOT NULL,  -- drives the 5-min quiet window
  last_synthesized_at   INTEGER,
  attempts              INTEGER NOT NULL DEFAULT 0
);

-- ============ Briefing + Feedback ============
CREATE TABLE briefings (
  briefing_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL, window_end INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  mode        TEXT NOT NULL,               -- 'llm' | 'template' (§7.8 fallback)
  narrative_path TEXT NOT NULL,
  delta_ids_json TEXT NOT NULL,
  threads_still_processing INTEGER NOT NULL DEFAULT 0,   -- OI-1 disclosure
  caught_up_at INTEGER,                    -- FR-11 → NFR-10
  first_token_ms INTEGER, total_ms INTEGER
);
CREATE TABLE briefing_claims (
  claim_id TEXT PRIMARY KEY,
  briefing_id TEXT NOT NULL REFERENCES briefings(briefing_id),
  ordinal INTEGER NOT NULL, section TEXT NOT NULL, text TEXT NOT NULL,
  citation_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  delta_id TEXT REFERENCES state_deltas(delta_id)
);
CREATE TABLE feedback (
  feedback_id TEXT PRIMARY KEY,
  briefing_id TEXT NOT NULL, claim_id TEXT,
  verdict TEXT NOT NULL,                   -- 'relevant'|'irrelevant'|'missed'|'wrong'
  note TEXT, created_at INTEGER NOT NULL
);

-- ============ Recurring briefing schedules (FR-3 time-based half, OI-4) ============
CREATE TABLE briefing_schedules (
  schedule_id   TEXT PRIMARY KEY,
  cadence       TEXT NOT NULL,             -- 'daily' | 'weekdays' | 'weekly'
  hour_local    INTEGER NOT NULL,          -- 0-23, evaluated in local time (DST-aware)
  minute_local  INTEGER NOT NULL,
  weekday       INTEGER,                   -- 0-6, only for cadence='weekly'
  enabled       INTEGER NOT NULL DEFAULT 1,
  quiet_from    INTEGER, quiet_to INTEGER, -- local hours; suppress the notification, not the briefing
  last_fired_at INTEGER,                   -- collapses missed runs after sleep; never replayed N times
  created_at    INTEGER NOT NULL
);

-- ============ Observability (NFR-8) ============
CREATE TABLE ai_calls (
  call_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, layer INTEGER NOT NULL,
  model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  latency_ms INTEGER NOT NULL, tokens_in INTEGER, tokens_out INTEGER,
  outcome TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
