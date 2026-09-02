/**
 * LanceDB vector store wrapper.
 *
 * This is the *embedding* half of the persistence layer: SQLite (see `db.ts`)
 * owns all relational data, while LanceDB owns the vectors used for semantic
 * retrieval. There is exactly one LanceDB table, `chunks`, whose columns are
 * `{ id, event_id, artifact_id, thread_key, occurred_at, text, vector }`.
 *
 * LanceDB is used (rather than a client/server vector database) because the app
 * must run as a single process with no listening socket: LanceDB is embedded and
 * talks directly to files on disk.
 *
 * Embeddings themselves are produced elsewhere (Ollama `nomic-embed-text`); this
 * module only stores, searches and deletes vectors that it is handed.
 */

import { connect, type Connection, type Table as LanceTable } from '@lancedb/lancedb';

/** Name of the single LanceDB table managed by this module. */
const TABLE_NAME = 'chunks';

/**
 * Primary key of the throw-away row used to pin the Arrow schema when the table
 * is first created. LanceDB infers the table schema from sample data, so one row
 * is written and immediately deleted.
 */
const SEED_ID = '__schema_seed__';

/**
 * Default embedding width. `nomic-embed-text` emits 768-dimensional vectors, so
 * that is the schema created for a brand new (still empty) store. If the first
 * vectors actually written have a different width — e.g. a different embedding
 * model, or small fixtures in tests — the still-empty table is transparently
 * recreated at the observed width. See {@link ensureDimension}.
 */
const DEFAULT_DIMENSION = 768;

/** Maximum number of ids interpolated into a single SQL `IN (...)` predicate. */
const MAX_IDS_PER_PREDICATE = 500;

/** A single embedded chunk of text, as stored in the `chunks` table. */
export interface Chunk {
  /** Stable primary key for the chunk. Upserts are idempotent on this value. */
  id: string;
  /** Id of the event this chunk was derived from (`events.id` in SQLite). */
  eventId: string;
  /** Id of the artifact this chunk was derived from (`artifacts.id` in SQLite). */
  artifactId: string;
  /** Conversation/thread grouping key, used to scope retrieval to one thread. */
  threadKey: string;
  /** Event time in epoch milliseconds. Used for recency filtering. */
  occurredAt: number;
  /** The chunk text that was embedded. */
  text: string;
  /** The embedding. Every chunk in a given store must have the same length. */
  vector: number[];
}

/** Optional narrowing applied before the nearest-neighbour search runs. */
export interface SearchFilter {
  /** Restrict results to a single thread. */
  threadKey?: string;
  /** Restrict results to chunks with `occurredAt >= since` (epoch milliseconds). */
  since?: number;
}

/** A search hit: the stored chunk plus its distance from the query vector. */
export type SearchResult = Chunk & {
  /** Distance from the query vector; smaller is more similar. */
  distance: number;
};

/** Storage-facing API for chunk embeddings. */
export interface VectorStore {
  /**
   * Insert or replace chunks. Idempotent on {@link Chunk.id}: upserting the same
   * id twice leaves exactly one row.
   */
  upsert(chunks: Chunk[]): Promise<void>;
  /**
   * Return at most `k` chunks nearest to `vector`, ordered by ascending distance.
   * Filters are applied *before* the nearest-neighbour search, so the results are
   * the `k` nearest among the rows that satisfy the filter.
   */
  search(vector: number[], k: number, filter?: SearchFilter): Promise<SearchResult[]>;
  /**
   * Delete every chunk whose {@link Chunk.eventId} appears in `eventIds`.
   * Returns the number of rows removed. Used by the retention purge and by
   * right-to-delete requests.
   */
  deleteByEventIds(eventIds: string[]): Promise<number>;
  /** Release the underlying LanceDB resources. Safe to call more than once. */
  close(): Promise<void>;
}

/** Options for {@link openVectors}. */
export interface OpenVectorsOptions {
  /**
   * Embedding width used when creating a brand new table.
   * Defaults to {@link DEFAULT_DIMENSION} (`nomic-embed-text`).
   */
  dimension?: number;
}

/** Shape of a row as it comes back from LanceDB (snake_case, Arrow-backed). */
interface RawRow {
  id: string;
  event_id: string;
  artifact_id: string;
  thread_key: string;
  occurred_at: number;
  text: string;
  vector: ArrayLike<number> | Iterable<number>;
  _distance?: number;
}

/** Shape of a row as it is written to LanceDB. */
interface WriteRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  artifact_id: string;
  thread_key: string;
  occurred_at: number;
  text: string;
  vector: number[];
}

/** Escape a string for use as a SQL literal inside a LanceDB predicate. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Split `values` into slices of at most `size` entries. */
function batch<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    batches.push(values.slice(i, i + size));
  }
  return batches;
}

/** Build a `column IN ('a', 'b')` predicate. */
function inPredicate(column: string, values: readonly string[]): string {
  return `${column} IN (${values.map(sqlLiteral).join(', ')})`;
}

/** Convert a domain {@link Chunk} into a LanceDB row. */
function toRow(chunk: Chunk): WriteRow {
  return {
    id: chunk.id,
    event_id: chunk.eventId,
    artifact_id: chunk.artifactId,
    thread_key: chunk.threadKey,
    occurred_at: chunk.occurredAt,
    text: chunk.text,
    vector: [...chunk.vector],
  };
}

/** Convert a LanceDB row back into a {@link SearchResult}. */
function toSearchResult(row: RawRow): SearchResult {
  return {
    id: row.id,
    eventId: row.event_id,
    artifactId: row.artifact_id,
    threadKey: row.thread_key,
    occurredAt: Number(row.occurred_at),
    text: row.text,
    // Arrow returns a `Vector`, not a plain array; normalise it for callers.
    vector: Array.from(row.vector as ArrayLike<number>, Number),
    distance: Number(row._distance ?? Number.NaN),
  };
}

/** Build the single seed row used to pin the schema at `dimension` wide. */
function seedRow(dimension: number): WriteRow {
  return {
    id: SEED_ID,
    event_id: '',
    artifact_id: '',
    thread_key: '',
    occurred_at: 0,
    text: '',
    vector: new Array<number>(dimension).fill(0),
  };
}

/** Read the fixed-size-list width of the table's `vector` column. */
async function readDimension(table: LanceTable): Promise<number> {
  const schema = await table.schema();
  const field = schema.fields.find((candidate) => candidate.name === 'vector');
  const listSize: unknown = (field?.type as { listSize?: unknown } | undefined)?.listSize;
  return typeof listSize === 'number' ? listSize : -1;
}

/**
 * Open (or create) the `chunks` table. Creation is idempotent: calling this on a
 * directory that already holds a store simply reuses the existing table.
 */
async function openOrCreateTable(conn: Connection, dimension: number): Promise<LanceTable> {
  // `mode: 'create'` + `existOk: true` is a no-op when the table already exists
  // (the seed data is ignored), which makes repeated calls safe and race-free.
  const table = await conn.createTable(TABLE_NAME, [seedRow(dimension)], {
    mode: 'create',
    existOk: true,
  });
  // Only a freshly created table still contains the seed row.
  await table.delete(`id = ${sqlLiteral(SEED_ID)}`);
  return table;
}

/**
 * Open the LanceDB-backed vector store rooted at `dir`, creating the database
 * directory and the `chunks` table if they do not exist yet.
 *
 * Calling this twice against the same directory is safe: the second call reuses
 * the existing table rather than recreating or duplicating it.
 *
 * @param dir Directory that holds (or will hold) the LanceDB database.
 * @param options See {@link OpenVectorsOptions}.
 */
export async function openVectors(dir: string, options: OpenVectorsOptions = {}): Promise<VectorStore> {
  const conn = await connect(dir);
  let table = await openOrCreateTable(conn, options.dimension ?? DEFAULT_DIMENSION);

  // All mutations are serialised: LanceDB commits are optimistic and concurrent
  // writers against the same table can fail with a commit conflict.
  let queue: Promise<unknown> = Promise.resolve();
  const serialise = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work, work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  /**
   * Reconcile the table's vector width with the data being written.
   *
   * A brand new store is created at the default width before any embedding has
   * been seen. If the first vectors written are a different width, the (still
   * empty) table is recreated to match. Once the table holds data its width is
   * fixed, and a mismatch is a programming error worth surfacing loudly.
   */
  const ensureDimension = async (incoming: number): Promise<void> => {
    const current = await readDimension(table);
    if (current === incoming) return;

    const rows = await table.countRows();
    if (rows > 0) {
      throw new Error(
        `Vector dimension mismatch: table '${TABLE_NAME}' stores ${current}-dimensional ` +
          `vectors but a ${incoming}-dimensional vector was supplied. Re-embed the corpus ` +
          `or open a different directory.`,
      );
    }

    table = await conn.createTable(TABLE_NAME, [seedRow(incoming)], { mode: 'overwrite' });
    await table.delete(`id = ${sqlLiteral(SEED_ID)}`);
  };

  const upsert = async (chunks: Chunk[]): Promise<void> => {
    if (chunks.length === 0) return;

    const widths = new Set(chunks.map((chunk) => chunk.vector.length));
    if (widths.size > 1) {
      throw new Error(`All chunks in one upsert must share a vector length, got: ${[...widths].join(', ')}`);
    }
    const [width] = [...widths];
    if (width === undefined || width === 0) {
      throw new Error('Chunk vectors must be non-empty.');
    }

    await serialise(async () => {
      await ensureDimension(width);
      // LanceDB 0.13 has no key-based upsert on `Table.add`, so replace by id:
      // delete any existing rows with these ids, then append the new versions.
      // De-duplicate within the batch as well, keeping the last occurrence, so a
      // single call can never insert two rows for the same id.
      const deduped = new Map<string, Chunk>();
      for (const chunk of chunks) deduped.set(chunk.id, chunk);
      const ids = [...deduped.keys()];

      for (const ids_ of batch(ids, MAX_IDS_PER_PREDICATE)) {
        await table.delete(inPredicate('id', ids_));
      }
      await table.add([...deduped.values()].map(toRow));
    });
  };

  const search = async (vector: number[], k: number, filter?: SearchFilter): Promise<SearchResult[]> => {
    if (k <= 0 || vector.length === 0) return [];
    if ((await table.countRows()) === 0) return [];

    const predicates: string[] = [];
    if (filter?.threadKey !== undefined) {
      predicates.push(`thread_key = ${sqlLiteral(filter.threadKey)}`);
    }
    if (filter?.since !== undefined) {
      predicates.push(`occurred_at >= ${filter.since}`);
    }

    let query = table.vectorSearch(vector).limit(k);
    if (predicates.length > 0) {
      // `where` on a vector query pre-filters by default, so the k results are
      // the k nearest *among matching rows* rather than a filtered top-k.
      query = query.where(predicates.join(' AND '));
    }

    const rows = (await query.toArray()) as RawRow[];
    // LanceDB already returns nearest-first; sort defensively so the contract
    // holds regardless of index or execution-plan changes.
    return rows.map(toSearchResult).sort((a, b) => a.distance - b.distance);
  };

  const deleteByEventIds = async (eventIds: string[]): Promise<number> => {
    if (eventIds.length === 0) return 0;
    const unique = [...new Set(eventIds)];

    return serialise(async () => {
      let removed = 0;
      for (const ids of batch(unique, MAX_IDS_PER_PREDICATE)) {
        const predicate = inPredicate('event_id', ids);
        removed += await table.countRows(predicate);
        await table.delete(predicate);
      }
      return removed;
    });
  };

  const close = async (): Promise<void> => {
    await queue.catch(() => undefined);
    if (table.isOpen()) table.close();
    if (conn.isOpen()) conn.close();
  };

  return { upsert, search, deleteByEventIds, close };
}
