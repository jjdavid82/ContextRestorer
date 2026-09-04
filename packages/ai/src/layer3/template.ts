/**
 * Layer 3 — the deterministic template fallback (§7.8, Task 4.3; X-3).
 *
 * When the local model is not there, the product still owes the user an answer.
 * This module is that answer: a briefing assembled by ordinary code out of rows
 * that are already on disk — `current_state_deltas` (D-6 tips) and
 * `pending_items` — with no inference of any kind.
 *
 * Four properties are load-bearing.
 *
 * 1. **X-3: the chain is exactly `['ollama', 'template']`.** {@link FALLBACK_CHAIN}
 *    is the whole of it. There is no vendor step, no remote model, no "try the
 *    cloud if local is down" branch — not disabled, not behind a flag, absent.
 *
 * 2. **The renderer cannot call a model, structurally.** {@link TemplateBriefingRenderer}
 *    holds no `OllamaClient`-shaped dependency at all: not an unused one, not an
 *    optional one. The same guarantee `briefing:pending` gets in Task 3.5 — "no
 *    model client is in scope", rather than "we checked the call count was zero".
 *    A zero call count is what a test can observe; having nothing to call is what
 *    makes the zero inevitable.
 *
 * 3. **AC-2 survives the fallback.** Every template claim is backed by a
 *    `citation_artifact_ids_json` entry the *delta* already carried — a real,
 *    already-validated artifact id minted when the delta was synthesized. So the
 *    fallback does not weaken the citation invariant; it inherits it. A delta
 *    whose citations no longer resolve in the graph is DROPPED, exactly as an
 *    uncited model claim would be, because `briefing_claims.citation_artifact_id`
 *    is a NOT NULL foreign key and an unstorable claim must never be attempted.
 *
 * 4. **An empty window says so.** Zero tips and zero obligations produces a
 *    briefing that states "nothing to report" in the narrative and reports
 *    {@link TemplateBriefingResult.nothingToReport}. A claim-free briefing with
 *    no explanation is indistinguishable from a broken one.
 *
 * ### Relationship to the generation budget (§7.8)
 *
 * A run cut short by `budgets.generationMs` is NOT a fallback case. That is a
 * healthy, deliberate truncation which {@link BriefingGenerator} already handles
 * by keeping every accepted claim and marking the briefing `partial`. Topping it
 * up from the template would silently undo the budget. {@link generateWithFallback}
 * therefore branches on the generator's `outcome`, not on its `partial` flag:
 * only a genuine model failure earns a template remainder.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  newId,
  systemClock,
  type AppConfig,
  type BriefingClaim,
  type BriefingMode,
  type Clock,
  type PendingItem,
  type StateDelta,
} from '@cr/core';
import { redactOutput } from '@cr/redact';
import { startTrace } from '@cr/observability';
import type {
  AiCallsRepo,
  BriefingsRepo,
  DeltasRepo,
  GraphRepo,
  PendingItemsRepo,
  WatermarkRepo,
} from '@cr/store';
import { rankDeltas, toRankableDelta, type RankableDeltaContext } from '../ranker.js';
import { preflight, type PreflightResult } from '../preflight.js';
import {
  BRIEFING_SECTIONS,
  type AcceptedClaimChunk,
  type BriefingGenerationResult,
  type BriefingGenerator,
  type BriefingSection,
  type BriefingWindow,
} from './generate.js';

// ---------------------------------------------------------------------------
// X-3 — the fallback chain
// ---------------------------------------------------------------------------

/** One step of the fallback chain. The union has exactly two members, forever. */
export interface FallbackChainStep {
  name: 'ollama' | 'template';
}

/**
 * The complete fallback chain (X-3).
 *
 * ---------------------------------------------------------------------------
 * X-3 GUARDRAIL — READ BEFORE ADDING A STEP.
 *
 * This array is the entire escalation path for a briefing. Adding ANY vendor or
 * remote-inference step to it — OpenAI, Anthropic, Bedrock, a hosted gateway, an
 * API "just for the fallback" — violates X-3 and SEC-6 simultaneously: SEC-6
 * forbids inference leaving the machine, and X-3 forbids the *option* existing.
 * The second half matters on its own. A remote step that is merely unreachable
 * today is still a remote step someone will make reachable tomorrow, and the
 * user's threads would leave their laptop without anybody deciding that they
 * should.
 *
 * Local model, then local code. That is the whole ladder.
 * ---------------------------------------------------------------------------
 */
export const FALLBACK_CHAIN: readonly FallbackChainStep['name'][] = ['ollama', 'template'] as const;

// ---------------------------------------------------------------------------
// Labels and vocabulary
// ---------------------------------------------------------------------------

/**
 * The human-readable name of a template-mode briefing.
 *
 * Exported so what the store's `mode = 'template'` row *means* is written down
 * once. `apps/ui/components/BriefingView.tsx` renders this same phrase when
 * `BriefingDone.mode === 'template'`.
 */
export const SIMPLIFIED_BRIEFING_LABEL = 'Simplified briefing';

/** The label a normal, model-written briefing carries. */
export const LLM_BRIEFING_LABEL = 'Briefing';

/**
 * The label for an LLM briefing the template had to finish.
 *
 * Deliberately neither of the two above: the claims the model produced before it
 * died are genuine model output, so calling the whole thing "simplified" would
 * understate it, and calling it a plain briefing would hide that it was topped
 * up from local records.
 */
export const COMPLETED_BRIEFING_LABEL = 'Partial briefing, completed from local records';

/** The remedy shown alongside {@link SIMPLIFIED_BRIEFING_LABEL}. */
export const TEMPLATE_REMEDY_HINT = 'Check that Ollama is running, then request a new briefing.';

/**
 * `model` recorded on the layer-3 `ai_calls` row for a template render.
 *
 * Not a model name, on purpose: the column must not read as though some model
 * produced this briefing. `ai_calls.model` is TEXT NOT NULL, so the honest value
 * is a sentinel that says no model ran.
 */
export const TEMPLATE_MODEL = 'none:deterministic-template';

/** `prompt_version` for a template render. There is no prompt; there is a renderer version. */
export const TEMPLATE_PROMPT_VERSION = 'layer3-template.v1';

/** Why the deterministic template ran. Recorded as the `ai_calls` outcome. */
export type TemplateReason =
  /** Preflight said the local runtime (or a required model) was not there. */
  | 'preflight_failed'
  /** `generate()` rejected outright — nothing was published for this window. */
  | 'generation_failed'
  /** The model failed mid-stream; the template supplied whatever it had not covered. */
  | 'stream_error'
  /** The caller asked for a template render directly. */
  | 'requested';

/** `ai_calls.outcome` written for each reason. Free text by schema; fixed here. */
const OUTCOME_BY_REASON: Record<TemplateReason, string> = {
  preflight_failed: 'fallback_template_preflight',
  generation_failed: 'fallback_template_error',
  stream_error: 'fallback_template_stream_error',
  requested: 'template',
};

// ---------------------------------------------------------------------------
// Section routing
// ---------------------------------------------------------------------------

/** `section name → position`, so the four sections render in contract order. */
const SECTION_ORDER = new Map<string, number>(
  BRIEFING_SECTIONS.map((section, index) => [section, index]),
);

/**
 * Section for a delta with no obligation hanging off it.
 *
 * `reversal` lands in "What moved" rather than a section of its own: reversing a
 * decision *is* movement, and the four sections are a fixed contract
 * (`config/prompts/layer3-brief.v1.md`) that the fallback must not extend.
 * Anything unrecognised falls to "Worth knowing" — the only section that asserts
 * nothing about obligation or urgency, so a misfile there is cosmetic rather
 * than a false alarm.
 */
function sectionForKind(kind: string): BriefingSection {
  switch (kind) {
    case 'resolution':
      return 'Quietly resolved';
    case 'decision':
    case 'progress':
    case 'reversal':
      return 'What moved';
    default:
      return 'Worth knowing';
  }
}

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

/** See `generate.ts`: past this, `toISOString()` throws over a cosmetic defect. */
const MAX_EPOCH_MS = 8.64e15;

function isoOrUnknown(epochMs: number): string {
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_EPOCH_MS) return 'unknown';
  return new Date(epochMs).toISOString();
}

/** A claim the template produced, ready to be ordered and persisted. */
interface TemplateClaim {
  section: BriefingSection;
  /** Redacted (SEC-5), marker-free. Safe to render. */
  text: string;
  /** An artifact id proven to exist in the graph. Never empty. */
  citationArtifactId: string;
  /** The delta this claim was rendered from, for `briefing_claims.delta_id`. */
  deltaId: string;
  /** Rank position, used as the within-section tiebreaker. */
  arrival: number;
}

/** One rendered bullet of the markdown body. */
interface NarrativeClaim {
  section: string;
  text: string;
  citationArtifactId: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * A template render's outcome.
 *
 * Extends {@link BriefingGenerationResult} rather than replacing it so the
 * fallback is a drop-in for the generator at every call site — the scheduler and
 * the IPC handler read `briefingId` / `claimsAccepted` / `partial` / `mode` and
 * neither needs to know which branch produced them.
 */
export interface TemplateBriefingResult extends BriefingGenerationResult {
  /** Always `'template'` here. This is the signal the UI renders as a banner. */
  mode: 'template';
  /** Human-readable label: {@link SIMPLIFIED_BRIEFING_LABEL}. */
  label: string;
  /** Why the template ran. */
  reason: TemplateReason;
  /** True when the window held no tip deltas and no open obligations. */
  nothingToReport: boolean;
  /** Deltas skipped because none of their citations resolve in the graph. */
  claimsDropped: number;
}

/** The result of running the whole {@link FALLBACK_CHAIN}. */
export interface FallbackBriefingResult extends BriefingGenerationResult {
  /** Which chain step produced the content the user will read. */
  step: FallbackChainStep['name'];
  /** Human-readable label for this briefing. */
  label: string;
  /** Present only when the template contributed anything. */
  reason?: TemplateReason;
  /** How many claims the deterministic template contributed. 0 on the happy path. */
  templateClaims: number;
}

/** Per-call options for {@link TemplateBriefingRenderer.renderTemplate}. */
export interface RenderTemplateOptions {
  /** Id to render under, instead of minting one. Empty string is treated as absent. */
  briefingId?: string;
  /** Recorded on the `ai_calls` row. Defaults to `'requested'`. */
  reason?: TemplateReason;
  /**
   * Called once per claim the template produces, in narrative order.
   *
   * The same claim-level hook the streamed path offers (§12.2), so a renderer
   * that subscribed to `briefing:chunk` still paints something in template mode.
   * Notification only: a throwing subscriber changes neither what is stored nor
   * what the result reports.
   */
  onClaimAccepted?: (chunk: AcceptedClaimChunk) => void;
}

/** Optional wiring for {@link TemplateBriefingRenderer}. */
export interface TemplateRendererOptions {
  /** Directory for the trace JSONL sink. Tests should pass an absolute temp dir. */
  logsDir?: string;
}

/** What {@link TemplateBriefingRenderer.appendTemplateRemainder} reports back. */
export interface TemplateRemainderResult {
  /** Claims the template contributed on top of the model's. */
  appended: number;
  /**
   * The briefing's mode AFTER the top-up: `'template'` when the model
   * contributed nothing at all and the template wrote the whole page,
   * `'llm'` when the model's claims are still the bulk of it.
   */
  mode: BriefingMode;
  narrativePath: string;
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

/**
 * Builds a briefing out of stored rows, with no inference.
 *
 * ---------------------------------------------------------------------------
 * STRUCTURAL GUARANTEE — READ BEFORE ADDING A CONSTRUCTOR PARAMETER.
 *
 * No dependency of this class may expose `generateJson`, `generateStream` or
 * `embed`, and none may wrap something that does. The point of the fallback is
 * that it works when the model does not; a class that *could* reach for one
 * would eventually be changed to, and the failure would surface as a hang on the
 * exact day the user most needs a briefing. `test/template.test.ts` walks this
 * instance's own fields and fails if any of them looks like a model client.
 * ---------------------------------------------------------------------------
 */
export class TemplateBriefingRenderer {
  private readonly clock: Clock;
  private readonly logsDir: string;

  /**
   * @param deltas - D-6 store. Read tip-only, via `current_state_deltas`.
   * @param pending - Open obligations; the "Waiting on you" source.
   * @param briefings - Briefing + claim persistence.
   * @param graph - Artifact existence (AC-2) and the ranker's structural facts.
   * @param watermarks - Read-only, for the OI-1 disclosure count.
   * @param aiCalls - Telemetry sink; one layer-3 row per template render.
   * @param config - `ranking.*` weights (FR-5). `budgets.*` is unused: nothing
   *   here can run long, so there is no deadline to enforce.
   * @param narrativeDir - Root under which `briefings/<id>.md` is written.
   * @param clock - Injected time source; nothing here calls `Date.now()`.
   * @param options - Trace sink location.
   */
  constructor(
    private readonly deltas: DeltasRepo,
    private readonly pending: PendingItemsRepo,
    private readonly briefings: BriefingsRepo,
    private readonly graph: GraphRepo,
    private readonly watermarks: WatermarkRepo,
    private readonly aiCalls: AiCallsRepo,
    private readonly config: AppConfig,
    private readonly narrativeDir: string,
    clock: Clock = systemClock,
    options: TemplateRendererOptions = {},
  ) {
    this.clock = clock;
    this.logsDir = options.logsDir ?? 'logs';
  }

  /**
   * Render one briefing over `[windowStart, windowEnd)` from stored rows only.
   *
   * Never rejects. Writes one `briefings` row (mode `'template'`), one `ai_calls`
   * row, one markdown file, and one `briefing_claims` row per claim whose
   * citation resolves.
   */
  async renderTemplate(
    window: BriefingWindow,
    options: RenderTemplateOptions = {},
  ): Promise<TemplateBriefingResult> {
    // `async` for call-site symmetry with `BriefingGenerator.generate` — the
    // orchestrator awaits either one — not because anything here is deferred.
    // Every read below is synchronous SQLite; every write is synchronous fs.
    await Promise.resolve();

    const trace = startTrace(this.clock, this.logsDir);
    const generatedAt = this.clock.now();
    const reason = options.reason ?? 'requested';

    const briefingId =
      options.briefingId !== undefined && options.briefingId !== '' ? options.briefingId : newId();
    const narrativePath = join(this.narrativeDir, 'briefings', `${briefingId}.md`);

    // OI-1, read before any work, exactly as the LLM path does: the number has
    // to describe the backlog this briefing was built against.
    const threadsStillProcessing = this.watermarks.countPendingSynthesis();

    // ---- stage 1: read ------------------------------------------------------
    const readSpan = trace.span('retrieval');
    const tips = this.deltas.currentForWindow(window.windowStart, window.windowEnd);
    const openByDelta = this.openPendingByDelta();
    readSpan.end();

    // ---- stage 2: rank and render ------------------------------------------
    const assemblySpan = trace.span('assembly');
    const ranked = this.rank(tips, openByDelta);
    const claims = this.buildClaims(ranked, openByDelta);
    const candidates = countCandidates(ranked, openByDelta);
    assemblySpan.end();

    const nothingToReport = claims.length === 0 && candidates === 0;

    // Reuse rather than clobber: only reachable when a caller renders twice
    // under one id. The row's `mode` then stays whatever the first write said,
    // which is preferable to a primary-key error escaping a never-throws path.
    if (this.briefings.getById(briefingId) === undefined) {
      this.briefings.create({
        briefingId,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        generatedAt,
        mode: 'template',
        narrativePath,
        deltaIds: ranked.map((delta) => delta.deltaId),
        threadsStillProcessing,
      });
    }

    // ---- stage 3: persist ---------------------------------------------------
    const citationSpan = trace.span('citation');
    claims.forEach((claim, ordinal) => {
      this.briefings.addClaim({
        briefingId,
        ordinal,
        section: claim.section,
        text: claim.text,
        citationArtifactId: claim.citationArtifactId,
        deltaId: claim.deltaId,
      });
      this.announce(options.onClaimAccepted, claim);
    });
    citationSpan.end();

    writeNarrativeFile(narrativePath, {
      window,
      claims,
      threadsStillProcessing,
      banner: templateBanner(reason),
      ...(nothingToReport ? { footnote: NOTHING_TO_REPORT_NOTE } : {}),
    });

    const timings = trace.stageTimings();
    const latencyMs = this.clock.now() - generatedAt;
    // `firstTokenMs` is 0 because there were no tokens. Recorded rather than
    // left null so a latency dashboard can tell "the template answered instantly"
    // apart from "this briefing never reported".
    this.briefings.recordTimings(briefingId, 0, latencyMs);
    // One layer-3 row, on every path — the same audit guarantee the LLM path
    // makes. `model` names no model, because none ran.
    this.aiCalls.log({
      traceId: trace.id,
      layer: 3,
      model: TEMPLATE_MODEL,
      promptVersion: TEMPLATE_PROMPT_VERSION,
      latencyMs,
      outcome: OUTCOME_BY_REASON[reason],
    });
    trace.finish();

    return {
      briefingId,
      traceId: trace.id,
      mode: 'template',
      label: SIMPLIFIED_BRIEFING_LABEL,
      reason,
      claimsAccepted: claims.length,
      claimsDropped: Math.max(0, candidates - claims.length),
      // Always 0: the template renders stored delta summaries verbatim and runs
      // no model, so there is no generated prose for the F-4 grounding check to
      // have an opinion about.
      groundingFailures: 0,
      // No model ran, so there was no NDJSON stream to malform.
      malformedLines: 0,
      // No citation GATE ran: the template only renders rows whose citations
      // already resolve in the graph, so its drops have exactly one cause and it
      // is not one of the gate's four reasons. Reporting `{}` rather than
      // inventing a reason keeps the breakdown meaning what it says (Task 4.4).
      claimsDroppedByReason: {},
      // No model produced prose, so there is nothing for the SEC-5 output scan
      // to have found. Delta summaries were redacted on the way IN.
      redactionCount: 0,
      redactionKinds: [],
      threadsStillProcessing,
      // A template render is never truncated: it reads every row it is going to
      // read before it writes anything. `partial` stays false even for an empty
      // window, because "there was nothing" is a complete answer.
      partial: false,
      outcome: 'template',
      nothingToReport,
      narrativePath,
      timings,
    };
  }

  /**
   * Top up a briefing whose LLM stream died part-way, without duplicating it.
   *
   * The generator cannot say which deltas it had reached before the connection
   * dropped — a stream is tokens, not a cursor — so coverage is inferred from
   * the claims that DID land: any delta one of whose citation ids is already
   * cited by a stored claim is treated as narrated, and the rest are rendered
   * from the template. That is conservative in the safe direction: the worst
   * case is a delta the model mentioned in passing being left out, never the
   * same state change stated twice on one page.
   *
   * Does **not** write an `ai_calls` row: the generator already wrote this run's
   * single layer-3 row (`outcome: 'stream_error'`), and a second row would break
   * the one-row-per-generation audit invariant.
   *
   * Never rejects. The caller marks the briefing `partial` — the model's half is
   * genuinely incomplete, and the user is entitled to know that even though the
   * page looks full.
   */
  async appendTemplateRemainder(
    briefingId: string,
    window: BriefingWindow,
    options: { onClaimAccepted?: (chunk: AcceptedClaimChunk) => void } = {},
  ): Promise<TemplateRemainderResult> {
    await Promise.resolve();

    const existing = this.briefings.listClaims(briefingId);
    const covered = new Set(
      existing
        .map((claim) => claim.citationArtifactId)
        .filter((id): id is string => id !== null && id !== ''),
    );

    const tips = this.deltas.currentForWindow(window.windowStart, window.windowEnd);
    const openByDelta = this.openPendingByDelta();
    const remaining = this.rank(tips, openByDelta).filter(
      (delta) => !delta.citationArtifactIds.some((id) => covered.has(id)),
    );

    const claims = this.buildClaims(remaining, openByDelta);
    let ordinal = existing.reduce((max, claim) => Math.max(max, claim.ordinal + 1), 0);

    for (const claim of claims) {
      this.briefings.addClaim({
        briefingId,
        ordinal,
        section: claim.section,
        text: claim.text,
        citationArtifactId: claim.citationArtifactId,
        deltaId: claim.deltaId,
      });
      ordinal += 1;
      this.announce(options.onClaimAccepted, claim);
    }

    // The model contributed nothing readable, so the template wrote the whole
    // page and the row must say so — otherwise the UI suppresses the "Simplified
    // briefing" banner for a briefing no model touched.
    const wroteEverything = existing.length === 0;
    if (wroteEverything && this.briefings.getById(briefingId) !== undefined) {
      this.briefings.markTemplateMode(briefingId);
    }

    const row = this.briefings.getById(briefingId);
    const narrativePath =
      row?.narrativePath ?? join(this.narrativeDir, 'briefings', `${briefingId}.md`);

    // Rewritten from the database rather than appended to on disk, so the file
    // and `briefing_claims` cannot disagree about what the briefing said. The
    // stored text is already marker-free and redacted, and each row's primary
    // citation is restored as a marker; a claim that cited several artifacts
    // keeps only the primary one in the file, which is the one the row links.
    writeNarrativeFile(narrativePath, {
      window,
      claims: fromRows(this.briefings.listClaims(briefingId)),
      threadsStillProcessing: row?.threadsStillProcessing ?? 0,
      banner: wroteEverything ? templateBanner('stream_error') : COMPLETED_REMAINDER_BANNER,
    });

    return {
      appended: claims.length,
      mode: wroteEverything ? 'template' : 'llm',
      narrativePath,
    };
  }

  // -------------------------------------------------------------------------
  // Claim construction
  // -------------------------------------------------------------------------

  /** Open obligations, bucketed by the delta they hang off. */
  private openPendingByDelta(): Map<string, PendingItem[]> {
    const byDelta = new Map<string, PendingItem[]>();
    for (const item of this.pending.listOpen()) {
      const bucket = byDelta.get(item.deltaId);
      if (bucket === undefined) byDelta.set(item.deltaId, [item]);
      else bucket.push(item);
    }
    return byDelta;
  }

  /**
   * Order the window's tips with the SAME ranker the LLM path uses (FR-5).
   *
   * Reused rather than reinvented on purpose: a fallback briefing that ordered
   * its items differently would teach the user that the two modes disagree about
   * what matters, which is a worse failure than the fallback itself.
   */
  private rank(
    tips: readonly StateDelta[],
    openByDelta: ReadonlyMap<string, PendingItem[]>,
  ): StateDelta[] {
    const selfPersonId = this.graph.getSelf()?.personId;
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
   * Turn ranked deltas into sectioned, cited claims.
   *
   * A delta with an open obligation is narrated by that obligation, under
   * "Waiting on you", and is NOT repeated under its kind's section: one state
   * change must produce one line, or the fallback reads like a stutter.
   */
  private buildClaims(
    ranked: readonly StateDelta[],
    openByDelta: ReadonlyMap<string, PendingItem[]>,
  ): TemplateClaim[] {
    const claims: TemplateClaim[] = [];

    ranked.forEach((delta, arrival) => {
      const open = openByDelta.get(delta.deltaId) ?? [];

      if (open.length > 0) {
        for (const item of open) {
          // The item's own citation first: it is the more specific fact, and it
          // need not be one of the delta's. The delta's ids follow as a defensive
          // fallback — `pending_items.citation_artifact_id` is NOT NULL in the
          // schema, but `PendingItem.citationArtifactId` is nullable in the
          // domain type, and an obligation is worth stating whenever *something*
          // can prove where it came from.
          const citation = this.resolveCitation([
            item.citationArtifactId,
            ...delta.citationArtifactIds,
          ]);
          if (citation === undefined) continue;
          claims.push({
            section: 'Waiting on you',
            text: sanitize(item.description),
            citationArtifactId: citation,
            deltaId: delta.deltaId,
            arrival,
          });
        }
        return;
      }

      const citation = this.resolveCitation(delta.citationArtifactIds);
      if (citation === undefined) return;
      claims.push({
        section: sectionForKind(delta.kind),
        text: sanitize(delta.summary),
        citationArtifactId: citation,
        deltaId: delta.deltaId,
        arrival,
      });
    });

    // Section order is the briefing's contract, imposed here rather than
    // inherited from the ranking, so the four headings always read in order
    // while the stakes ranking survives as the within-section order.
    return claims
      .filter((claim) => claim.text !== '')
      .sort(
        (a, b) =>
          (SECTION_ORDER.get(a.section) ?? BRIEFING_SECTIONS.length) -
            (SECTION_ORDER.get(b.section) ?? BRIEFING_SECTIONS.length) || a.arrival - b.arrival,
      );
  }

  /**
   * First id in `candidates` that names an artifact the graph actually holds.
   *
   * `briefing_claims.citation_artifact_id` is a NOT NULL foreign key, so a claim
   * whose citations do not resolve is not merely unwise, it is unstorable. AC-2
   * is satisfied by never building such a claim, exactly as the citation gate
   * satisfies it for model output.
   */
  private resolveCitation(candidates: readonly (string | null)[]): string | undefined {
    for (const candidate of candidates) {
      if (candidate === null || candidate === '') continue;
      if (this.graph.getArtifact(candidate) !== undefined) return candidate;
    }
    return undefined;
  }

  /** Notify a live subscriber. Never throws: a broken renderer is not a failure. */
  private announce(
    notify: ((chunk: AcceptedClaimChunk) => void) | undefined,
    claim: TemplateClaim,
  ): void {
    if (notify === undefined) return;
    try {
      notify({
        section: claim.section,
        text: claim.text,
        citationArtifactIds: [claim.citationArtifactId],
      });
    } catch (error) {
      console.error('[layer3/template] claim subscriber failed', error);
    }
  }
}

// ---------------------------------------------------------------------------
// Narrative text
// ---------------------------------------------------------------------------

/**
 * Stated in the file itself, so an exported markdown briefing is self-explaining.
 *
 * Requirement: an empty window must read as an answer, not as a malfunction. A
 * briefing with four empty headings and no explanation looks broken, and a user
 * who suspects the tool is broken checks the sources by hand — which is the
 * entire cost the product exists to remove.
 */
const NOTHING_TO_REPORT_NOTE =
  '_Nothing to report for this window: no state changes were recorded and nothing is waiting on you._';

const COMPLETED_REMAINDER_BANNER =
  `_${COMPLETED_BRIEFING_LABEL}. The local model stopped part-way through; ` +
  'the remaining items below were assembled directly from recorded state changes._';

/** The banner a template render leads with, worded for the reason it ran. */
function templateBanner(reason: TemplateReason): string {
  const why =
    reason === 'preflight_failed'
      ? 'the local model was unavailable'
      : reason === 'generation_failed'
        ? 'the local model failed'
        : reason === 'stream_error'
          ? 'the local model stopped responding'
          : 'it was requested directly';
  return (
    `_${SIMPLIFIED_BRIEFING_LABEL} — ${why}, so this was assembled directly from ` +
    `recorded state changes. Every line below is cited. ${TEMPLATE_REMEDY_HINT}_`
  );
}

/** Project stored claim rows onto the narrative's bullet shape. */
function fromRows(rows: readonly BriefingClaim[]): NarrativeClaim[] {
  return rows
    .filter((row): row is BriefingClaim & { citationArtifactId: string } =>
      typeof row.citationArtifactId === 'string' && row.citationArtifactId !== '',
    )
    .map((row) => ({
      section: row.section,
      text: row.text,
      citationArtifactId: row.citationArtifactId,
    }));
}

/**
 * Write `briefings/<id>.md`.
 *
 * All four headings are emitted, empty or not, so the shape of a template
 * briefing is the shape of an LLM one — the user should not have to relearn the
 * page because the model was down.
 */
function writeNarrativeFile(
  path: string,
  input: {
    window: BriefingWindow;
    claims: readonly NarrativeClaim[];
    threadsStillProcessing: number;
    banner: string;
    footnote?: string;
  },
): void {
  const lines: string[] = [
    '# Briefing',
    '',
    `_Window: ${isoOrUnknown(input.window.windowStart)} → ${isoOrUnknown(input.window.windowEnd)}_`,
    '',
    input.banner,
    '',
  ];

  // OI-1 disclosure, stated before the content rather than in a footnote: a
  // briefing the user cannot tell is incomplete is worse than a short one.
  if (input.threadsStillProcessing > 0) {
    lines.push(
      `_${input.threadsStillProcessing} thread(s) still had unsynthesized activity when this briefing was generated._`,
      '',
    );
  }
  if (input.footnote !== undefined) {
    lines.push(input.footnote, '');
  }

  for (const section of BRIEFING_SECTIONS) {
    lines.push(`## ${section}`, '');
    for (const claim of input.claims) {
      if (claim.section !== section) continue;
      lines.push(`- ${claim.text} [artifact:${claim.citationArtifactId}]`);
    }
    lines.push('');
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n').trimEnd()}\n`, 'utf8');
}

/**
 * How many claims these deltas *would* produce if every citation resolved.
 *
 * The difference against what was actually built is the drop count — the
 * fallback's equivalent of the citation gate's `claimsDropped`, and the number
 * that separates "the window was quiet" from "the window had content we could
 * not prove".
 */
function countCandidates(
  ranked: readonly StateDelta[],
  openByDelta: ReadonlyMap<string, PendingItem[]>,
): number {
  return ranked.reduce((total, delta) => {
    const open = openByDelta.get(delta.deltaId) ?? [];
    return total + (open.length > 0 ? open.length : 1);
  }, 0);
}

/**
 * Collapse whitespace and run the SEC-5 output scan.
 *
 * Delta summaries and pending descriptions are themselves model output that was
 * stored earlier, so they can restate a secret the input-side redactor let
 * through — the fallback is not exempt from the output-side scan just because no
 * model ran *this* time.
 */
function sanitize(text: string): string {
  return redactOutput(text.replace(/\s+/g, ' ').trim()).text;
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

/** Probe signature, so a test can supply a preflight result without a socket. */
export type PreflightProbe = (
  baseUrl: string,
  chatModel: string,
  embedModel: string,
) => Promise<PreflightResult>;

/** Per-call options for {@link generateWithFallback}. */
export interface FallbackOptions {
  /** Id to generate under; the IPC path mints this before the renderer subscribes. */
  briefingId?: string;
  /** Real-time claim hook, honoured on BOTH branches of the chain. */
  onClaimAccepted?: (chunk: AcceptedClaimChunk) => void;
  /** Preflight override. Defaults to the real {@link preflight}. */
  probe?: PreflightProbe;
}

/**
 * Run the whole {@link FALLBACK_CHAIN}: local model, then local code.
 *
 * Never rejects. That is the point of the function — every branch below ends in
 * a briefing the user can read, including the branches where the model is not
 * installed, not running, or dies halfway through a sentence.
 *
 * The order of the checks is deliberate:
 *
 * 1. **Preflight first.** A cold start (Ollama not running, model not pulled) is
 *    the common case and is answerable with one cheap `GET /api/tags` — far
 *    cheaper than assembling a prompt and then waiting out a connection timeout.
 * 2. **Then generate, inside a `try`.** `generate()` rejects only when retrieval
 *    itself failed, in which case nothing was published for this window and a
 *    template render is free to take the id over.
 * 3. **Then inspect the outcome.** `'stream_error'` / `'error'` mean the local
 *    model failed, so the template fills in the deltas the surviving claims did
 *    not cover. `'budget_exceeded'` is left exactly as the generator left it: a
 *    deliberate §7.8 truncation is not a failure and must not be topped up.
 *
 * @param generator - The real LLM path (chain step 1).
 * @param templateRenderer - The deterministic path (chain step 2).
 * @param ollamaBaseUrl - Loopback base URL, for the preflight probe.
 * @param chatModel - Chat model preflight must find installed.
 * @param embedModel - Embedding model preflight must find installed.
 * @param window - Half-open briefing window.
 * @param options - Pre-minted id, claim hook, probe override.
 */
export async function generateWithFallback(
  generator: Pick<BriefingGenerator, 'generate'>,
  templateRenderer: TemplateBriefingRenderer,
  ollamaBaseUrl: string,
  chatModel: string,
  embedModel: string,
  window: BriefingWindow,
  options: FallbackOptions = {},
): Promise<FallbackBriefingResult> {
  const briefingId =
    options.briefingId !== undefined && options.briefingId !== '' ? options.briefingId : newId();
  const probe = options.probe ?? preflight;
  const notify =
    options.onClaimAccepted === undefined ? {} : { onClaimAccepted: options.onClaimAccepted };

  // ---- step 1: is the local model even there? ------------------------------
  let ready: PreflightResult;
  try {
    ready = await probe(ollamaBaseUrl, chatModel, embedModel);
  } catch (error) {
    // `preflight` is documented as never rejecting; a probe override might.
    // Either way an unanswerable probe means an unavailable model, not a crash.
    console.error('[layer3/fallback] preflight threw', error);
    ready = { ok: false, reason: 'unreachable', message: describe(error) };
  }

  if (!ready.ok) {
    return asFallback(
      await templateRenderer.renderTemplate(window, {
        briefingId,
        reason: 'preflight_failed',
        ...notify,
      }),
    );
  }

  // ---- step 1 (cont.): generate --------------------------------------------
  let result: BriefingGenerationResult;
  try {
    result = await generator.generate(window, { briefingId, ...notify });
  } catch (error) {
    // Retrieval failed, so nothing was written for this window and the id is
    // still free. The user asked what they missed; "the vector store is down" is
    // not an answer, and the deltas are sitting right there on disk.
    console.error('[layer3/fallback] generation failed', briefingId, error);
    return asFallback(
      await templateRenderer.renderTemplate(window, {
        briefingId,
        reason: 'generation_failed',
        ...notify,
      }),
    );
  }

  // ---- step 2: did the model die mid-sentence? -----------------------------
  if (result.outcome === 'stream_error' || result.outcome === 'error') {
    const remainder = await templateRenderer.appendTemplateRemainder(
      result.briefingId,
      window,
      notify,
    );

    return {
      ...result,
      mode: remainder.mode,
      // The generator already set this on a stream failure; restated because
      // "incomplete" is the claim this combined result makes.
      partial: true,
      step: 'template',
      label: result.claimsAccepted > 0 ? COMPLETED_BRIEFING_LABEL : SIMPLIFIED_BRIEFING_LABEL,
      reason: 'stream_error',
      claimsAccepted: result.claimsAccepted + remainder.appended,
      templateClaims: remainder.appended,
      narrativePath: remainder.narrativePath,
    };
  }

  return { ...result, step: 'ollama', label: LLM_BRIEFING_LABEL, templateClaims: 0 };
}

/** Widen a template result into the chain's result shape. */
function asFallback(result: TemplateBriefingResult): FallbackBriefingResult {
  return {
    ...result,
    step: 'template',
    label: result.label,
    reason: result.reason,
    templateClaims: result.claimsAccepted,
  };
}

/** Render an unknown thrown value as something a log can carry. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
