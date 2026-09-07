-- ============ The Layer 1 gate on synthesis: make it fast, and make it end ============
--
-- `WatermarkRepo.due()` (DUE_SQL) will not synthesize a thread while any event
-- on it lacks an `extractions` row, and its hard-cap branch also asks "has
-- Layer 1 written anything lately". Both run on every 30s scheduler tick, and
-- `EventsRepo.countUnextracted()` runs the same `NOT EXISTS extractions` shape
-- every 5s for the status strip. `extractions.event_id` had no index (a
-- `REFERENCES` does not create one in SQLite) and `extractions.created_at` had
-- none either, so all of that was a full scan of the table.
--
-- Two plain indexes fix that. `IF NOT EXISTS` so a hand-built DB is tolerated.

CREATE INDEX IF NOT EXISTS idx_extractions_event      ON extractions(event_id);
CREATE INDEX IF NOT EXISTS idx_extractions_created_at ON extractions(created_at);

-- ---------------------------------------------------------------------------
--
-- "Needs extraction" is defined as "no row in `extractions`", and the recovery
-- sweep re-offers everything that matches on every pass. Correct for a
-- transient failure (a crash, an Ollama restart); wrong for an event this
-- (model, prompt) pair simply cannot classify. `parseLayer1Batch` returns a
-- `null` slot for such an event on every batch, no row is ever written, the
-- sweep burns a model call on it forever, and the DUE_SQL gate above holds the
-- event's whole thread out of synthesis indefinitely — for one bad event.
--
-- Layer 1 records a row here each time the model RESPONDS but fails to classify
-- the event (a transport error is NOT counted — that is the transient case we
-- do want retried). Once `attempts` reaches Layer 1's cap the extractor writes
-- a terminal `noise` row tagged `model = 'unextractable:layer1'`, which takes
-- the event out of both the sweep queue and the gate. Rows here are kept as the
-- audit trail; re-examining a written-off event later means deleting both this
-- row and its terminal `extractions` row by hand — a deliberate maintenance
-- step, not something any code path does on its own.

CREATE TABLE extraction_failures (
  event_id  TEXT PRIMARY KEY REFERENCES events(event_id),
  attempts  INTEGER NOT NULL,
  first_at  INTEGER NOT NULL,
  last_at   INTEGER NOT NULL
);
