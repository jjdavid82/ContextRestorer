/**
 * PendingItem derivation (Task 2.6).
 *
 * Every repository here is the REAL one on an in-memory SQLite database. That is
 * not incidental: three of the five rules under test are only meaningful against
 * the actual schema —
 *
 *   - `pending_items.citation_artifact_id` is a NOT NULL FK into `artifacts`, so
 *     the "never uncited" rule and the failed-insert path can only bite when
 *     `PRAGMA foreign_keys` is genuinely on (it is; see `openDb`);
 *   - `pending_items` has NO unique constraint on `delta_id`, so the duplicate
 *     guard has to be shown to be doing the work itself rather than leaning on
 *     the database;
 *   - `state_deltas` is append-only with a D-6 supersedes chain that `DeltasRepo`
 *     derives, so "a superseding delta resolves the prior item" needs real rows
 *     to have a chain at all.
 *
 * A mocked repo would let all three pass while the schema disagreed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { FakeClock, type Artifact, type DeltaKind, type Person, type StateDelta } from '@cr/core';
import {
  AiCallsRepo,
  DeltasRepo,
  GraphRepo,
  PendingItemsRepo,
  WatermarkRepo,
  migrate,
  openDb,
} from '@cr/store';
import type { GenerateJsonOptions, GenerateJsonResult, OllamaClient } from '../src/ollama.js';
import type { RetrievalResult, RetrievedChunk } from '../src/retrieval.js';
import { Layer2Synthesizer, type ThreadRetriever } from '../src/layer2/synthesize.js';
import {
  LOW_CONFIDENCE_FLAG_THRESHOLD,
  derivePendingItem,
  isLowConfidence,
  resolvePendingItemsForSupersededDelta,
  waitsOnSelf,
  type PendingDerivationInput,
} from '../src/layer2/pending.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const MODEL = 'llama3.1:8b';
const PROMPT_VERSION = 'layer2-synthesize.v1';
const K = 'C1:1';
const A1 = 'slack:thread:C1:1';
const MISSING_ARTIFACT = 'slack:thread:NEVER_INGESTED';

let db: Database;
let deltas: DeltasRepo;
let pending: PendingItemsRepo;
let graph: GraphRepo;
let clock: FakeClock;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  deltas = new DeltasRepo(db);
  pending = new PendingItemsRepo(db);
  graph = new GraphRepo(db);
  clock = new FakeClock(NOW);
});

afterEach(() => {
  db.close();
});

/** A real `artifacts` row, so the citation FK has something to point at. */
function seedArtifact(artifactId: string): void {
  const artifact: Artifact = {
    artifactId,
    source: 'slack',
    kind: 'thread',
    externalRef: `https://example.invalid/${artifactId}`,
    title: null,
    state: null,
    ownerId: null,
    firstSeenAt: NOW - 10 * MIN,
    lastSeenAt: NOW,
  };
  graph.upsertArtifact(artifact);
}

/** Appends a real delta so `pending_items.delta_id`'s FK resolves. */
function appendDelta(over: { kind?: DeltaKind; summary?: string } = {}): StateDelta {
  return deltas.append({
    threadKey: K,
    artifactId: null,
    summary: over.summary ?? 'The team committed to Postgres for the ledger.',
    kind: over.kind ?? 'decision',
    confidence: 0.8,
    sourceEventIds: ['e-1'],
    citationArtifactIds: [A1],
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    createdAt: clock.now(),
  });
}

const input = (over: Partial<PendingDerivationInput> = {}): PendingDerivationInput => ({
  deltaId: 'placeholder',
  threadKey: K,
  citationArtifactId: A1,
  confidence: 0.72,
  description: 'Reply to the vendor with the migration date.',
  waitingOnSelf: true,
  ...over,
});

/** Rows as SQLite holds them, so a suppressed insert cannot hide behind a filter. */
const allRows = (): Array<{ delta_id: string; status: string; resolved_at: number | null }> =>
  db.prepare('SELECT delta_id, status, resolved_at FROM pending_items').all() as Array<{
    delta_id: string;
    status: string;
    resolved_at: number | null;
  }>;

// ---------------------------------------------------------------------------
// Rule 1 — only obligations owed by THE USER become items (FR-4 / AC-4).
// Per the plan this is "the most common false-positive source", so it is first.
// ---------------------------------------------------------------------------

describe('derivePendingItem — rule 1: waiting on the user, not a third party', () => {
  it('creates the item when the obligation is the user’s', () => {
    seedArtifact(A1);
    const delta = appendDelta();

    const item = derivePendingItem(
      input({ deltaId: delta.deltaId, waitingOnSelf: true }),
      pending,
      clock,
    );

    expect(item).not.toBeNull();
    expect(item).toMatchObject({
      deltaId: delta.deltaId,
      description: 'Reply to the vendor with the migration date.',
      citationArtifactId: A1,
      status: 'open',
      createdAt: NOW,
      resolvedAt: null,
    });
    expect(pending.listOpen()).toHaveLength(1);
  });

  it('creates NOTHING when the obligation is owed by a third party', () => {
    seedArtifact(A1);
    const delta = appendDelta();

    const item = derivePendingItem(
      input({
        deltaId: delta.deltaId,
        description: 'Dana to migrate the ledger schema before Friday.',
        waitingOnSelf: false,
      }),
      pending,
      clock,
    );

    // The delta still narrates it; only the to-do is suppressed.
    expect(item).toBeNull();
    expect(pending.listOpen()).toEqual([]);
    expect(allRows()).toEqual([]);
    expect(deltas.chainFor(K)).toHaveLength(1);
  });

  it('reads waiting_on: "self" as the user and a named party as someone else', () => {
    // The condition is genuinely falsifiable: only recognisably-first-person
    // tokens pass, and anything naming another party does not.
    expect(waitsOnSelf('self')).toBe(true);
    expect(waitsOnSelf('  SELF  ')).toBe(true);
    expect(waitsOnSelf('me')).toBe(true);
    expect(waitsOnSelf('the user')).toBe(true);

    expect(waitsOnSelf('Dana')).toBe(false);
    expect(waitsOnSelf('the vendor')).toBe(false);
    expect(waitsOnSelf('legal team')).toBe(false);

    // Absent/blank is the safe direction for a precision requirement: no
    // evidence the obligation is the user's must not default to admitting it.
    expect(waitsOnSelf(undefined)).toBe(false);
    expect(waitsOnSelf(null)).toBe(false);
    expect(waitsOnSelf('')).toBe(false);
  });

  it('suppresses a third-party item even when everything else is perfect', () => {
    // Cited, high confidence, well-described — and still not a to-do, because
    // the user is not the one who owes it. `is_self` is what decides.
    seedArtifact(A1);
    const delta = appendDelta();
    const self: Person = {
      personId: 'p-self',
      displayName: 'The User',
      emailHash: null,
      isSelf: true,
    };
    const other: Person = { personId: 'p-dana', displayName: 'Dana', emailHash: null, isSelf: false };
    graph.upsertPerson(self);
    graph.upsertPerson(other);

    expect(graph.getPerson('p-self')?.isSelf).toBe(true);
    expect(graph.getPerson('p-dana')?.isSelf).toBe(false);

    const forOther = derivePendingItem(
      input({ deltaId: delta.deltaId, confidence: 0.99, waitingOnSelf: waitsOnSelf('Dana') }),
      pending,
      clock,
    );
    expect(forOther).toBeNull();
    expect(allRows()).toEqual([]);

    const forSelf = derivePendingItem(
      input({ deltaId: delta.deltaId, confidence: 0.99, waitingOnSelf: waitsOnSelf('self') }),
      pending,
      clock,
    );
    expect(forSelf).not.toBeNull();
    expect(allRows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — a pending item inherits the delta's citation, and is never uncited.
// ---------------------------------------------------------------------------

describe('derivePendingItem — rule 2: never uncited', () => {
  it('creates NOTHING when the derivation has no citation', () => {
    seedArtifact(A1);
    const delta = appendDelta();

    expect(derivePendingItem(input({ deltaId: delta.deltaId, citationArtifactId: null }), pending, clock)).toBeNull();
    expect(derivePendingItem(input({ deltaId: delta.deltaId, citationArtifactId: '   ' }), pending, clock)).toBeNull();

    expect(allRows()).toEqual([]);
  });

  it('carries the delta’s citation onto the item it creates', () => {
    seedArtifact(A1);
    const delta = appendDelta();

    const item = derivePendingItem(
      input({ deltaId: delta.deltaId, citationArtifactId: delta.citationArtifactIds[0] ?? null }),
      pending,
      clock,
    );

    expect(item?.citationArtifactId).toBe(A1);
    // Non-null in the database too, not merely in the returned object.
    expect(
      db.prepare('SELECT citation_artifact_id AS c FROM pending_items').get(),
    ).toEqual({ c: A1 });
  });

  it('drops the obligation LOUDLY when the citation FK cannot resolve', () => {
    // The regression this replaces: `catch {}` swallowed an artifact the graph
    // had not caught up on, and a missing obligation looked exactly like a model
    // that reported none. It is still dropped — the delta is already committed
    // and retrying would duplicate it — but it is no longer invisible.
    const delta = appendDelta(); // NB: MISSING_ARTIFACT was never seeded
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const item = derivePendingItem(
      input({ deltaId: delta.deltaId, citationArtifactId: MISSING_ARTIFACT }),
      pending,
      clock,
    );

    expect(item).toBeNull();
    expect(allRows()).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);

    const [message, context] = spy.mock.calls[0] ?? [];
    expect(String(message)).toContain('[layer2/pending]');
    expect(context).toMatchObject({
      deltaId: delta.deltaId,
      threadKey: K,
      citationArtifactId: MISSING_ARTIFACT,
    });
    // Enough context to debug, and no model-generated prose (SEC-7).
    expect(String((context as { reason: string }).reason)).toMatch(/FOREIGN KEY/i);
    expect(context).not.toHaveProperty('description');

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — a superseding delta RESOLVES the prior item; it never deletes it.
// ---------------------------------------------------------------------------

describe('resolvePendingItemsForSupersededDelta — rule 3: resolved, not deleted', () => {
  it('marks the prior open item resolved and keeps the row on disk', () => {
    seedArtifact(A1);
    const v1 = appendDelta({ kind: 'decision' });
    const item = derivePendingItem(input({ deltaId: v1.deltaId }), pending, clock);
    expect(item).not.toBeNull();

    clock.advance(10 * MIN);
    const v2 = appendDelta({ kind: 'resolution', summary: 'The migration date was confirmed.' });
    expect(v2.supersedes).toBe(v1.deltaId);

    const closed = resolvePendingItemsForSupersededDelta(v2.supersedes ?? [], pending, clock.now());

    expect(closed).toHaveLength(1);
    expect(pending.listOpen()).toEqual([]);
    // The row is still there — `resolved`, with a timestamp. A DELETE would
    // erase "this was owed and got done", which is the signal, not the noise.
    expect(allRows()).toEqual([
      { delta_id: v1.deltaId, status: 'resolved', resolved_at: NOW + 10 * MIN },
    ]);
    expect(pending.getById(item?.pendingId ?? '')).toMatchObject({
      status: 'resolved',
      resolvedAt: NOW + 10 * MIN,
      description: 'Reply to the vendor with the migration date.',
      citationArtifactId: A1,
    });
  });

  it('closes an item carried by an EARLIER version, not just the adjacent one', () => {
    // v1 raises the obligation, v2 is unrelated progress, v3 resolves. v3's
    // `supersedes` points at v2, so only passing the whole prior chain finds it.
    seedArtifact(A1);
    const v1 = appendDelta({ kind: 'decision' });
    derivePendingItem(input({ deltaId: v1.deltaId }), pending, clock);

    clock.advance(MIN);
    const v2 = appendDelta({ kind: 'progress', summary: 'The migration reached staging.' });
    clock.advance(MIN);
    const v3 = appendDelta({ kind: 'resolution', summary: 'The migration date was confirmed.' });
    expect(v3.supersedes).toBe(v2.deltaId);

    const priorIds = deltas
      .chainFor(K)
      .map((d) => d.deltaId)
      .filter((id) => id !== v3.deltaId);
    const closed = resolvePendingItemsForSupersededDelta(priorIds, pending, clock.now());

    expect(closed.map((c) => c.deltaId)).toEqual([v1.deltaId]);
    expect(pending.listOpen()).toEqual([]);
    expect(allRows()).toEqual([
      { delta_id: v1.deltaId, status: 'resolved', resolved_at: NOW + 2 * MIN },
    ]);
  });

  it('leaves items belonging to other deltas untouched', () => {
    seedArtifact(A1);
    const mine = appendDelta();
    derivePendingItem(input({ deltaId: mine.deltaId }), pending, clock);

    const otherThread = deltas.append({
      threadKey: 'C9:9',
      artifactId: null,
      summary: 'A different thread decided something else.',
      kind: 'decision',
      confidence: 0.6,
      sourceEventIds: ['e-9'],
      citationArtifactIds: [A1],
      model: MODEL,
      promptVersion: PROMPT_VERSION,
      createdAt: clock.now(),
    });
    derivePendingItem(
      input({ deltaId: otherThread.deltaId, description: 'Unrelated obligation.' }),
      pending,
      clock,
    );

    resolvePendingItemsForSupersededDelta(mine.deltaId, pending, clock.now());

    expect(pending.listOpen().map((i) => i.deltaId)).toEqual([otherThread.deltaId]);
  });

  it('is a no-op when there is nothing to close', () => {
    seedArtifact(A1);
    const delta = appendDelta();
    derivePendingItem(input({ deltaId: delta.deltaId }), pending, clock);

    // v1 has no predecessor, so the synthesizer passes an empty set.
    expect(resolvePendingItemsForSupersededDelta([], pending, clock.now())).toEqual([]);
    expect(pending.listOpen()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — low confidence is FLAGGED, never suppressed (§7.6).
// ---------------------------------------------------------------------------

describe('derivePendingItem — rule 4: low confidence still stores', () => {
  it('stores a low-confidence but cited item, with its confidence intact', () => {
    seedArtifact(A1);
    const delta = appendDelta();
    const low = 0.11;
    expect(low).toBeLessThan(LOW_CONFIDENCE_FLAG_THRESHOLD);

    const item = derivePendingItem(input({ deltaId: delta.deltaId, confidence: low }), pending, clock);

    expect(item).not.toBeNull();
    expect(item?.confidence).toBe(low);
    expect(item?.status).toBe('open');
    // Survives the round trip, so a later UI layer can flag rather than guess.
    expect(pending.listOpen()[0]?.confidence).toBe(low);
    expect(isLowConfidence({ confidence: low })).toBe(true);
    expect(isLowConfidence({ confidence: 0.9 })).toBe(false);
  });

  it('stores across the whole confidence range — suppression is only for rule 2', () => {
    seedArtifact(A1);
    for (const confidence of [0, 0.05, 0.49, 0.5, 0.95, 1]) {
      const delta = appendDelta();
      const item = derivePendingItem(input({ deltaId: delta.deltaId, confidence }), pending, clock);
      expect(item?.confidence).toBe(confidence);
    }

    expect(pending.listOpen()).toHaveLength(6);
    // The SAME confidences, uncited, write nothing at all.
    const before = allRows().length;
    for (const confidence of [0, 0.5, 1]) {
      const delta = appendDelta();
      expect(
        derivePendingItem(
          input({ deltaId: delta.deltaId, confidence, citationArtifactId: null }),
          pending,
          clock,
        ),
      ).toBeNull();
    }
    expect(allRows()).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — one item per delta, however many times derivation runs.
// ---------------------------------------------------------------------------

describe('derivePendingItem — rule 5: no duplicate for the same delta', () => {
  it('does not insert a second row for an identical deltaId', () => {
    seedArtifact(A1);
    const delta = appendDelta();

    const first = derivePendingItem(input({ deltaId: delta.deltaId }), pending, clock);
    const second = derivePendingItem(input({ deltaId: delta.deltaId }), pending, clock);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(allRows()).toEqual([{ delta_id: delta.deltaId, status: 'open', resolved_at: null }]);
  });

  it('guards even when the second derivation says something different', () => {
    // `pending_items` has NO unique constraint on delta_id, so a differing
    // description would otherwise sail straight in as a second obligation.
    seedArtifact(A1);
    const delta = appendDelta();

    derivePendingItem(input({ deltaId: delta.deltaId, description: 'Reply to the vendor.' }), pending, clock);
    clock.advance(MIN);
    const second = derivePendingItem(
      input({ deltaId: delta.deltaId, description: 'Reply to the vendor, with the date.', confidence: 0.9 }),
      pending,
      clock,
    );

    expect(second).toBeNull();
    expect(pending.listOpen()).toHaveLength(1);
    expect(pending.listOpen()[0]?.description).toBe('Reply to the vendor.');
  });

  it('still allows one item per distinct delta on the same thread', () => {
    seedArtifact(A1);
    const v1 = appendDelta();
    const v2 = appendDelta({ kind: 'progress', summary: 'Staging came up.' });

    derivePendingItem(input({ deltaId: v1.deltaId }), pending, clock);
    derivePendingItem(input({ deltaId: v2.deltaId, description: 'Sign off on staging.' }), pending, clock);

    expect(pending.listOpen().map((i) => i.deltaId)).toEqual([v1.deltaId, v2.deltaId]);
  });
});

// ---------------------------------------------------------------------------
// The wiring. The rules above are exercised directly; these assert that
// `Layer2Synthesizer.write()` actually routes through them, which is the part a
// unit test of the free functions cannot see.
// ---------------------------------------------------------------------------

/** Scripted `OllamaClient`, replaying queued responses in order. */
class StubOllama implements OllamaClient {
  private queue: GenerateJsonResult<unknown>[] = [];

  push(value: unknown): this {
    this.queue.push({ value, raw: JSON.stringify(value), latencyMs: 10 });
    return this;
  }

  generateJson<T>(_o: GenerateJsonOptions): Promise<GenerateJsonResult<T>> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error('StubOllama: unexpected generateJson call');
    return Promise.resolve(next as GenerateJsonResult<T>);
  }

  generateStream(): AsyncIterable<string> {
    throw new Error('not used');
  }

  embed(): Promise<number[][]> {
    throw new Error('not used');
  }
}

/** Hand-built retrieval fake: `chunks` IS the citation allowlist. */
class StubRetrieval implements ThreadRetriever {
  chunks: RetrievedChunk[] = [
    {
      artifactId: A1,
      eventId: 'e-1',
      threadKey: K,
      occurredAt: NOW - MIN,
      text: 'We are going with Postgres for the ledger.',
      score: 0.9,
    },
  ];

  forThread(): Promise<RetrievalResult> {
    return Promise.resolve({ chunks: this.chunks, partial: false });
  }
}

describe('Layer2Synthesizer — wired to the derivation rules', () => {
  const meaningful = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    meaningful: true,
    kind: 'decision',
    summary: 'The team committed to Postgres for the ledger.',
    confidence: 0.81,
    citation_artifact_ids: [A1],
    ...over,
  });

  function makeSynth(ollama: StubOllama): Layer2Synthesizer {
    return new Layer2Synthesizer(
      ollama,
      new StubRetrieval(),
      deltas,
      pending,
      new WatermarkRepo(db),
      new AiCallsRepo(db),
      MODEL,
      PROMPT_VERSION,
      clock,
    );
  }

  it('writes the delta but NO item when the model says a third party owes it', async () => {
    seedArtifact(A1);
    const ollama = new StubOllama().push(
      meaningful({
        pending_item: {
          description: 'Dana to migrate the ledger schema before Friday.',
          confidence: 0.66,
          waiting_on: 'Dana',
          citation_artifact_id: A1,
        },
      }),
    );

    await makeSynth(ollama).synthesize(K);

    expect(deltas.chainFor(K)).toHaveLength(1);
    expect(allRows()).toEqual([]);
  });

  it('writes the item when the model says the user owes it', async () => {
    seedArtifact(A1);
    const ollama = new StubOllama().push(
      meaningful({
        pending_item: {
          description: 'Reply to the vendor with the migration date.',
          confidence: 0.3, // below the flag threshold — stored anyway (§7.6)
          waiting_on: 'self',
          citation_artifact_id: A1,
        },
      }),
    );

    await makeSynth(ollama).synthesize(K);

    const open = pending.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      deltaId: deltas.chainFor(K)[0]?.deltaId,
      confidence: 0.3,
      citationArtifactId: A1,
      status: 'open',
    });
  });

  it('resolves — never deletes — the prior item when a resolution supersedes it', async () => {
    seedArtifact(A1);
    const ollama = new StubOllama()
      .push(
        meaningful({
          pending_item: {
            description: 'Reply to the vendor with the migration date.',
            confidence: 0.7,
            waiting_on: 'self',
            citation_artifact_id: A1,
          },
        }),
      )
      .push(
        meaningful({
          kind: 'resolution',
          summary: 'The migration date was confirmed with the vendor.',
        }),
      );
    const synth = makeSynth(ollama);

    await synth.synthesize(K);
    const v1 = deltas.chainFor(K)[0];
    expect(pending.listOpen()).toHaveLength(1);

    clock.advance(10 * MIN);
    await synth.synthesize(K);

    const chain = deltas.chainFor(K);
    expect(chain.map((d) => d.version)).toEqual([1, 2]);
    expect(chain[1]?.supersedes).toBe(v1?.deltaId);

    expect(pending.listOpen()).toEqual([]);
    expect(allRows()).toEqual([
      { delta_id: v1?.deltaId ?? '', status: 'resolved', resolved_at: NOW + 10 * MIN },
    ]);
  });

  it('leaves the prior item OPEN when the superseding delta is not a resolution', async () => {
    seedArtifact(A1);
    const ollama = new StubOllama()
      .push(
        meaningful({
          pending_item: {
            description: 'Reply to the vendor with the migration date.',
            confidence: 0.7,
            waiting_on: 'self',
            citation_artifact_id: A1,
          },
        }),
      )
      .push(meaningful({ kind: 'progress', summary: 'The migration reached staging.' }));
    const synth = makeSynth(ollama);

    await synth.synthesize(K);
    clock.advance(10 * MIN);
    await synth.synthesize(K);

    // Progress on a thread does not discharge what the thread put on the user.
    expect(pending.listOpen()).toHaveLength(1);
    expect(pending.listOpen()[0]?.status).toBe('open');
  });
});
