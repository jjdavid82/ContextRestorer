/**
 * Task 5.4 — retention and right-to-delete, end to end (SEC-8 + the 90-day NFR).
 *
 * `test/retention.test.ts` already covers `purgeRawEventsOlderThan` and
 * `deleteEverything` as *SQLite* units, against `:memory:`. This file is the
 * broader claim: that the erasure promise actually holds across every store the
 * app writes to at once —
 *
 *   - SQLite, on a real file (so WAL sidecars and file-level cleanup are real),
 *   - LanceDB, a real embedded store in a real directory,
 *   - the narrative `.md` files on disk,
 *   - the OAuth token vault (`tokens.enc`).
 *
 * Nothing here is mocked except Electron's `safeStorage`, which cannot exist
 * outside an Electron process; the mock follows the same transforming pattern as
 * `packages/ingest/test/vault.test.ts` so "no plaintext survives" stays a real
 * assertion rather than a vacuous one.
 *
 * The point of the file is the *caller contract*. `deleteEverything` deliberately
 * performs no I/O beyond SQLite and instead returns
 * `{ vectorEventIds, narrativePaths }` — a manifest of what it could not erase
 * itself. That contract is only worth anything if somebody acts on it, and this
 * is the first test that plays the caller: it feeds `vectorEventIds` to
 * `VectorStore.deleteByEventIds`, unlinks every `narrativePath`, and drains the
 * `TokenVault` — then proves that nothing identifying is left anywhere.
 *
 * `TokenVault` is imported from `packages/ingest`'s *source*, not from
 * `@cr/ingest`: `@cr/store` does not (and must not) depend on `@cr/ingest`, and
 * the bare specifier would resolve to `packages/ingest/dist`, making this test's
 * result depend on whether a sibling package happened to be built. `vault.ts`
 * has no runtime imports of its own, so pulling in the source file is free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Artifact, Person, SourceId } from '@cr/core';
import { openDb, migrate } from '../src/index.js';
import { openVectors, type Chunk, type VectorStore } from '../src/vectors.js';
import { purgeRawEventsOlderThan, deleteEverything } from '../src/retention.js';
import { EventsRepo } from '../src/repos/events.js';
import { GraphRepo } from '../src/repos/graph.js';
import { ExtractionsRepo } from '../src/repos/extractions.js';
import { DeltasRepo } from '../src/repos/deltas.js';
import { PendingItemsRepo } from '../src/repos/pending.js';
import { BriefingsRepo } from '../src/repos/briefings.js';
import { FeedbackRepo } from '../src/repos/feedback.js';
import { AiCallsRepo } from '../src/repos/aiCalls.js';
import { WatermarkRepo } from '../src/repos/watermark.js';
import { BriefingSchedulesRepo } from '../src/repos/briefingSchedules.js';
import { SlackChannelsRepo } from '../src/repos/slackChannels.js';
import {
  TokenVault,
  type OAuthTokens,
  type SafeStorageLike,
} from '../../ingest/src/oauth/vault.js';

/** LanceDB's native calls are slow to warm up; give each case real headroom. */
const TIMEOUT_MS = 60_000;

/** Fixed 4-dimensional fixtures — no embedding model needed for exact assertions. */
const QUERY = [1, 0, 0, 0];

/** Retrieval limit used when reading *everything* back out of LanceDB. */
const READ_ALL = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
/** The retention horizon the NFR specifies. */
const RETENTION_DAYS = 90;

const SLACK_TOKENS: OAuthTokens = {
  accessToken: 'xoxp-slack-access-token',
  refreshToken: 'xoxe-1-slack-refresh-token-SECRET',
  expiresAt: 1_800_000_000_000,
  scope: 'channels:history,im:history,users:read',
};

const GMAIL_TOKENS: OAuthTokens = {
  accessToken: 'ya29.gmail-access-token',
  refreshToken: '1//gmail-refresh-token-SECRET',
  expiresAt: 1_900_000_000_000,
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
};

const CIPHER_PREFIX = 'enc:';

/**
 * Transforming stand-in for Electron's `safeStorage` (same shape as the one in
 * `packages/ingest/test/vault.test.ts`). Reversible, but nothing readable
 * survives into the raw file bytes.
 */
const makeSafeStorage = (): SafeStorageLike => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((plainText: string) =>
    Buffer.from(CIPHER_PREFIX + Buffer.from(plainText, 'utf8').toString('base64'), 'utf8'),
  ),
  decryptString: vi.fn((encrypted: Buffer) => {
    const raw = encrypted.toString('utf8');
    if (!raw.startsWith(CIPHER_PREFIX)) throw new Error('mock decrypt: not our ciphertext');
    return Buffer.from(raw.slice(CIPHER_PREFIX.length), 'base64').toString('utf8');
  }),
});

/** Every table `deleteEverything` is required to leave empty. */
const USER_DATA_TABLES = [
  'events',
  'artifacts',
  'people',
  'projects',
  'relationships',
  'extractions',
  'state_deltas',
  'pending_items',
  'synthesis_watermark',
  'briefings',
  'briefing_claims',
  'feedback',
  'ai_calls',
  'briefing_schedules',
  'slack_selected_channels',
] as const;

/** The append-only guards that must survive every privileged write. */
const APPEND_ONLY_TRIGGERS = ['deltas_no_update', 'events_no_delete', 'events_no_update'];

// ---------------------------------------------------------------------------
// Per-test fixture: a real app-shaped directory tree.
// ---------------------------------------------------------------------------

/** Root temp dir; everything the app would write lives underneath it. */
let root: string;
let dbPath: string;
let vectorsDir: string;
/** Where narrative markdown lives, mirroring `<narrativeDir>/briefings/<id>.md`. */
let briefingsDir: string;
let vaultPath: string;

let db: Database;
let vectors: VectorStore;
let vault: TokenVault;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cr-rtd-'));
  dbPath = join(root, 'app.db');
  vectorsDir = join(root, 'vectors');
  briefingsDir = join(root, 'briefings');
  vaultPath = join(root, 'tokens.enc');

  // A FILE-backed database, not `:memory:` — this test also asserts things about
  // files on disk, and WAL mode (which `:memory:` silently ignores) is what the
  // shipped app actually runs.
  db = openDb(dbPath);
  migrate(db);

  vectors = await openVectors(vectorsDir);
  vault = new TokenVault(makeSafeStorage(), vaultPath);
  mkdirSync(briefingsDir, { recursive: true });
});

afterEach(async () => {
  // Close both stores before removing the tree: Windows refuses to unlink files
  // that are still open, and better-sqlite3 keeps `-wal`/`-shm` sidecars around.
  await vectors.close().catch(() => undefined);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/**
 * Every real table `deleteEverything` is obligated to empty, discovered from
 * `sqlite_master` rather than hand-maintained — the same drift that let
 * `slack_selected_channels` (migration 004) go unwiped for a full feature cycle
 * cannot recur silently once this list is generated from the live schema
 * instead of copied into a second array by hand.
 */
function allUserDataTables(): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name != 'schema_version' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function triggerNames(): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * Assert the guards are not merely *listed* in `sqlite_master` but actually
 * *fire*. A recreated-but-broken trigger would pass a name check while leaving
 * the source of truth mutable, so both halves are checked together.
 */
function expectAppendOnlyEnforced(eventId: string): void {
  expect(triggerNames()).toEqual(APPEND_ONLY_TRIGGERS);
  expect(() =>
    db.prepare(`UPDATE events SET actor_id = 'x' WHERE event_id = ?`).run(eventId),
  ).toThrow(/append-only/);
  expect(() => db.prepare(`DELETE FROM events WHERE event_id = ?`).run(eventId)).toThrow(
    /append-only/,
  );
}

function artifact(id: string, at: number): Artifact {
  return {
    artifactId: id,
    source: 'slack',
    kind: 'thread',
    externalRef: `https://slack.example/archives/${id}`,
    title: `thread ${id}`,
    state: 'open',
    ownerId: 'person-self',
    firstSeenAt: at,
    lastSeenAt: at,
  };
}

function person(id: string, isSelf: boolean): Person {
  return { personId: id, displayName: `name-${id}`, emailHash: `hash-${id}`, isSelf };
}

/** Insert one event through the real repo; returns its id. */
function insertEvent(
  events: EventsRepo,
  eventId: string,
  occurredAt: number,
  threadKey = 'C1:1',
  source: SourceId = 'slack',
): string {
  const result = events.insertIfAbsent({
    eventId,
    source,
    sourceEventId: `${source}-${eventId}`,
    threadKey,
    actorId: 'person-self',
    occurredAt,
    ingestedAt: occurredAt + 10,
    payload: { text: `verbatim payload for ${eventId}` },
    redactionCount: 1,
  });
  expect(result.inserted, `${eventId} should have been inserted`).toBe(true);
  return eventId;
}

/** The chunk that would have been embedded for `eventId`. */
function chunkFor(eventId: string, artifactId: string, occurredAt: number, threadKey = 'C1:1'): Chunk {
  return {
    id: `${eventId}:0`,
    eventId,
    artifactId,
    threadKey,
    occurredAt,
    text: `embedded text for ${eventId}`,
    vector: [1, 0, 0, 0],
  };
}

/** Every `eventId` currently present in the LanceDB `chunks` table. */
async function chunkEventIds(): Promise<string[]> {
  const hits = await vectors.search(QUERY, READ_ALL);
  return hits.map((hit) => hit.eventId).sort();
}

// ---------------------------------------------------------------------------
// Test 1 — the full SEC-8 erasure, including the caller's half of the contract.
// ---------------------------------------------------------------------------

/** Ids and paths the seed produced, so the assertions can name them exactly. */
interface Seeded {
  eventIds: string[];
  chunkIds: string[];
  narrativeFiles: string[];
  briefingId: string;
}

/**
 * Populate every user-data table, the vector store, the narrative directory and
 * the token vault — one coherent dataset, written exclusively through the real
 * repositories so the FK graph is exercised the way the app exercises it.
 */
async function seedEverything(): Promise<Seeded> {
  const graph = new GraphRepo(db);
  const events = new EventsRepo(db);
  const extractions = new ExtractionsRepo(db);
  const deltas = new DeltasRepo(db);
  const pending = new PendingItemsRepo(db);
  const briefings = new BriefingsRepo(db);
  const feedback = new FeedbackRepo(db);
  const aiCalls = new AiCallsRepo(db);
  const watermark = new WatermarkRepo(db);
  const schedules = new BriefingSchedulesRepo(db);
  const slackChannels = new SlackChannelsRepo(db);

  // --- graph: artifacts, people, a declared project and the edges between them.
  graph.upsertArtifact(artifact('artifact-1', 1_000));
  graph.upsertArtifact(artifact('artifact-2', 2_000));
  graph.upsertPerson(person('person-self', true));
  graph.upsertPerson(person('person-other', false));
  const project = graph.declareProject({ name: 'Apollo', origin: 'declared', stakesWeight: 2 });
  graph.relate({ fromId: 'artifact-1', rel: 'belongs_to', toId: project.projectId, confidence: 0.9 });
  graph.relate({ fromId: 'artifact-1', rel: 'participant', toId: 'person-other', confidence: 0.8 });

  // --- events + one extraction each (raw payloads and their Layer-1 output).
  const eventIds = [
    insertEvent(events, 'event-1', 1_000),
    insertEvent(events, 'event-2', 2_000),
    insertEvent(events, 'event-3', 3_000),
    insertEvent(events, 'event-4', 4_000, 'gmail-thread-9', 'gmail'),
  ];
  for (const [index, eventId] of eventIds.entries()) {
    extractions.insert({
      extractionId: `extraction-${index + 1}`,
      eventId,
      class: 'decision',
      confidence: 0.9,
      participants: ['person-self', 'person-other'],
      artifacts: ['artifact-1'],
      model: 'test-model',
      promptVersion: 'v1',
      createdAt: 1_000 * (index + 1),
    });
  }

  // --- Layer 2: a two-version chain, so `supersedes` (self-FK) is populated.
  const delta1 = deltas.append({
    threadKey: 'C1:1',
    artifactId: 'artifact-1',
    summary: 'shipping Friday',
    kind: 'decision',
    confidence: 0.9,
    sourceEventIds: ['event-1', 'event-2'],
    citationArtifactIds: ['artifact-1'],
    model: 'test-model',
    promptVersion: 'v1',
    createdAt: 2_000,
  });
  const delta2 = deltas.append({
    threadKey: 'C1:1',
    artifactId: 'artifact-1',
    summary: 'slipped to Monday',
    kind: 'reversal',
    confidence: 0.8,
    sourceEventIds: ['event-3'],
    citationArtifactIds: ['artifact-1', 'artifact-2'],
    model: 'test-model',
    promptVersion: 'v1',
    createdAt: 3_000,
  });
  expect(delta2.supersedes).toBe(delta1.deltaId);

  pending.insert({
    pendingId: 'pending-1',
    deltaId: delta2.deltaId,
    description: 'confirm the new date with the team',
    confidence: 0.6,
    citationArtifactId: 'artifact-1',
    createdAt: 3_500,
  });

  watermark.touch('C1:1', 'slack', 3_000);
  watermark.touch('gmail-thread-9', 'gmail', 4_000);

  // --- Layer 3: a briefing whose narrative path is a real file on disk, exactly
  //     as `@cr/ai`'s generator names it: `<narrativeDir>/briefings/<id>.md`.
  const briefingId = 'briefing-1';
  const narrativePath = join(briefingsDir, `${briefingId}.md`);
  briefings.create({
    briefingId,
    windowStart: 0,
    windowEnd: 10_000,
    generatedAt: 10_000,
    mode: 'llm',
    narrativePath,
    deltaIds: [delta1.deltaId, delta2.deltaId],
    threadsStillProcessing: 0,
  });
  // A second briefing that deliberately re-uses the same narrative file, to
  // prove the manifest is DISTINCT paths and a double-unlink is not attempted.
  const secondBriefingId = 'briefing-2';
  const secondNarrativePath = join(briefingsDir, `${secondBriefingId}.md`);
  briefings.create({
    briefingId: secondBriefingId,
    windowStart: 10_000,
    windowEnd: 20_000,
    generatedAt: 20_000,
    mode: 'template',
    narrativePath: secondNarrativePath,
    deltaIds: [delta2.deltaId],
    threadsStillProcessing: 1,
  });
  briefings.create({
    briefingId: 'briefing-3',
    windowStart: 20_000,
    windowEnd: 30_000,
    generatedAt: 30_000,
    mode: 'llm',
    narrativePath, // same file as briefing-1
    deltaIds: [],
    threadsStillProcessing: 0,
  });

  const claim = briefings.addClaim({
    briefingId,
    ordinal: 1,
    section: 'decisions',
    text: 'The launch slipped to Monday.',
    citationArtifactId: 'artifact-1',
    deltaId: delta2.deltaId,
  });
  briefings.addClaim({
    briefingId,
    ordinal: 2,
    section: 'pending',
    text: 'Someone still needs to confirm the new date.',
    citationArtifactId: 'artifact-2',
    deltaId: delta2.deltaId,
  });

  feedback.submit({ briefingId, claimId: claim.claimId, verdict: 'relevant' });
  feedback.submit({ briefingId, verdict: 'missed', note: 'the vendor call was left out' });

  aiCalls.log({
    traceId: 'trace-1',
    layer: 3,
    model: 'test-model',
    promptVersion: 'v1',
    latencyMs: 1_200,
    tokensIn: 900,
    tokensOut: 300,
    outcome: 'ok',
  });
  schedules.create({
    scheduleId: 'schedule-1',
    cadence: 'weekdays',
    hourLocal: 8,
    minuteLocal: 30,
    createdAt: 1_000,
  });
  slackChannels.setSelected([{ channelId: 'C-1', name: 'general' }], 1_000);

  // --- Outside SQLite: vectors, narrative files, token vault.
  const chunks = [
    chunkFor('event-1', 'artifact-1', 1_000),
    chunkFor('event-2', 'artifact-1', 2_000),
    chunkFor('event-3', 'artifact-2', 3_000),
    chunkFor('event-4', 'artifact-2', 4_000, 'gmail-thread-9'),
  ];
  await vectors.upsert(chunks);

  const narrativeFiles = [narrativePath, secondNarrativePath];
  for (const file of narrativeFiles) {
    writeFileSync(file, `# briefing\n\nverbatim narrative prose for ${file}\n`, 'utf8');
  }

  await vault.store('slack', SLACK_TOKENS);
  await vault.store('gmail', GMAIL_TOKENS);

  return {
    eventIds,
    chunkIds: chunks.map((chunk) => chunk.id),
    narrativeFiles,
    briefingId,
  };
}

describe('right to delete, end to end (SEC-8)', () => {
  it(
    'erases SQLite, LanceDB, the narrative files and the token vault together',
    async () => {
      const seeded = await seedEverything();

      // ---- Preconditions: everything really is there before the wipe. -------
      for (const table of USER_DATA_TABLES) {
        expect(countRows(table), `${table} should be seeded`).toBeGreaterThan(0);
      }
      expect(await chunkEventIds()).toEqual([...seeded.eventIds].sort());
      expect(readdirSync(briefingsDir).sort()).toEqual(['briefing-1.md', 'briefing-2.md']);
      expect(existsSync(vaultPath)).toBe(true);
      const schemaVersionsBefore = countRows('schema_version');
      expect(schemaVersionsBefore).toBeGreaterThan(0);

      // ---- Step 1: the privileged SQLite wipe. ----------------------------
      const manifest = deleteEverything(db);

      // The manifest is the whole contract: SQLite is emptied, and everything it
      // could not reach is *reported* rather than deleted.
      expect([...manifest.vectorEventIds].sort()).toEqual([...seeded.eventIds].sort());
      expect([...manifest.narrativePaths].sort()).toEqual([...seeded.narrativeFiles].sort());

      // Proof the manifest is not decorative: at this moment the vectors and the
      // files are still on disk. Nothing but a caller acting on it erases them.
      expect(await chunkEventIds()).toEqual([...seeded.eventIds].sort());
      expect(readdirSync(briefingsDir)).toHaveLength(2);

      // ---- Step 2: the caller's half of the contract. ----------------------
      const removedChunks = await vectors.deleteByEventIds(manifest.vectorEventIds);
      for (const path of manifest.narrativePaths) unlinkSync(path);
      // `TokenVault` has no "clear all" operation on purpose — it is keyed per
      // source — so a full erasure revokes each source in turn. Revoking the
      // LAST entry deletes `tokens.enc` outright (SEC-3), which is what makes
      // "no token file left behind" achievable through the public API alone.
      for (const source of ['slack', 'gmail'] satisfies SourceId[]) {
        await vault.revoke(source);
      }

      expect(removedChunks).toBe(seeded.chunkIds.length);

      // ---- Assertions: SQLite. --------------------------------------------
      for (const table of USER_DATA_TABLES) {
        expect(countRows(table), `${table} must be empty after erasure`).toBe(0);
      }
      // Safety net independent of USER_DATA_TABLES: enumerate every table the
      // live schema actually has (except `schema_version`) and require each one
      // empty. A future migration that adds a table but forgets to add it to
      // `retention.ts`'s `DELETE_ORDER` fails HERE, rather than silently
      // shipping a right-to-delete gap the way migration 004 briefly did.
      for (const table of allUserDataTables()) {
        expect(countRows(table), `${table} must be empty after erasure`).toBe(0);
      }
      // `schema_version` is deliberately NOT wiped: erasing the migration ledger
      // would make the next `migrate()` re-apply 001 against a live schema.
      expect(countRows('schema_version')).toBe(schemaVersionsBefore);

      // ---- Assertions: append-only survived the privileged write. ----------
      // The single most important invariant in this file. A wipe that forgot to
      // recreate `events_no_delete` would leave the source of truth an ordinary
      // mutable table, and every other assertion here would still pass.
      const events = new EventsRepo(db);
      new GraphRepo(db).upsertArtifact(artifact('artifact-fresh', 40_000));
      insertEvent(events, 'event-fresh', 40_000);
      expectAppendOnlyEnforced('event-fresh');
      expect(countRows('events')).toBe(1); // the wiped db is usable again

      // ---- Assertions: LanceDB. -------------------------------------------
      expect(await chunkEventIds()).toEqual([]);
      const hits = await vectors.search(QUERY, READ_ALL);
      expect(hits).toEqual([]);
      // Idempotent: replaying the caller's step removes nothing further.
      expect(await vectors.deleteByEventIds(manifest.vectorEventIds)).toBe(0);

      // ---- Assertions: the filesystem. ------------------------------------
      expect(readdirSync(briefingsDir)).toEqual([]);
      for (const path of seeded.narrativeFiles) {
        expect(existsSync(path), `${path} must be unlinked`).toBe(false);
      }

      // ---- Assertions: the token vault. -----------------------------------
      // Not an empty-but-present `{}` file — gone entirely (SEC-3).
      expect(existsSync(vaultPath)).toBe(false);
      await expect(vault.load('slack')).resolves.toBeUndefined();
      await expect(vault.load('gmail')).resolves.toBeUndefined();
    },
    TIMEOUT_MS,
  );

  it(
    'is idempotent: a second full erasure is a no-op with an empty manifest',
    async () => {
      await seedEverything();

      const first = deleteEverything(db);
      await vectors.deleteByEventIds(first.vectorEventIds);
      for (const path of first.narrativePaths) unlinkSync(path);
      for (const source of ['slack', 'gmail'] satisfies SourceId[]) {
        await vault.revoke(source);
      }

      const second = deleteEverything(db);

      expect(second).toEqual({ vectorEventIds: [], narrativePaths: [] });
      expect(await vectors.deleteByEventIds(second.vectorEventIds)).toBe(0);
      expect(existsSync(vaultPath)).toBe(false);
      expect(triggerNames()).toEqual(APPEND_ONLY_TRIGGERS);
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Test 2 — 90-day retention across SQLite and LanceDB.
// ---------------------------------------------------------------------------

describe('90-day retention, end to end (NFR)', () => {
  it(
    'ages out old raw payloads and their vectors while keeping recent ones',
    async () => {
      const now = 1_800_000_000_000;
      const cutoff = now - RETENTION_DAYS * DAY_MS;

      const graph = new GraphRepo(db);
      const events = new EventsRepo(db);
      const extractions = new ExtractionsRepo(db);
      const deltas = new DeltasRepo(db);

      graph.upsertArtifact(artifact('artifact-old', cutoff - 10 * DAY_MS));
      graph.upsertArtifact(artifact('artifact-new', now));

      // Two clearly older than the horizon, one exactly on it (kept — the cutoff
      // is exclusive), two clearly inside it.
      const old = [
        insertEvent(events, 'old-1', cutoff - 30 * DAY_MS),
        insertEvent(events, 'old-2', cutoff - 1 * DAY_MS),
      ];
      const kept = [
        insertEvent(events, 'at-cutoff', cutoff),
        insertEvent(events, 'new-1', cutoff + 1 * DAY_MS),
        insertEvent(events, 'new-2', now - 1_000),
      ];

      for (const [index, eventId] of [...old, ...kept].entries()) {
        extractions.insert({
          extractionId: `x-${eventId}`,
          eventId,
          class: 'status_update',
          confidence: 0.7,
          participants: [],
          artifacts: [],
          model: 'test-model',
          promptVersion: 'v1',
          createdAt: cutoff + index,
        });
      }

      // Derived state referencing an aged-out event: it must NOT be purged, which
      // is exactly why retention keeps the memory and drops only the verbatim text.
      deltas.append({
        threadKey: 'C1:1',
        artifactId: 'artifact-old',
        summary: 'decided the vendor months ago',
        kind: 'decision',
        confidence: 0.9,
        sourceEventIds: ['old-1'],
        citationArtifactIds: ['artifact-old'],
        model: 'test-model',
        promptVersion: 'v1',
        createdAt: cutoff - 20 * DAY_MS,
      });

      await vectors.upsert([
        chunkFor('old-1', 'artifact-old', cutoff - 30 * DAY_MS),
        chunkFor('old-2', 'artifact-old', cutoff - 1 * DAY_MS),
        chunkFor('at-cutoff', 'artifact-new', cutoff),
        chunkFor('new-1', 'artifact-new', cutoff + 1 * DAY_MS),
        chunkFor('new-2', 'artifact-new', now - 1_000),
      ]);

      // ---- The purge. ------------------------------------------------------
      const purged = purgeRawEventsOlderThan(db, cutoff);

      expect(purged).toBe(old.length);
      const remaining = (db.prepare(`SELECT event_id FROM events`).all() as {
        event_id: string;
      }[]).map((row) => row.event_id);
      expect(remaining.sort()).toEqual([...kept].sort());

      // Extractions cascaded with their parent events; derived state did not.
      const survivingExtractions = (db.prepare(`SELECT event_id FROM extractions`).all() as {
        event_id: string;
      }[]).map((row) => row.event_id);
      expect(survivingExtractions.sort()).toEqual([...kept].sort());
      expect(countRows('state_deltas')).toBe(1);

      // ---- The documented non-scope, verified rather than assumed. ---------
      // `purgeRawEventsOlderThan` is SQLite-only: the aged-out chunks are still
      // in LanceDB at this point, and would stay there forever if the caller
      // never followed up. The vectors are derived from the same raw payloads
      // and are just as identifying, so leaving them is not an option.
      expect(await chunkEventIds()).toEqual([...old, ...kept].sort());

      // ---- The caller completes the flow. ---------------------------------
      const removed = await vectors.deleteByEventIds(old);

      expect(removed).toBe(old.length);
      expect(await chunkEventIds()).toEqual([...kept].sort());

      // ---- And the guards are still live afterwards. -----------------------
      expectAppendOnlyEnforced('new-1');
    },
    TIMEOUT_MS,
  );

  it(
    'keeps the append-only guards enforcing across repeated purges',
    async () => {
      const events = new EventsRepo(db);
      insertEvent(events, 'e-1', 1_000);
      insertEvent(events, 'e-2', 2_000);
      insertEvent(events, 'e-3', 9_000);
      await vectors.upsert([
        chunkFor('e-1', 'artifact-1', 1_000),
        chunkFor('e-2', 'artifact-1', 2_000),
        chunkFor('e-3', 'artifact-1', 9_000),
      ]);

      expect(purgeRawEventsOlderThan(db, 1_500)).toBe(1);
      expect(await vectors.deleteByEventIds(['e-1'])).toBe(1);
      expect(triggerNames()).toEqual(APPEND_ONLY_TRIGGERS);

      expect(purgeRawEventsOlderThan(db, 2_500)).toBe(1);
      expect(await vectors.deleteByEventIds(['e-2'])).toBe(1);

      // A no-op purge must not double-create the trigger it just recreated.
      expect(purgeRawEventsOlderThan(db, 2_500)).toBe(0);

      expect(countRows('events')).toBe(1);
      expect(await chunkEventIds()).toEqual(['e-3']);
      expectAppendOnlyEnforced('e-3');
    },
    TIMEOUT_MS,
  );
});
