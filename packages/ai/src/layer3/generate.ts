/**
 * Layer 3 — the briefing generator (design §7.8, §8.2; FR-5, AC-2, OI-1, T-1).
 *
 * This is the last step in the pipeline and the only one whose output a human
 * actually reads, so every guarantee the earlier layers established has to
 * survive it. Five of its properties are load-bearing:
 *
 * 1. **Nothing uncited reaches the page.** The model streams markdown bullets;
 *    {@link ClaimBuffer} reassembles them into whole claims, and every whole
 *    claim goes through {@link CitationGate}. A dropped claim is *omitted* — not
 *    hedged, not asterisked. `briefing_claims.citation_artifact_id` is a NOT
 *    NULL foreign key, so an uncited claim is not merely rejected here, it is
 *    unstorable; the gate's job is to make sure we never try.
 *
 * 2. **Superseded deltas do not speak (D-6).** Only `currentForWindow()` — the
 *    tip of every chain, via the `current_state_deltas` view — feeds the prompt.
 *    The one exception is narrow and deliberate: when a tip delta is a
 *    `reversal`, the summary of the version it superseded is included, labelled
 *    as prior state, so the briefing can say "we chose X, then reversed to Y"
 *    instead of presenting Y as though nothing preceded it. That is the entire
 *    reason D-6 keeps history rather than overwriting. No other superseded
 *    delta's content is rendered.
 *
 * 3. **All artifact text is untrusted (T-1).** Retrieved chunks and delta
 *    summaries alike are rendered into one payload that goes through
 *    `wrapUntrusted` + `assemblePrompt`. Those are the only route into the
 *    prompt, and the branded `WrappedContent` type makes that structural: a raw
 *    string cannot reach the untrusted slot.
 *
 * 4. **Running long truncates, it does not fabricate (§7.8).** When
 *    `budgets.generationMs` elapses mid-stream the generation is aborted, every
 *    claim already accepted is kept, and the briefing is marked `partial`. The
 *    user gets a short, true briefing rather than a complete, late one — and is
 *    told which they got.
 *
 * 5. **The honesty disclosures are measured, not estimated.**
 *    `threads_still_processing` is read from the watermark table at *request*
 *    time (OI-1), before any generation work starts, so it describes the backlog
 *    the briefing was actually built against.
 *
 * Exactly one `ai_calls` row (layer 3) is written per `generate()` call, on
 * every path — including the paths where no model call happened at all.
 *
 * ### Not in scope here
 *
 * The deterministic template fallback (`mode: 'template'`) lives in
 * `./template.ts` (Task 4.3) and is orchestrated *around* this module, never
 * inside it. This module always produces `mode: 'llm'`; a truncated run is
 * reported by the separate `partial` flag rather than by pretending a template
 * ran. See migration `003_briefing_partial.sql` for why those are two columns.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  newId,
  systemClock,
  type AppConfig,
  type BriefingMode,
  type Clock,
  type PendingItem,
  type StateDelta,
} from '@cr/core';
import { startTrace, type StageTimings } from '@cr/observability';
import type {
  AiCallsRepo,
  BriefingsRepo,
  DeltasRepo,
  GraphRepo,
  PendingItemsRepo,
  WatermarkRepo,
} from '@cr/store';
import type { OllamaClient } from '../ollama.js';
import type { RetrievalService, RetrievedChunk } from '../retrieval.js';
import { assemblePrompt } from '../prompt/assemble.js';
import { wrapUntrusted } from '../prompt/wrap.js';
import { rankDeltas, toRankableDelta, type RankableDeltaContext } from '../ranker.js';
import type { CitationGate, DropReason, GroundingOptions } from './citationGate.js';
import { ClaimBuffer } from './citationGate.js';

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The four sections, in the order the briefing must present them.
 *
 * This array is the single source of that ordering: it drives the system
 * prompt, the `ordinal` assigned to persisted claims, and the rendered
 * markdown, so the three cannot drift apart. It mirrors
 * `config/prompts/layer3-brief.v1.md`.
 */
export const BRIEFING_SECTIONS = [
  'Waiting on you',
  'What moved',
  'Quietly resolved',
  'Worth knowing',
] as const;

export type BriefingSection = (typeof BRIEFING_SECTIONS)[number];

/** `section name → position`, for sorting claims into narrative order. */
const SECTION_ORDER = new Map<string, number>(
  BRIEFING_SECTIONS.map((section, index) => [section, index]),
);

/** Lowercased heading text → canonical section name. */
const SECTION_BY_LABEL = new Map<string, BriefingSection>(
  BRIEFING_SECTIONS.map((section) => [section.toLowerCase(), section]),
);

/**
 * Section used for claims the model emitted before (or outside of) any
 * recognised heading.
 *
 * "Worth knowing" is the only safe default: it is the section that asserts
 * nothing about obligation or urgency. Mis-filing a claim as background is a
 * cosmetic error; mis-filing it as something waiting on the user is not.
 */
const DEFAULT_SECTION: BriefingSection = 'Worth knowing';

/** An ATX markdown heading. The space after the hashes is required, so `#tag` is prose. */
const HEADING_RE = /^\s{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** Canonical section for a heading's text, or `undefined` when unrecognised. */
function canonicalSection(label: string): BriefingSection | undefined {
  return SECTION_BY_LABEL.get(label.trim().replace(/[.:;,\s]+$/, '').toLowerCase());
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * System prompt for `layer3-brief.v1`.
 *
 * `config/prompts/layer3-brief.v1.md` is the human-readable source of truth and
 * the thing `promptVersion` names; this constant is its executable form. The
 * template's `{{NONCE}}`/`{{CONTENT}}` placeholders and its untrusted-content
 * clause are deliberately absent: `wrapUntrusted` mints the nonce and
 * `assemblePrompt` appends `UNTRUSTED_SYSTEM_RULE` unconditionally, so restating
 * them here would let the rule and the delimiters drift apart.
 */
const SYSTEM_PROMPT = [
  'You write a briefing that tells one person what happened while they were away.',
  '',
  'Emit exactly these four sections, in this order, as level-2 markdown headings:',
  '',
  ...BRIEFING_SECTIONS.map((section) => `## ${section}`),
  '',
  'Section contents:',
  '- Waiting on you   — outstanding obligations that are on this person right now.',
  '- What moved       — decisions made and work that visibly advanced.',
  '- Quietly resolved — questions, blockers, or obligations that closed without their input.',
  '- Worth knowing    — context they would want but that requires nothing from them.',
  '',
  'Rules:',
  '- One bullet per claim. One claim per bullet. Never combine two claims into one bullet.',
  '- Every bullet ends with one or more citation markers of the form [artifact:<id>].',
  '  The markers are the last thing on the line.',
  '- Use only artifact ids that appear in the provided content. Do not invent ids.',
  '- Omit any claim you cannot cite. A missing claim is acceptable; an uncited claim is not.',
  '- Past tense throughout.',
  '- No preamble, no introduction, no "here is your briefing", no summary of the summary.',
  '- No sign-off, no closing line, no follow-up questions, no offers to help.',
  '- Emit every heading even when its section has no bullets; leave such a section empty.',
  '- Plain factual sentences. No adjectives of importance, no urgency language you were not',
  '  given, no speculation about what the person should do.',
].join('\n');

/**
 * Trusted instructions, placed AFTER the fenced block so the model reads the
 * real task last. Never interpolate artifact text into this string.
 */
const INSTRUCTIONS = `Write the briefing. Markdown only, starting with "## ${BRIEFING_SECTIONS[0]}".`;

// ---------------------------------------------------------------------------
// Rendering the untrusted payload
// ---------------------------------------------------------------------------

/**
 * Largest absolute epoch-ms value `Date` can represent; past it `toISOString()`
 * throws. Guarding matters because that throw would escape before the
 * `ai_calls` row is written, breaking the one-row-per-call audit guarantee over
 * what is a purely cosmetic defect.
 */
const MAX_EPOCH_MS = 8.64e15;

function isoOrUnknown(epochMs: number): string {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_EPOCH_MS) return 'unknown';
  return new Date(epochMs).toISOString();
}

/** A tip delta plus, for reversals only, the summary of what it reversed. */
interface DeltaForPrompt {
  delta: StateDelta;
  /** Present only when `delta.kind === 'reversal'` and a predecessor exists. */
  priorSummary?: string;
}

/**
 * Renders retrieval chunks and ranked deltas as one untrusted payload.
 *
 * Every entry is labelled with the artifact ids it may be cited by, using
 * `[artifact:<id>]` — the EXACT marker shape {@link SYSTEM_PROMPT} instructs
 * the model to emit, not a paraphrase of it. This used to label context
 * entries `[artifact_id: …]` / `[artifact_ids: … …]` (English-readable, but a
 * different token shape from the instructed `[artifact:<id>]` marker), and a
 * model weak enough to prioritise pattern-matching the content it was just
 * shown over a differently-worded rule two paragraphs up would echo THAT
 * shape back — writing a real, correct id in a marker the citation gate does
 * not recognise, and losing every claim to `no_citation` despite citing
 * something genuine. Matching the two exactly removes the only cue that could
 * cause the drift. The whole rendering — labels included — is fenced by
 * `wrapUntrusted`, so content that imitates a label cannot escape into the
 * trusted half of the prompt.
 */
function renderContext(
  chunks: readonly RetrievedChunk[],
  deltas: readonly DeltaForPrompt[],
): string {
  const parts: string[] = [];

  for (const chunk of chunks) {
    parts.push(
      `[artifact:${chunk.artifactId}] [thread: ${chunk.threadKey}] ` +
        `[at: ${isoOrUnknown(chunk.occurredAt)}]\n${chunk.text}`,
    );
  }

  for (const { delta, priorSummary } of deltas) {
    const lines = [
      `[state_change] [thread: ${delta.threadKey}] [kind: ${delta.kind}] ` +
        `[at: ${isoOrUnknown(delta.createdAt)}] ` +
        delta.citationArtifactIds.map((id) => `[artifact:${id}]`).join(' '),
      delta.summary,
    ];
    // D-6: the ONLY superseded content that is allowed into a prompt, and only
    // so a reversal can be narrated as "X, then Y" instead of as a bare Y.
    if (priorSummary !== undefined) {
      lines.push(`[prior state, since reversed] ${priorSummary}`);
    }
    parts.push(lines.join('\n'));
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Streaming: bullets → sectioned claims
// ---------------------------------------------------------------------------

/** A whole claim, with the section that was in force when it was emitted. */
interface CollectedClaim {
  section: BriefingSection;
  text: string;
}

/**
 * Splits {@link ClaimBuffer} output into headings and claim bodies.
 *
 * `ClaimBuffer` knows about bullet boundaries only, so a section heading arrives
 * glued to the tail of the preceding bullet ("…the cert. \n\n## Worth knowing").
 * This router pulls those apart: heading lines switch the current section, and
 * the surrounding prose is emitted as a claim under whichever section was in
 * force *before* the heading it preceded.
 *
 * An unrecognised heading leaves the current section unchanged rather than
 * inventing a fifth section — the prompt forbids extra sections, and a claim
 * under a hallucinated heading is still a claim that must be filed somewhere the
 * reader can trust.
 */
class SectionRouter {
  private section: BriefingSection = DEFAULT_SECTION;

  constructor(private readonly onClaim: (claim: CollectedClaim) => void) {}

  /** Route one whole claim as handed over by `ClaimBuffer`. */
  push(rawClaim: string): void {
    let pending: string[] = [];

    for (const line of rawClaim.split('\n')) {
      const heading = HEADING_RE.exec(line);
      if (heading === null) {
        pending.push(line);
        continue;
      }

      this.flush(pending);
      pending = [];
      this.section = canonicalSection(heading[1] ?? '') ?? this.section;
    }

    this.flush(pending);
  }

  /** Emit `lines` as one claim, collapsing the wrapping the model chose. */
  private flush(lines: readonly string[]): void {
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (text === '') return;
    this.onClaim({ section: this.section, text });
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * The retrieval capability this module needs.
 *
 * A `Pick` of the real service rather than the class itself, so a test can
 * supply a hand-built allowlist: `RetrievalService` carries private state, which
 * makes an object literal structurally incompatible with the class type. A real
 * `RetrievalService` satisfies this alias unchanged.
 */
export type BriefingRetriever = Pick<RetrievalService, 'forBriefing'>;

/** Half-open briefing window `[windowStart, windowEnd)`. */
export interface BriefingWindow {
  windowStart: number;
  windowEnd: number;
}

/** Outcome vocabulary recorded on the layer-3 `ai_calls` row. */
export type BriefingOutcome =
  /** The model finished and its claims were gated. */
  | 'ok'
  /**
   * The model finished, produced claims, and the gate withheld EVERY one of
   * them (Task 4.4, Gap A).
   *
   * This exists because `'ok'` was previously written for such a run, which made
   * a total gate failure — including a run whose claims were all dropped as
   * `injection_pattern` — indistinguishable in `ai_calls` from a healthy
   * briefing. `ai_calls.outcome` is `TEXT NOT NULL` with no CHECK constraint, so
   * widening the vocabulary is a code change, not a migration: the per-reason
   * breakdown lives in the trace, and this value is the queryable flag that says
   * "go look at that trace". A run that lost SOME claims is still `'ok'` — it
   * produced a real briefing — and is explained by the trace's `gateDrops`.
   */
  | 'all_claims_dropped'
  /** Neither retrieval nor the deltas offered a single citable artifact. */
  | 'no_context'
  /** `budgets.generationMs` elapsed mid-stream; kept what had arrived. */
  | 'budget_exceeded'
  /** The stream failed after producing tokens; kept what had arrived. */
  | 'stream_error'
  /** The model call failed before producing anything. */
  | 'error'
  /** Retrieval itself threw. Rethrown to the caller. */
  | 'retrieval_error'
  /**
   * No model ran at all: the deterministic template produced this briefing
   * (Task 4.3). Never produced by this module — reserved here so the fallback
   * renderer and the generator report outcomes in one shared vocabulary.
   */
  | 'template';

/**
 * How many claims the citation gate withheld, per reason.
 *
 * A `Partial` record on purpose: a reason that never fired is ABSENT, never
 * `0` — the same rule `StageTimings` follows, and for the same reason. `{}` is
 * the shape of "nothing was dropped", and a caller can therefore treat any
 * present key as a real event worth reading.
 */
export type GateDropCounts = Partial<Record<DropReason, number>>;

export interface BriefingGenerationResult {
  briefingId: string;
  /**
   * The `trace_id` every `ai_calls` row for this run carries, and the id of the
   * JSONL line describing it. Surfaced (Task 4.4) so a caller can correlate
   * without re-deriving it — and so a caller that PASSED one in can prove it
   * was honoured.
   */
  traceId: string;
  /**
   * Always `'llm'` in this phase — the deterministic template fallback is
   * Phase 4. A run cut short by the generation budget is still an LLM briefing
   * and is reported by {@link partial}, not by a different mode.
   */
  mode: BriefingMode;
  /** Claims that passed the citation gate and were persisted. */
  claimsAccepted: number;
  /** Claims the gate withheld. Never rendered, never stored — counted only. */
  claimsDropped: number;
  /**
   * {@link claimsDropped}, broken down by the gate's own `reason` (Task 4.4,
   * Gap A). `{}` when nothing was dropped.
   *
   * The gate has always produced a reason per drop and the generator has always
   * thrown it away, so `injection_pattern` — the T-1 detector actually firing —
   * was completely unobservable. The same breakdown is written to the trace.
   */
  claimsDroppedByReason: GateDropCounts;
  /**
   * SEC-5 (Task 4.4, Gap B): how many separate values `redactOutput` removed
   * from ACCEPTED claims, and which detector kinds fired.
   *
   * `GateResult` began reporting these in Task 4.2 and nothing consumed them. A
   * redaction is not a drop: the claim was published, with a secret or a contact
   * detail taken out of it. That is a leak that was caught, and a leak caught
   * silently reads exactly like no leak at all.
   */
  redactionCount: number;
  /** Distinct detector kinds redacted across all accepted claims. Safe to log. */
  redactionKinds: string[];
  /**
   * F-4: accepted claims whose cited source text did not support them.
   *
   * Under `groundingMode: 'observe'` (the default) these were still published —
   * the number exists so the eval can quantify what enforcing would cost before
   * anyone enforces it. Under `'enforce'` it is always 0, because such claims
   * are dropped as `unsupported` instead.
   */
  groundingFailures: number;
  /** OI-1: threads with unsynthesized work at request time. */
  threadsStillProcessing: number;
  /** §7.8: generation was cut short. Everything present is still real. */
  partial: boolean;
  /**
   * The same vocabulary written to this run's `ai_calls` row, surfaced so a
   * caller can tell the *reasons* a run ended apart from one another.
   *
   * Added for Task 4.3. {@link partial} alone cannot drive the fallback chain:
   * `'budget_exceeded'` and `'stream_error'` both set it, but only the second
   * means the local model died — the first is a deliberate, healthy truncation
   * that must NOT be topped up from the deterministic template. Reporting the
   * outcome here is the whole of the change this module needed; a stream failure
   * already resolves (keeping every accepted claim) rather than rejecting.
   */
  outcome: BriefingOutcome;
  /** Absolute path of the markdown written for this briefing. */
  narrativePath: string;
  /** The five OI-1 stage timings, as measured by the trace's spans. */
  timings: StageTimings;
}

/** Optional wiring; every field has a production default. */
export interface BriefingGeneratorOptions {
  /**
   * Directory for the trace JSONL sink. Relative paths resolve against
   * `process.cwd()`; tests should pass an absolute temp dir.
   */
  logsDir?: string;
  /**
   * §7.8 budget enforcement, independent of the `Clock`. Defaults to
   * `setTimeout`/`clearTimeout`; tests inject a fake pair so the "abort before
   * any token arrives" path is exercised without a real wait.
   *
   * Deliberately NOT driven by {@link Clock} the way the rest of this class is:
   * `Clock.now()` only advances when something calls it, and the whole point
   * of this timer is to fire even while nothing is happening — while the model
   * is still evaluating the prompt and the stream has yielded nothing at all
   * for {@link BriefingGenerator.generate} to check a clock against. See the
   * generation stage's own comment for what this closes.
   */
  scheduleTimer?: (fn: () => void, ms: number) => unknown;
  /** Defaults to `clearTimeout`. Must accept whatever `scheduleTimer` returned. */
  clearTimer?: (handle: unknown) => void;
}

/**
 * One accepted claim, handed to {@link GenerateOptions.onClaimAccepted} as it is
 * accepted (§12.2: claim-level streaming, never token-level).
 *
 * Deliberately the gate's own output, not the persisted row: `text` is already
 * marker-free and redacted, and `citationArtifactIds` holds ALL the ids the
 * claim cited — not just the primary one `briefing_claims` can store.
 */
export interface AcceptedClaimChunk {
  section: string;
  /** Marker-free, redacted claim text. Safe to render. */
  text: string;
  /** Every artifact id the claim cited, in order of appearance. */
  citationArtifactIds: string[];
}

/** Per-call options for {@link BriefingGenerator.generate}. All optional. */
export interface GenerateOptions {
  /**
   * Briefing id to use instead of minting one.
   *
   * The IPC path (`briefing:request`) hands the renderer a `briefingId`
   * *synchronously*, before generation starts, and the renderer immediately
   * subscribes to `briefing:chunk` / `briefing:done` with it. Passing that id in
   * here is what makes the id the renderer holds the same id the claims are
   * persisted under. Absent (the scheduler's path), one is minted as before.
   *
   * An empty string is treated as absent: it would produce a `briefings/.md`
   * narrative path shared by every such run.
   */
  briefingId?: string;
  /**
   * Correlation id to run this generation under, instead of minting one
   * (NFR-8, Task 4.4).
   *
   * A briefing is the tip of a pipeline: the events it narrates were classified
   * by Layer 1 and synthesized by Layer 2, each of which wrote its own
   * `ai_calls` rows. Threading ONE id through all three is the only thing that
   * makes `SELECT * FROM ai_calls WHERE trace_id = ?` answer "what did the
   * pipeline do for this briefing" — which is the question `AiCallsRepo`'s own
   * doc comment says the table exists to answer, and which was unanswerable
   * because every layer minted its own id.
   *
   * Absent (or blank) mints one, so every existing call site is unchanged. The
   * id is also the id of this run's line in `trace-YYYY-MM-DD.jsonl`.
   */
  traceId?: string;
  /**
   * Called once per claim the citation gate accepts, in arrival order, while the
   * model is still streaming — this is the real-time hook the briefing UI paints
   * from.
   *
   * Notification only. It is invoked from a `try`/`catch` that is separate from
   * the persistence path, so a throwing (or slow) subscriber can change neither
   * what is stored nor what the returned result reports. It also fires only for
   * claims that pass the gate, so an uncited claim cannot reach a renderer even
   * transiently (AC-2).
   */
  onClaimAccepted?: (chunk: AcceptedClaimChunk) => void;
}

/** A claim that survived the gate, ready to be ordered and persisted. */
interface AcceptedClaim {
  section: BriefingSection;
  text: string;
  citationArtifactIds: string[];
  /** Arrival index, used as the within-section tiebreaker. */
  arrival: number;
}

/** Everything one pass of the citation gate produced, content and telemetry. */
interface GateTally {
  accepted: AcceptedClaim[];
  dropped: number;
  dropsByReason: GateDropCounts;
  /** Accepted claims that had at least one value redacted (not the value count). */
  redactedClaims: number;
  /** F-4 'observe': accepted claims the grounding check would have withheld. */
  groundingFailures: number;
  redactionCount: number;
  redactionKinds: string[];
}

export class BriefingGenerator {
  private readonly clock: Clock;
  private readonly logsDir: string;
  private readonly scheduleTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  /**
   * @param ollama - Local inference client; streamed, not JSON-constrained.
   * @param retrieval - Supplies context AND the bulk of the citation allowlist.
   * @param deltas - D-6 store. Read tip-only, except for reversal narration.
   * @param briefings - Briefing + claim persistence.
   * @param citationGate - AC-2 enforcement; holds its own `GraphRepo`.
   * @param watermarks - Read-only here, for the OI-1 disclosure count.
   * @param graph - Stakes/participation facts for the FR-5 ranker.
   * @param pending - Open obligations, for the ranker's `hasPendingOnMe` term.
   * @param aiCalls - Telemetry sink; exactly one layer-3 row per `generate()`.
   * @param config - `budgets.*` (§7.8 deadlines) and `ranking.*` (FR-5 weights).
   * @param narrativeDir - Root under which `briefings/<id>.md` is written.
   * @param model - Chat model name, recorded on the `ai_calls` row.
   * @param promptVersion - e.g. `layer3-brief.v1`.
   * @param clock - Injected time source; nothing here calls `Date.now()`.
   * @param options - Trace sink location.
   */
  constructor(
    private readonly ollama: OllamaClient,
    private readonly retrieval: BriefingRetriever,
    private readonly deltas: DeltasRepo,
    private readonly briefings: BriefingsRepo,
    private readonly citationGate: CitationGate,
    private readonly watermarks: WatermarkRepo,
    private readonly graph: GraphRepo,
    private readonly pending: PendingItemsRepo,
    private readonly aiCalls: AiCallsRepo,
    private readonly config: AppConfig,
    private readonly narrativeDir: string,
    private readonly model: string,
    private readonly promptVersion: string,
    clock: Clock = systemClock,
    options: BriefingGeneratorOptions = {},
  ) {
    this.clock = clock;
    this.logsDir = options.logsDir ?? 'logs';
    this.scheduleTimer = options.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  /**
   * Generate one briefing over `[windowStart, windowEnd)`.
   *
   * Resolves after writing exactly one `briefings` row, one `ai_calls` row, one
   * markdown file, and one `briefing_claims` row per gate-accepted claim.
   * Rejects only when retrieval itself throws — a transient fault the caller is
   * expected to retry, and the one case where writing a briefing would mean
   * publishing a window we never actually read.
   *
   * @param options - Optional pre-minted id and real-time claim callback; see
   * {@link GenerateOptions}. Omitting it reproduces the original behaviour
   * exactly, which is what keeps the scheduler's `generate(window)` call site
   * (`apps/desktop/src/scheduler/briefingSchedule.ts`) valid unchanged.
   */
  async generate(
    window: BriefingWindow,
    options: GenerateOptions = {},
  ): Promise<BriefingGenerationResult> {
    // `options.traceId`, when supplied, is adopted as the trace's own id — see
    // `GenerateOptions.traceId`. `startTrace` treats a blank string as absent.
    const trace = startTrace(this.clock, this.logsDir, {
      ...(options.traceId === undefined ? {} : { id: options.traceId }),
    });
    const generatedAt = this.clock.now();

    // Minted here rather than by the repo because `narrative_path` names the id
    // (`briefings/<id>.md`) and the row cannot be written without the path —
    // unless the caller already committed to an id (the IPC path handed one to
    // the renderer before this call), in which case that id is authoritative.
    const briefingId =
      options.briefingId !== undefined && options.briefingId !== '' ? options.briefingId : newId();
    const narrativePath = join(this.narrativeDir, 'briefings', `${briefingId}.md`);

    // OI-1, read BEFORE any work: the number must describe the backlog this
    // briefing was built against, not the one that exists once it finishes.
    const threadsStillProcessing = this.watermarks.countPendingSynthesis();

    trace.annotate({
      event: 'briefing',
      layer: 3,
      briefingId,
      model: this.model,
      promptVersion: this.promptVersion,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      threadsStillProcessing,
    });

    // ---- stage 1: retrieval -------------------------------------------------
    const retrievalSpan = trace.span('retrieval');
    let chunks: readonly RetrievedChunk[];
    let tips: StateDelta[];
    try {
      const retrieved = await this.retrieval.forBriefing({
        start: window.windowStart,
        end: window.windowEnd,
      });
      chunks = retrieved.chunks;
      // D-6: the `current_state_deltas` view. A superseded delta's row is still
      // on disk and is deliberately not read here.
      tips = this.deltas.currentForWindow(window.windowStart, window.windowEnd);
    } catch (error) {
      retrievalSpan.end();
      // `forBriefing` is documented as never throwing, but "documented" is not
      // "enforced", and a silent empty briefing would be indistinguishable from
      // a genuinely quiet window.
      trace.annotate({ outcome: 'retrieval_error', error: String(error) });
      this.log(trace.id, 0, 'retrieval_error');
      trace.finish();
      throw error;
    }
    retrievalSpan.end();

    // ---- stage 2: assembly --------------------------------------------------
    const assemblySpan = trace.span('assembly');
    const ranked = this.rank(tips);
    const forPrompt = ranked.map((delta) => this.withReversalContext(delta));

    // The citation allowlist. Retrieval supplies most of it; a ranked delta's
    // own citations are added because those ids are rendered as labels in the
    // payload, so the model is *told* it may cite them. The gate still checks
    // each id against the graph, which is what keeps `briefing_claims`' NOT NULL
    // artifact FK satisfiable.
    const allowed = new Set<string>([
      ...chunks.map((chunk) => chunk.artifactId),
      ...ranked.flatMap((delta) => delta.citationArtifactIds),
    ]);

    // F-4 grounding source: the RAW INGESTED TEXT of each retrieved chunk, and
    // deliberately nothing else.
    //
    // Delta summaries are in this prompt too, and are excluded on purpose —
    // they are Layer 2's own model output, so grounding a Layer 3 claim against
    // one would check model output against model output and prove nothing. An
    // artifact known only through a delta therefore has no entry here, and
    // `isGrounded` treats a missing entry as "cannot check" rather than "not
    // supported" (see its rule 2), so such a claim is passed through exactly as
    // it was before F-4.
    //
    // Several chunks can share an artifact; their texts are joined so a claim
    // grounded across two messages of the same thread is not judged against
    // whichever one happened to be indexed first.
    const sourceTextByArtifact = new Map<string, string>();
    for (const chunk of chunks) {
      const existing = sourceTextByArtifact.get(chunk.artifactId);
      sourceTextByArtifact.set(
        chunk.artifactId,
        existing === undefined ? chunk.text : `${existing}
${chunk.text}`,
      );
    }
    const grounding: GroundingOptions = {
      sourceTextFor: (artifactId: string): string | undefined =>
        sourceTextByArtifact.get(artifactId),
      mode: this.config.briefing.groundingMode,
    };

    const { system, prompt } = assemblePrompt({
      system: SYSTEM_PROMPT,
      // T-1: the ONLY route artifact text takes into a prompt.
      wrappedContent: wrapUntrusted(renderContext(chunks, forPrompt), `briefing:${briefingId}`),
      instructions: INSTRUCTIONS,
    });
    assemblySpan.end();

    this.briefings.create({
      briefingId,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      generatedAt,
      mode: 'llm',
      narrativePath,
      deltaIds: ranked.map((delta) => delta.deltaId),
      threadsStillProcessing,
    });

    // Nothing citable means nothing sayable: every claim the model could produce
    // would have to be dropped, so the call is skipped rather than paid for.
    if (allowed.size === 0) {
      return this.finishEmpty(trace, {
        briefingId,
        narrativePath,
        window,
        threadsStillProcessing,
      });
    }

    // ---- stage 3: generation ------------------------------------------------
    const collected: CollectedClaim[] = [];
    const notify = options.onClaimAccepted;
    const router = new SectionRouter((claim) => {
      collected.push(claim);
      // Real-time claim-level streaming (§12.2). `ClaimBuffer` has already
      // proven this claim is WHOLE — nothing partial reaches here — so this is
      // the earliest instant at which a claim can honestly be shown.
      if (notify !== undefined) this.announce(notify, claim, allowed, grounding);
    });
    const buffer = new ClaimBuffer((claim) => router.push(claim));

    const generationSpan = trace.span('generation');
    const firstTokenSpan = trace.span('firstToken');

    const budgetMs = this.config.budgets.generationMs;
    const deadline =
      Number.isFinite(budgetMs) && budgetMs > 0 ? this.clock.now() + budgetMs : Infinity;

    const controller = new AbortController();
    let partial = false;
    let sawToken = false;
    // Set only by the real timer below (or by the per-token check that mirrors
    // it), never inferred from the abort itself: `controller.abort()` can also
    // fire for reasons this method did not request, and only THIS flag may
    // turn into `outcome: 'budget_exceeded'`.
    let timedOut = false;
    let outcome: BriefingOutcome = 'ok';

    /**
     * §7.8 enforcement, callable from either the real timer or the per-token
     * check below — the two are one policy with two triggers, not two
     * policies, so there is exactly one place that flips these three flags.
     */
    const enforceBudget = (): void => {
      timedOut = true;
      partial = true;
      controller.abort();
    };

    // THE FIX: a real timer, independent of token arrival. Without this, the
    // per-token check below can only run once a token has actually been
    // pushed — and while the model is still evaluating the prompt, Ollama's
    // stream yields NOTHING at all, so `for await` sits inside `reader.read()`
    // with no token to trigger a check against. A slow-to-start (or stuck)
    // model previously ran unbounded past `budgets.generationMs` for exactly
    // that reason: the budget only ever fired AFTER the cost it was meant to
    // cap had already been paid.
    const budgetTimer =
      Number.isFinite(budgetMs) && budgetMs > 0 ? this.scheduleTimer(enforceBudget, budgetMs) : undefined;

    try {
      const stream = this.ollama.generateStream({ prompt, system, signal: controller.signal });
      for await (const token of stream) {
        if (!sawToken) {
          sawToken = true;
          firstTokenSpan.end();
        }
        buffer.push(token);

        // Kept alongside the timer above, not replaced by it: this is what
        // makes a claim that fully arrived before the deadline kept, and the
        // one being typed when it passed not — a real timer firing between
        // two `await`s cannot retroactively un-buffer a token already pushed,
        // so the boundary still has to be checked here, per token.
        if (this.clock.now() >= deadline) {
          enforceBudget();
          break;
        }
      }

      // `end()` flushes the final buffered claim, which only has meaning when
      // the stream actually ended. After an abort the tail is a half-typed
      // sentence whose citation marker may simply not have arrived yet, so it is
      // discarded rather than gated — a truncated claim that happens to carry a
      // valid marker is still a claim the model never finished making.
      if (!partial) buffer.end();
    } catch {
      partial = true;
      outcome = timedOut ? 'budget_exceeded' : sawToken ? 'stream_error' : 'error';
    } finally {
      if (budgetTimer !== undefined) this.clearTimer(budgetTimer);
      // Idempotent. When no token ever arrived this records how long we waited
      // for one, which is the number an operator diagnosing a dead model wants;
      // leaving it open would report the stage as never having run.
      firstTokenSpan.end();
      generationSpan.end();
    }

    // The in-loop `break` path (deadline hit between two already-received
    // tokens) never throws, so the `catch` above never runs for it — this is
    // what promotes THAT path to the same outcome the timer's throw-driven
    // path resolves to, without duplicating the assignment in two places.
    if (timedOut && outcome === 'ok') outcome = 'budget_exceeded';

    // ---- stage 4: citation --------------------------------------------------
    const citationSpan = trace.span('citation');
    const tally = this.gate(collected, allowed, grounding);
    const { accepted } = tally;
    this.persist(briefingId, accepted, ranked);
    citationSpan.end();

    // Gap A. The gate produced a reason for every drop and this method used to
    // discard all of them, so `outcome: 'ok'` was written for a run that
    // published nothing. A total loss now says so in `ai_calls` (the queryable
    // flag) and the per-reason breakdown goes to the trace (the detail).
    //
    // Only an otherwise-`'ok'` run is relabelled: `'budget_exceeded'` and
    // `'stream_error'` already name a MORE specific cause, and overwriting them
    // would hide the reason the claims were missing in the first place.
    if (outcome === 'ok' && accepted.length === 0 && tally.dropped > 0) {
      outcome = 'all_claims_dropped';
    }

    this.writeNarrative(narrativePath, {
      window,
      accepted,
      threadsStillProcessing,
      partial,
    });

    if (partial) this.briefings.markPartial(briefingId);

    const timings = trace.stageTimings();
    this.briefings.recordTimings(
      briefingId,
      timings.firstTokenMs ?? 0,
      this.clock.now() - generatedAt,
    );

    // Gaps A and B land here: drop reasons and redaction kinds are carried by
    // the trace, not by `ai_calls`, because `ai_calls`' ten columns are fixed
    // and neither fact is a scalar. `redactionKinds` is detector KINDS only
    // (`email`, `aws_access_key`) — never any part of a redacted value — which
    // is what makes it safe to persist next to a claim count.
    trace.annotate({
      claimsCollected: collected.length,
      claimsAccepted: accepted.length,
      claimsDropped: tally.dropped,
      gateDrops: tally.dropsByReason,
      redactedClaims: tally.redactedClaims,
      // F-4: how many PUBLISHED claims the grounding check would have withheld
      // under 'enforce'. This is the number that decides whether enforcing is
      // safe, and it is only knowable by shipping the detector in observe mode.
      groundingFailures: tally.groundingFailures,
      groundingMode: this.config.briefing.groundingMode,
      redactionCount: tally.redactionCount,
      redactionKinds: tally.redactionKinds,
      partial,
      outcome,
    });

    this.log(trace.id, timings.generationMs ?? 0, outcome);
    trace.finish();

    return {
      briefingId,
      traceId: trace.id,
      mode: 'llm',
      claimsAccepted: accepted.length,
      claimsDropped: tally.dropped,
      claimsDroppedByReason: tally.dropsByReason,
      redactionCount: tally.redactionCount,
      redactionKinds: tally.redactionKinds,
      groundingFailures: tally.groundingFailures,
      threadsStillProcessing,
      partial,
      outcome,
      narrativePath,
      timings,
    };
  }

  // -------------------------------------------------------------------------
  // Ranking (FR-5)
  // -------------------------------------------------------------------------

  /**
   * Order the window's tip deltas by stakes, obligation and participation.
   *
   * The weights come from `config.ranking` (NFR-7), and the projection onto the
   * ranker's input shape is `toRankableDelta`'s — the one place that decides
   * what the ranker is allowed to see (X-2).
   */
  private rank(tips: readonly StateDelta[]): StateDelta[] {
    const selfPersonId = this.graph.getSelf()?.personId;

    const openByDelta = new Map<string, PendingItem[]>();
    for (const item of this.pending.listOpen()) {
      const bucket = openByDelta.get(item.deltaId);
      if (bucket === undefined) openByDelta.set(item.deltaId, [item]);
      else bucket.push(item);
    }

    const byId = new Map(tips.map((delta) => [delta.deltaId, delta]));
    const rankable = tips.map((delta) => {
      const context: RankableDeltaContext = {
        graph: this.graph,
        pendingItems: openByDelta.get(delta.deltaId) ?? [],
        // Spread rather than assigned: `exactOptionalPropertyTypes` forbids an
        // explicit `undefined`, and an unknown self must skip the term rather
        // than be scored as absent-from-every-thread.
        ...(selfPersonId === undefined ? {} : { selfPersonId }),
      };
      return toRankableDelta(delta, context);
    });

    return rankDeltas(rankable, this.config.ranking, this.clock.now())
      .map((entry) => byId.get(entry.deltaId))
      .filter((delta): delta is StateDelta => delta !== undefined);
  }

  /**
   * Attach the superseded summary to a `reversal`, and to nothing else (D-6).
   *
   * `chainFor` returns the whole history including superseded versions, which is
   * exactly why this is the only method allowed to call it: the predecessor is
   * looked up by `supersedes` and only its `summary` is carried forward, so a
   * non-tip delta can never contribute content on any other path.
   */
  private withReversalContext(delta: StateDelta): DeltaForPrompt {
    if (delta.kind !== 'reversal' || delta.supersedes === null) return { delta };

    const previous = this.deltas
      .chainFor(delta.threadKey)
      .find((prior) => prior.deltaId === delta.supersedes);

    return previous === undefined ? { delta } : { delta, priorSummary: previous.summary };
  }

  // -------------------------------------------------------------------------
  // Gating and persistence (AC-2)
  // -------------------------------------------------------------------------

  /**
   * Notify a live subscriber about one just-arrived claim, if the gate takes it.
   *
   * Runs the gate a second time, on purpose. {@link CitationGate.accept} is a
   * pure, deterministic function of `(text, allowed)` — regexes plus an indexed
   * artifact lookup — so the set announced here is exactly the set {@link gate}
   * accepts afterwards, and re-running it costs microseconds per claim. What it
   * buys is total isolation: the streaming path shares no mutable state with the
   * persistence path, so nothing a subscriber does (throw, block, mutate the
   * chunk it is handed) can change which claims are stored, their order, or the
   * counts the result reports.
   *
   * Never throws: a broken renderer subscription must not abort a generation
   * that is otherwise succeeding.
   */
  private announce(
    notify: (chunk: AcceptedClaimChunk) => void,
    claim: CollectedClaim,
    allowed: ReadonlySet<string>,
    grounding: GroundingOptions,
  ): void {
    try {
      const result = this.citationGate.accept(claim.text, allowed, grounding);
      if (!result.accepted) return;
      notify({
        section: claim.section,
        text: result.text,
        // Copied, not aliased: the array handed out is the subscriber's to keep.
        citationArtifactIds: [...result.citationArtifactIds],
      });
    } catch (error) {
      console.error('[layer3] claim stream subscriber failed', error);
    }
  }

  /**
   * Run every collected claim past the gate. Drops are counted, never kept.
   *
   * Also totals the two things the gate reports and this method previously threw
   * away: the `reason` behind each drop and the SEC-5 redaction counts on each
   * accept (Task 4.4, Gaps A and B). The dropped TEXT is still discarded here —
   * `GateResult.droppedClaim` exists and is deliberately not accumulated,
   * because the counts are what an operator needs and the text is untrusted
   * model output that would then have to be redacted, stored and expired.
   */
  private gate(
    collected: readonly CollectedClaim[],
    allowed: ReadonlySet<string>,
    grounding: GroundingOptions,
  ): GateTally {
    const accepted: AcceptedClaim[] = [];
    let dropped = 0;
    const dropsByReason: GateDropCounts = {};
    let redactedClaims = 0;
    let groundingFailures = 0;
    let redactionCount = 0;
    // A Set, then spread: the same detector firing on three claims is one KIND
    // of leak, and the count already carries the magnitude.
    const redactionKinds = new Set<string>();

    collected.forEach((claim, arrival) => {
      const result = this.citationGate.accept(claim.text, allowed, grounding);
      if (!result.accepted) {
        dropped += 1;
        // `reason` is documented as always present on a drop; `?? 'no_citation'`
        // would invent evidence, so an (impossible) missing reason is counted in
        // `dropped` and simply absent from the breakdown.
        if (result.reason !== undefined) {
          dropsByReason[result.reason] = (dropsByReason[result.reason] ?? 0) + 1;
        }
        return;
      }

      if (result.redactionCount !== undefined && result.redactionCount > 0) {
        redactedClaims += 1;
        redactionCount += result.redactionCount;
        for (const kind of result.redactionKinds ?? []) redactionKinds.add(kind);
      }

      if (result.groundingFailed === true) groundingFailures += 1;

      accepted.push({
        section: claim.section,
        text: result.text,
        citationArtifactIds: result.citationArtifactIds,
        arrival,
      });
    });

    // Section order is the briefing's contract, so it is imposed here rather
    // than trusted from the model: a model that emits "What moved" before
    // "Waiting on you" still yields correctly ordered `ordinal`s.
    accepted.sort(
      (a, b) =>
        (SECTION_ORDER.get(a.section) ?? BRIEFING_SECTIONS.length) -
          (SECTION_ORDER.get(b.section) ?? BRIEFING_SECTIONS.length) || a.arrival - b.arrival,
    );

    return {
      accepted,
      dropped,
      dropsByReason,
      redactedClaims,
      groundingFailures,
      redactionCount,
      redactionKinds: [...redactionKinds],
    };
  }

  /**
   * Write one `briefing_claims` row per accepted claim, in narrative order.
   *
   * `citation_artifact_id` is single-valued in the schema while a claim may cite
   * several artifacts; the first cited id is stored as the primary link and the
   * rest remain visible in the rendered markers. A claim is linked back to a
   * delta when one of its citations belongs to a delta in this window, which is
   * what lets the UI answer "which state change did this sentence come from?".
   *
   * ### This method does NOT create pending items (F-5, 2026-09-03)
   *
   * It used to: a "Waiting on you" claim that resolved to a `deltaId` was
   * promoted into a real `pending_items` row via `derivePendingItem`, asserting
   * `waitingOnSelf: true` because layer 3 has no per-claim obligee signal. That
   * assertion was the problem. `layer2/pending.ts`'s rule 1 exists precisely to
   * reject obligations owed by a third party — the plan names them as the single
   * most common false-positive source — and it decides using the model's
   * explicit `waiting_on` field. Promoting on section membership alone routed
   * around that rule with strictly weaker evidence: "the SYSTEM_PROMPT told the
   * model to put the user's own obligations here" is a prompt instruction, not
   * an observation, and a model that misfiles one claim then mints a durable
   * to-do the user must dismiss by hand.
   *
   * AC-4 (pending-item precision, ≥ 75%) was measured at 48.0% (n=25 items,
   * 2026-08-28) with this path live. Layer 2 remains the only writer of
   * `pending_items`, which is what keeps rule 1 the single gate on that table.
   *
   * A streamed "Waiting on you" claim still RENDERS — `BriefingView` shows it
   * beneath the pending list — it just no longer becomes a stored obligation.
   */
  private persist(
    briefingId: string,
    accepted: readonly AcceptedClaim[],
    ranked: readonly StateDelta[],
  ): void {
    const deltaByArtifact = new Map<string, string>();
    for (const delta of ranked) {
      for (const artifactId of delta.citationArtifactIds) {
        if (!deltaByArtifact.has(artifactId)) deltaByArtifact.set(artifactId, delta.deltaId);
      }
    }
    accepted.forEach((claim, ordinal) => {
      // Non-null by construction: the gate rejects a claim with no citations.
      const primary = claim.citationArtifactIds[0] as string;
      const deltaId = claim.citationArtifactIds
        .map((artifactId) => deltaByArtifact.get(artifactId))
        .find((id): id is string => id !== undefined);

      this.briefings.addClaim({
        briefingId,
        ordinal,
        section: claim.section,
        text: claim.text,
        citationArtifactId: primary,
        deltaId: deltaId ?? null,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Narrative file
  // -------------------------------------------------------------------------

  /**
   * Write `briefings/<id>.md`.
   *
   * Only accepted claims are rendered, with their citation markers restored so
   * the file is self-describing: an artifact id in the markdown is a promise
   * that `briefing_claims` holds the same link. All four headings are always
   * emitted, empty or not, so the shape of the briefing does not change with its
   * contents.
   */
  private writeNarrative(
    path: string,
    input: {
      window: BriefingWindow;
      accepted: readonly AcceptedClaim[];
      threadsStillProcessing: number;
      partial: boolean;
    },
  ): void {
    const lines: string[] = [
      '# Briefing',
      '',
      `_Window: ${isoOrUnknown(input.window.windowStart)} → ${isoOrUnknown(input.window.windowEnd)}_`,
      '',
    ];

    // OI-1 / §7.8 disclosures, stated before the content rather than in a
    // footnote: a briefing the user cannot tell is incomplete is worse than a
    // short one.
    if (input.threadsStillProcessing > 0) {
      lines.push(
        `_${input.threadsStillProcessing} thread(s) still had unsynthesized activity when this briefing was generated._`,
        '',
      );
    }
    if (input.partial) {
      lines.push(
        '_Generation stopped at the latency budget. Everything below is complete and cited; there may be more that was not written._',
        '',
      );
    }

    for (const section of BRIEFING_SECTIONS) {
      lines.push(`## ${section}`, '');
      for (const claim of input.accepted) {
        if (claim.section !== section) continue;
        const markers = claim.citationArtifactIds.map((id) => `[artifact:${id}]`).join(' ');
        lines.push(`- ${claim.text} ${markers}`);
      }
      lines.push('');
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join('\n').trimEnd()}\n`, 'utf8');
  }

  // -------------------------------------------------------------------------
  // Terminal paths
  // -------------------------------------------------------------------------

  /**
   * Close out a run that had nothing citable to say.
   *
   * Still writes the briefing, the file and the `ai_calls` row: "there was
   * nothing to report" is an answer the user asked for and the audit trail needs
   * to be able to count.
   */
  private finishEmpty(
    trace: ReturnType<typeof startTrace>,
    input: {
      briefingId: string;
      narrativePath: string;
      window: BriefingWindow;
      threadsStillProcessing: number;
    },
  ): BriefingGenerationResult {
    this.writeNarrative(input.narrativePath, {
      window: input.window,
      accepted: [],
      threadsStillProcessing: input.threadsStillProcessing,
      partial: false,
    });

    const timings = trace.stageTimings();
    trace.annotate({
      claimsCollected: 0,
      claimsAccepted: 0,
      claimsDropped: 0,
      gateDrops: {},
      redactionCount: 0,
      outcome: 'no_context',
      partial: false,
    });
    this.log(trace.id, 0, 'no_context');
    trace.finish();

    return {
      briefingId: input.briefingId,
      traceId: trace.id,
      mode: 'llm',
      claimsAccepted: 0,
      claimsDropped: 0,
      claimsDroppedByReason: {},
      redactionCount: 0,
      redactionKinds: [],
      groundingFailures: 0,
      threadsStillProcessing: input.threadsStillProcessing,
      partial: false,
      outcome: 'no_context',
      narrativePath: input.narrativePath,
      timings,
    };
  }

  /** Writes the single layer-3 `ai_calls` row for this generation attempt. */
  private log(traceId: string, latencyMs: number, outcome: BriefingOutcome): void {
    this.aiCalls.log({
      traceId,
      layer: 3,
      model: this.model,
      promptVersion: this.promptVersion,
      latencyMs,
      outcome,
    });
  }
}
