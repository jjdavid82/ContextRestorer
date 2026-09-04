import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, type AppConfig, type Artifact } from '@cr/core';
import {
  GraphRepo,
  migrate,
  openDb,
  openVectors,
  type Chunk,
  type SearchFilter,
  type SearchResult,
  type VectorStore,
} from '@cr/store';
import { RetrievalService } from '../src/retrieval.js';

/**
 * Most cases run against a *real* LanceDB store in a temp directory and a real
 * SQLite graph: the distance maths, the pre-filtering and the SQL joins are the
 * things worth exercising. Vectors are fixed 4-dimensional fixtures, so
 * distances are predictable without touching an embedding model.
 *
 * The budget case is the exception — it needs a hand-built `VectorStore` whose
 * `search()` can be stalled for an arbitrary time.
 */

/** LanceDB's native calls are slow to warm up; give each case headroom. */
const TIMEOUT_MS = 30_000;

/** Fixed "now" for the fake clock; every fixture timestamp hangs off it. */
const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Query vector returned by the stub embedder; fixtures fan out from it. */
const QUERY = [1, 0, 0, 0];

let dir: string;
let db: ReturnType<typeof openDb>;
let graph: GraphRepo;
let clock: FakeClock;
const opened: VectorStore[] = [];

function config(overrides: Partial<AppConfig['retrieval']> = {}): AppConfig {
  return {
    model: { chat: 'test', embed: 'test', ollamaBaseUrl: 'http://localhost:11434' },
    promptVersions: { layer1: 'v1', layer2: 'v1', layer3: 'v1' },
    debounce: {
      slack: { quietWindowMs: 1000, hardCapMs: 2000 },
      gmail: { quietWindowMs: 1000, hardCapMs: 2000 },
    },
    polling: {
      slack: { intervalMs: 1000, maxBackoffMs: 2000 },
      gmail: { intervalMs: 1000, maxBackoffMs: 2000 },
    },
    retrieval: { topK: 10, budgetMs: 5000, ...overrides },
    ranking: { wStakes: 3, wPendingOnMe: 5, wSelfParticipation: 1.5, wRecency: 0.5 },
    budgets: { retrievalMs: 5000, assemblyMs: 2000, generationMs: 30000, citationMs: 5000 },
    retention: { rawEventDays: 90 },
    onboarding: { minDeclaredProjects: 3 },
    briefing: { maxChangedItems: 7 },
  };
}

/** The injected embedder: deterministic, never touches Ollama. */
const embed = async (): Promise<number[]> => QUERY;

/** Open a real vector store in the temp dir and track it for cleanup. */
async function openStore(): Promise<VectorStore> {
  const store = await openVectors(dir, { dimension: QUERY.length });
  opened.push(store);
  return store;
}

/** Build a chunk, overriding whatever a test cares about. */
function chunk(id: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    eventId: `event-${id}`,
    artifactId: `artifact-${id}`,
    threadKey: 'thread-a',
    occurredAt: NOW - DAY_MS,
    text: `text for ${id}`,
    vector: [...QUERY],
    ...overrides,
  };
}

/** Register an artifact in the graph so participant/project joins can resolve. */
function artifact(artifactId: string, ownerId: string | null = null): Artifact {
  const a: Artifact = {
    artifactId,
    source: 'slack',
    kind: 'message',
    externalRef: `https://example.invalid/${artifactId}`,
    title: null,
    state: null,
    ownerId,
    firstSeenAt: NOW - 10 * DAY_MS,
    lastSeenAt: NOW,
  };
  graph.upsertArtifact(a);
  return a;
}

/** Declare a project at `stakesWeight` and attach `artifactIds` to it. */
function project(name: string, stakesWeight: number, artifactIds: string[]): void {
  const p = graph.declareProject({ name, origin: 'declared', stakesWeight });
  for (const artifactId of artifactIds) {
    graph.relate({ fromId: artifactId, rel: 'belongs_to', toId: p.projectId });
  }
}

function service(store: VectorStore, cfg: AppConfig = config()): RetrievalService {
  return new RetrievalService(store, graph, cfg, embed, { clock });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-retrieval-'));
  db = openDb(':memory:');
  migrate(db);
  clock = new FakeClock(NOW);
  graph = new GraphRepo(db, clock);
});

afterEach(async () => {
  // Close every store first: Windows will not remove files that are still open.
  await Promise.all(opened.splice(0).map((store) => store.close().catch(() => undefined)));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('RetrievalService.forThread', () => {
  it(
    "returns the thread's own chunks plus shared-artifact and shared-participant neighbours",
    async () => {
      const store = await openStore();

      // thread-a is the subject. thread-b shares an *artifact* with it.
      // thread-c shares a *participant* (person-1) via a different artifact.
      // thread-d shares neither and must not come back.
      artifact('art-shared', 'person-1');
      artifact('art-a', 'person-1');
      artifact('art-c', 'person-1');
      artifact('art-d', 'person-9');

      await store.upsert([
        chunk('own-1', { threadKey: 'thread-a', artifactId: 'art-a' }),
        chunk('own-2', { threadKey: 'thread-a', artifactId: 'art-shared' }),
        chunk('nb-artifact', { threadKey: 'thread-b', artifactId: 'art-shared' }),
        chunk('nb-person', { threadKey: 'thread-c', artifactId: 'art-c' }),
        chunk('unrelated', { threadKey: 'thread-d', artifactId: 'art-d' }),
      ]);

      const result = await service(store).forThread('thread-a');

      expect(result.partial).toBe(false);
      const threads = new Set(result.chunks.map((c) => c.threadKey));
      expect(threads).toEqual(new Set(['thread-a', 'thread-b', 'thread-c']));
      expect(result.chunks.map((c) => c.artifactId)).toContain('art-shared');
      expect(result.chunks.map((c) => c.artifactId)).toContain('art-c');
      expect(result.chunks.some((c) => c.artifactId === 'art-d')).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'excludes chunks whose artifact id is missing — they could never be cited',
    async () => {
      const store = await openStore();
      artifact('art-ok', 'person-1');

      await store.upsert([
        chunk('good', { threadKey: 'thread-a', artifactId: 'art-ok' }),
        // A connector bug (or the schema seed row) can leave this empty.
        chunk('orphan', { threadKey: 'thread-a', artifactId: '' }),
        chunk('blank', { threadKey: 'thread-a', artifactId: '   ' }),
      ]);

      const result = await service(store).forThread('thread-a');

      expect(result.chunks.map((c) => c.eventId)).toEqual(['event-good']);
      for (const c of result.chunks) expect(c.artifactId.trim()).not.toBe('');
    },
    TIMEOUT_MS,
  );
});

describe('RetrievalService.forBriefing', () => {
  it(
    'returns at most config.retrieval.topK chunks even when more match',
    async () => {
      const store = await openStore();
      const chunks: Chunk[] = [];
      for (let i = 0; i < 25; i += 1) {
        artifact(`art-${i}`, 'person-1');
        chunks.push(
          chunk(`c-${i}`, {
            artifactId: `art-${i}`,
            threadKey: `thread-${i % 3}`,
            occurredAt: NOW - i * 60_000,
          }),
        );
      }
      await store.upsert(chunks);

      const result = await service(store, config({ topK: 5 })).forBriefing({
        start: NOW - DAY_MS,
        end: NOW + 1,
      });

      expect(result.partial).toBe(false);
      expect(result.chunks).toHaveLength(5);
    },
    TIMEOUT_MS,
  );

  it(
    'excludes chunks outside the half-open window',
    async () => {
      const store = await openStore();
      artifact('art-old', 'person-1');
      artifact('art-in', 'person-1');
      artifact('art-edge', 'person-1');

      await store.upsert([
        chunk('old', { artifactId: 'art-old', occurredAt: NOW - 30 * DAY_MS }),
        chunk('inside', { artifactId: 'art-in', occurredAt: NOW - 2 * DAY_MS }),
        // `end` is exclusive: this one belongs to the *next* window.
        chunk('edge', { artifactId: 'art-edge', occurredAt: NOW - DAY_MS }),
      ]);

      const result = await service(store).forBriefing({ start: NOW - 3 * DAY_MS, end: NOW - DAY_MS });

      expect(result.chunks.map((c) => c.eventId)).toEqual(['event-inside']);
    },
    TIMEOUT_MS,
  );

  it(
    'orders results by descending score: newer beats older at equal similarity and stakes',
    async () => {
      const store = await openStore();
      for (const id of ['art-new', 'art-mid', 'art-old']) artifact(id, 'person-1');

      await store.upsert([
        // Identical vectors ⇒ identical similarity; identical (default) stakes.
        chunk('old', { artifactId: 'art-old', occurredAt: NOW - 20 * DAY_MS }),
        chunk('new', { artifactId: 'art-new', occurredAt: NOW - 1 * DAY_MS }),
        chunk('mid', { artifactId: 'art-mid', occurredAt: NOW - 5 * DAY_MS }),
      ]);

      const result = await service(store).forBriefing({ start: NOW - 60 * DAY_MS, end: NOW + 1 });

      expect(result.chunks.map((c) => c.eventId)).toEqual(['event-new', 'event-mid', 'event-old']);
      const scores = result.chunks.map((c) => c.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    },
    TIMEOUT_MS,
  );

  it(
    'orders results by descending score: higher stakes beats lower at equal recency and similarity',
    async () => {
      const store = await openStore();
      artifact('art-high', 'person-1');
      artifact('art-low', 'person-1');
      artifact('art-none', 'person-1');
      project('high stakes', 5, ['art-high']);
      project('low stakes', 0.25, ['art-low']);
      // art-none belongs to no project ⇒ default weight 1.0, so it sorts between.

      await store.upsert([
        chunk('low', { artifactId: 'art-low' }),
        chunk('none', { artifactId: 'art-none' }),
        chunk('high', { artifactId: 'art-high' }),
      ]);

      const result = await service(store).forBriefing({ start: NOW - 60 * DAY_MS, end: NOW + 1 });

      expect(result.chunks.map((c) => c.eventId)).toEqual(['event-high', 'event-none', 'event-low']);
    },
    TIMEOUT_MS,
  );

  it(
    'excludes chunks of a stakesWeight = 0 project entirely — not merely ranks them last',
    async () => {
      const store = await openStore();
      artifact('art-muted', 'person-1');
      artifact('art-live', 'person-1');
      project('muted', 0, ['art-muted']);
      project('live', 1, ['art-live']);

      await store.upsert([
        // The muted chunk is the *closest* match and the most recent, so a
        // ranking-only implementation would still return it first.
        chunk('muted', { artifactId: 'art-muted', occurredAt: NOW, vector: [1, 0, 0, 0] }),
        chunk('live', { artifactId: 'art-live', occurredAt: NOW - 10 * DAY_MS, vector: [0.6, 0.8, 0, 0] }),
      ]);

      const briefing = await service(store).forBriefing({ start: NOW - 60 * DAY_MS, end: NOW + 1 });
      expect(briefing.chunks.map((c) => c.artifactId)).toEqual(['art-live']);
      expect(briefing.chunks.some((c) => c.artifactId === 'art-muted')).toBe(false);

      // Same exclusion on the thread path, including for the thread's own chunks.
      const thread = await service(store).forThread('thread-a');
      expect(thread.chunks.some((c) => c.artifactId === 'art-muted')).toBe(false);
    },
    TIMEOUT_MS,
  );
});

/**
 * A `VectorStore` whose `search()` stalls for `delayMs`. Only the methods the
 * retrieval service uses do anything; the rest satisfy the interface.
 */
function slowStore(delayMs: number, results: SearchResult[] = []): VectorStore {
  return {
    upsert: async () => undefined,
    search: async (_vector: number[], _k: number, _filter?: SearchFilter) =>
      new Promise<SearchResult[]>((resolve) => {
        setTimeout(() => resolve(results), delayMs);
      }),
    deleteByEventIds: async () => 0,
    close: async () => undefined,
  };
}

/** Build a `SearchResult` fixture without going through LanceDB. */
function hit(id: string, overrides: Partial<SearchResult> = {}): SearchResult {
  return { ...chunk(id), distance: 0, ...overrides };
}

describe('RetrievalService budget (OI-1)', () => {
  it('returns partial: true instead of waiting on a hung vector store', async () => {
    const budgetMs = 50;
    const store = slowStore(3000, [hit('never-arrives')]);

    const started = Date.now();
    const result = await service(store, config({ budgetMs })).forBriefing({
      start: NOW - DAY_MS,
      end: NOW + 1,
    });
    const elapsed = Date.now() - started;

    expect(result.partial).toBe(true);
    expect(result.chunks).toEqual([]);
    // The whole point: the deadline is enforced, not merely documented.
    expect(elapsed).toBeLessThan(1000);
  });

  it('returns the chunks it did manage to collect before the deadline', async () => {
    artifact('art-own', 'person-1');
    const own = [hit('own-1', { threadKey: 'thread-a', artifactId: 'art-own' })];

    // First search (the thread's own chunks) is fast; the neighbour sweep hangs.
    let call = 0;
    const store: VectorStore = {
      upsert: async () => undefined,
      search: async () => {
        call += 1;
        if (call === 1) return own;
        return new Promise<SearchResult[]>((resolve) => setTimeout(() => resolve([]), 3000));
      },
      deleteByEventIds: async () => 0,
      close: async () => undefined,
    };

    const started = Date.now();
    const result = await service(store, config({ budgetMs: 50 })).forThread('thread-a');
    const elapsed = Date.now() - started;

    expect(result.partial).toBe(true);
    expect(result.chunks.map((c) => c.artifactId)).toEqual(['art-own']);
    expect(elapsed).toBeLessThan(1000);
  });

  it('gives up on a hung embedder too, without throwing', async () => {
    const hang: (text: string) => Promise<number[]> = () =>
      new Promise<number[]>((resolve) => setTimeout(() => resolve(QUERY), 3000));
    const svc = new RetrievalService(slowStore(0), graph, config({ budgetMs: 50 }), hang, { clock });

    const started = Date.now();
    const result = await svc.forThread('thread-a');

    expect(result).toEqual({ chunks: [], partial: true });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('treats a failing vector store as partial rather than propagating the error', async () => {
    const store: VectorStore = {
      upsert: async () => undefined,
      search: async () => {
        throw new Error('lancedb exploded');
      },
      deleteByEventIds: async () => 0,
      close: async () => undefined,
    };

    await expect(
      service(store).forBriefing({ start: NOW - DAY_MS, end: NOW + 1 }),
    ).resolves.toEqual({ chunks: [], partial: true });
  });
});
