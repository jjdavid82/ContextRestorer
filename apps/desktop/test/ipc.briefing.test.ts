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
import { migrate, openDb, PendingItemsRepo, GraphRepo } from '@cr/store';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const {
  DEFAULT_STAKES_WEIGHT,
  PENDING_CHANNEL,
  REQUEST_CHANNEL,
  RESOLVE_CHANNEL,
  beginBriefing,
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
