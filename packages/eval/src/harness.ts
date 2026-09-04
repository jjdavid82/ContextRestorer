/**
 * The eval harness (Task 5.1) — drives the REAL pipeline over the labeled
 * fixture set and grades the result.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE, AND WHAT IS NOT
 *
 * Real, with no doubles of any kind:
 *
 *   - `IngestionPipeline`     — normalize → redact (SEC-4) → persist → graph → D-7
 *   - `Layer1Extractor`       — real Ollama chat call per event
 *   - `Layer2Synthesizer`     — real Ollama chat call per thread, real retrieval
 *   - `RetrievalService`      — real LanceDB, real `nomic-embed-text` embeddings
 *   - `generateWithFallback`  — real preflight, real streamed Layer 3, real
 *                               `CitationGate`, real deterministic fallback
 *   - SQLite                  — a real database with the real migrations, so the
 *                               AC-2 foreign keys actually bite
 *
 * This is the ONE suite in the build that talks to a live model. It is meant to
 * be run deliberately (`npm run eval`), not on every change, and it takes
 * minutes rather than seconds.
 *
 * Two deliberate departures from production, both because the eval needs
 * determinism rather than realism:
 *
 * 1. **`DebounceScheduler` is skipped.** `synthesize()` is called directly, once
 *    per thread. The scheduler's job is to decide *when* a quiet thread is ready
 *    (a 5-minute quiet window, a 30-minute hard cap, D-7); waiting those out in
 *    wall-clock time would make one run take hours and would be testing the
 *    scheduler, which has its own unit tests (`packages/ai/test/scheduler.test.ts`).
 *    What this harness grades is the *synthesis*, and calling it directly is the
 *    same call the scheduler makes — `onSynthesize` is literally
 *    `(threadKey, traceId) => synth.synthesize(threadKey, traceId)`.
 *
 * 2. **The clock is pinned inside the fixture's window.** `FakeClock` is set to
 *    `windowEnd - 1ms`. This is not cosmetic: `DeltasRepo.currentForWindow()`
 *    filters on `created_at`, so deltas stamped with the wall clock (2026-08-27)
 *    would fall outside a fixture's window (2026-03-09 … 2026-03-13) and Layer 3
 *    would see an empty briefing for every fixture. Pinning the clock also keeps
 *    retrieval's recency decay meaningful, since a months-old fixture event
 *    scores `0.5 ^ 21 ≈ 3e-7` against a live clock.
 *
 *    Consequence, stated so it is not mistaken for a result: the §7.8 generation
 *    budget can never elapse under a frozen clock, and every latency the store
 *    records for an eval briefing is 0. **This harness measures quality, not
 *    latency.** AC-1 belongs to Task 5.3's benchmark.
 * ---------------------------------------------------------------------------
 *
 * ### Citation granularity — read before trusting the AC-6 number
 *
 * Fixture citations are per MESSAGE (`slack:C0PLATFORM:1773040800.000200`). The
 * pipeline's citations are per THREAD: `Layer1Extractor.eventArtifactId()`
 * computes `artifactId(source, 'thread', threadKey)` for every event, so all of
 * a conversation's chunks share one artifact id and the retrieval allowlist — and
 * therefore every citation the system can possibly emit — names a conversation,
 * not a message.
 *
 * So the harness resolves a predicted citation against the SET of fixture
 * artifact ids that the cited thread covers ({@link buildCoverage}). That is
 * strict at the granularity the system under test actually supports, and it
 * still catches the failure `pm-wrong-citation-01.json` was built for (its
 * distractor is a different thread). It does NOT catch a citation that names the
 * right thread but the wrong message inside it. The report states the
 * granularity next to the number rather than letting a thread-level match be
 * read as a message-level one.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClock,
  artifactId as artifactIdFor,
  newId,
  type AppConfig,
  type Person,
  type SourceId,
} from '@cr/core';
import { IngestionPipeline, type RawSourceEvent } from '@cr/ingest';
import {
  AiCallsRepo,
  BriefingsRepo,
  DeltasRepo,
  EventsRepo,
  ExtractionsRepo,
  GraphRepo,
  PendingItemsRepo,
  WatermarkRepo,
  migrate,
  openDb,
  openVectors,
  type VectorStore,
} from '@cr/store';
import {
  BriefingGenerator,
  CitationGate,
  Layer1Extractor,
  Layer2Synthesizer,
  RetrievalService,
  TemplateBriefingRenderer,
  createOllamaClient,
  generateWithFallback,
  type OllamaClient,
} from '@cr/ai';
import {
  DESCRIPTION_MATCH_THRESHOLD,
  citationAccuracyDetail,
  contentTokens,
  containment,
  hallucinationRateDetail,
  isSurfaced,
  isWrongCitation,
  matchPendingItems,
  precisionDetail,
  recallDetail,
  top3RelevanceDetail,
  type CitationEquivalence,
  type EvalCase,
  type GroundTruthPendingItem,
  type MatchedItem,
  type PredictedClaim,
  type PredictedPendingItem,
} from './metrics.js';
import { buildReport, type EvalReport, type PerFixtureResult } from './report.js';
import { validateFixture, type EvalFixture } from './types.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Fraction of a claim's content tokens that must appear in the cited artifact's
 * own source text for the citation to count as supporting the claim.
 *
 * **0.60.** This is the harness's automated stand-in for a human reading the
 * message and the sentence side by side, and it is the weakest link in the AC-5
 * and AC-6 numbers — which is why the report says so. The rule is:
 *
 *   1. A claim that ASSERTS a `ground_truth.unsupported_claims` label (see
 *      {@link LABELED_NEGATIVE_CONTAINMENT_THRESHOLD}) is **unsupported, full
 *      stop** — every citation on it is wrong. These are hand-labeled negatives
 *      (`"The Atlas launch slipped to May 4."`) chosen precisely because they
 *      are *lexically* grounded in the source text and would fool step 2. The
 *      label overrides the heuristic.
 *   2. Otherwise a citation supports the claim when at least 60% of the claim's
 *      content tokens occur in the text of the events behind the cited artifact.
 *
 * 60% leaves room for the connective words and the paraphrase a summarizer
 * legitimately introduces, while a claim built mostly from words that are not in
 * the cited thread at all cannot clear it.
 */
export const GROUNDING_CONTAINMENT_THRESHOLD = 0.6;

/**
 * Fraction of a hand-labeled negative's content tokens that must appear in a
 * claim before the claim counts as ASSERTING that negative.
 *
 * **0.80, and measured by CONTAINMENT of the label in the claim — not by the
 * symmetric similarity used for pending-item descriptions.** The two questions
 * are genuinely different and using one measure for both is a bug:
 *
 *  - "Are these two descriptions the same obligation?" is symmetric. Either side
 *    may be the longer one. Dice is right.
 *  - "Does this claim assert that falsehood?" is not. The falsehood must be
 *    *present in* the claim, and every word of it matters.
 *
 * The fixtures make this concrete, and it is why they were written the way they
 * were: `pm-vacation-01`'s labeled negative is `"The Atlas launch slipped to
 * May 4."` and its own notes say every negative is "a plausible compression of
 * what was actually said". A perfectly correct claim — "Ben raised May 4 as an
 * option for the Atlas launch but did not decide" — shares `atlas`, `launch` and
 * `may` with that label, scoring Dice 0.545 and sailing past the 0.30
 * description threshold. Symmetric matching would therefore have scored a
 * CORRECT claim as a fabrication and inflated the AC-5 release-gate number.
 *
 * Containment gets it right for exactly the reason the fixture is interesting:
 * the whole falsehood lives in the word `slipped`, the correct claim does not
 * contain it, and 3-of-4 = 0.75 falls below the bar. The actual falsehood scores
 * 4-of-4 = 1.00.
 */
export const LABELED_NEGATIVE_CONTAINMENT_THRESHOLD = 0.8;

/** Artifact `kind` the ingestion pipeline files conversation artifacts under. */
const THREAD_ARTIFACT_KIND = 'thread';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Progress notification, so a CLI can say something during a multi-minute run. */
export interface EvalProgress {
  /** 1-based position in the run. */
  index: number;
  total: number;
  fixtureId: string;
  phase: 'start' | 'done';
  /** Present on `'done'`. */
  result?: PerFixtureResult;
}

export interface EvalRunOptions {
  /** Directory of `*.json` fixtures. Every file in it must validate. */
  fixturesDir: string;
  config: AppConfig;
  /** Overrides `config.model.ollamaBaseUrl`. Must be loopback (SEC-6). */
  ollamaBaseUrl?: string;
  /**
   * Restrict the run to these fixture ids, in `fixturesDir` order.
   *
   * Exists because a full pass is *hours* of live local inference — measured at
   * ~25 minutes per fixture for `qwen2.5:14b` on a 16 GB machine — which makes
   * iterating on the harness itself impractical without it. An unknown id
   * THROWS rather than being ignored: a typo that silently narrowed the run to
   * four fixtures would report a smaller `n` than the operator believed they
   * asked for, which is the RO-2 failure in its most deniable form.
   *
   * The resulting report records both `n` and `available` and prints a SUBSET
   * banner, so a partial run can never be read as a full one.
   */
  fixtureIds?: readonly string[];
  /** Optional progress hook. */
  onProgress?: (progress: EvalProgress) => void;
}

/**
 * Load, run and grade every fixture in `options.fixturesDir`.
 *
 * Never rejects on a per-fixture failure: a fixture whose pipeline run throws is
 * recorded with its `error` and contributes nothing to the metric denominators,
 * so one broken example cannot hide the other sixty-nine. It DOES reject when a
 * fixture fails schema validation, because an unlabeled fixture cannot be scored
 * and silently skipping it would overstate the set's coverage.
 *
 * @returns one {@link EvalReport}. `n` is the number of fixtures loaded.
 */
export async function runEval(options: EvalRunOptions): Promise<EvalReport> {
  const available = loadFixtures(options.fixturesDir);
  const fixtures = selectFixtures(available, options.fixtureIds);
  const baseUrl = options.ollamaBaseUrl ?? options.config.model.ollamaBaseUrl;

  const perFixture: PerFixtureResult[] = [];
  const allMatches: MatchedItem[] = [];
  const allPredictions: PredictedPendingItem[] = [];
  const allClaims: PredictedClaim[] = [];
  const allCases: EvalCase[] = [];

  for (const [index, fixture] of fixtures.entries()) {
    options.onProgress?.({
      index: index + 1,
      total: fixtures.length,
      fixtureId: fixture.id,
      phase: 'start',
    });

    const outcome = await scoreFixture(fixture, options.config, baseUrl);

    // Pooled counts, not averaged per-fixture ratios. Averaging ratios would let
    // a fixture with one labeled item weigh as much as one with twelve, and would
    // hand a free 1.0 to every `expect_no_pending` fixture (empty denominator).
    allMatches.push(...outcome.matches);
    allPredictions.push(...outcome.predictions);
    allClaims.push(...outcome.claims);
    if (outcome.evalCase !== undefined) allCases.push(outcome.evalCase);
    perFixture.push(outcome.result);

    options.onProgress?.({
      index: index + 1,
      total: fixtures.length,
      fixtureId: fixture.id,
      phase: 'done',
      result: outcome.result,
    });
  }

  const recall = recallDetail(allMatches);
  const precision = precisionDetail(allPredictions, allMatches);
  const hallucination = hallucinationRateDetail(allClaims);
  const citations = citationAccuracyDetail(allClaims);
  const top3 = top3RelevanceDetail(allCases);

  const failed = perFixture.filter((entry) => entry.error !== undefined).map((entry) => entry.id);

  return buildReport({
    // RO-2: `n` is the number of LABELED EXAMPLES, which is what Task 5.2's
    // "~70 examples" counts and what the acceptance table means by "state n".
    // The per-item / per-claim / per-citation denominators are reported
    // separately in `counts` — see `report.ts`.
    n: fixtures.length,
    // Disclosed only when the run was narrowed, so a full pass renders cleanly
    // and a partial one can never be mistaken for the set (RO-2).
    ...(fixtures.length === available.length
      ? {}
      : {
          available: available.length,
          selectedFixtureIds: fixtures.map((fixture) => fixture.id),
        }),
    recall: recall.value,
    precision: precision.value,
    hallucinationRate: hallucination.value,
    citationAccuracy: citations.value,
    top3Relevance: top3.value,
    counts: {
      recall,
      precision,
      hallucinationRate: hallucination,
      citationAccuracy: citations,
      top3Relevance: top3,
      top3Skipped: top3.skipped,
    },
    environment: {
      chatModel: options.config.model.chat,
      embedModel: options.config.model.embed,
      promptVersions: [
        `layer1=${options.config.promptVersions.layer1}`,
        `layer2=${options.config.promptVersions.layer2}`,
        `layer3=${options.config.promptVersions.layer3}`,
      ].join(', '),
      descriptionMatchThreshold: DESCRIPTION_MATCH_THRESHOLD,
      citationGranularity: 'thread',
    },
    ...(failed.length > 0 ? { failedFixtures: failed } : {}),
    notes: [
      '**Citations are compared at THREAD granularity, not message granularity.** ' +
        'Layer 1 files every chunk under the conversation-level artifact ' +
        '`artifactId(source, "thread", threadKey)`, so the retrieval allowlist — and ' +
        'therefore every citation the system can emit — names a conversation. A ' +
        'predicted citation is credited when the cited thread contains the labeled ' +
        'message. This catches a citation pointing at the wrong thread (the ' +
        '`pm-wrong-citation-01` trap) but not one pointing at the wrong message ' +
        'within the right thread. The AC-6 number should be read as an upper bound.',
      '**Claim support is decided by hand-labeled negatives plus a lexical ' +
        'grounding check, not by a human reading each claim.** A claim is ' +
        'unsupported unconditionally when it ASSERTS a ' +
        '`ground_truth.unsupported_claims` entry (≥ ' +
        `${Math.round(LABELED_NEGATIVE_CONTAINMENT_THRESHOLD * 100)}% of the label's ` +
        "content tokens present in the claim); otherwise a citation supports a claim " +
        `when ≥ ${Math.round(GROUNDING_CONTAINMENT_THRESHOLD * 100)}% of the claim's ` +
        "content tokens appear in the cited artifact's source text. This is an " +
        'approximation. AC-5 is a release gate, so before shipping on this number, ' +
        'spot-check the claims it scored as supported.',
      '**Latency is not measured here.** The clock is frozen inside each ' +
        "fixture's window (see `harness.ts`), so the §7.8 generation budget cannot " +
        'elapse and every latency the STORE records for an eval briefing is 0. The ' +
        '`ms` column in the table above is the harness\'s own wall clock for the ' +
        'whole fixture — ingest, every Layer 1 call, every Layer 2 call and the ' +
        'streamed briefing — and is useful only as a rough cost signal. AC-1 is ' +
        "Task 5.3's benchmark.",
    ],
    perFixture,
    generatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

/**
 * Read and validate every `*.json` file in `dir`, sorted by filename.
 *
 * Sorted so a run is reproducible and two reports are diffable. A fixture that
 * fails {@link validateFixture} throws rather than being skipped: `test/
 * fixtures.test.ts` already guarantees the committed set validates, so a failure
 * here means somebody added a fixture without running the tests, and scoring the
 * rest as though the set were complete would misreport `n`.
 */
export function loadFixtures(dir: string): EvalFixture[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));

  return files.map((file) => {
    const path = join(dir, file);
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const { valid, errors } = validateFixture(parsed);
    if (!valid) {
      throw new Error(`eval: fixture '${file}' is invalid:\n  - ${errors.join('\n  - ')}`);
    }
    return parsed as EvalFixture;
  });
}

/**
 * Narrow `fixtures` to `ids`, preserving directory order.
 *
 * @throws Error when an id names no fixture. See
 *   {@link EvalRunOptions.fixtureIds} for why this is loud rather than lenient.
 */
export function selectFixtures(
  fixtures: readonly EvalFixture[],
  ids: readonly string[] | undefined,
): EvalFixture[] {
  if (ids === undefined || ids.length === 0) return [...fixtures];

  const wanted = new Set(ids);
  const known = new Set(fixtures.map((fixture) => fixture.id));
  const unknown = [...wanted].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `eval: no such fixture id(s): ${unknown.join(', ')}. ` +
        `Available: ${[...known].sort((a, b) => a.localeCompare(b)).join(', ')}`,
    );
  }
  return fixtures.filter((fixture) => wanted.has(fixture.id));
}

// ---------------------------------------------------------------------------
// Citation resolution
// ---------------------------------------------------------------------------

/**
 * `pipeline artifact id → the fixture artifact ids that thread covers`.
 *
 * The bridge between the fixture's message-granular citations and the pipeline's
 * thread-granular ones. See the module comment for why this exists rather than a
 * plain string comparison.
 */
export function buildCoverage(fixture: EvalFixture): Map<string, Set<string>> {
  const coverage = new Map<string, Set<string>>();
  for (const event of fixture.events) {
    const pipelineId = artifactIdFor(event.source as SourceId, THREAD_ARTIFACT_KIND, event.thread_key);
    const covered = coverage.get(pipelineId);
    if (covered === undefined) coverage.set(pipelineId, new Set([event.artifact_id]));
    else covered.add(event.artifact_id);
  }
  return coverage;
}

/**
 * Citation rule for one fixture: strict equality, OR the predicted (thread)
 * artifact demonstrably contains the labeled (message) artifact.
 *
 * `null` never matches — an uncited obligation is never a hit.
 */
export function citationResolver(coverage: ReadonlyMap<string, Set<string>>): CitationEquivalence {
  return (predicted, groundTruth) => {
    if (predicted === null) return false;
    if (predicted === groundTruth) return true;
    return coverage.get(predicted)?.has(groundTruth) === true;
  };
}

// ---------------------------------------------------------------------------
// Claim scoring
// ---------------------------------------------------------------------------

/** Everything needed to grade one fixture's claims. */
interface ClaimScoringContext {
  /** `pipeline artifact id → content tokens of the events behind it`. */
  tokensByArtifact: ReadonlyMap<string, Set<string>>;
  /** `ground_truth.unsupported_claims`. Hand-labeled negatives. */
  unsupported: readonly string[];
}

/**
 * Grade one generated claim.
 *
 * See {@link GROUNDING_CONTAINMENT_THRESHOLD} for the two-step rule and its
 * limitations.
 */
export function classifyClaim(
  text: string,
  citedArtifactIds: readonly string[],
  context: ClaimScoringContext,
): { claim: PredictedClaim; labeledUnsupported: boolean } {
  const claimTokens = contentTokens(text);
  // Containment of the LABEL in the CLAIM, not symmetric similarity — see
  // `LABELED_NEGATIVE_CONTAINMENT_THRESHOLD` for why the distinction decides
  // whether a correct claim gets scored as a fabrication.
  const labeledUnsupported = context.unsupported.some(
    (label) =>
      containment(contentTokens(label), claimTokens) >= LABELED_NEGATIVE_CONTAINMENT_THRESHOLD,
  );

  const citations = citedArtifactIds.map((artifactId) => {
    if (labeledUnsupported) return { artifactId, supportsClaim: false };
    const sourceTokens = context.tokensByArtifact.get(artifactId);
    const grounded =
      sourceTokens !== undefined &&
      containment(claimTokens, sourceTokens) >= GROUNDING_CONTAINMENT_THRESHOLD;
    return { artifactId, supportsClaim: grounded };
  });

  return { claim: { text, citations }, labeledUnsupported };
}

// ---------------------------------------------------------------------------
// Running one fixture
// ---------------------------------------------------------------------------

/** What one fixture contributed to the pooled metrics. */
interface FixtureOutcome {
  result: PerFixtureResult;
  matches: MatchedItem[];
  predictions: PredictedPendingItem[];
  claims: PredictedClaim[];
  /** Absent when the fixture failed to run. */
  evalCase?: EvalCase;
}

/** ISO 8601 → epoch ms. Throws on an unparseable timestamp. */
function epochMs(iso: string, what: string): number {
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) {
    throw new Error(`eval: ${what} is not a parseable ISO 8601 instant: '${iso}'`);
  }
  return value;
}

/** Stable synthetic person id for a fixture actor. */
function personIdFor(actor: string): string {
  return `eval:${actor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/**
 * Seed, run and grade one fixture.
 *
 * Every fixture gets a FRESH in-memory SQLite database and a FRESH temporary
 * LanceDB directory. Not shared, on purpose: retrieval is a nearest-neighbour
 * search over whatever is in the store, so one fixture's chunks leaking into
 * another's context window would let a passing score come from the wrong
 * conversation entirely.
 */
async function scoreFixture(
  fixture: EvalFixture,
  config: AppConfig,
  baseUrl: string,
): Promise<FixtureOutcome> {
  const startedAt = Date.now();
  const groundTruth: GroundTruthPendingItem[] = (fixture.ground_truth.pending_items ?? []).map(
    (item) => ({ description: item.description, citation: item.citation }),
  );
  const coverage = buildCoverage(fixture);
  const citationMatches = citationResolver(coverage);

  const failed = (error: unknown): FixtureOutcome => ({
    result: {
      id: fixture.id,
      failureModeTags: [...fixture.failure_mode_tags],
      groundTruthItems: groundTruth.length,
      surfacedItems: 0,
      matchedItems: 0,
      wrongCitationItems: 0,
      claims: 0,
      hallucinatedClaims: 0,
      labeledUnsupportedClaims: 0,
      citations: 0,
      supportedCitations: 0,
      top3Relevant: null,
      briefingStep: '—',
      briefingOutcome: 'harness_error',
      claimsDropped: 0,
      groundingFailures: 0,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    },
    matches: [],
    predictions: [],
    claims: [],
  });

  const tmp = mkdtempSync(join(tmpdir(), `cr-eval-${fixture.id}-`));
  let db: ReturnType<typeof openDb> | undefined;
  let vectors: VectorStore | undefined;

  try {
    const windowStart = epochMs(fixture.window.start, `${fixture.id}: window.start`);
    const windowEnd = epochMs(fixture.window.end, `${fixture.id}: window.end`);
    // See the module comment: a delta stamped with the wall clock falls outside
    // the fixture's window and `currentForWindow` would never return it.
    const clock = new FakeClock(windowEnd - 1);

    db = openDb(':memory:');
    migrate(db);

    const events = new EventsRepo(db);
    const extractions = new ExtractionsRepo(db);
    const graph = new GraphRepo(db, clock);
    const watermarks = new WatermarkRepo(db);
    const deltas = new DeltasRepo(db);
    const pending = new PendingItemsRepo(db);
    const briefings = new BriefingsRepo(db);
    const aiCalls = new AiCallsRepo(db);
    const gate = new CitationGate(graph);

    vectors = await openVectors(join(tmp, 'vectors'));

    const ollama: OllamaClient = createOllamaClient(baseUrl, config.model.chat, config.model.embed);
    const embed = async (text: string): Promise<number[]> => {
      const [vector] = await ollama.embed([text]);
      if (vector === undefined || vector.length === 0) {
        throw new Error(`eval: embedding model returned no vector for a ${text.length}-char input`);
      }
      return vector;
    };

    const retrieval = new RetrievalService(vectors, graph, config, embed, { clock });
    const traceId = `eval-${fixture.id}-${newId().slice(0, 8)}`;

    // ---- seed: people ----------------------------------------------------
    // The production pipeline resolves identity elsewhere; the harness does it
    // here so `actor_is_self` in a fixture means something to the FR-5 ranker.
    // Participant EDGES are deliberately not written — `IngestionPipeline` does
    // not write them either, and inventing them would give retrieval a
    // neighbour-join the real system does not have.
    const seenActors = new Set<string>();
    for (const event of fixture.events) {
      const personId = personIdFor(event.actor);
      if (seenActors.has(personId)) continue;
      seenActors.add(personId);
      const person: Person = {
        personId,
        displayName: event.actor,
        emailHash: null,
        isSelf: event.actor_is_self === true,
      };
      graph.upsertPerson(person);
    }

    // ---- seed: events, through the REAL ingestion pipeline ----------------
    const pipeline = new IngestionPipeline(
      events,
      graph,
      watermarks,
      () => {
        // The durable extraction queue belongs to the desktop app. Layer 1 is
        // driven below from `EventsRepo.listUnextracted()`, which is the system's
        // own definition of outstanding work — so nothing is lost by discarding
        // the hand-off, and the harness exercises the recovery-sweep work-list
        // rather than a list it invented.
      },
      clock,
    );

    const raws: RawSourceEvent[] = fixture.events.map((event) => ({
      source: event.source,
      sourceEventId: event.event_id,
      threadKey: event.thread_key,
      actorId: personIdFor(event.actor),
      occurredAt: epochMs(event.occurred_at, `${fixture.id}/${event.event_id}: occurred_at`),
      text: event.text,
    }));
    await pipeline.ingestBatch(raws);

    // ---- Layer 1: real extraction, one model call per event ---------------
    // `listUnextracted()` IS the system's definition of "needs extraction", so
    // driving the loop from it exercises the same work-list the recovery sweep
    // uses rather than a list the harness made up.
    const extractor = new Layer1Extractor(
      ollama,
      extractions,
      vectors,
      aiCalls,
      embed,
      config.model.chat,
      config.promptVersions.layer1,
      clock,
    );
    for (const event of events.listUnextracted()) {
      await extractor.extractEvent(event, traceId);
    }

    // ---- Layer 2: real synthesis, one model call per thread ---------------
    const synthesizer = new Layer2Synthesizer(
      ollama,
      retrieval,
      deltas,
      pending,
      watermarks,
      aiCalls,
      config.model.chat,
      config.promptVersions.layer2,
      clock,
    );
    const threadKeys = [...new Set(fixture.events.map((event) => event.thread_key))];
    for (const threadKey of threadKeys) {
      await synthesizer.synthesize(threadKey, traceId);
      // The scheduler closes the cycle in production (see `scheduler.ts`); doing
      // it here keeps the OI-1 "still processing" disclosure honest, so a
      // briefing does not claim a backlog that the harness already drained.
      watermarks.markSynthesized(threadKey, clock.now(), null);
    }

    // ---- Layer 3: the real fallback chain ---------------------------------
    const generator = new BriefingGenerator(
      ollama,
      retrieval,
      deltas,
      briefings,
      gate,
      watermarks,
      graph,
      pending,
      aiCalls,
      config,
      tmp,
      config.model.chat,
      config.promptVersions.layer3,
      clock,
      { logsDir: join(tmp, 'logs') },
    );
    const templateRenderer = new TemplateBriefingRenderer(
      deltas,
      pending,
      briefings,
      graph,
      watermarks,
      aiCalls,
      config,
      tmp,
      clock,
      { logsDir: join(tmp, 'logs') },
    );

    const briefing = await generateWithFallback(
      generator,
      templateRenderer,
      baseUrl,
      config.model.chat,
      config.model.embed,
      { windowStart, windowEnd },
      { briefingId: `eval-${fixture.id}` },
    );

    // ---- grade -----------------------------------------------------------
    const predictions: PredictedPendingItem[] = pending
      .listOpen()
      .map((item) => ({ description: item.description, citation: item.citationArtifactId }));

    const matches = matchPendingItems(groundTruth, predictions, { citationMatches });

    const tokensByArtifact = new Map<string, Set<string>>();
    for (const threadKey of threadKeys) {
      const source = fixture.events.find((event) => event.thread_key === threadKey)?.source;
      if (source === undefined) continue;
      const pipelineId = artifactIdFor(source, THREAD_ARTIFACT_KIND, threadKey);
      // The STORED text, not the fixture's — SEC-4 redaction runs before
      // persistence, and grounding a claim against text the model never saw
      // would grade it against the wrong evidence.
      const text = events
        .listByThread(threadKey)
        .map((event) => (typeof event.payload['text'] === 'string' ? event.payload['text'] : ''))
        .join('\n');
      tokensByArtifact.set(pipelineId, contentTokens(text));
    }

    const scoringContext: ClaimScoringContext = {
      tokensByArtifact,
      unsupported: fixture.ground_truth.unsupported_claims ?? [],
    };

    const storedClaims = briefings.listClaims(briefing.briefingId);
    const claims: PredictedClaim[] = [];
    let labeledUnsupportedClaims = 0;
    for (const stored of storedClaims) {
      const cited = stored.citationArtifactId === null ? [] : [stored.citationArtifactId];
      const graded = classifyClaim(stored.text, cited, scoringContext);
      claims.push(graded.claim);
      if (graded.labeledUnsupported) labeledUnsupportedClaims += 1;
    }

    // AC-7 ranks what the user SEES, in the order they see it: claims are stored
    // in narrative order (section order, then arrival), so `ordinal` is the rank.
    const rankedItems: PredictedPendingItem[] = [...storedClaims]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((claim) => ({ description: claim.text, citation: claim.citationArtifactId }));

    const evalCase: EvalCase = {
      id: fixture.id,
      rankedItems,
      groundTruth,
      citationMatches,
    };
    const top3 = top3RelevanceDetail([evalCase]);

    const citationCounts = citationAccuracyDetail(claims);
    const result: PerFixtureResult = {
      id: fixture.id,
      failureModeTags: [...fixture.failure_mode_tags],
      groundTruthItems: groundTruth.length,
      surfacedItems: predictions.length,
      matchedItems: matches.filter(isSurfaced).length,
      wrongCitationItems: matches.filter(isWrongCitation).length,
      claims: claims.length,
      hallucinatedClaims: hallucinationRateDetail(claims).numerator,
      labeledUnsupportedClaims,
      citations: citationCounts.denominator,
      supportedCitations: citationCounts.numerator,
      top3Relevant: top3.denominator === 0 ? null : top3.numerator === 1,
      briefingStep: briefing.step,
      briefingOutcome: briefing.outcome,
      claimsDropped: briefing.claimsDropped,
      groundingFailures: briefing.groundingFailures,
      // `{}` renders as absent rather than as an empty string, so the report's
      // by-reason table only appears when there is something in it.
      ...(Object.keys(briefing.claimsDroppedByReason).length === 0
        ? {}
        : {
            claimsDroppedByReason: Object.entries(briefing.claimsDroppedByReason)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([reason, count]) => `${reason}=${count}`)
              .join(', '),
          }),
      durationMs: Date.now() - startedAt,
    };

    return { result, matches, predictions, claims, evalCase };
  } catch (error) {
    return failed(error);
  } finally {
    // Ordered: LanceDB holds file handles inside `tmp`, so it closes before the
    // directory is removed. On Windows an open handle makes `rmSync` throw.
    if (vectors !== undefined) await vectors.close().catch(() => undefined);
    db?.close();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
