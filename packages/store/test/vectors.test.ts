import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVectors, type Chunk, type VectorStore } from '../src/vectors.js';

/**
 * These tests run against a real LanceDB database in a temp directory: the
 * native calls are the thing worth testing, so nothing is mocked. Vectors are
 * fixed 4-dimensional fixtures so distances are predictable without embeddings.
 */

/** LanceDB's native calls are slow to warm up; give each case some headroom. */
const TIMEOUT_MS = 15_000;

/** Query vector used throughout; the fixtures below fan out from it. */
const QUERY = [1, 0, 0, 0];

let dir: string;
const opened: VectorStore[] = [];

/** Open a store against the shared temp dir and track it for cleanup. */
async function open(at: string = dir): Promise<VectorStore> {
  const store = await openVectors(at);
  opened.push(store);
  return store;
}

/** Build a chunk, overriding whichever fields a test cares about. */
function chunk(id: string, overrides: Partial<Chunk> = {}): Chunk {
  return {
    id,
    eventId: `event-${id}`,
    artifactId: `artifact-${id}`,
    threadKey: 'thread-a',
    occurredAt: 1_700_000_000_000,
    text: `text for ${id}`,
    vector: [1, 0, 0, 0],
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cr-vectors-'));
});

afterEach(async () => {
  // Close every store first: Windows will not remove files that are still open.
  await Promise.all(opened.splice(0).map((store) => store.close().catch(() => undefined)));
  rmSync(dir, { recursive: true, force: true });
});

describe('openVectors', () => {
  it(
    'creates the chunks table on first call and reuses it on the second',
    async () => {
      const first = await open();
      await first.upsert([chunk('c1')]);

      // Re-opening the same directory must neither throw nor reset the table.
      const second = await open();
      const hits = await second.search(QUERY, 10);

      expect(hits).toHaveLength(1);
      expect(hits[0]?.id).toBe('c1');
    },
    TIMEOUT_MS,
  );

  it(
    'round-trips every chunk field',
    async () => {
      const store = await open();
      const original = chunk('c1', {
        eventId: 'e-42',
        artifactId: 'a-42',
        threadKey: 'thread-z',
        occurredAt: 1_699_999_999_000,
        text: "quotes ' are escaped",
        vector: [0, 1, 0, 0],
      });
      await store.upsert([original]);

      const [hit] = await store.search([0, 1, 0, 0], 1);

      expect(hit).toMatchObject({
        id: 'c1',
        eventId: 'e-42',
        artifactId: 'a-42',
        threadKey: 'thread-z',
        occurredAt: 1_699_999_999_000,
        text: "quotes ' are escaped",
      });
      expect(hit?.vector).toEqual([0, 1, 0, 0]);
      expect(hit?.distance).toBeCloseTo(0, 5);
    },
    TIMEOUT_MS,
  );
});

describe('upsert', () => {
  it(
    'is idempotent on id',
    async () => {
      const store = await open();

      await store.upsert([chunk('dup', { text: 'first' })]);
      await store.upsert([chunk('dup', { text: 'second' })]);

      const hits = await store.search(QUERY, 100);
      const forId = hits.filter((hit) => hit.id === 'dup');

      expect(forId).toHaveLength(1);
      // The later write wins.
      expect(forId[0]?.text).toBe('second');
    },
    TIMEOUT_MS,
  );

  it(
    'de-duplicates repeated ids inside a single batch',
    async () => {
      const store = await open();

      await store.upsert([chunk('dup', { text: 'first' }), chunk('dup', { text: 'second' })]);

      const hits = await store.search(QUERY, 100);
      expect(hits.filter((hit) => hit.id === 'dup')).toHaveLength(1);
      expect(hits[0]?.text).toBe('second');
    },
    TIMEOUT_MS,
  );

  it(
    'accepts an empty batch',
    async () => {
      const store = await open();
      await expect(store.upsert([])).resolves.toBeUndefined();
      await expect(store.search(QUERY, 5)).resolves.toEqual([]);
    },
    TIMEOUT_MS,
  );
});

describe('search', () => {
  /** Fixtures ordered by increasing squared-L2 distance from QUERY. */
  const ordered: Array<[string, number[]]> = [
    ['near', [1, 0, 0, 0]], // 0
    ['close', [0.9, 0.1, 0, 0]], // 0.02
    ['mid', [0.5, 0.5, 0, 0]], // 0.5
    ['far', [0, 1, 0, 0]], // 2
  ];

  it(
    'returns at most k rows, nearest first',
    async () => {
      const store = await open();
      // Insert out of order so any ordering must come from the search itself.
      await store.upsert([...ordered].reverse().map(([id, vector]) => chunk(id, { vector })));

      const hits = await store.search(QUERY, 3);

      expect(hits).toHaveLength(3);
      expect(hits.map((hit) => hit.id)).toEqual(['near', 'close', 'mid']);

      const distances = hits.map((hit) => hit.distance);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
      expect(distances[0]).toBeCloseTo(0, 5);
    },
    TIMEOUT_MS,
  );

  it(
    'never returns more rows than exist',
    async () => {
      const store = await open();
      await store.upsert(ordered.map(([id, vector]) => chunk(id, { vector })));

      await expect(store.search(QUERY, 100)).resolves.toHaveLength(4);
    },
    TIMEOUT_MS,
  );

  it(
    'restricts results to the requested threadKey',
    async () => {
      const store = await open();
      await store.upsert([
        chunk('a1', { threadKey: 'thread-a', vector: [1, 0, 0, 0] }),
        chunk('a2', { threadKey: 'thread-a', vector: [0.9, 0.1, 0, 0] }),
        chunk('b1', { threadKey: 'thread-b', vector: [1, 0, 0, 0] }),
        chunk('b2', { threadKey: 'thread-b', vector: [0.95, 0.05, 0, 0] }),
      ]);

      const hits = await store.search(QUERY, 10, { threadKey: 'thread-b' });

      expect(hits.map((hit) => hit.id).sort()).toEqual(['b1', 'b2']);
      expect(hits.every((hit) => hit.threadKey === 'thread-b')).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'restricts results to chunks at or after `since`',
    async () => {
      const store = await open();
      await store.upsert([
        chunk('old', { occurredAt: 1_000, vector: [1, 0, 0, 0] }),
        chunk('boundary', { occurredAt: 2_000, vector: [0.9, 0.1, 0, 0] }),
        chunk('new', { occurredAt: 3_000, vector: [0.5, 0.5, 0, 0] }),
      ]);

      const hits = await store.search(QUERY, 10, { since: 2_000 });

      // `since` is inclusive, so the boundary row is kept.
      expect(hits.map((hit) => hit.id)).toEqual(['boundary', 'new']);
    },
    TIMEOUT_MS,
  );

  it(
    'applies threadKey and since together',
    async () => {
      const store = await open();
      await store.upsert([
        chunk('keep', { threadKey: 'thread-b', occurredAt: 5_000 }),
        chunk('wrong-thread', { threadKey: 'thread-a', occurredAt: 5_000 }),
        chunk('too-old', { threadKey: 'thread-b', occurredAt: 1_000 }),
      ]);

      const hits = await store.search(QUERY, 10, { threadKey: 'thread-b', since: 2_000 });

      expect(hits.map((hit) => hit.id)).toEqual(['keep']);
    },
    TIMEOUT_MS,
  );

  it(
    'returns an empty array for an empty store or a non-positive k',
    async () => {
      const store = await open();
      await expect(store.search(QUERY, 5)).resolves.toEqual([]);

      await store.upsert([chunk('c1')]);
      await expect(store.search(QUERY, 0)).resolves.toEqual([]);
    },
    TIMEOUT_MS,
  );
});

describe('deleteByEventIds', () => {
  it(
    'removes exactly the matching chunks and returns the count',
    async () => {
      const store = await open();
      await store.upsert([
        chunk('c1', { eventId: 'e1', vector: [1, 0, 0, 0] }),
        chunk('c2', { eventId: 'e1', vector: [0.9, 0.1, 0, 0] }),
        chunk('c3', { eventId: 'e2', vector: [0.5, 0.5, 0, 0] }),
        chunk('c4', { eventId: 'e3', vector: [0, 1, 0, 0] }),
      ]);

      // e1 has two chunks, e2 has one -> three rows removed.
      await expect(store.deleteByEventIds(['e1', 'e2'])).resolves.toBe(3);

      const remaining = await store.search(QUERY, 100);
      expect(remaining.map((hit) => hit.id)).toEqual(['c4']);
    },
    TIMEOUT_MS,
  );

  it(
    'returns 0 for unknown ids and for an empty list, without touching data',
    async () => {
      const store = await open();
      await store.upsert([chunk('c1', { eventId: 'e1' })]);

      await expect(store.deleteByEventIds([])).resolves.toBe(0);
      await expect(store.deleteByEventIds(['missing'])).resolves.toBe(0);
      await expect(store.search(QUERY, 10)).resolves.toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  it(
    'is idempotent: deleting the same ids twice removes nothing the second time',
    async () => {
      const store = await open();
      await store.upsert([chunk('c1', { eventId: 'e1' }), chunk('c2', { eventId: 'e1' })]);

      await expect(store.deleteByEventIds(['e1'])).resolves.toBe(2);
      await expect(store.deleteByEventIds(['e1'])).resolves.toBe(0);
      await expect(store.search(QUERY, 10)).resolves.toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'survives a reopen: deletions are durable',
    async () => {
      const first = await open();
      await first.upsert([chunk('c1', { eventId: 'e1' }), chunk('c2', { eventId: 'e2' })]);
      await first.deleteByEventIds(['e1']);
      await first.close();

      const second = await open();
      const hits = await second.search(QUERY, 10);
      expect(hits.map((hit) => hit.id)).toEqual(['c2']);
    },
    TIMEOUT_MS,
  );
});
