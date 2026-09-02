import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate } from '../src/index.js';
import type { Database } from 'better-sqlite3';

let db: Database;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

const insertEvent = () => db.prepare(
  `INSERT INTO events (event_id, source, source_event_id, thread_key, occurred_at, ingested_at, payload_json)
   VALUES ('e1','slack','s1','C1:1',1000,1000,'{}')`
).run();

describe('append-only enforcement', () => {
  it('rejects UPDATE on events', () => {
    insertEvent();
    expect(() => db.prepare(`UPDATE events SET actor_id='x' WHERE event_id='e1'`).run())
      .toThrow(/append-only/);
  });

  it('rejects DELETE on events', () => {
    insertEvent();
    expect(() => db.prepare(`DELETE FROM events WHERE event_id='e1'`).run())
      .toThrow(/append-only/);
  });

  it('rejects UPDATE on state_deltas (D-6)', () => {
    insertEvent();
    db.prepare(`INSERT INTO state_deltas
      (delta_id, thread_key, version, summary, kind, confidence,
       source_event_ids_json, citation_artifact_ids_json, model, prompt_version, created_at)
      VALUES ('d1','C1:1',1,'s','decision',0.9,'["e1"]','[]','m','v1',1000)`).run();
    expect(() => db.prepare(`UPDATE state_deltas SET summary='x' WHERE delta_id='d1'`).run())
      .toThrow(/append-only/);
  });

  it('enforces idempotency via UNIQUE(source, source_event_id)', () => {
    insertEvent();
    expect(() => insertEvent()).toThrow(/UNIQUE/);
  });
});
