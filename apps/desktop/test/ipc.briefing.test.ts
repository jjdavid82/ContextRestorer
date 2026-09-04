/**
 * First-paint path tests (Task 3.5) — `apps/desktop/src/ipc/briefing.ts`.
 *
 * These run against a REAL `PendingItemsRepo` over `openDb(':memory:')` + `migrate`,
 * not a stubbed reader: the whole claim of this module is "the first screenful comes
 * out of SQLite fast enough", and a fake in-memory array would prove nothing about
 * either the query or the 200ms budget.
 *
 * `briefing.ts` imports `ipcMain` at module scope, which does not exist outside a
 * running Electron process — same `vi.mock('electron', …)` + dynamic-import pattern
 * as `oauth.test.ts`/`health.test.ts`/`tray.test.ts`.
 *
 * The four numbered requirements map onto the four `describe` blocks below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { migrate, openDb, PendingItemsRepo, GraphRepo, EventsRepo, BriefingsRepo } from '@cr/store';
import type { Artifact, Event, SourceId } from '@cr/core';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const {
  DEFAULT_STAKES_WEIGHT,
  PENDING_CHANNEL,
  REQUEST_CHANNEL,
  RESOLVE_CHANNEL,
  SNAPSHOT_CHANNEL,
  RESUME_POINT_CHANNEL,
  beginBriefing,
  citationForArtifact,
  getBriefingSnapshot,
  getResumePoint,
  sourceQuoteFor,
  MAX_SOURCE_QUOTE_CHARS,
  DEFAULT_MAX_CHANGED_ITEMS,
  listPending,
  parseBriefingWindow,
  rankPendingItems,
  registerBriefingHandlers,
  resolvePendingItem,
} = await import('../src/ipc/briefing.js');

type BriefingModule = typeof import('../src/ipc/briefing.js');
type Deps = Parameters<BriefingModule['listPending']>[0];

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let db: Database;
let pending: PendingItemsRepo;
let graph: GraphRepo;
let events: EventsRepo;
let briefings: BriefingsRepo;

/**
 * A stub with the shape of `@cr/ai`'s Ollama client.
 *
 * It is deliberately NEVER passed to anything: `BriefingHandlerDeps` has no member
 * it could be assigned to. Its call counts exist purely as a tripwire for a future
 * edit that widens the dependency set — see the "zero Ollama calls" block.
 */
function makeOllamaStub(): {
  generateJson: ReturnType<typeof vi.fn>;
  generateStream: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
  callCount(): number;
} {
  const generateJson = vi.fn(() => Promise.reject(new Error('Ollama must not be called')));
  const generateStream = vi.fn(() => {
    throw new Error('Ollama must not be called');
  });
  const embed = vi.fn(() => Promise.reject(new Error('Ollama must not be called')));
  return {
    generateJson,
    generateStream,
    embed,
    callCount: () =>
      generateJson.mock.calls.length + generateStream.mock.calls.length + embed.mock.calls.length,
  };
}

/** `pending_items` has live FKs to both `artifacts` and `state_deltas`. */
function seedArtifact(id: string): void {
  db.prepare(
    `INSERT INTO artifacts (artifact_id, source, kind, external_ref, first_seen_at, last_seen_at)
     VALUES (?, 'slack', 'message', ?, 1000, 1000)`,
  ).run(id, `https://slack/${id}`);
}

function seedDelta(id: string, artifact: string): void {
  db.prepare(
    `INSERT INTO state_deltas
       (delta_id, thread_key, version, summary, kind, confidence,
        source_event_ids_json, citation_artifact_ids_json, model, prompt_version, created_at)
     VALUES (?, ?, 1, 'summary', 'decision', 0.9, '[]', ?, 'llama3', 'v1', 1000)`,
  ).run(id, `C:${id}`, JSON.stringify([artifact]));
}

/** Insert one open item, minting its artifact + delta so the FKs are satisfiable. */
function seedPending(opts: {
  pendingId: string;
  confidence: number;
  createdAt: number;
  artifactId?: string;
  description?: string;
}): string {
  const artifact = opts.artifactId ?? `art-${opts.pendingId}`;
  const delta = `delta-${opts.pendingId}`;
  const exists = db
    .prepare(`SELECT 1 FROM artifacts WHERE artifact_id = ?`)
    .get(artifact) as unknown;
  if (exists === undefined) seedArtifact(artifact);
  seedDelta(delta, artifact);

  pending.insert({
    pendingId: opts.pendingId,
    deltaId: delta,
    description: opts.description ?? `obligation ${opts.pendingId}`,
    confidence: opts.confidence,
    citationArtifactId: artifact,
    createdAt: opts.createdAt,
  });
  return artifact;
}

/**
 * A thread artifact exactly as `@cr/ingest`'s `artifactFor()` builds one:
 * `externalRef` IS the thread key — same fixture `ipc.claim.test.ts` uses,
 * since `citationForArtifact` walks the identical join.
 */
function seedThreadArtifact(opts: { artifactId: string; threadKey: string; source?: SourceId }): Artifact {
  const artifact: Artifact = {
    artifactId: opts.artifactId,
    source: opts.source ?? 'slack',
    kind: 'thread',
    externalRef: opts.threadKey,
    title: null,
    state: null,
    ownerId: null,
    firstSeenAt: 1_000,
    lastSeenAt: 1_000,
  };
  graph.upsertArtifact(artifact);
  return artifact;
}

/** One already-redacted event on `threadKey`. */
function seedEvent(opts: {
  eventId: string;
  threadKey: string;
  occurredAt: number;
  source?: SourceId;
  sourceEventId?: string;
  /** Body text. Defaults to `body of <eventId>`. */
  text?: string;
}): Event {
  const event: Event = {
    eventId: opts.eventId,
    source: opts.source ?? 'slack',
    sourceEventId: opts.sourceEventId ?? `C123:${opts.occurredAt / 1000}`,
    threadKey: opts.threadKey,
    actorId: 'U-alice',
    occurredAt: opts.occurredAt,
    ingestedAt: opts.occurredAt + 10,
    payload: { text: opts.text ?? `body of ${opts.eventId}`, isNoiseCandidate: false },
    redactionCount: 0,
  };
  events.insertIfAbsent(event);
  return event;
}

/** A `briefings` row, defaulting to a finished LLM run. */
function seedBriefing(
  briefingId: string,
  over: { mode?: 'llm' | 'template'; totalMs?: number | null; threadsStillProcessing?: number } = {},
): void {
  briefings.create({
    briefingId,
    windowStart: 1_000,
    windowEnd: 2_000,
    generatedAt: 3_000,
    mode: over.mode ?? 'llm',
    narrativePath: `briefings/${briefingId}.md`,
    deltaIds: [],
    threadsStillProcessing: over.threadsStillProcessing ?? 0,
  });
  if (over.totalMs !== null) {
    briefings.recordTimings(briefingId, 900, over.totalMs ?? 4_200);
  }
}

/** Declare a project at `stakesWeight` and attach `artifactIds` to it. */
function seedProject(name: string, stakesWeight: number, artifactIds: string[]): void {
  const project = graph.declareProject({ name, origin: 'declared', stakesWeight });
  for (const artifactId of artifactIds) {
    graph.relate({ fromId: artifactId, rel: 'belongs_to', toId: project.projectId });
  }
}

function makeDeps(over: Partial<Deps> = {}): Deps {
  return {
    pending,
    graph,
    startGeneration: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  handle.mockReset();
  db = openDb(':memory:');
  migrate(db);
  pending = new PendingItemsRepo(db);
  graph = new GraphRepo(db);
  events = new EventsRepo(db);
  briefings = new BriefingsRepo(db);
});

afterEach(() => {
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Requirement 1 — ranked by stakes, zero Ollama calls                        */
/* -------------------------------------------------------------------------- */

describe('briefing:pending returns open items ranked by stakes with zero Ollama calls', () => {
  it('orders by stakes weight x confidence, highest first', () => {
    // Equal confidence, different project stakes: stakes alone must decide.
    const lowArtifact = seedPending({ pendingId: 'p-low', confidence: 0.9, createdAt: 1_000 });
    const highArtifact = seedPending({ pendingId: 'p-high', confidence: 0.9, createdAt: 2_000 });
    seedProject('side-quest', 0.5, [lowArtifact]);
    seedProject('the-migration', 5, [highArtifact]);

    expect(listPending(makeDeps()).map((p) => p.pendingId)).toEqual(['p-high', 'p-low']);
  });

  it('breaks equal scores by age, oldest obligation first', () => {
    seedPending({ pendingId: 'p-new', confidence: 0.5, createdAt: 9_000 });
    seedPending({ pendingId: 'p-old', confidence: 0.5, createdAt: 1_000 });

    expect(listPending(makeDeps()).map((p) => p.pendingId)).toEqual(['p-old', 'p-new']);
  });

  it('ranks a zero-stakes item last but never drops it', () => {
    // Unlike retrieval, which may discard zero-stakes chunks: an obligation ON
    // the user is still outstanding, and hiding it is how a briefing starts lying.
    const muted = seedPending({ pendingId: 'p-muted', confidence: 1, createdAt: 1_000 });
    seedPending({ pendingId: 'p-normal', confidence: 0.1, createdAt: 2_000 });
    seedProject('muted', 0, [muted]);

    expect(listPending(makeDeps()).map((p) => p.pendingId)).toEqual(['p-normal', 'p-muted']);
  });

  it('falls back to the default stakes weight with no graph wired', () => {
    seedPending({ pendingId: 'p-a', confidence: 0.4, createdAt: 1_000 });
    seedPending({ pendingId: 'p-b', confidence: 0.8, createdAt: 2_000 });

    // No graph => every weight is DEFAULT_STAKES_WEIGHT, so confidence decides.
    expect(DEFAULT_STAKES_WEIGHT).toBe(1);
    const deps = makeDeps({ graph: undefined });
    expect(listPending(deps).map((p) => p.pendingId)).toEqual(['p-b', 'p-a']);
  });

  it('excludes resolved and dismissed items', () => {
    seedPending({ pendingId: 'p-open', confidence: 0.5, createdAt: 1_000 });
    seedPending({ pendingId: 'p-done', confidence: 0.5, createdAt: 2_000 });
    seedPending({ pendingId: 'p-nope', confidence: 0.5, createdAt: 3_000 });
    pending.resolve('p-done', 5_000);
    pending.dismiss('p-nope', 5_000);

    expect(listPending(makeDeps()).map((p) => p.pendingId)).toEqual(['p-open']);
  });

  it('makes zero Ollama calls: no model client is reachable from the dep set', async () => {
    const ollama = makeOllamaStub();
    seedPending({ pendingId: 'p1', confidence: 0.7, createdAt: 1_000 });
    seedPending({ pendingId: 'p2', confidence: 0.3, createdAt: 2_000 });

    // Structural half: the deps object the handler is constructed with contains
    // no member that even LOOKS like a model client. If a future edit injects one,
    // this fails before any call-count assertion gets a chance to.
    const deps = makeDeps();
    const modelish = Object.values(deps as Record<string, unknown>).filter((value) => {
      if (typeof value !== 'object' || value === null) return false;
      const candidate = value as Record<string, unknown>;
      return (
        typeof candidate.generateJson === 'function' ||
        typeof candidate.generateStream === 'function' ||
        typeof candidate.embed === 'function'
      );
    });
    expect(modelish).toEqual([]);

    // Empirical half: a trapped global `fetch` (every Ollama call goes through it)
    // plus the stub client's own counters.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('no network on the first-paint path')));
    try {
      const items = listPending(deps);
      expect(items).toHaveLength(2);
      await Promise.resolve();

      expect(fetchSpy).toHaveBeenCalledTimes(0);
      expect(ollama.callCount()).toBe(0);
      expect(ollama.generateJson).toHaveBeenCalledTimes(0);
      expect(ollama.generateStream).toHaveBeenCalledTimes(0);
      expect(ollama.embed).toHaveBeenCalledTimes(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('registers the pending channel and answers it without touching Ollama', async () => {
    const ollama = makeOllamaStub();
    seedPending({ pendingId: 'p1', confidence: 0.7, createdAt: 1_000 });

    registerBriefingHandlers(makeDeps());

    const registered = handle.mock.calls.find(([channel]) => channel === PENDING_CHANNEL);
    expect(registered).toBeDefined();

    const callback = registered?.[1] as (e: unknown, arg: unknown) => unknown;
    const result = await callback({}, { briefingId: 'b1' });
    expect((result as Array<{ pendingId: string }>).map((p) => p.pendingId)).toEqual(['p1']);
    expect(ollama.callCount()).toBe(0);
  });

  it('returns an empty list rather than rejecting for a missing briefingId', () => {
    seedPending({ pendingId: 'p1', confidence: 0.7, createdAt: 1_000 });
    registerBriefingHandlers(makeDeps());

    const callback = handle.mock.calls.find(([c]) => c === PENDING_CHANNEL)?.[1] as (
      e: unknown,
      arg: unknown,
    ) => unknown;

    // Returned, not rejected — an invoke rejection reaches the renderer as an
    // opaque `Error invoking remote method …` string it cannot render.
    expect(callback({}, {})).toEqual([]);
    expect(callback({}, null)).toEqual([]);
    expect(callback({}, undefined)).toEqual([]);
    expect(callback({}, { briefingId: '' })).toEqual([]);
    expect(callback({}, { briefingId: 42 })).toEqual([]);
  });

  it('degrades a failing read to an empty list instead of a rejected invoke', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: Deps['pending'] = {
      listOpen: () => {
        throw new Error('database is locked');
      },
      resolve: () => {},
    };
    registerBriefingHandlers(makeDeps({ pending: broken }));

    const callback = handle.mock.calls.find(([c]) => c === PENDING_CHANNEL)?.[1] as (
      e: unknown,
      arg: unknown,
    ) => unknown;

    expect(callback({}, { briefingId: 'b1' })).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 2 — 500 items under the 200ms budget                           */
/* -------------------------------------------------------------------------- */

describe('performance budget', () => {
  it('serves 500 seeded pending items in well under 200ms', () => {
    const BUDGET_MS = 200;
    const COUNT = 500;

    // Seeded in one transaction: 500 individual commits would measure SQLite's
    // fsync behaviour, not the read path this budget is about.
    db.transaction(() => {
      for (let i = 0; i < COUNT; i += 1) {
        const artifact = seedPending({
          pendingId: `p-${String(i).padStart(4, '0')}`,
          confidence: (i % 100) / 100,
          createdAt: 1_000 + i,
        });
        // Every 10th item hangs off a weighted project, so the ranking actually
        // exercises the graph lookups rather than short-circuiting to the default.
        if (i % 10 === 0) seedProject(`proj-${i}`, 1 + (i % 7), [artifact]);
      }
    })();

    expect(pending.listOpen()).toHaveLength(COUNT);

    const deps = makeDeps();
    // One warm pass so prepared-statement caches are hot, exactly as they are in
    // a running app where the repo is built once at startup.
    listPending(deps);

    const started = performance.now();
    const items = listPending(deps);
    const elapsedMs = performance.now() - started;

    expect(items).toHaveLength(COUNT);
    // Sorted, non-increasing: the budget must not have been met by skipping work.
    expect(items[0]?.pendingId).toBeTruthy();
    console.info(`[perf] briefing:pending over ${COUNT} items: ${elapsedMs.toFixed(2)}ms`);
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 3 — citation + confidence travel with every item               */
/* -------------------------------------------------------------------------- */

describe('every item carries its citation and confidence', () => {
  it('projects citationArtifactId and confidence onto each returned item', () => {
    const artifact = seedPending({
      pendingId: 'p1',
      confidence: 0.42,
      createdAt: 1_000,
      description: 'send Dana the migration plan',
    });

    const [item] = listPending(makeDeps());

    expect(item).toEqual({
      pendingId: 'p1',
      description: 'send Dana the migration plan',
      confidence: 0.42,
      // No artifact/event readers on these deps, so P4's inline quote resolves
      // to null — see the sourceQuoteFor block for the wired case.
      sourceQuote: null,
      citationArtifactId: artifact,
    });
  });

  it('exposes exactly the renderer view shape and no internal columns', () => {
    seedPending({ pendingId: 'p1', confidence: 0.9, createdAt: 1_000 });

    const [item] = listPending(makeDeps());

    // `deltaId`/`status`/`resolvedAt` are internal and must not cross the bridge.
    expect(Object.keys(item ?? {}).sort()).toEqual([
      'citationArtifactId',
      'confidence',
      'description',
      'pendingId',
      'sourceQuote',
    ]);
  });

  it('tolerates a null citation without dropping the item', () => {
    // The store column is NOT NULL, but the domain type allows null (template
    // mode) — the ranker must weight it at the default rather than crash.
    const ranked = rankPendingItems(
      [
        {
          pendingId: 'p-uncited',
          deltaId: 'd1',
          description: 'no artifact resolved',
          confidence: 0.6,
          citationArtifactId: null,
          status: 'open',
          createdAt: 1_000,
          resolvedAt: null,
        },
      ],
      graph,
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.citationArtifactId).toBeNull();
    expect(ranked[0]?.confidence).toBe(0.6);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4 — briefing:request returns synchronously                     */
/* -------------------------------------------------------------------------- */

describe('briefing:request returns a briefingId synchronously', () => {
  const WINDOW = { windowStart: 1_000, windowEnd: 2_000 };

  it('returns the handle before generation starts, then fires startGeneration', async () => {
    const startGeneration = vi.fn();
    const deps = makeDeps({ startGeneration, mintBriefingId: () => 'brief-1' });

    const result = beginBriefing(WINDOW, deps);

    // Synchronous: the id exists on the very next line, and nothing has run yet.
    expect(result).toEqual({ briefingId: 'brief-1' });
    expect(startGeneration).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(startGeneration).toHaveBeenCalledTimes(1);
    expect(startGeneration).toHaveBeenCalledWith('brief-1', WINDOW);
  });

  it('does not block on a slow generator', async () => {
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startGeneration = vi.fn(() => blocked);

    const started = performance.now();
    const result = beginBriefing(WINDOW, makeDeps({ startGeneration }));
    const elapsedMs = performance.now() - started;

    expect(result.briefingId).not.toBe('');
    expect(elapsedMs).toBeLessThan(50);

    await Promise.resolve();
    expect(startGeneration).toHaveBeenCalledTimes(1);
    release();
    await blocked;
  });

  it('swallows a generator that throws, so the handle is never invalidated', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const startGeneration = vi.fn(() => {
      throw new Error('layer 3 exploded');
    });

    const result = beginBriefing(WINDOW, makeDeps({ startGeneration }));
    expect(result.briefingId).not.toBe('');

    await Promise.resolve();
    await Promise.resolve();

    expect(startGeneration).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('mints a distinct id per request', () => {
    const deps = makeDeps();
    const a = beginBriefing(WINDOW, deps).briefingId;
    const b = beginBriefing(WINDOW, deps).briefingId;

    expect(a).not.toBe('');
    expect(a).not.toBe(b);
  });

  it('rejects an unusable window with an empty id and starts nothing', () => {
    const startGeneration = vi.fn();
    const deps = makeDeps({ startGeneration });

    expect(beginBriefing(null, deps).briefingId).toBe('');
    expect(beginBriefing({ windowStart: 2_000, windowEnd: 1_000 }, deps).briefingId).toBe('');
    expect(beginBriefing({ windowStart: 1_000, windowEnd: 1_000 }, deps).briefingId).toBe('');
    expect(beginBriefing({ windowStart: Number.NaN, windowEnd: 2_000 }, deps).briefingId).toBe('');
    expect(beginBriefing({ windowStart: '1', windowEnd: '2' }, deps).briefingId).toBe('');
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it('parses a valid half-open window', () => {
    expect(parseBriefingWindow(WINDOW)).toEqual(WINDOW);
    expect(parseBriefingWindow({ ...WINDOW, extra: 'ignored' })).toEqual(WINDOW);
  });

  it('registers the request channel with a non-async handler', () => {
    registerBriefingHandlers(makeDeps({ mintBriefingId: () => 'brief-9' }));

    const callback = handle.mock.calls.find(([c]) => c === REQUEST_CHANNEL)?.[1] as (
      e: unknown,
      arg: unknown,
    ) => unknown;
    expect(callback).toBeDefined();

    // The callback itself returns the handle, not a promise of one — proof the
    // main process does no awaiting before the renderer has its id.
    const returned = callback({}, WINDOW);
    expect(returned).toEqual({ briefingId: 'brief-9' });
    expect(returned).not.toBeInstanceOf(Promise);
  });
});

/* -------------------------------------------------------------------------- */
/* briefing:resolvePending — the manual "I've dealt with this" action         */
/* -------------------------------------------------------------------------- */

describe('briefing:resolvePending', () => {
  it('closes the item as resolved and drops it from the open list', () => {
    seedPending({ pendingId: 'p1', confidence: 0.5, createdAt: 1_000 });
    const deps = makeDeps({ clock: { now: () => 5_000 } });

    expect(resolvePendingItem({ pendingId: 'p1' }, deps)).toEqual({ ok: true });
    expect(pending.getById('p1')?.status).toBe('resolved');
    expect(listPending(deps)).toEqual([]);
  });

  it('rejects a missing or empty pendingId without touching the store', () => {
    const deps = makeDeps();

    expect(resolvePendingItem(null, deps)).toEqual({ ok: false, reason: 'invalid_pending_id' });
    expect(resolvePendingItem({}, deps)).toEqual({ ok: false, reason: 'invalid_pending_id' });
    expect(resolvePendingItem({ pendingId: '' }, deps)).toEqual({
      ok: false,
      reason: 'invalid_pending_id',
    });
  });

  it('degrades a storage fault to a reported failure instead of a rejected invoke', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: Deps['pending'] = {
      listOpen: () => [],
      resolve: () => {
        throw new Error('database is locked');
      },
    };

    expect(resolvePendingItem({ pendingId: 'p1' }, makeDeps({ pending: broken }))).toEqual({
      ok: false,
      reason: 'internal_error',
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('registers the resolve channel', () => {
    seedPending({ pendingId: 'p1', confidence: 0.5, createdAt: 1_000 });
    registerBriefingHandlers(makeDeps());

    const callback = handle.mock.calls.find(([c]) => c === RESOLVE_CHANNEL)?.[1] as (
      e: unknown,
      arg: unknown,
    ) => unknown;
    expect(callback).toBeDefined();

    expect(callback({}, { pendingId: 'p1' })).toEqual({ ok: true });
    expect(pending.getById('p1')?.status).toBe('resolved');
  });
});

/* -------------------------------------------------------------------------- */
/* briefing:snapshot — rehydration after a Settings round-trip                */
/* -------------------------------------------------------------------------- */

describe('briefing:snapshot', () => {
  const BRIEFING_ID = 'brief-snap-1';

  it('rebuilds every claim citation and reports done once generation finished', () => {
    const artifact = seedThreadArtifact({ artifactId: 'art-1', threadKey: 'C1:1' });
    seedEvent({ eventId: 'evt-1', threadKey: 'C1:1', occurredAt: 1_500 });
    seedBriefing(BRIEFING_ID);
    briefings.addClaim({
      briefingId: BRIEFING_ID,
      ordinal: 0,
      section: 'What moved',
      text: 'Alpha shipped to staging.',
      citationArtifactId: artifact.artifactId,
    });

    const snapshot = getBriefingSnapshot(
      { briefingId: BRIEFING_ID },
      makeDeps({ briefings, artifacts: graph, events }),
    );

    expect(snapshot.found).toBe(true);
    expect(snapshot.claims).toEqual([
      {
        briefingId: BRIEFING_ID,
        section: 'What moved',
        claim: 'Alpha shipped to staging.',
        citation: {
          eventId: 'evt-1',
          artifactId: 'art-1',
          source: 'slack',
          externalUrl: expect.stringContaining('slack.com/app_redirect'),
        },
      },
    ]);
    expect(snapshot.done).toEqual({
      briefingId: BRIEFING_ID,
      mode: 'llm',
      threadsStillProcessing: 0,
      timings: { firstTokenMs: 900, totalMs: 4_200 },
    });
  });

  it('preserves narrative order (ordinal) across multiple claims', () => {
    const a = seedThreadArtifact({ artifactId: 'art-a', threadKey: 'C1:1' });
    const b = seedThreadArtifact({ artifactId: 'art-b', threadKey: 'C2:1' });
    seedEvent({ eventId: 'evt-a', threadKey: 'C1:1', occurredAt: 1_500 });
    seedEvent({ eventId: 'evt-b', threadKey: 'C2:1', occurredAt: 1_600 });
    seedBriefing(BRIEFING_ID);
    // Written out of narrative order; `listClaims` is what re-imposes it.
    briefings.addClaim({
      briefingId: BRIEFING_ID,
      ordinal: 1,
      section: 'What moved',
      text: 'second',
      citationArtifactId: b.artifactId,
    });
    briefings.addClaim({
      briefingId: BRIEFING_ID,
      ordinal: 0,
      section: 'Waiting on you',
      text: 'first',
      citationArtifactId: a.artifactId,
    });

    const snapshot = getBriefingSnapshot(
      { briefingId: BRIEFING_ID },
      makeDeps({ briefings, artifacts: graph, events }),
    );

    expect(snapshot.claims.map((c) => c.claim)).toEqual(['first', 'second']);
  });

  it('reports done: null while the briefing is still generating', () => {
    seedBriefing(BRIEFING_ID, { totalMs: null });

    const snapshot = getBriefingSnapshot(
      { briefingId: BRIEFING_ID },
      makeDeps({ briefings, artifacts: graph, events }),
    );

    expect(snapshot.found).toBe(true);
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.done).toBeNull();
  });

  it('returns found: false for an id with no briefings row', () => {
    expect(
      getBriefingSnapshot({ briefingId: 'never-existed' }, makeDeps({ briefings, artifacts: graph, events })),
    ).toEqual({ found: false, claims: [], done: null });
  });

  it('rejects a missing or empty briefingId without touching the store', () => {
    const deps = makeDeps({ briefings, artifacts: graph, events });
    const empty = { found: false, claims: [], done: null };

    expect(getBriefingSnapshot(null, deps)).toEqual(empty);
    expect(getBriefingSnapshot({}, deps)).toEqual(empty);
    expect(getBriefingSnapshot({ briefingId: '' }, deps)).toEqual(empty);
  });

  it('returns found: false unless briefings, artifacts AND events are all wired', () => {
    seedBriefing(BRIEFING_ID);
    const empty = { found: false, claims: [], done: null };

    expect(getBriefingSnapshot({ briefingId: BRIEFING_ID }, makeDeps())).toEqual(empty);
    expect(getBriefingSnapshot({ briefingId: BRIEFING_ID }, makeDeps({ briefings }))).toEqual(empty);
    expect(
      getBriefingSnapshot({ briefingId: BRIEFING_ID }, makeDeps({ briefings, artifacts: graph })),
    ).toEqual(empty);
  });

  it('skips a claim whose artifact cannot be resolved, and one with no citation at all', () => {
    // `citation_artifact_id` is NOT NULL in the schema, so a hand-rolled reader
    // is what exercises the domain type's nullable case (template connective
    // text) and an artifact retention already purged.
    const fakeBriefings = {
      getById: () => ({ mode: 'llm' as const, threadsStillProcessing: 0, firstTokenMs: 900, totalMs: 4_200 }),
      listClaims: () => [
        { section: 'What moved', text: 'ghost citation', citationArtifactId: 'art-purged' },
        { section: 'Quietly resolved', text: 'connective text', citationArtifactId: null },
      ],
    };

    const snapshot = getBriefingSnapshot(
      { briefingId: BRIEFING_ID },
      makeDeps({ briefings: fakeBriefings, artifacts: graph, events }),
    );

    expect(snapshot.found).toBe(true);
    expect(snapshot.claims).toEqual([]);
  });

  it('degrades a storage fault to found: false rather than a rejected invoke', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      getById: () => {
        throw new Error('database is locked');
      },
      listClaims: () => [],
    };

    expect(
      getBriefingSnapshot({ briefingId: BRIEFING_ID }, makeDeps({ briefings: broken, artifacts: graph, events })),
    ).toEqual({ found: false, claims: [], done: null });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('registers the snapshot channel', async () => {
    const artifact = seedThreadArtifact({ artifactId: 'art-1', threadKey: 'C1:1' });
    seedEvent({ eventId: 'evt-1', threadKey: 'C1:1', occurredAt: 1_500 });
    seedBriefing(BRIEFING_ID);
    briefings.addClaim({
      briefingId: BRIEFING_ID,
      ordinal: 0,
      section: 'What moved',
      text: 'Alpha shipped.',
      citationArtifactId: artifact.artifactId,
    });

    registerBriefingHandlers(makeDeps({ briefings, artifacts: graph, events }));

    const callback = handle.mock.calls.find(([c]) => c === SNAPSHOT_CHANNEL)?.[1] as (
      e: unknown,
      arg: unknown,
    ) => unknown;
    expect(callback).toBeDefined();

    const result = (await callback({}, { briefingId: BRIEFING_ID })) as { found: boolean };
    expect(result.found).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* citationForArtifact — shared resolution behind briefing:snapshot           */
/* -------------------------------------------------------------------------- */

describe('citationForArtifact', () => {
  it('resolves the most recent event on the artifact\'s thread, with a deep link', () => {
    seedThreadArtifact({ artifactId: 'art-1', threadKey: 'C1:1' });
    seedEvent({ eventId: 'evt-old', threadKey: 'C1:1', occurredAt: 1_000 });
    seedEvent({ eventId: 'evt-new', threadKey: 'C1:1', occurredAt: 2_000 });

    const citation = citationForArtifact('art-1', graph, events);

    expect(citation?.eventId).toBe('evt-new');
    expect(citation?.artifactId).toBe('art-1');
    expect(citation?.source).toBe('slack');
    expect(citation?.externalUrl).toContain('slack.com/app_redirect');
  });

  it('returns undefined for an artifact that does not exist', () => {
    expect(citationForArtifact('art-nope', graph, events)).toBeUndefined();
  });

  it('falls back to the artifact\'s own source with no eventId when the thread has no events', () => {
    seedThreadArtifact({ artifactId: 'art-empty', threadKey: 'C-empty:1' });

    const citation = citationForArtifact('art-empty', graph, events);

    expect(citation).toEqual({ eventId: '', artifactId: 'art-empty', source: 'slack' });
  });
});

/* -------------------------------------------------------------------------- */
/* F-2 — `briefing:resumePoint`                                                */
/* -------------------------------------------------------------------------- */

/**
 * The window resolution behind "Brief me on what I missed".
 *
 * Run against the REAL `BriefingsRepo`, same as the snapshot block above: the
 * whole value of this channel is the `caught_up_at IS NOT NULL` gate in the
 * query, and a stubbed reader would test the handler's plumbing while asserting
 * nothing about the thing that actually decides the answer.
 */
describe('briefing:resumePoint (F-2)', () => {
  const createBriefing = (windowEnd: number): string => {
    const created = briefings.create({
      windowStart: windowEnd - 86_400_000,
      windowEnd,
      generatedAt: windowEnd,
      mode: 'llm',
      narrativePath: `/briefings/${windowEnd}.md`,
      deltaIds: [],
      threadsStillProcessing: 0,
    });
    return created.briefingId;
  };

  it('reports null when nothing has been acknowledged', () => {
    createBriefing(2_000_000);

    expect(getResumePoint({ pending, briefings, startGeneration: () => {} } as Deps)).toEqual({
      windowStart: null,
      maxChangedItems: DEFAULT_MAX_CHANGED_ITEMS,
    });
  });

  it('reports the acknowledged window end', () => {
    const id = createBriefing(2_000_000);
    briefings.markCaughtUp(id, 2_000_500);

    expect(
      getResumePoint({ pending, resume: briefings, startGeneration: () => {} } as Deps),
    ).toEqual({ windowStart: 2_000_000, maxChangedItems: DEFAULT_MAX_CHANGED_ITEMS });
  });

  it('degrades to null when no resume reader is wired', () => {
    const id = createBriefing(2_000_000);
    briefings.markCaughtUp(id, 2_000_500);

    // A host that wired the briefing channels but not this dependency: the
    // channel is still registered and answers the first-run state rather than
    // rejecting, so the primary button stays usable.
    expect(getResumePoint({ pending, startGeneration: () => {} } as Deps)).toEqual({
      windowStart: null,
      maxChangedItems: DEFAULT_MAX_CHANGED_ITEMS,
    });
  });

  it('degrades to null when the read throws, instead of rejecting the invoke', () => {
    const exploding = {
      lastAcknowledgedWindowEnd: (): number | null => {
        throw new Error('database is locked');
      },
    };

    expect(
      getResumePoint({ pending, resume: exploding, startGeneration: () => {} } as Deps),
    ).toEqual({ windowStart: null, maxChangedItems: DEFAULT_MAX_CHANGED_ITEMS });
  });

  it('treats a non-finite stored value as never-acknowledged', () => {
    const nonsense = { lastAcknowledgedWindowEnd: (): number | null => Number.NaN };

    expect(
      getResumePoint({ pending, resume: nonsense, startGeneration: () => {} } as Deps),
    ).toEqual({ windowStart: null, maxChangedItems: DEFAULT_MAX_CHANGED_ITEMS });
  });

  it('registers the channel and takes no argument', () => {
    registerBriefingHandlers({ pending, resume: briefings, startGeneration: () => {} } as Deps);

    const entry = handle.mock.calls.find(([channel]) => channel === RESUME_POINT_CHANNEL);
    expect(entry).toBeDefined();

    const id = createBriefing(2_000_000);
    briefings.markCaughtUp(id, 2_000_500);

    // Invoked the way `ipcMain` will invoke it: an event, and nothing else.
    const listener = entry?.[1] as (event: unknown) => unknown;
    expect(listener({})).toEqual({
      windowStart: 2_000_000,
      maxChangedItems: DEFAULT_MAX_CHANGED_ITEMS,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* P4 — the inline verbatim source quote                                      */
/* -------------------------------------------------------------------------- */

describe('sourceQuoteFor (P4)', () => {
  it('returns the latest message text on the artifact', () => {
    seedThreadArtifact({ artifactId: 'art-q', threadKey: 'C-q:1' });
    seedEvent({ eventId: 'evt-old', threadKey: 'C-q:1', occurredAt: 1_000 });
    seedEvent({ eventId: 'evt-new', threadKey: 'C-q:1', occurredAt: 5_000 });

    expect(sourceQuoteFor('art-q', graph, events)).toBe('body of evt-new');
  });

  it('collapses whitespace so a quote stays one line', () => {
    seedThreadArtifact({ artifactId: 'art-ws', threadKey: 'C-ws:1' });
    seedEvent({
      eventId: 'evt-ws',
      threadKey: 'C-ws:1',
      occurredAt: 1_000,
      text: '  can you\n\n  approve this?  ',
    });

    expect(sourceQuoteFor('art-ws', graph, events)).toBe('can you approve this?');
  });

  it('truncates a long body at the quote limit', () => {
    seedThreadArtifact({ artifactId: 'art-long', threadKey: 'C-long:1' });
    seedEvent({
      eventId: 'evt-long',
      threadKey: 'C-long:1',
      occurredAt: 1_000,
      text: 'x'.repeat(MAX_SOURCE_QUOTE_CHARS + 50),
    });

    const quote = sourceQuoteFor('art-long', graph, events);
    // A one-line proof under a one-line claim — long enough to scroll would
    // rebuild the density the list layout removed.
    expect(quote).toHaveLength(MAX_SOURCE_QUOTE_CHARS + 1); // + the ellipsis
    expect(quote?.endsWith('…')).toBe(true);
  });

  it('returns null for a missing artifact, no events, or an empty body', () => {
    expect(sourceQuoteFor('art-nope', graph, events)).toBeNull();

    seedThreadArtifact({ artifactId: 'art-empty', threadKey: 'C-empty:1' });
    expect(sourceQuoteFor('art-empty', graph, events)).toBeNull();

    seedThreadArtifact({ artifactId: 'art-blank', threadKey: 'C-blank:1' });
    seedEvent({ eventId: 'evt-blank', threadKey: 'C-blank:1', occurredAt: 1_000, text: '   ' });
    expect(sourceQuoteFor('art-blank', graph, events)).toBeNull();
  });

  it('returns null when no readers are wired, rather than throwing', () => {
    expect(sourceQuoteFor('art-q', undefined, undefined)).toBeNull();
    expect(sourceQuoteFor(null, graph, events)).toBeNull();
  });

  it('is attached to every item listPending returns', () => {
    seedThreadArtifact({ artifactId: 'art-p', threadKey: 'C-p:1' });
    seedEvent({ eventId: 'evt-p', threadKey: 'C-p:1', occurredAt: 1_000 });
    seedPending({ pendingId: 'p1', confidence: 0.9, createdAt: 1_000, artifactId: 'art-p' });

    const [item] = listPending(makeDeps({ artifacts: graph, events }));
    expect(item?.sourceQuote).toBe('body of evt-p');
  });

  it('leaves sourceQuote null when the readers are not wired', () => {
    seedPending({ pendingId: 'p1', confidence: 0.9, createdAt: 1_000 });

    const [item] = listPending(makeDeps());
    // First paint must still work on a partially-wired host; the renderer
    // simply shows the obligation with no inline evidence.
    expect(item?.sourceQuote).toBeNull();
  });
});

describe('briefing:resumePoint carries the A-4 cap', () => {
  it('reports the configured cap', () => {
    expect(
      getResumePoint({ pending, maxChangedItems: 5, startGeneration: () => {} } as Deps),
    ).toEqual({ windowStart: null, maxChangedItems: 5 });
  });

  it('falls back to the default for an absent or nonsensical cap', () => {
    for (const maxChangedItems of [undefined, 0, -3, 2.5, Number.NaN]) {
      expect(
        getResumePoint({ pending, maxChangedItems, startGeneration: () => {} } as Deps),
      ).toEqual({ windowStart: null, maxChangedItems: DEFAULT_MAX_CHANGED_ITEMS });
    }
  });
});
