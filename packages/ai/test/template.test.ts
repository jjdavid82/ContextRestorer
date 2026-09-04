/**
 * Layer 3 — deterministic template fallback (Task 4.3; X-3, §7.8, AC-2).
 *
 * Doubles are chosen on the same principle as `generate.test.ts`:
 *
 * - `DeltasRepo` / `PendingItemsRepo` / `BriefingsRepo` / `GraphRepo` /
 *   `WatermarkRepo` / `AiCallsRepo` are the REAL repositories on an in-memory
 *   SQLite database. The three properties under test here are properties of the
 *   schema, not of the code: `current_state_deltas` is the D-6 tip view, and
 *   `briefing_claims.citation_artifact_id` is a NOT NULL foreign key into
 *   `artifacts` (AC-2). A mocked repo would assert neither, and the "every
 *   template claim is cited" test would prove nothing at all.
 * - `OllamaClient` is a COUNTING stub. It exists so the "no model was called"
 *   assertion can be made empirically as well as structurally: the counters must
 *   read 0/0/0, AND the renderer must be shown to hold no field that even has
 *   those methods. The second check is the real guarantee; the first is what
 *   catches a regression that reintroduces one.
 * - `preflight` is injected as a probe function rather than stubbed over the
 *   network, so "Ollama unreachable" is a first-class input instead of a
 *   socket-timing accident.
 * - The clock is a `FakeClock`, so the timings a template render reports are
 *   exact rather than approximately zero.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { FakeClock, type AppConfig, type Artifact, type DeltaKind } from '@cr/core';
import {
  AiCallsRepo,
  BriefingsRepo,
  DeltasRepo,
  GraphRepo,
  PendingItemsRepo,
  WatermarkRepo,
  migrate,
  openDb,
} from '@cr/store';
import type {
  GenerateJsonOptions,
  GenerateJsonResult,
  GenerateStreamOptions,
  OllamaClient,
} from '../src/ollama.js';
import type { PreflightResult } from '../src/preflight.js';
import type { RetrievalResult, RetrievalWindow, RetrievedChunk } from '../src/retrieval.js';
import { CitationGate } from '../src/layer3/citationGate.js';
import { BriefingGenerator, type BriefingRetriever } from '../src/layer3/generate.js';
import {
  FALLBACK_CHAIN,
  SIMPLIFIED_BRIEFING_LABEL,
  COMPLETED_BRIEFING_LABEL,
  TEMPLATE_MODEL,
  TEMPLATE_PROMPT_VERSION,
  TemplateBriefingRenderer,
  generateWithFallback,
  type PreflightProbe,
} from '../src/layer3/template.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const MODEL = 'llama3.1:8b';
const PROMPT_VERSION = 'layer3-brief.v1';
const BASE_URL = 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';

const A1 = 'slack:thread:C1:1';
const A2 = 'slack:thread:C2:1';
const A3 = 'jira:issue:ACME-7';
/** Deliberately never inserted into `artifacts`: an unresolvable citation. */
const GHOST = 'slack:thread:GONE:9';

const WINDOW = { windowStart: NOW - DAY, windowEnd: NOW + 1 };

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/**
 * An `OllamaClient` that counts every way it could be reached.
 *
 * Every method also throws, not merely counts: a template path that somehow
 * acquired a model client should fail loudly in a test rather than quietly
 * succeed against a stub that returns plausible data.
 */
class CountingOllama implements OllamaClient {
  jsonCalls = 0;
  streamCalls = 0;
  embedCalls = 0;

  /** Scripted stream, for the tests that DO exercise the model path. */
  tokens: string[] = [];
  /** When set, the stream throws instead of yielding the token at this index. */
  throwAtIndex: number | undefined;
  /** Fake-clock ms each token costs, so the §7.8 budget abort is deterministic. */
  msPerToken = 0;
  clock: FakeClock | undefined;
  aborted = false;

  get totalCalls(): number {
    return this.jsonCalls + this.streamCalls + this.embedCalls;
  }

  generateJson<T>(_options: GenerateJsonOptions): Promise<GenerateJsonResult<T>> {
    this.jsonCalls += 1;
    return Promise.reject(new Error('CountingOllama: generateJson must not be called'));
  }

  generateStream(options: GenerateStreamOptions): AsyncIterable<string> {
    this.streamCalls += 1;
    options.signal?.addEventListener('abort', () => {
      this.aborted = true;
    });

    const stub = this;
    async function* iterate(): AsyncGenerator<string, void, undefined> {
      for (let i = 0; i < stub.tokens.length; i += 1) {
        if (stub.throwAtIndex === i) throw new Error('ECONNRESET: ollama went away');
        await Promise.resolve();
        if (stub.msPerToken > 0) stub.clock?.advance(stub.msPerToken);
        yield stub.tokens[i] as string;
      }
    }
    return iterate();
  }

  embed(_texts: string[]): Promise<number[][]> {
    this.embedCalls += 1;
    return Promise.reject(new Error('CountingOllama: embed must not be called'));
  }
}

/** Retrieval fake. The template path never touches it; the LLM path does. */
class StubRetrieval implements BriefingRetriever {
  chunks: RetrievedChunk[] = [];
  error: Error | undefined;

  forBriefing(_window: RetrievalWindow): Promise<RetrievalResult> {
    if (this.error !== undefined) return Promise.reject(this.error);
    return Promise.resolve({ chunks: this.chunks, partial: false });
  }
}

const artifact = (artifactId: string): Artifact => ({
  artifactId,
  source: 'slack',
  kind: 'thread',
  externalRef: `https://example.test/${artifactId}`,
  title: null,
  state: null,
  ownerId: null,
  firstSeenAt: NOW - DAY,
  lastSeenAt: NOW,
});

/** Only `budgets` and `ranking` are read; the rest of `AppConfig` is noise here. */
const makeConfig = (generationMs = 30_000): AppConfig =>
  ({
    budgets: { retrievalMs: 5_000, assemblyMs: 2_000, generationMs, citationMs: 2_000 },
    briefing: { maxChangedItems: 7, groundingMode: 'observe' as const },
    ranking: { wStakes: 3, wPendingOnMe: 5, wSelfParticipation: 2, wRecency: 1 },
  }) as unknown as AppConfig;

/** A probe that reports the local runtime as absent. */
const unreachable: PreflightProbe = () =>
  Promise.resolve<PreflightResult>({
    ok: false,
    reason: 'unreachable',
    message: 'Ollama at http://localhost:11434 is unreachable: connect ECONNREFUSED',
  });

/** A probe that reports everything installed and running. */
const healthy: PreflightProbe = () => Promise.resolve<PreflightResult>({ ok: true });

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let db: Database;
let deltas: DeltasRepo;
let pending: PendingItemsRepo;
let briefings: BriefingsRepo;
let graph: GraphRepo;
let watermarks: WatermarkRepo;
let aiCalls: AiCallsRepo;
let ollama: CountingOllama;
let retrieval: StubRetrieval;
let clock: FakeClock;
let tmp: string;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);

  deltas = new DeltasRepo(db);
  pending = new PendingItemsRepo(db);
  briefings = new BriefingsRepo(db);
  graph = new GraphRepo(db);
  watermarks = new WatermarkRepo(db);
  aiCalls = new AiCallsRepo(db);

  for (const id of [A1, A2, A3]) graph.upsertArtifact(artifact(id));

  clock = new FakeClock(NOW);
  ollama = new CountingOllama();
  ollama.clock = clock;
  retrieval = new StubRetrieval();

  tmp = mkdtempSync(join(tmpdir(), 'cr-template-'));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeRenderer(): TemplateBriefingRenderer {
  return new TemplateBriefingRenderer(
    deltas,
    pending,
    briefings,
    graph,
    watermarks,
    aiCalls,
    makeConfig(),
    tmp,
    clock,
    { logsDir: join(tmp, 'logs') },
  );
}

function makeGenerator(
  tokens: string[],
  over: { throwAtIndex?: number; generationMs?: number; msPerToken?: number } = {},
) {
  ollama.tokens = tokens;
  ollama.throwAtIndex = over.throwAtIndex;
  ollama.msPerToken = over.msPerToken ?? 0;

  return new BriefingGenerator(
    ollama,
    retrieval,
    deltas,
    briefings,
    new CitationGate(graph),
    watermarks,
    graph,
    pending,
    aiCalls,
    makeConfig(over.generationMs ?? 30_000),
    tmp,
    MODEL,
    PROMPT_VERSION,
    clock,
    { logsDir: join(tmp, 'logs') },
  );
}

function appendDelta(input: {
  threadKey: string;
  summary: string;
  kind: DeltaKind;
  citations: string[];
  createdAt?: number;
}) {
  return deltas.append({
    threadKey: input.threadKey,
    artifactId: null,
    summary: input.summary,
    kind: input.kind,
    confidence: 0.8,
    sourceEventIds: ['e-1'],
    citationArtifactIds: input.citations,
    model: MODEL,
    promptVersion: 'layer2-synthesize.v1',
    createdAt: input.createdAt ?? NOW - 3_600_000,
  });
}

/** Three tip deltas on three threads, each citing a different artifact. */
function seedThreeDeltas() {
  return {
    d1: appendDelta({
      threadKey: 'C1:1',
      summary: 'The team chose Postgres for the event store.',
      kind: 'decision',
      citations: [A1],
    }),
    d2: appendDelta({
      threadKey: 'C2:1',
      summary: 'The staging rollout completed.',
      kind: 'progress',
      citations: [A2],
    }),
    d3: appendDelta({
      threadKey: 'C3:1',
      summary: 'The expired-cert outage was closed out.',
      kind: 'resolution',
      citations: [A3],
    }),
  };
}

function claimRows(briefingId: string): { citation_artifact_id: string | null; text: string }[] {
  return db
    .prepare(`SELECT citation_artifact_id, text FROM briefing_claims WHERE briefing_id = ?`)
    .all(briefingId) as { citation_artifact_id: string | null; text: string }[];
}

function countAiCalls(layer: number): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ai_calls WHERE layer = ?`).get(layer) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// 1. Ollama unreachable → template, and never a throw
// ---------------------------------------------------------------------------

describe('fallback chain — Ollama unreachable', () => {
  it('returns a template briefing instead of throwing when preflight says the model is absent', async () => {
    seedThreeDeltas();

    const result = await generateWithFallback(
      makeGenerator([`${JSON.stringify({ section: 'What moved', claim: "unused", artifact_ids: ["slack:thread:C1:1"] })}\n`]),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: unreachable },
    );

    expect(result.mode).toBe('template');
    expect(result.step).toBe('template');
    expect(result.reason).toBe('preflight_failed');
    expect(result.claimsAccepted).toBe(3);
    expect(result.templateClaims).toBe(3);

    // The row on disk agrees, which is what the UI reads.
    expect(briefings.getById(result.briefingId)?.mode).toBe('template');
  });

  it('does not attempt generation at all once preflight has failed', async () => {
    seedThreeDeltas();

    await generateWithFallback(
      makeGenerator([`${JSON.stringify({ section: 'What moved', claim: "unused", artifact_ids: ["slack:thread:C1:1"] })}\n`]),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: unreachable },
    );

    // A failed preflight is the whole answer: paying for prompt assembly and a
    // connection timeout to learn the same thing is the cold-start latency this
    // check exists to remove.
    expect(ollama.streamCalls).toBe(0);
  });

  it('treats a probe that throws as an unavailable model rather than propagating', async () => {
    seedThreeDeltas();
    const exploding: PreflightProbe = () => Promise.reject(new Error('probe blew up'));

    const result = await generateWithFallback(
      makeGenerator([]),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: exploding },
    );

    expect(result.mode).toBe('template');
    expect(result.claimsAccepted).toBe(3);
  });

  it('falls back when generation itself rejects (retrieval down), keeping the pre-minted id', async () => {
    seedThreeDeltas();
    retrieval.error = new Error('vector store is down');

    const result = await generateWithFallback(
      makeGenerator([]),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: healthy, briefingId: 'brief-from-ipc-0001' },
    );

    // The renderer subscribed to this id before generation started; the fallback
    // must publish under it or the user watches an empty stream forever.
    expect(result.briefingId).toBe('brief-from-ipc-0001');
    expect(result.mode).toBe('template');
    expect(result.reason).toBe('generation_failed');
    expect(result.claimsAccepted).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. No model call, structurally
// ---------------------------------------------------------------------------

describe('template rendering makes no model call', () => {
  it('renders from current_state_deltas and pending_items with zero model calls', async () => {
    const { d1 } = seedThreeDeltas();
    pending.insert({
      deltaId: d1.deltaId,
      description: 'Approve the migration plan before Thursday.',
      confidence: 0.9,
      citationArtifactId: A1,
      createdAt: NOW - 3_000_000,
    });

    const result = await makeRenderer().renderTemplate(WINDOW);

    expect(result.claimsAccepted).toBe(3);
    expect(ollama.jsonCalls).toBe(0);
    expect(ollama.streamCalls).toBe(0);
    expect(ollama.embedCalls).toBe(0);
    expect(ollama.totalCalls).toBe(0);

    // And what it rendered came from the two tables, not from thin air.
    const texts = claimRows(result.briefingId).map((row) => row.text);
    expect(texts).toContain('Approve the migration plan before Thursday.');
    expect(texts).toContain('The staging rollout completed.');
  });

  it('holds no dependency that could reach a model, not merely an unused one', () => {
    const renderer = makeRenderer();

    // The structural half of the guarantee (the same shape Task 3.5 gives
    // `briefing:pending`): an empirically-zero call count only proves the code
    // did not call a client on THIS path, whereas having no client in scope
    // proves no future edit to this class can. Walk the instance's own fields —
    // TypeScript's `private readonly` constructor params are ordinary
    // properties — and fail if any of them looks like an inference client.
    const modelMethods = ['generateJson', 'generateStream', 'embed'] as const;
    const fields = Object.entries(renderer as unknown as Record<string, unknown>);

    expect(fields.length).toBeGreaterThan(0);
    for (const [name, value] of fields) {
      if (value === null || typeof value !== 'object') continue;
      for (const method of modelMethods) {
        expect(
          typeof (value as Record<string, unknown>)[method],
          `TemplateBriefingRenderer.${name} exposes ${method}() — X-3/§7.8: the fallback must not be able to call a model`,
        ).not.toBe('function');
      }
    }
  });

  it('records a layer-3 ai_calls row that names no model', async () => {
    seedThreeDeltas();

    await makeRenderer().renderTemplate(WINDOW);

    expect(countAiCalls(3)).toBe(1);
    const row = db.prepare(`SELECT * FROM ai_calls WHERE layer = 3`).get() as {
      model: string;
      prompt_version: string;
      outcome: string;
    };
    // The audit trail must not read as though some model produced this.
    expect(row.model).toBe(TEMPLATE_MODEL);
    expect(row.model).not.toBe(MODEL);
    expect(row.prompt_version).toBe(TEMPLATE_PROMPT_VERSION);
    expect(row.outcome).toBe('template');
  });
});

// ---------------------------------------------------------------------------
// 3. AC-2 survives the fallback
// ---------------------------------------------------------------------------

describe('AC-2 in template mode', () => {
  it('gives every persisted claim a citation that resolves to a real artifact', async () => {
    const { d1 } = seedThreeDeltas();
    // `pending_items.citation_artifact_id` is itself NOT NULL REFERENCES
    // artifacts, so an obligation arrives already cited — and by an artifact
    // that need not be one of its delta's. The item's own citation is the more
    // specific fact and must win.
    pending.insert({
      deltaId: d1.deltaId,
      description: 'Sign off on the two SRE reqs.',
      confidence: 0.7,
      citationArtifactId: A2,
      createdAt: NOW - 2_000_000,
    });

    const result = await makeRenderer().renderTemplate(WINDOW);
    const rows = claimRows(result.briefingId);

    expect(rows).toHaveLength(result.claimsAccepted);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.citation_artifact_id !== null)).toBe(true);
    for (const row of rows) {
      expect(graph.getArtifact(row.citation_artifact_id as string)).toBeDefined();
    }

    const obligation = rows.find((row) => row.text === 'Sign off on the two SRE reqs.');
    expect(obligation?.citation_artifact_id).toBe(A2);
  });

  it('drops a delta whose citations no longer resolve rather than writing an uncitable claim', async () => {
    appendDelta({
      threadKey: 'C9:1',
      summary: 'This one cites an artifact that is gone.',
      kind: 'progress',
      citations: [GHOST],
    });
    appendDelta({
      threadKey: 'C1:1',
      summary: 'This one is properly grounded.',
      kind: 'progress',
      citations: [A1],
    });

    const result = await makeRenderer().renderTemplate(WINDOW);

    // `briefing_claims.citation_artifact_id` is a NOT NULL FK, so the ghost claim
    // is not rejected after being written — it is never attempted.
    expect(result.claimsAccepted).toBe(1);
    expect(result.claimsDropped).toBe(1);
    const texts = claimRows(result.briefingId).map((row) => row.text);
    expect(texts).toEqual(['This one is properly grounded.']);
    expect(readFileSync(result.narrativePath, 'utf8')).not.toContain('cites an artifact that is gone');
  });

  it('restores a citation marker for every bullet in the narrative file', async () => {
    seedThreeDeltas();

    const result = await makeRenderer().renderTemplate(WINDOW);
    const markdown = readFileSync(result.narrativePath, 'utf8');
    const bullets = markdown.split('\n').filter((line) => line.startsWith('- '));

    expect(bullets).toHaveLength(3);
    for (const bullet of bullets) expect(bullet).toMatch(/\[artifact:[^\]]+\]$/);
  });
});

// ---------------------------------------------------------------------------
// 4. "Simplified briefing"
// ---------------------------------------------------------------------------

describe('the briefing is labelled "Simplified briefing"', () => {
  it('labels the returned payload and stores mode = template', async () => {
    seedThreeDeltas();

    const result = await makeRenderer().renderTemplate(WINDOW, { reason: 'preflight_failed' });

    expect(result.label).toBe(SIMPLIFIED_BRIEFING_LABEL);
    expect(result.label).toBe('Simplified briefing');
    expect(result.mode).toBe('template');

    // `briefings.mode` IS the stored signal — there is no separate label column,
    // and adding one would give the UI two sources of truth to disagree about.
    // `apps/ui/components/BriefingView.tsx` renders the phrase from this value.
    expect(briefings.getById(result.briefingId)?.mode).toBe('template');
  });

  it('says so in the narrative file, with the remedy', async () => {
    seedThreeDeltas();

    const result = await makeRenderer().renderTemplate(WINDOW, { reason: 'preflight_failed' });
    const markdown = readFileSync(result.narrativePath, 'utf8');

    expect(markdown).toContain(SIMPLIFIED_BRIEFING_LABEL);
    expect(markdown).toContain('the local model was unavailable');
    expect(markdown).toContain('Check that Ollama is running');
  });

  it('keeps the four canonical sections, in order, so the page shape does not change', async () => {
    seedThreeDeltas();

    const result = await makeRenderer().renderTemplate(WINDOW);
    const markdown = readFileSync(result.narrativePath, 'utf8');
    const positions = ['Waiting on you', 'What moved', 'Quietly resolved', 'Worth knowing'].map(
      (section) => markdown.indexOf(`## ${section}`),
    );

    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('files claims into sections by delta kind, and obligations under "Waiting on you"', async () => {
    const { d2 } = seedThreeDeltas();
    pending.insert({
      deltaId: d2.deltaId,
      description: 'Reply to the vendor about the SOC 2 letter.',
      confidence: 0.8,
      citationArtifactId: A2,
      createdAt: NOW - 1_000_000,
    });

    const result = await makeRenderer().renderTemplate(WINDOW);
    const claims = briefings.listClaims(result.briefingId);

    expect(claims.map((claim) => claim.section)).toEqual([
      'Waiting on you',
      'What moved',
      'Quietly resolved',
    ]);
    // The delta that carried the obligation is narrated ONCE, by the obligation.
    expect(claims.map((claim) => claim.text)).not.toContain('The staging rollout completed.');
    expect(claims[0]?.text).toBe('Reply to the vendor about the SOC 2 letter.');
  });
});

// ---------------------------------------------------------------------------
// 5. An empty window is an answer, not a malfunction
// ---------------------------------------------------------------------------

describe('empty window', () => {
  it('reports "nothing to report" rather than an error or a silently blank page', async () => {
    // No deltas, no pending items.
    const result = await makeRenderer().renderTemplate(WINDOW);

    expect(result.claimsAccepted).toBe(0);
    expect(result.claimsDropped).toBe(0);
    expect(result.nothingToReport).toBe(true);
    expect(result.partial).toBe(false); // nothing was cut short; there was nothing

    const markdown = readFileSync(result.narrativePath, 'utf8');
    expect(markdown).toContain('Nothing to report for this window');
    expect(markdown).toContain('no state changes were recorded and nothing is waiting on you');

    // Still a real, queryable briefing: "nothing happened" is an answer the user
    // asked for and the audit trail has to be able to count.
    expect(briefings.getById(result.briefingId)?.mode).toBe('template');
    expect(countAiCalls(3)).toBe(1);
  });

  it('distinguishes an empty window from one whose content could not be cited', async () => {
    appendDelta({
      threadKey: 'C9:1',
      summary: 'Something happened but its artifact is gone.',
      kind: 'progress',
      citations: [GHOST],
    });

    const result = await makeRenderer().renderTemplate(WINDOW);

    // Zero claims either way, but this window was NOT quiet, and saying it was
    // would be the dishonest version of the same empty page.
    expect(result.claimsAccepted).toBe(0);
    expect(result.claimsDropped).toBe(1);
    expect(result.nothingToReport).toBe(false);
    expect(readFileSync(result.narrativePath, 'utf8')).not.toContain('Nothing to report');
  });

  it('does not reject when the whole chain runs against an empty database', async () => {
    const result = await generateWithFallback(
      makeGenerator([]),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: unreachable },
    );

    expect(result.mode).toBe('template');
    expect(result.claimsAccepted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Ollama dying MID-STREAM
// ---------------------------------------------------------------------------

describe('mid-stream failure', () => {
  /**
   * Four tokens; the stream dies before the fourth. `ClaimBuffer` proves a claim
   * whole only when the NEXT bullet starts, so "Alpha" (completed by token 2) is
   * kept and the half-typed "Bravo" in the buffer is discarded — the generator's
   * existing behaviour, unchanged by this task.
   */
  const DYING_TOKENS = [
    `${JSON.stringify({ section: 'What moved', claim: "Alpha was decided", artifact_ids: [A1] })}\n`,
    `${JSON.stringify({ section: 'What moved', claim: "Bravo was decided", artifact_ids: [A2] })}\n`,
    `${JSON.stringify({ section: 'What moved', claim: "Charlie was decided", artifact_ids: [A3] })}\n`,
  ];

  it('keeps the accepted claims, appends the uncovered deltas from the template, and marks partial', async () => {
    const { d1 } = seedThreeDeltas();
    retrieval.chunks = [];

    const result = await generateWithFallback(
      makeGenerator(DYING_TOKENS, { throwAtIndex: 1 }),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: healthy },
    );

    expect(result.partial).toBe(true);
    expect(result.step).toBe('template');
    expect(result.reason).toBe('stream_error');
    expect(result.label).toBe(COMPLETED_BRIEFING_LABEL);

    // One claim from the model, two from the template.
    expect(result.templateClaims).toBe(2);
    expect(result.claimsAccepted).toBe(3);

    const claims = briefings.listClaims(result.briefingId);
    const texts = claims.map((claim) => claim.text);
    expect(texts).toContain('Alpha was decided');
    expect(texts).toContain('The staging rollout completed.');
    expect(texts).toContain('The expired-cert outage was closed out.');

    // The delta the model DID narrate (it cited A1) is not restated by the
    // template: one state change, one line.
    expect(texts).not.toContain('The team chose Postgres for the event store.');
    expect(claims.filter((claim) => claim.deltaId === d1.deltaId)).toHaveLength(1);

    // Ordinals stay unique and contiguous across the seam.
    expect(claims.map((claim) => claim.ordinal)).toEqual([0, 1, 2]);
    expect(briefings.getById(result.briefingId)?.partial).toBe(true);
  });

  it('writes exactly one layer-3 ai_calls row for the whole run', async () => {
    seedThreeDeltas();
    retrieval.chunks = [];

    await generateWithFallback(
      makeGenerator(DYING_TOKENS, { throwAtIndex: 1 }),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: healthy },
    );

    // The generator logged `stream_error`; the top-up must not log a second row
    // or the one-row-per-generation audit invariant is gone.
    expect(countAiCalls(3)).toBe(1);
    expect(
      (db.prepare(`SELECT outcome FROM ai_calls WHERE layer = 3`).get() as { outcome: string })
        .outcome,
    ).toBe('stream_error');
  });

  it('says in the narrative that the remainder came from local records', async () => {
    seedThreeDeltas();
    retrieval.chunks = [];

    const result = await generateWithFallback(
      makeGenerator(DYING_TOKENS, { throwAtIndex: 1 }),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: healthy },
    );

    const markdown = readFileSync(result.narrativePath, 'utf8');
    expect(markdown).toContain('completed from local records');
    expect(markdown).toContain('The staging rollout completed.');
    expect(markdown).toContain('Alpha was decided');
  });

  it('relabels the row as template mode when the model produced nothing readable', async () => {
    seedThreeDeltas();
    retrieval.chunks = [];

    // The stream dies before its first token, so no claim ever completes.
    const result = await generateWithFallback(
      makeGenerator(DYING_TOKENS, { throwAtIndex: 0 }),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: healthy },
    );

    expect(result.templateClaims).toBe(3);
    expect(result.claimsAccepted).toBe(3);
    expect(result.label).toBe(SIMPLIFIED_BRIEFING_LABEL);
    // Nothing the model wrote survived, so calling this an LLM briefing would
    // suppress the very banner the user needs.
    expect(result.mode).toBe('template');
    expect(briefings.getById(result.briefingId)?.mode).toBe('template');
  });

  it('leaves a budget-truncated briefing alone — that is not a fallback case (§7.8)', async () => {
    seedThreeDeltas();
    retrieval.chunks = [];

    // Four tokens at 10 fake-ms each against a 25ms budget: the boundary that
    // completes "Alpha" is seen at t=30ms, so the run is `budget_exceeded` — a
    // deliberate truncation, not a failure.
    const result = await generateWithFallback(
      makeGenerator(DYING_TOKENS, { generationMs: 25, msPerToken: 10 }),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: healthy },
    );

    expect(result.outcome).toBe('budget_exceeded');
    expect(result.partial).toBe(true);
    // Topping this up from the template would silently undo the latency budget.
    expect(result.step).toBe('ollama');
    expect(result.templateClaims).toBe(0);
    expect(result.mode).toBe('llm');
  });

  it('passes a healthy run straight through, untouched by the template', async () => {
    seedThreeDeltas();
    retrieval.chunks = [];

    const result = await generateWithFallback(
      makeGenerator([
        `${JSON.stringify({ section: 'What moved', claim: "Alpha was decided", artifact_ids: [A1] })}\n`,
        `${JSON.stringify({ section: 'What moved', claim: "Bravo was decided", artifact_ids: [A2] })}\n`,
      ]),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: healthy },
    );

    expect(result.step).toBe('ollama');
    expect(result.mode).toBe('llm');
    expect(result.partial).toBe(false);
    expect(result.templateClaims).toBe(0);
    expect(result.claimsAccepted).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 7. X-3 — no vendor step, ever
// ---------------------------------------------------------------------------

describe('X-3 — the fallback chain', () => {
  it('is exactly ollama then template, with no third step', () => {
    expect(FALLBACK_CHAIN).toEqual(['ollama', 'template']);
    expect(FALLBACK_CHAIN).toHaveLength(2);
    expect(FALLBACK_CHAIN[0]).toBe('ollama');
    expect(FALLBACK_CHAIN[1]).toBe('template');
    expect(FALLBACK_CHAIN[2]).toBeUndefined();
  });

  it('names no vendor or remote inference provider anywhere in the chain', () => {
    // Not a style check. X-3 forbids the OPTION existing: a remote step that is
    // merely unreachable today is one somebody makes reachable tomorrow, and the
    // user's threads leave the laptop without anyone deciding that they should.
    const forbidden = [
      'openai',
      'anthropic',
      'claude',
      'gpt',
      'gemini',
      'bedrock',
      'azure',
      'vertex',
      'cohere',
      'mistral-api',
      'together',
      'groq',
      'replicate',
      'huggingface',
      'remote',
      'cloud',
      'vendor',
      'api',
    ];
    for (const step of FALLBACK_CHAIN) {
      for (const needle of forbidden) {
        expect(step.toLowerCase()).not.toContain(needle);
      }
    }
  });

  it('exercises both steps and only those two across the chain', async () => {
    seedThreeDeltas();
    retrieval.chunks = [];

    const healthyRun = await generateWithFallback(
      makeGenerator([`${JSON.stringify({ section: 'What moved', claim: "Alpha was decided", artifact_ids: [A1] })}\n`]),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: healthy },
    );
    const downRun = await generateWithFallback(
      makeGenerator([]),
      makeRenderer(),
      BASE_URL,
      MODEL,
      EMBED_MODEL,
      WINDOW,
      { probe: unreachable },
    );

    // Every reachable value of `step` is a member of the chain, and both members
    // are reachable — so there is no hidden third branch and no dead one.
    expect(new Set([healthyRun.step, downRun.step])).toEqual(new Set(FALLBACK_CHAIN));
  });
});

// ---------------------------------------------------------------------------
// 8. Ordering, D-6 and the claim stream
// ---------------------------------------------------------------------------

describe('template ordering and D-6', () => {
  it('reuses the FR-5 ranker rather than inventing its own order', async () => {
    // Two "What moved" deltas; the older one carries the declared-project stakes
    // that the ranker weights above recency.
    const older = appendDelta({
      threadKey: 'C1:1',
      summary: 'Older but higher-stakes.',
      kind: 'progress',
      citations: [A1],
      createdAt: NOW - 10 * 3_600_000,
    });
    appendDelta({
      threadKey: 'C2:1',
      summary: 'Newer but nothing is riding on it.',
      kind: 'progress',
      citations: [A2],
      createdAt: NOW - 60_000,
    });

    const project = graph.declareProject({ name: 'Event store migration', origin: 'declared' });
    graph.relate({ fromId: A1, toId: project.projectId, rel: 'belongs_to', confidence: 1 });

    const result = await makeRenderer().renderTemplate(WINDOW);
    const claims = briefings.listClaims(result.briefingId);

    expect(claims.map((claim) => claim.text)).toEqual([
      'Older but higher-stakes.',
      'Newer but nothing is riding on it.',
    ]);
    expect(claims[0]?.deltaId).toBe(older.deltaId);
  });

  it('never narrates a superseded delta (D-6): only the tip of each chain speaks', async () => {
    appendDelta({
      threadKey: 'C1:1',
      summary: 'SUPERSEDED_ONLY_TEXT was believed.',
      kind: 'progress',
      citations: [A1],
    });
    appendDelta({
      threadKey: 'C1:1',
      summary: 'The staging rollout completed after all.',
      kind: 'progress',
      citations: [A1],
    });

    const result = await makeRenderer().renderTemplate(WINDOW);
    const markdown = readFileSync(result.narrativePath, 'utf8');

    expect(result.claimsAccepted).toBe(1);
    expect(markdown).not.toContain('SUPERSEDED_ONLY_TEXT');
    expect(markdown).toContain('The staging rollout completed after all.');
  });

  it('announces every template claim to a live subscriber, and survives a broken one', async () => {
    seedThreeDeltas();
    const seen: string[] = [];

    const result = await makeRenderer().renderTemplate(WINDOW, {
      onClaimAccepted: (chunk) => {
        seen.push(chunk.text);
        if (seen.length === 1) throw new Error('renderer subscription exploded');
      },
    });

    expect(seen).toHaveLength(3);
    // A throwing subscriber changed neither the stored set nor the counts.
    expect(result.claimsAccepted).toBe(3);
    expect(claimRows(result.briefingId)).toHaveLength(3);
  });

  it('discloses the OI-1 backlog measured at request time', async () => {
    seedThreeDeltas();
    watermarks.touch('C1:1', 'slack', NOW - 120_000);
    watermarks.touch('C2:1', 'slack', NOW - 90_000);

    const result = await makeRenderer().renderTemplate(WINDOW);

    expect(result.threadsStillProcessing).toBe(2);
    expect(briefings.getById(result.briefingId)?.threadsStillProcessing).toBe(2);
    expect(readFileSync(result.narrativePath, 'utf8')).toContain('2 thread(s) still had');
  });
});
