/**
 * Layer 2 — state synthesis with D-6 versioning.
 *
 * This module turns "a thread went quiet" into "here is what changed, and here
 * is the artifact that proves it". It is the highest-consequence generation step
 * in the pipeline, and three of its properties are load-bearing:
 *
 * 1. **Silence is the default.** A synthesizer that emits a delta per thread is
 *    a bug, not an eager feature: every delta it invents floods the briefing and
 *    costs the user more than the state change it missed (R-3). `{meaningful:
 *    false}` writes nothing at all — no delta, no pending item.
 *
 * 2. **Citations are gated against the retrieval allowlist.** The artifact ids
 *    returned by {@link RetrievalService.forThread} are the *only* ids this call
 *    may cite. A meaningful delta with zero citations, or with a single citation
 *    that retrieval never produced, is dropped whole. Filtering the bad ids out
 *    and keeping the summary is deliberately NOT done: a sentence grounded
 *    partly in an artifact the model made up is exactly the AC-2 failure this
 *    gate exists to prevent, and it would surface three layers downstream where
 *    nothing points back here.
 *
 * 2b. **Obligations are derived, not transcribed.** A `pending_item` in the
 *    model's response is a proposal, not a row. `pending.ts` decides whether it
 *    becomes one — see that module for the FR-4 rules it enforces.
 *
 * 3. **Thread content is untrusted (T-1).** Every retrieved chunk goes through
 *    `wrapUntrusted` + `assemblePrompt`. The branded `WrappedContent` type makes
 *    that structural rather than conventional — a raw string cannot reach the
 *    prompt's untrusted slot.
 *
 * ### What this module deliberately does NOT do
 *
 * It never calls `WatermarkRepo.markSynthesized`. `DebounceScheduler.run()`
 * already calls it on a resolved `onSynthesize` (see `scheduler.ts`), and
 * calling it here as well would be a double write, not redundant safety: the
 * scheduler re-reads the clock after synthesis returns so the watermark records
 * when the cycle *finished*, and it owns the "next unsynthesized event" value.
 * The repo is still injected so that the ownership boundary is visible at the
 * construction site rather than buried in this comment.
 *
 * ### Failure policy
 *
 * A rejected `synthesize()` leaves the watermark armed and the scheduler retries
 * it (up to `maxAttempts`), so only *transient* faults may reject: the model
 * call itself, or retrieval blowing up. Everything the model got wrong —
 * unparseable JSON, a bad shape, a forged citation — resolves normally after
 * writing nothing, because retrying an identical prompt would produce an
 * identical rejection and burn the thread's attempt budget for nothing.
 *
 * Exactly one `ai_calls` row (layer 2) is written per call, on every path,
 * including the paths where no model call happened at all — the audit trail's
 * value comes from being able to count how often each outcome occurs.
 */

import { newId, systemClock, type Clock, type DeltaKind } from '@cr/core';
import type { AiCallsRepo, DeltasRepo, PendingItemsRepo, WatermarkRepo } from '@cr/store';
import type { OllamaClient } from '../ollama.js';
import type { RetrievalService, RetrievedChunk } from '../retrieval.js';
import { assemblePrompt } from '../prompt/assemble.js';
import { wrapUntrusted } from '../prompt/wrap.js';
import {
  derivePendingItem,
  resolvePendingItemsForSupersededDelta,
  waitsOnSelf,
} from './pending.js';

/**
 * The retrieval capability this module needs.
 *
 * Typed as a `Pick` of the real service rather than the class itself so a test
 * can supply a hand-built allowlist: `RetrievalService` carries private state,
 * which makes an object literal structurally incompatible with the class type.
 * A real `RetrievalService` satisfies this alias unchanged.
 */
export type ThreadRetriever = Pick<RetrievalService, 'forThread'>;

/**
 * Outcome vocabulary recorded on the `ai_calls` row.
 *
 * Split finer than `ok`/`error` on purpose: "the model declined" and "the model
 * forged a citation" are both non-writes, and only the second one is a problem.
 */
export type SynthesisOutcome =
  /** A delta was written. */
  | 'ok'
  /** The model said nothing meaningful happened — the expected common case. */
  | 'not_meaningful'
  /** Retrieval returned no citable context, so no model call was made. */
  | 'no_context'
  /** The model emitted something that was not JSON. */
  | 'parse_error'
  /** Valid JSON, but not the shape the schema requires. */
  | 'schema_error'
  /** `meaningful: true` with an empty `citation_artifact_ids`. */
  | 'no_citations'
  /** A cited artifact id was not in the retrieval allowlist. */
  | 'uncited'
  /** Retrieval itself threw. Rethrown to the scheduler. */
  | 'retrieval_error'
  /** The model call threw or returned non-2xx. Rethrown to the scheduler. */
  | 'error';

/** The four categories a delta may take; anything else is a schema error. */
const DELTA_KINDS = new Set<string>([
  'decision',
  'progress',
  'reversal',
  'resolution',
] satisfies DeltaKind[]);

/**
 * System prompt for `layer2-synthesize.v1`.
 *
 * `config/prompts/layer2-synthesize.v1.md` is the human-readable source of truth
 * and the thing `promptVersion` names; this constant is its executable form. The
 * template's `{{NONCE}}`/`{{CONTENT}}` placeholders and its untrusted-content
 * clause are omitted here because `wrapUntrusted` mints the nonce and
 * `assemblePrompt` appends `UNTRUSTED_SYSTEM_RULE` unconditionally — restating
 * them would let the rule and the delimiters drift apart.
 */
const SYSTEM_PROMPT = [
  'You determine whether a thread changed state in a way its participants would care about.',
  '',
  'Most threads do not contain a meaningful state change. If nothing meaningful changed,',
  'return {"meaningful": false}. Do not invent significance.',
  '',
  'Meaningful means one of:',
  '  decision    — a choice was made or committed to',
  '  progress    — work visibly advanced past a prior state',
  '  reversal    — a previous decision or direction was undone or changed',
  '  resolution  — an open question, blocker, or obligation was closed out',
  '',
  'Not meaningful: restating what was already known, acknowledgements, scheduling chatter,',
  'opinions without commitment, automation noise, or a thread that is merely still active.',
  '',
  'Rules:',
  '- Prefer {"meaningful": false}. Returning it is always an acceptable answer.',
  '- summary is exactly one sentence, past tense, factual, and free of adjectives of importance.',
  '- Every claim must be grounded in the provided content. If you cannot point to the artifact',
  '  that supports the summary, the answer is {"meaningful": false}.',
  '- citation_artifact_ids must be non-empty whenever meaningful is true, and must contain',
  '  only artifact ids that appear in the provided content. Do not invent artifact ids.',
  '- pending_item is optional. Include it only when a specific, named obligation is now',
  '  outstanding. Omit it or set it to null otherwise. An unclear or implied obligation is',
  '  not a pending item.',
  '- pending_item.waiting_on names who owes that obligation: "self" when the user owes it,',
  '  otherwise the party who does. Always set it when you return a pending_item. An',
  '  obligation the user is waiting on someone else for is recorded, not acted on.',
  '- confidence is your own calibrated certainty, from 0.0 to 1.0.',
  '- Return JSON only. No markdown fences, no commentary, no preamble, no trailing text.',
].join('\n');

/**
 * Trusted instructions, placed AFTER the fenced block so the model reads the
 * real task last. Never interpolate artifact text into this string.
 *
 * The allowlist is intentionally not restated here: the ids already appear as
 * labels inside the fenced block, which is what the prompt means by "appears in
 * the provided content", and copying store-derived strings into the trusted half
 * of a prompt is the habit that eventually smuggles content past the fence.
 */
const INSTRUCTIONS = [
  'Return the JSON object described by this schema, and nothing else:',
  '',
  '{ "meaningful": true,',
  '  "kind": "decision|progress|reversal|resolution",',
  '  "summary": "one sentence, past tense",',
  '  "confidence": 0.0,',
  '  "citation_artifact_ids": ["..."],',
  '  "pending_item": { "description": "...", "confidence": 0.0, "waiting_on": "self",',
  '                    "citation_artifact_id": "..." } }',
  '',
  'If nothing meaningful changed, return exactly {"meaningful": false} with no other field.',
  'Every id in citation_artifact_ids must be an artifact_id shown in the block above.',
  'JSON only.',
].join('\n');

/** Name reported to `generateJson` for error attribution only. */
const SCHEMA_NAME = 'layer2_synthesis_v1';

/** A validated model response, ready to be written. */
interface AcceptedSynthesis {
  kind: DeltaKind;
  summary: string;
  confidence: number;
  citationArtifactIds: string[];
  pending: AcceptedPendingItem | undefined;
}

/** A validated `pending_item`, if the model reported a usable one. */
interface AcceptedPendingItem {
  description: string;
  confidence: number;
  citationArtifactId: string;
  /**
   * Whose obligation this is, per `waiting_on`. Carried through rather than
   * acted on here — `derivePendingItem` owns the FR-4 decision.
   */
  waitingOnSelf: boolean;
}

/** Narrows to a plain object without asserting anything about its fields. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A non-blank string, or `undefined`. Blank is treated as absent, not as data. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * A finite confidence clamped into `[0, 1]`, or `undefined` when absent.
 *
 * Clamping rather than rejecting is safe here: an out-of-range confidence is a
 * calibration bug, not a grounding one, and it cannot fabricate a citation.
 */
function asConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/**
 * Largest absolute epoch-ms value the ECMAScript Date type can represent.
 * Beyond it `toISOString()` throws `RangeError: Invalid time value`.
 */
const MAX_EPOCH_MS = 8.64e15;

/**
 * ISO timestamp for a chunk, or a placeholder when the epoch value is junk.
 *
 * `Number.isFinite` alone is NOT a sufficient guard: `1e20` is finite but out of
 * Date's representable range, so `new Date(1e20).toISOString()` throws. That
 * throw would escape `synthesize()` *before* the `ai_calls` row is written —
 * breaking the one-row-per-call audit guarantee — and be counted by the
 * scheduler as a transient failure, so a single artifact with a corrupt
 * timestamp would burn the thread's whole retry budget and park it forever.
 * A bad timestamp is cosmetic; it must never be able to do that.
 */
function isoOrUnknown(occurredAt: number): string {
  if (!Number.isFinite(occurredAt) || Math.abs(occurredAt) > MAX_EPOCH_MS) return 'unknown';
  return new Date(occurredAt).toISOString();
}

/**
 * Renders retrieved chunks as one untrusted payload.
 *
 * Each chunk is labelled with its `artifact_id` because that label is what the
 * model is told to cite. The whole rendering — labels included — is fenced by
 * `wrapUntrusted`, so a chunk whose text imitates a label cannot escape into the
 * trusted half of the prompt.
 */
function renderContext(chunks: readonly RetrievedChunk[]): string {
  return chunks
    .map(
      (chunk) =>
        `[artifact_id: ${chunk.artifactId}] [thread: ${chunk.threadKey}] ` +
        `[at: ${isoOrUnknown(chunk.occurredAt)}]\n${chunk.text}`,
    )
    .join('\n\n');
}

export class Layer2Synthesizer {
  private readonly clock: Clock;

  /**
   * @param ollama - Local inference client.
   * @param retrieval - Supplies context AND the citation allowlist.
   * @param deltas - D-6 store; derives `version`/`supersedes` itself.
   * @param pending - Obligation store.
   * @param watermarks - Injected to make the ownership boundary explicit: this
   *   class never writes to it. The scheduler closes the synthesis cycle (see
   *   the module comment).
   * @param aiCalls - Telemetry sink; exactly one row per `synthesize()` call.
   * @param model - Chat model name, recorded on every delta and `ai_calls` row.
   * @param promptVersion - e.g. `layer2-synthesize.v1`; recorded on every delta.
   * @param clock - Injected time source; nothing here calls `Date.now()`.
   */
  constructor(
    private readonly ollama: OllamaClient,
    private readonly retrieval: ThreadRetriever,
    private readonly deltas: DeltasRepo,
    private readonly pending: PendingItemsRepo,
    private readonly watermarks: WatermarkRepo,
    private readonly aiCalls: AiCallsRepo,
    private readonly model: string,
    private readonly promptVersion: string,
    clock: Clock = systemClock,
  ) {
    this.clock = clock;
  }

  /**
   * Synthesize one thread. This IS the `DebounceScheduler`'s `onSynthesize`
   * callback: `onSynthesize: (threadKey, traceId) => synth.synthesize(threadKey, traceId)`.
   *
   * Resolves after writing at most one delta (plus at most one pending item),
   * and always after writing exactly one `ai_calls` row. Rejects only on a
   * transient fault, which the scheduler counts as a failed attempt and retries.
   *
   * @param threadKey - Thread to synthesize.
   * @param traceId - Correlation id to record on this call's `ai_calls` row
   *   (NFR-8). Added additively in Task 4.4: minting one internally, as this
   *   method used to do unconditionally, made a layer-2 row impossible to join
   *   to the trigger that caused it or to the briefing that consumed its delta.
   *   Omitted (or blank) still mints one, so every existing call site is valid.
   * @returns The {@link SynthesisOutcome} written to the `ai_calls` row, so the
   *   caller can tell "wrote a delta" (`'ok'`) from "nothing was meaningful"
   *   (`'not_meaningful'`) from every other non-write. Previously `void`, which
   *   made those indistinguishable to the scheduler.
   */
  async synthesize(threadKey: string, traceId?: string): Promise<SynthesisOutcome> {
    // A blank id is treated as absent: an empty `trace_id` would silently group
    // every such call together in the audit trail.
    const trace = traceId !== undefined && traceId !== '' ? traceId : newId();

    let context;
    try {
      context = await this.retrieval.forThread(threadKey);
    } catch (error) {
      // Documented as never throwing, but "documented" is not "enforced": a
      // silent zero-row outcome here would look identical to a quiet thread.
      this.log(trace, 0, 'retrieval_error');
      throw error;
    }

    // No citable context means no groundable claim. Skipping the model call is
    // not just an optimisation — a prompt with an empty allowlist can only be
    // answered with citations that would have to be rejected.
    if (context.chunks.length === 0) {
      this.log(trace, 0, 'no_context');
      return 'no_context';
    }

    // T-1: the ONLY route thread content takes into a prompt.
    const wrapped = wrapUntrusted(renderContext(context.chunks), `thread:${threadKey}`);
    const { system, prompt } = assemblePrompt({
      system: SYSTEM_PROMPT,
      wrappedContent: wrapped,
      instructions: INSTRUCTIONS,
    });

    let result;
    try {
      result = await this.ollama.generateJson<unknown>({ prompt, system, schemaName: SCHEMA_NAME });
    } catch (error) {
      this.log(trace, 0, 'error');
      throw error; // transient: the scheduler retries with the watermark still armed
    }

    if (result.value === null) {
      this.log(trace, result.latencyMs, 'parse_error', result.tokensIn, result.tokensOut);
      return 'parse_error';
    }

    const verdict = this.validate(result.value, context.chunks);
    if (typeof verdict === 'string') {
      this.log(trace, result.latencyMs, verdict, result.tokensIn, result.tokensOut);
      return verdict;
    }

    this.write(threadKey, verdict, context.chunks);
    this.log(trace, result.latencyMs, 'ok', result.tokensIn, result.tokensOut);
    return 'ok';
  }

  /**
   * Validates a parsed response against the schema and the citation allowlist.
   *
   * @returns the accepted synthesis, or the {@link SynthesisOutcome} explaining
   *   why nothing will be written. Returning a reason rather than throwing keeps
   *   "the model was wrong" off the scheduler's retry path.
   */
  private validate(
    value: unknown,
    chunks: readonly RetrievedChunk[],
  ): AcceptedSynthesis | SynthesisOutcome {
    const body = asRecord(value);
    if (body === undefined || typeof body['meaningful'] !== 'boolean') return 'schema_error';

    // The default path, and the one most threads must take.
    if (body['meaningful'] === false) return 'not_meaningful';

    const kind = asText(body['kind']);
    const summary = asText(body['summary']);
    const confidence = asConfidence(body['confidence']);
    if (kind === undefined || !DELTA_KINDS.has(kind)) return 'schema_error';
    if (summary === undefined || confidence === undefined) return 'schema_error';

    const raw = body['citation_artifact_ids'];
    if (!Array.isArray(raw)) return 'schema_error';

    const citations = raw.map(asText);
    // A non-string entry is a shape failure; an empty list is the model claiming
    // a state change it cannot point at. Both write nothing, but they are worth
    // telling apart in the audit trail.
    if (citations.some((id) => id === undefined)) return 'schema_error';
    const cited = citations as string[];
    if (cited.length === 0) return 'no_citations';

    // THE gate. `chunks` is the allowlist; anything else was invented.
    const allowed = new Set(chunks.map((chunk) => chunk.artifactId));
    if (cited.some((id) => !allowed.has(id))) return 'uncited';

    return {
      kind: kind as DeltaKind,
      summary,
      confidence,
      // De-duplicated, order preserved: a model repeating one id must not make
      // the delta look better-supported than it is.
      citationArtifactIds: [...new Set(cited)],
      pending: this.validatePending(body['pending_item'], allowed, confidence),
    };
  }

  /**
   * Validates the optional `pending_item`.
   *
   * A malformed obligation yields `undefined` rather than rejecting the whole
   * response: the state change is the valuable part and is independently
   * grounded, so discarding it over a bad sub-object would trade a real delta
   * for a speculative one.
   *
   * The citation is held to the same allowlist as the delta's — `pending_items.
   * citation_artifact_id` is what the UI links to, so an unresolvable id here is
   * as bad as an unresolvable one there.
   *
   * This method validates *shape*; whether the obligation is worth storing is
   * `pending.ts`'s call (Task 2.6). The two are kept apart so the FR-4 rules can
   * be exercised without driving a whole model response through them.
   */
  private validatePending(
    value: unknown,
    allowed: ReadonlySet<string>,
    fallbackConfidence: number,
  ): AcceptedPendingItem | undefined {
    const body = asRecord(value);
    if (body === undefined) return undefined;

    const description = asText(body['description']);
    const citationArtifactId = asText(body['citation_artifact_id']);
    if (description === undefined) return undefined;
    if (citationArtifactId === undefined || !allowed.has(citationArtifactId)) return undefined;

    return {
      description,
      // Inherits the delta's confidence when the model omits its own, so a
      // missing field cannot read as "certain" (or as zero).
      confidence: asConfidence(body['confidence']) ?? fallbackConfidence,
      citationArtifactId,
      waitingOnSelf: waitsOnSelf(body['waiting_on']),
    };
  }

  /**
   * Appends the delta, closes out anything it resolves, and derives its pending
   * item.
   *
   * Order matters. Resolution runs against the chain as it stood *before* this
   * delta, so a `resolution` that also raises a new obligation cannot close the
   * item it just created.
   */
  private write(
    threadKey: string,
    accepted: AcceptedSynthesis,
    chunks: readonly RetrievedChunk[],
  ): void {
    const delta = this.deltas.append({
      threadKey,
      // Left null on purpose. This column carries a FK into `artifacts`, while
      // the allowlist is chunk-derived and may name an artifact whose graph row
      // ingest has not written yet; a FK abort would reject a valid delta and be
      // retried into a duplicate. Nothing is lost — `citationArtifactIds` has no
      // FK and carries the full citation set.
      artifactId: null,
      summary: accepted.summary,
      kind: accepted.kind,
      confidence: accepted.confidence,
      sourceEventIds: this.lineageFor(accepted.citationArtifactIds, chunks),
      citationArtifactIds: accepted.citationArtifactIds,
      model: this.model,
      promptVersion: this.promptVersion,
      createdAt: this.clock.now(),
      // `version` and `supersedes` are the repo's to derive (D-6): it reads the
      // chain tip and inserts in one IMMEDIATE transaction.
    });

    // D-6 + rule 3: a `resolution` that supersedes a prior version closes that
    // thread's still-open obligations. `supersedes === null` means this is v1,
    // so there is no prior version and nothing to close.
    if (delta.kind === 'resolution' && delta.supersedes !== null) {
      resolvePendingItemsForSupersededDelta(
        this.deltas
          .chainFor(threadKey)
          .map((prior) => prior.deltaId)
          .filter((deltaId) => deltaId !== delta.deltaId),
        this.pending,
        this.clock.now(),
      );
    }

    if (accepted.pending === undefined) return;

    // The FR-4 gates (self-owed, cited, not a duplicate) and the failed-insert
    // telemetry all live in `pending.ts`. A `null` return is a normal outcome
    // and never invalidates the delta above, which is already committed.
    derivePendingItem(
      {
        deltaId: delta.deltaId,
        threadKey,
        citationArtifactId: accepted.pending.citationArtifactId,
        confidence: accepted.pending.confidence,
        description: accepted.pending.description,
        waitingOnSelf: accepted.pending.waitingOnSelf,
      },
      this.pending,
      this.clock,
    );
  }

  /**
   * Lineage (§5.4): the source events this delta was synthesized from.
   *
   * Scoped to the chunks whose artifact the model actually cited, not to every
   * chunk in the context window. Retrieval deliberately over-fetches — it mixes
   * in graph neighbours from other threads — and recording all of it would make
   * `source_event_ids_json` mean "what was on screen" instead of "what this
   * sentence came from", which is the question lineage exists to answer.
   * Validation guarantees every cited id matched a chunk, so this is non-empty.
   *
   * Order follows retrieval rank (highest score first); duplicates are dropped.
   */
  private lineageFor(citations: readonly string[], chunks: readonly RetrievedChunk[]): string[] {
    const cited = new Set(citations);
    const eventIds = new Set<string>();
    for (const chunk of chunks) {
      if (cited.has(chunk.artifactId) && chunk.eventId !== '') eventIds.add(chunk.eventId);
    }
    return [...eventIds];
  }

  /** Writes the single `ai_calls` row for this synthesis attempt. */
  private log(
    traceId: string,
    latencyMs: number,
    outcome: SynthesisOutcome,
    tokensIn?: number,
    tokensOut?: number,
  ): void {
    this.aiCalls.log({
      traceId,
      layer: 2,
      model: this.model,
      promptVersion: this.promptVersion,
      latencyMs,
      outcome,
      // Spread rather than assigned: `exactOptionalPropertyTypes` forbids an
      // explicit `undefined`, and unreported usage must stay unreported rather
      // than being faked as 0.
      ...(typeof tokensIn === 'number' ? { tokensIn } : {}),
      ...(typeof tokensOut === 'number' ? { tokensOut } : {}),
    });
  }
}
