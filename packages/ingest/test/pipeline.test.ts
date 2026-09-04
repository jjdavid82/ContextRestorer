/**
 * Integration tests for the ingestion pipeline (Task 1.6).
 *
 * These run against a REAL in-memory SQLite database and REAL repositories, not
 * mocks: the guarantees under test (SEC-4 redact-before-persist, AC-10 replay
 * idempotency, D-7 watermark arming) are all enforced by actual UNIQUE
 * constraints and actual SQL upsert semantics. Mocking the store would test the
 * mock's opinion of those rules instead of the rules.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventsRepo, GraphRepo, WatermarkRepo, migrate, openDb } from '@cr/store';
import { artifactId } from '@cr/core';
import { IngestionPipeline } from '../src/pipeline.js';
import type { RawSourceEvent } from '../src/sources/types.js';

type Db = ReturnType<typeof openDb>;

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const THREAD = 'C1:1';

let db: Db;
let eventsRepo: EventsRepo;
let graphRepo: GraphRepo;
let watermarkRepo: WatermarkRepo;
let enqueueExtraction: ReturnType<typeof vi.fn>;
let pipeline: IngestionPipeline;

/** A minimal well-formed connector item; `overrides` tweak one field at a time. */
function rawEvent(sourceEventId: string, overrides: Partial<RawSourceEvent> = {}): RawSourceEvent {
  return {
    source: 'slack',
    sourceEventId,
    threadKey: THREAD,
    actorId: 'U1',
    occurredAt: 1_000,
    text: 'shipping the migration tonight',
    ...overrides,
  };
}

/** An item whose body still carries a raw secret — i.e. a normalizer that failed. */
function rawWith(secret: string): RawSourceEvent {
  return rawEvent('s-secret', { text: `deploy key is ${secret} please rotate` });
}

function count(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  eventsRepo = new EventsRepo(db);
  graphRepo = new GraphRepo(db);
  watermarkRepo = new WatermarkRepo(db);
  enqueueExtraction = vi.fn();
  pipeline = new IngestionPipeline(eventsRepo, graphRepo, watermarkRepo, enqueueExtraction);
});

afterEach(() => {
  db.close();
});

describe('ingestion pipeline', () => {
  it('redacts before persisting (SEC-4)', async () => {
    const outcome = await pipeline.ingest(rawWith(AWS_KEY));

    const row = db.prepare('SELECT payload_json, redaction_count FROM events').get() as {
      payload_json: string;
      redaction_count: number;
    };

    expect(row.payload_json).not.toContain(AWS_KEY);
    expect(row.payload_json).toContain('[REDACTED:aws_access_key]');
    expect(row.redaction_count).toBe(1);
    expect(outcome.status).toBe('ingested');
    expect(outcome.redactionKinds).toContain('aws_access_key');
  });

  it('redacts even when the connector already redacted (idempotent second pass)', async () => {
    // Simulates the normal path: the Slack normalizer already ran redact(), so
    // the pipeline's own pass must find nothing left to do and must not
    // double-count or mangle the existing placeholder.
    await pipeline.ingest(rawEvent('s-clean', { text: 'key is [REDACTED:aws_access_key] now' }));

    const row = db.prepare('SELECT payload_json, redaction_count FROM events').get() as {
      payload_json: string;
      redaction_count: number;
    };

    expect(row.redaction_count).toBe(0);
    expect(row.payload_json).toContain('[REDACTED:aws_access_key]');
  });

  it('is idempotent — replaying the same batch adds no rows (AC-10)', async () => {
    const batch = [rawEvent('s1'), rawEvent('s2'), rawEvent('s3')];

    const first = await pipeline.ingestBatch(batch);
    const after1 = count('events');

    const second = await pipeline.ingestBatch(batch);

    expect(count('events')).toBe(after1);
    expect(after1).toBe(3);
    expect(first.map((o) => o.status)).toEqual(['ingested', 'ingested', 'ingested']);
    expect(second.map((o) => o.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
  });

  it('touches the synthesis watermark for each new event', async () => {
    await pipeline.ingest(rawEvent('s1', { threadKey: THREAD, occurredAt: 5_000 }));

    const w = watermarkRepo.get(THREAD);
    expect(w?.lastEventAt).toBe(5_000);
    expect(w?.oldestUnsynthAt).toBe(5_000);
    expect(w?.source).toBe('slack');
  });

  it('does NOT reset oldestUnsynthAt on a later event in the same thread', async () => {
    await pipeline.ingest(rawEvent('s1', { threadKey: THREAD, occurredAt: 5_000 }));
    await pipeline.ingest(rawEvent('s2', { threadKey: THREAD, occurredAt: 9_000 }));

    const w = watermarkRepo.get(THREAD);
    expect(w?.oldestUnsynthAt).toBe(5_000); // hard cap keeps running from the first event
    expect(w?.lastEventAt).toBe(9_000); // quiet window restarts
  });

  it('does not re-touch the watermark for a replayed (already-present) event', async () => {
    await pipeline.ingest(rawEvent('s1', { threadKey: THREAD, occurredAt: 5_000 }));
    watermarkRepo.markSynthesized(THREAD, 6_000, null); // thread fully caught up

    const outcome = await pipeline.ingest(rawEvent('s1', { threadKey: THREAD, occurredAt: 5_000 }));

    expect(outcome.status).toBe('duplicate');
    // Still disarmed: a replay must not phantom-re-trigger Layer 2 synthesis.
    expect(watermarkRepo.get(THREAD)?.oldestUnsynthAt).toBeNull();
    expect(watermarkRepo.get(THREAD)?.lastSynthesizedAt).toBe(6_000);
  });

  it('upserts the artifact and advances last_seen_at only', async () => {
    await pipeline.ingest(rawEvent('s1', { threadKey: THREAD, occurredAt: 5_000 }));
    await pipeline.ingest(rawEvent('s2', { threadKey: THREAD, occurredAt: 9_000 }));

    const id = artifactId('slack', 'thread', THREAD);
    const artifact = graphRepo.getArtifact(id);

    expect(count('artifacts')).toBe(1);
    expect(artifact?.firstSeenAt).toBe(5_000); // never rewritten
    expect(artifact?.lastSeenAt).toBe(9_000); // advances
    expect(artifact?.kind).toBe('thread');
    expect(artifact?.externalRef).toBe(THREAD);
  });

  it('does not touch the graph for a replayed event', async () => {
    await pipeline.ingest(rawEvent('s1', { threadKey: THREAD, occurredAt: 5_000 }));
    await pipeline.ingest(rawEvent('s1', { threadKey: THREAD, occurredAt: 9_000 })); // replay, newer clock

    const artifact = graphRepo.getArtifact(artifactId('slack', 'thread', THREAD));
    expect(artifact?.lastSeenAt).toBe(5_000); // duplicate short-circuited before the upsert
  });

  it('enqueues extraction only for genuinely new events, not replays', async () => {
    const batch = [rawEvent('s1'), rawEvent('s2')];

    await pipeline.ingestBatch(batch);
    expect(enqueueExtraction).toHaveBeenCalledTimes(2);

    await pipeline.ingestBatch(batch); // exact replay
    expect(enqueueExtraction).toHaveBeenCalledTimes(2);

    await pipeline.ingest(rawEvent('s3'));
    expect(enqueueExtraction).toHaveBeenCalledTimes(3);
  });

  it('enqueues the deterministic eventId, matching the persisted primary key', async () => {
    await pipeline.ingest(rawEvent('s1'));

    const row = db.prepare('SELECT event_id FROM events').get() as { event_id: string };
    expect(enqueueExtraction).toHaveBeenCalledWith(row.event_id);
  });

  it('preserves per-source identity — same sourceEventId on two sources is two events', async () => {
    await pipeline.ingest(rawEvent('shared', { source: 'slack', threadKey: 'C1:1' }));
    await pipeline.ingest(rawEvent('shared', { source: 'gmail', threadKey: 'T-1' }));

    expect(count('events')).toBe(2);
  });

  it('defaults a missing actorId to the empty string rather than failing', async () => {
    const raw = rawEvent('s-anon');
    delete raw.actorId;

    await pipeline.ingest(raw);

    const row = db.prepare('SELECT actor_id FROM events').get() as { actor_id: string | null };
    expect(row.actor_id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// A-2 — linking a new thread to its channel's declared project (FR-5 / FR-8)
// ---------------------------------------------------------------------------

describe('project linking on ingest', () => {
  const PROJECT_REL = 'belongs_to';

  /** A declared project the `belongs_to` edge can point at. */
  function declareProject(name = 'Migration'): string {
    return graphRepo.declareProject({ name, origin: 'declared', stakesWeight: 2 }).projectId;
  }

  it('links the thread artifact when the resolver names a project', async () => {
    const projectId = declareProject();
    const linked = new IngestionPipeline(
      eventsRepo,
      graphRepo,
      watermarkRepo,
      enqueueExtraction,
      undefined,
      () => projectId,
    );

    await linked.ingest(rawEvent('s1', { threadKey: 'C1:100.1' }));

    // The edge must exist in the graph, because that is the only thing
    // `toRankableDelta` and retrieval's stakes lookup ever read.
    const artifact = artifactId('slack', 'thread', 'C1:100.1');
    expect(graphRepo.relatedIds(artifact, PROJECT_REL)).toEqual([projectId]);
  });

  it('writes no edge when the resolver returns null', async () => {
    const linked = new IngestionPipeline(
      eventsRepo,
      graphRepo,
      watermarkRepo,
      enqueueExtraction,
      undefined,
      () => null,
    );

    await linked.ingest(rawEvent('s1', { threadKey: 'C1:100.1' }));

    expect(graphRepo.relatedIds(artifactId('slack', 'thread', 'C1:100.1'), PROJECT_REL)).toEqual([]);
  });

  it('does not duplicate the edge across later messages on the same thread', async () => {
    const projectId = declareProject();
    const linked = new IngestionPipeline(
      eventsRepo,
      graphRepo,
      watermarkRepo,
      enqueueExtraction,
      undefined,
      () => projectId,
    );

    await linked.ingest(rawEvent('s1', { threadKey: 'C1:100.1', occurredAt: 1_000 }));
    await linked.ingest(rawEvent('s2', { threadKey: 'C1:100.1', occurredAt: 2_000 }));

    // `relate` is idempotent on (from, rel, to) — re-linking is a no-op, not a
    // second row.
    expect(graphRepo.relatedIds(artifactId('slack', 'thread', 'C1:100.1'), PROJECT_REL)).toEqual([
      projectId,
    ]);
  });

  it('is not called on a replayed event', async () => {
    const projectId = declareProject();
    const resolver = vi.fn(() => projectId);
    const linked = new IngestionPipeline(
      eventsRepo,
      graphRepo,
      watermarkRepo,
      enqueueExtraction,
      undefined,
      resolver,
    );

    await linked.ingest(rawEvent('s1', { threadKey: 'C1:100.1' }));
    await linked.ingest(rawEvent('s1', { threadKey: 'C1:100.1' })); // duplicate

    // The duplicate path returns before touching the graph at all (AC-10), and
    // linking must not be the one thing that breaks that guarantee.
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('behaves exactly as before when no resolver is supplied', async () => {
    await pipeline.ingest(rawEvent('s1', { threadKey: 'C1:100.1' }));

    expect(graphRepo.relatedIds(artifactId('slack', 'thread', 'C1:100.1'), PROJECT_REL)).toEqual([]);
  });
});
