/**
 * `briefing:pending` / `briefing:request` main-process handlers (Task 3.5) —
 * the **first-paint path**.
 *
 * This module is how OI-1's "first token under 5s" is actually met. Retrieval
 * alone can eat the entire five-second budget, so the user's first meaningful
 * screenful must come straight out of SQLite: open pending items, ranked, each
 * already carrying its citation and confidence. No embedding, no retrieval, no
 * model call, no I/O beyond a single prepared SELECT.
 *
 * ## The zero-Ollama guarantee is structural, not aspirational
 *
 * {@link BriefingHandlerDeps} contains **no Ollama-shaped member**, and this file
 * imports nothing from `@cr/ai`. `listPending()` therefore cannot reach a model
 * client: there is no reference in scope to reach *through*. That is a stronger
 * property than "the tests observed zero calls" — an accidental future call
 * would not compile without first widening the dependency type, which is a
 * visible, reviewable edit. `test/ipc.briefing.test.ts` additionally pins the
 * empirical half (a stub client's call counts, plus a trapped global `fetch`)
 * so such a widening cannot land quietly.
 *
 * ## `briefing:request` never blocks on generation
 *
 * The handler mints a `briefingId`, hands it back **synchronously**, and only
 * then schedules {@link BriefingHandlerDeps.startGeneration} on a microtask. The
 * renderer gets its handle in the same turn it asked, subscribes to
 * `briefing:chunk`/`briefing:done` with it, and paints pending items while Layer
 * 3 is still warming up. Generation is fire-and-forget from here: this module
 * neither awaits it nor observes its result.
 *
 * `startGeneration` is injected rather than imported because Layer 3 (Task 3.4)
 * is built in parallel; a later integration task supplies the real generator. The
 * seam is not a placeholder, though — it is the same seam that keeps this
 * handler synchronous regardless of what generation turns out to cost.
 */
import { ipcMain } from 'electron';
import { newId, systemClock, type PendingItem, type StateDelta } from '@cr/core';
import type { NewStateDelta } from '@cr/store';
import type {
  BriefingChunk,
  BriefingDone,
  BriefingHandle,
  BriefingMode,
  BriefingWindow,
  OkResult,
  PendingItem as PendingItemView,
} from '../preload.cjs';
import { deepLinkFor, resolveEvents, type ArtifactReader, type ThreadEventReader } from './claim.js';

export type { PendingItemView };

/** Invoke channel serving first-paint pending items. */
export const PENDING_CHANNEL = 'briefing:pending';

/** Invoke channel that reserves a briefing id and kicks off generation. */
export const REQUEST_CHANNEL = 'briefing:request';

/** Invoke channel for the user manually marking a pending item done. */
export const RESOLVE_CHANNEL = 'briefing:resolvePending';

/**
 * Invoke channel that rehydrates an already-requested briefing from what is
 * actually persisted — see {@link getBriefingSnapshot} for why this exists.
 */
export const SNAPSHOT_CHANNEL = 'briefing:snapshot';

/**
 * Invoke channel serving the "how far have you read?" watermark (F-2).
 *
 * See {@link getResumePoint}. Registered unconditionally, and answers
 * `{ windowStart: null }` when nothing has been acknowledged yet, so the
 * renderer's first-run path needs no separate capability check.
 */
export const RESUME_POINT_CHANNEL = 'briefing:resumePoint';

/**
 * Edge kind joining an artifact to the project whose stakes weight applies.
 * Must match `PROJECT_REL` in `@cr/ai`'s retrieval — duplicated as a literal
 * rather than imported so this module keeps zero `@cr/ai` imports (see above).
 */
const PROJECT_REL = 'belongs_to';

/** Stakes weight for an item whose artifact belongs to no declared project. */
export const DEFAULT_STAKES_WEIGHT = 1.0;

/**
 * Longest verbatim source quote shown inline beneath an obligation (P4).
 *
 * Far shorter than `MAX_EVENT_TEXT_CHARS` (2,000, the drill-down panel's limit):
 * this is a one-line proof sitting under a one-line claim, not the message. A
 * quote long enough to need scrolling would recreate the density the list layout
 * exists to remove.
 */
export const MAX_SOURCE_QUOTE_CHARS = 180;

/**
 * The most recent message on the artifact backing an obligation, clipped.
 *
 * P4 keeps verbatim evidence visible for "Needs you" items and paraphrases only
 * in the changed list: an item asserting that someone is waiting on the user is
 * exactly the claim they must be able to check without a click, and AC-4
 * precision measured 48%. The quote is the artifact's own text — never model
 * output — so it is evidence rather than a second assertion.
 *
 * `null` whenever it cannot be resolved (no artifact, no events, empty body).
 * The renderer then shows the item without a quote rather than an empty one.
 */
export function sourceQuoteFor(
  artifactId: string | null,
  artifacts: ArtifactReader | undefined,
  events: ThreadEventReader | undefined,
): string | null {
  if (artifactId === null || artifacts === undefined || events === undefined) return null;

  try {
    const [latest] = resolveEvents(artifactId, { artifacts, events, maxEvents: 1 });
    if (latest === undefined) return null;

    const text: unknown = latest.payload['text'];
    if (typeof text !== 'string') return null;
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (trimmed === '') return null;

    return trimmed.length <= MAX_SOURCE_QUOTE_CHARS
      ? trimmed
      : `${trimmed.slice(0, MAX_SOURCE_QUOTE_CHARS)}…`;
  } catch (error) {
    // A missing quote degrades the item to "no inline evidence", which the
    // renderer already handles; it must never fail the first-paint read.
    console.error('[briefing] source quote lookup failed', artifactId, error);
    return null;
  }
}

/**
 * The slice of `PendingItemsRepo` this module uses.
 *
 * Structural, so the real repo satisfies it with no adapter, and a test can pass
 * a hand-rolled reader. `resolve` is the one mutation this module makes: the
 * user manually declaring "I've dealt with this" (`briefing:resolvePending`) —
 * first paint itself still never mutates anything.
 */
export interface PendingReader {
  listOpen(): PendingItem[];
  /** `undefined` for an unknown id — used by the manual-resolve path to read the
   *  item's `deltaId`/`description`/citation before closing it. */
  getById(pendingId: string): PendingItem | undefined;
  resolve(pendingId: string, at: number): void;
}

/**
 * The slice of `DeltasRepo` the manual "Mark resolved" path needs.
 *
 * Optional on {@link BriefingHandlerDeps}: when a host wires it, resolving an
 * item also appends a `resolution` delta to its thread so the obligation stops
 * being restated in every future briefing (see {@link resolvePendingItem});
 * when it does not, resolve falls back to only flipping `pending_items.status`,
 * which clears the pinned card but leaves the narrative restatement.
 */
export interface ResolutionDeltaWriter {
  getById(deltaId: string): StateDelta | undefined;
  chainFor(threadKey: string): StateDelta[];
  append(input: NewStateDelta): StateDelta;
}

/**
 * The slice of `GraphRepo` needed to price an item's stakes. Optional throughout
 * — with no graph every item scores at {@link DEFAULT_STAKES_WEIGHT}, which
 * degrades ranking to "confidence, then oldest first" rather than failing.
 */
export interface StakesReader {
  relatedIds(fromId: string, rel: string): string[];
  /**
   * `name` is optional so every existing test double — which only ever needed
   * the weight — still satisfies this interface. A `GraphRepo` returns a full
   * `Project` and therefore always carries it; a double that omits it simply
   * yields no project label, which the renderer already has to handle for the
   * untagged case.
   */
  getProject(projectId: string): { stakesWeight: number; name?: string } | undefined;
}

/**
 * A `briefing_claims` row, narrowed to what {@link getBriefingSnapshot} needs
 * to rebuild a `ClaimChunk`. `citationArtifactId` stays nullable — a
 * template-mode connective claim has none, and is skipped on rehydration the
 * same way it was never streamed live.
 */
export interface BriefingSnapshotClaim {
  section: string;
  text: string;
  citationArtifactId: string | null;
}

/**
 * The `briefings` row fields {@link getBriefingSnapshot} needs, narrowed from
 * `Briefing`. `totalMs === null` is the "still generating" signal: that column
 * is written exactly once, by `BriefingsRepo.recordTimings`, at the very end
 * of `generate()` — on the LLM path and the template fallback alike — so its
 * presence means the run actually finished streaming.
 */
export interface BriefingSnapshotRow {
  mode: BriefingMode;
  threadsStillProcessing: number;
  firstTokenMs: number | null;
  totalMs: number | null;
}

/**
 * The slice of `BriefingsRepo` behind `briefing:snapshot`.
 *
 * A third, separately-narrow-typed view of the same repo `BriefingCompletionStore`
 * (`ipc/feedback.ts`) and `BriefingStatsReader` (`ipc/metrics.ts`) already
 * declare — each caller widens only as far as it reads, so a test double for
 * one never has to grow methods the others need.
 */
export interface BriefingSnapshotReader {
  getById(briefingId: string): BriefingSnapshotRow | undefined;
  listClaims(briefingId: string): BriefingSnapshotClaim[];
}

/**
 * The slice of `BriefingsRepo` behind `briefing:resumePoint`.
 *
 * Separate from {@link BriefingSnapshotReader} rather than folded into it: the
 * resume point must still be servable by a host that wired no snapshot support,
 * and each caller in this file widens only as far as it reads.
 */
export interface ResumePointReader {
  lastAcknowledgedWindowEnd(): number | null;
}

/**
 * Everything the first-paint handlers need.
 *
 * Note what is absent: any model client, any retriever, any embedder. That
 * absence is the contract.
 */
export interface BriefingHandlerDeps {
  /** Open-obligation source; `PendingItemsRepo` in production. */
  pending: PendingReader;
  /**
   * D-6 delta store, used only by the manual-resolve path to turn a "Mark
   * resolved" click into a real `resolution` delta — `DeltasRepo` in
   * production. Optional; absent, resolve only flips `pending_items.status`.
   */
  deltas?: ResolutionDeltaWriter;
  /** Optional stakes source; `GraphRepo` in production. */
  graph?: StakesReader;
  /**
   * Fire-and-forget hand-off to Layer 3. Called on a microtask *after* the
   * `briefingId` has been returned, so a slow (or throwing) generator can never
   * delay or fail the renderer's handle.
   */
  startGeneration: (briefingId: string, window: BriefingWindow) => void;
  /** Id minter; overridable so tests can assert an exact handle. Defaults to `newId`. */
  mintBriefingId?: () => string;
  /** Time source for `resolved_at`. Defaults to `systemClock`; overridable in tests. */
  clock?: { now(): number };
  /**
   * Rehydration source for `briefing:snapshot`; `BriefingsRepo` in production.
   * Optional, and registered only together with {@link artifacts} and
   * {@link events} below — all three are needed to rebuild a persisted claim's
   * citation, and a partially-wired host should leave the channel unregistered
   * rather than serve snapshots with citations silently dropped.
   */
  briefings?: BriefingSnapshotReader;
  /**
   * Read-only source for `briefing:resumePoint`; `BriefingsRepo` in production.
   * Optional and independent of {@link briefings} — a host that wires only this
   * one still serves the resume point, and one that wires neither answers
   * `{ windowStart: null }`, which is the same thing the renderer does on first
   * run anyway.
   */
  resume?: ResumePointReader;
  /** A-4 display cap, from `config.briefing.maxChangedItems`. */
  maxChangedItems?: number;
  /** Artifact/person source for resolving a claim's citation; `GraphRepo` in production. */
  artifacts?: ArtifactReader;
  /** Thread event source for the same resolution; `EventsRepo` in production. */
  events?: ThreadEventReader;
}

/**
 * Highest stakes weight among the projects `artifactId` belongs to, memoised in
 * `cache` for the life of one call.
 *
 * Highest wins, as in retrieval: being attached to something that matters must
 * not be diluted by also being attached to something that does not.
 */
function stakesWeightFor(
  graph: StakesReader | undefined,
  artifactId: string | null,
  cache: Map<string, number>,
): number {
  if (graph === undefined || artifactId === null) return DEFAULT_STAKES_WEIGHT;

  const cached = cache.get(artifactId);
  if (cached !== undefined) return cached;

  const weights = graph
    .relatedIds(artifactId, PROJECT_REL)
    .map((projectId) => graph.getProject(projectId)?.stakesWeight)
    .filter((w): w is number => typeof w === 'number' && Number.isFinite(w));

  const weight = weights.length === 0 ? DEFAULT_STAKES_WEIGHT : Math.max(...weights);
  cache.set(artifactId, weight);
  return weight;
}

/**
 * The name of the project an artifact belongs to, for the item's label.
 *
 * Until now the project was invisible to the user: it decided WHICH items
 * surfaced and in WHAT ORDER (it is the largest ranking weight after
 * obligation), while nothing on screen said so — the one ranking signal the
 * user declared themselves, and the one they had no way to verify was working.
 *
 * Picks the HIGHEST-stakes project when an artifact belongs to several, which
 * is deliberately the same rule {@link stakesWeightFor} applies. The label has
 * to name the project that actually moved this item up the list; showing a
 * different one would be worse than showing none.
 *
 * `undefined` for an untagged artifact — the ordinary case, not a defect.
 */
export function projectNameFor(
  graph: StakesReader | undefined,
  artifactId: string | null,
): string | undefined {
  if (graph === undefined || artifactId === null) return undefined;

  let best: { weight: number; name: string } | undefined;
  for (const projectId of graph.relatedIds(artifactId, PROJECT_REL)) {
    const project = graph.getProject(projectId);
    const name = project?.name?.trim();
    if (project === undefined || name === undefined || name === '') continue;
    const weight = Number.isFinite(project.stakesWeight) ? project.stakesWeight : 0;
    if (best === undefined || weight > best.weight) best = { weight, name };
  }
  return best?.name;
}

/**
 * Order open items by what they cost the user to ignore, and project them onto
 * the renderer's view shape.
 *
 * `score = stakesWeight × confidence`, descending; ties break oldest-first, then
 * by `pendingId` so the order is total and the list never reshuffles between two
 * identical reads.
 *
 * Two deliberate departures from retrieval's scoring:
 *
 * - **Zero-stakes items are ranked last, not dropped.** Retrieval may discard a
 *   chunk from a project the user weighted to zero; an outstanding obligation
 *   *on the user* is still outstanding, and silently hiding it is how a briefing
 *   becomes untrustworthy.
 * - **No recency decay.** An unanswered request does not become less owed with
 *   age — it becomes more so. Age is used only as a tie-break, oldest first.
 *
 * INTEGRATION NOTE: `packages/ai/src/ranker.ts` (a parallel task) will own the
 * full ranking signal (`wStakes`/`wPendingOnMe`/`wSelfParticipation`/`wRecency`
 * from `AppConfig.ranking`). This is the minimal stakes-only ordering over the
 * data reachable without it; a later pass should swap the real ranker in behind
 * this same function, which is why the sort lives here and not inline in the
 * handler.
 *
 * Pure — no I/O beyond the `graph` lookups, which are prepared-statement reads.
 */
export function rankPendingItems(
  items: readonly PendingItem[],
  graph?: StakesReader,
  /** Optional artifact/event readers used to attach the P4 inline quote. */
  sources?: { artifacts?: ArtifactReader; events?: ThreadEventReader },
): PendingItemView[] {
  const cache = new Map<string, number>();

  const scored = items.map((item) => ({
    item,
    score: stakesWeightFor(graph, item.citationArtifactId, cache) * item.confidence,
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.item.createdAt !== b.item.createdAt) return a.item.createdAt - b.item.createdAt;
    return a.item.pendingId < b.item.pendingId ? -1 : a.item.pendingId > b.item.pendingId ? 1 : 0;
  });

  // Projected, not passed through: `deltaId`/`status`/`resolvedAt` are internal
  // and have no business crossing the context bridge. `citationArtifactId` and
  // `confidence` DO cross, so the renderer can paint the low-confidence flag and
  // wire the drill-down without a second round trip.
  return scored.map(({ item }) => {
    const projectName = projectNameFor(graph, item.citationArtifactId);
    return {
      pendingId: item.pendingId,
      description: item.description,
      confidence: item.confidence,
      citationArtifactId: item.citationArtifactId,
      // P4: verbatim evidence, inline, for obligations only. Resolved here
      // rather than by a second round trip per item — this path is the
      // first-paint read and must stay one screenful in one call.
      sourceQuote: sourceQuoteFor(item.citationArtifactId, sources?.artifacts, sources?.events),
      // `exactOptionalPropertyTypes`: an untagged item has no KEY, not a key
      // holding `undefined`.
      ...(projectName === undefined ? {} : { projectName }),
    };
  });
}

/**
 * The whole of `briefing:pending`: one SELECT, one sort, one projection.
 *
 * Synchronous by construction. The `Promise` the renderer sees is manufactured
 * by `ipcMain.handle`, not by anything in here waiting on a model.
 */
export function listPending(deps: BriefingHandlerDeps): PendingItemView[] {
  return rankPendingItems(deps.pending.listOpen(), deps.graph, {
    // Spread-free: both are already optional on the deps, and `sourceQuoteFor`
    // treats either being absent as "no quote available".
    ...(deps.artifacts === undefined ? {} : { artifacts: deps.artifacts }),
    ...(deps.events === undefined ? {} : { events: deps.events }),
  });
}

/**
 * Re-validate the renderer-supplied window. The preload checks too, but a
 * compromised renderer controls what it sends, so the preload's check is a
 * convenience gate and this one is the trust boundary.
 *
 * Requires a strictly-positive-width, half-open `[start, end)` window of finite
 * epoch-ms values — same rule the preload applies.
 */
export function parseBriefingWindow(arg: unknown): BriefingWindow | null {
  const candidate = arg as Partial<BriefingWindow> | null;
  if (candidate === null || typeof candidate !== 'object') return null;

  const { windowStart, windowEnd } = candidate;
  if (typeof windowStart !== 'number' || !Number.isFinite(windowStart)) return null;
  if (typeof windowEnd !== 'number' || !Number.isFinite(windowEnd)) return null;
  if (windowStart >= windowEnd) return null;

  return { windowStart, windowEnd };
}

/**
 * Re-validate the renderer-supplied pending id. Same trust-boundary reasoning
 * as every other handler in this file: the preload's own check is a
 * convenience gate, not the authoritative one.
 */
export function parsePendingIdArg(arg: unknown): string | null {
  const pendingId: unknown = (arg as { pendingId?: unknown } | null)?.pendingId;
  if (typeof pendingId !== 'string' || pendingId === '') return null;
  return pendingId;
}

/** `state_deltas.model` / `prompt_version` sentinels for a user-authored delta:
 *  no model wrote it, so the audit columns must not read as though one did. */
const MANUAL_RESOLVE_MODEL = 'none:user-action';
const MANUAL_RESOLVE_PROMPT_VERSION = 'user-resolve.v1';

/**
 * Append the `resolution` delta that takes an obligation off the briefing
 * narrative for good (see {@link recordManualResolution} for why it, and not
 * the `pending_items.status` flip, is load-bearing).
 *
 * `append` derives version/supersedes from the chain tip inside its own
 * IMMEDIATE transaction (D-6), so a synthesis worker writing the same thread
 * concurrently blocks rather than races.
 */
function appendResolutionDelta(
  deltas: ResolutionDeltaWriter,
  threadKey: string,
  description: string,
  citationArtifactId: string | null,
  at: number,
): void {
  deltas.append({
    threadKey,
    artifactId: null,
    summary: `You marked this done: ${description}`,
    kind: 'resolution',
    confidence: 1,
    sourceEventIds: [],
    citationArtifactIds: citationArtifactId !== null ? [citationArtifactId] : [],
    model: MANUAL_RESOLVE_MODEL,
    promptVersion: MANUAL_RESOLVE_PROMPT_VERSION,
    createdAt: at,
  });
}

/**
 * Close a pending item on the user's say-so AND, when the delta store is wired,
 * append a `resolution` delta to its thread.
 *
 * The delta is the load-bearing half. The briefing narrative is rebuilt from
 * `current_state_deltas` on every request (`TemplateBriefingRenderer`), and a
 * tip delta that once carried an obligation is rendered on every run — as a
 * "Waiting on you" line while an open item hangs off it, and, once that item is
 * merely marked resolved, as a plain restatement under "What moved" / "Worth
 * knowing". Only a superseding `resolution` delta takes it off the briefing
 * (it then reads once under "Quietly resolved" and ages out with the window).
 * Layer 2 writes one automatically when it sees a reply that closes the thread;
 * a user who dealt with something offline produces no such reply, so this does.
 *
 * Falls back to a bare status flip when the delta store is absent, or the item
 * / its delta cannot be found — an unknown id reaching `resolve` is a harmless
 * no-op UPDATE, exactly as before this path existed.
 */
function recordManualResolution(pendingId: string, at: number, deps: BriefingHandlerDeps): void {
  const item = deps.pending.getById(pendingId);

  if (item === undefined || deps.deltas === undefined) {
    deps.pending.resolve(pendingId, at);
    return;
  }

  const delta = deps.deltas.getById(item.deltaId);
  if (delta === undefined) {
    deps.pending.resolve(pendingId, at);
    return;
  }

  appendResolutionDelta(deps.deltas, delta.threadKey, item.description, item.citationArtifactId, at);

  // Close this item and any open duplicates that a restatement minted on the
  // same chain before this fix landed.
  const chainDeltaIds = new Set(deps.deltas.chainFor(delta.threadKey).map((d) => d.deltaId));
  for (const open of deps.pending.listOpen()) {
    if (open.pendingId === pendingId || chainDeltaIds.has(open.deltaId)) {
      deps.pending.resolve(open.pendingId, at);
    }
  }
}

/**
 * The slice of `PendingItemsRepo` the startup backfill (below) needs: every
 * item already `resolved`/`dismissed`, so it can check each one's thread for a
 * missing `resolution` delta.
 */
export interface ClosedPendingReader {
  listClosed(): PendingItem[];
}

/**
 * One-time-per-launch repair for items resolved before {@link recordManualResolution}
 * existed (or resolved with `deps.deltas` unwired): those closes only flipped
 * `pending_items.status`, so their thread's tip delta still carries the
 * obligation and the briefing keeps restating it — moved out of "Waiting on
 * you" since the item itself is gone from `listOpen`, but still read out under
 * "What moved" / "Worth knowing" on every run, looking exactly like something
 * still open.
 *
 * For every closed item whose thread's current tip is not already a
 * `resolution`, appends one — the same delta a fresh manual resolve would have
 * written. Idempotent: run it again once every affected thread's tip is
 * `resolution` and it is a no-op, so calling it unconditionally on every
 * startup is safe and cheap (one `listClosed()` scan, no writes once caught up).
 *
 * Threads only, not items: two closed items on the same chain (a duplicate a
 * pre-fix restatement minted) need exactly one `resolution` delta between them,
 * not one each.
 */
export function backfillMissingResolutionDeltas(
  pending: ClosedPendingReader,
  deltas: ResolutionDeltaWriter,
  at: number,
): number {
  const patchedThreads = new Set<string>();
  let patched = 0;

  for (const item of pending.listClosed()) {
    const delta = deltas.getById(item.deltaId);
    if (delta === undefined || patchedThreads.has(delta.threadKey)) continue;
    patchedThreads.add(delta.threadKey);

    const chain = deltas.chainFor(delta.threadKey);
    const tip = chain.at(-1);
    if (tip === undefined || tip.kind === 'resolution') continue;

    appendResolutionDelta(deltas, delta.threadKey, item.description, item.citationArtifactId, at);
    patched += 1;
  }

  return patched;
}

/**
 * The whole of `briefing:resolvePending`: the user manually declaring "I've
 * dealt with this" for an item that would otherwise sit in "Waiting on you"
 * until the model happens to notice a reply superseded it (or forever, if it
 * never does).
 *
 * Never throws — a storage fault comes back as `{ ok: false, reason }`, the
 * same contract every other handler in this file uses, rather than an opaque
 * rejected invoke.
 */
export function resolvePendingItem(arg: unknown, deps: BriefingHandlerDeps): OkResult {
  const pendingId = parsePendingIdArg(arg);
  if (pendingId === null) return { ok: false, reason: 'invalid_pending_id' };

  try {
    recordManualResolution(pendingId, (deps.clock ?? systemClock).now(), deps);
    return { ok: true };
  } catch (error) {
    console.error('[briefing] resolvePending failed', pendingId, error);
    return { ok: false, reason: 'internal_error' };
  }
}

/**
 * Re-validate the renderer-supplied briefing id for `briefing:snapshot`. Same
 * trust-boundary reasoning as every other handler in this file.
 */
export function parseSnapshotIdArg(arg: unknown): string | null {
  const briefingId: unknown = (arg as { briefingId?: unknown } | null)?.briefingId;
  if (typeof briefingId !== 'string' || briefingId === '') return null;
  return briefingId;
}

/** `briefing:snapshot` result: what could be rehydrated for one briefing id. */
export interface BriefingSnapshot {
  found: boolean;
  claims: BriefingChunk[];
  /** `null` while the briefing is still generating — see {@link BriefingSnapshotRow}. */
  done: BriefingDone | null;
}

/**
 * Rebuild the renderer-facing `Citation` for one persisted claim's artifact
 * id — the same resolution `main.ts`'s live streaming path (`citationFor`)
 * performs for a freshly accepted claim, duplicated here (rather than shared)
 * because that function is keyed to the full `GraphRepo`/`EventsRepo` types
 * and this module only ever needs the narrow `ArtifactReader`/`ThreadEventReader`
 * slice, same as `claim.ts`'s own drill-down handler.
 *
 * `undefined` when the artifact cannot be resolved: better to omit the claim
 * from the snapshot than to render a citation that leads nowhere.
 */
export function citationForArtifact(
  artifactId: string,
  artifacts: ArtifactReader,
  events: ThreadEventReader,
  /**
   * Supplies the declared project this artifact belongs to, for the item's
   * label. Optional and last, so every existing call site stays valid and a
   * host wired without a graph simply renders no project.
   */
  graph?: StakesReader,
): BriefingChunk['citation'] | undefined {
  const artifact = artifacts.getArtifact(artifactId);
  if (artifact === undefined) return undefined;

  const [latest] = resolveEvents(artifactId, { artifacts, events, maxEvents: 1 });
  const externalUrl =
    latest === undefined ? undefined : deepLinkFor(latest.source, latest.sourceEventId);

  const projectName = projectNameFor(graph, artifactId);

  return {
    eventId: latest?.eventId ?? '',
    artifactId,
    source: latest?.source ?? artifact.source,
    // `exactOptionalPropertyTypes`: an absent link is an absent KEY.
    ...(externalUrl !== undefined ? { externalUrl } : {}),
    ...(projectName === undefined ? {} : { projectName }),
  };
}

/**
 * The whole of `briefing:snapshot`: rehydrate an already-requested briefing
 * from what is actually persisted, for a renderer that lost its live stream.
 *
 * Exists because `app/page.tsx`'s nav is plain `<a href>` markup, not a client
 * router (deliberately — see `layout.tsx`): switching to Settings and back is
 * a real page navigation, which drops every `briefing:chunk`/`briefing:done`
 * subscription and resets `BriefingView`'s state. Without this, a briefing
 * that finished generating while the user was on another page would show
 * nothing but its `pending_items` (which reload independently) until the user
 * asked for an entirely new one — see `BriefingView.tsx`'s `load()`.
 *
 * `found: false` covers an unknown id, a not-yet-created row, and a read
 * failure alike — the renderer's response is the same in all three cases
 * (fall back to whatever the live stream sends), so there is nothing for a
 * finer-grained reason to drive.
 */
export function getBriefingSnapshot(arg: unknown, deps: BriefingHandlerDeps): BriefingSnapshot {
  const empty: BriefingSnapshot = { found: false, claims: [], done: null };

  const briefingId = parseSnapshotIdArg(arg);
  if (briefingId === null) return empty;
  if (deps.briefings === undefined || deps.artifacts === undefined || deps.events === undefined) {
    return empty;
  }

  try {
    const row = deps.briefings.getById(briefingId);
    if (row === undefined) return empty;

    const claims: BriefingChunk[] = [];
    for (const claim of deps.briefings.listClaims(briefingId)) {
      if (claim.citationArtifactId === null) continue;
      const citation = citationForArtifact(
        claim.citationArtifactId,
        deps.artifacts,
        deps.events,
        deps.graph,
      );
      if (citation === undefined) continue;
      claims.push({ briefingId, section: claim.section, claim: claim.text, citation });
    }

    const done: BriefingDone | null =
      row.totalMs === null
        ? null
        : {
            briefingId,
            mode: row.mode,
            threadsStillProcessing: row.threadsStillProcessing,
            timings: { firstTokenMs: row.firstTokenMs ?? 0, totalMs: row.totalMs },
          };

    return { found: true, claims, done };
  } catch (error) {
    console.error('[briefing] snapshot read failed', briefingId, error);
    return empty;
  }
}

/**
 * `briefing:resumePoint` result: where the next briefing should start, and how
 * many changed items to show.
 *
 * The display cap rides along here rather than on its own channel because the
 * renderer needs both at exactly the same moment — the click that requests a
 * briefing — and a second round trip for one integer would be pure ceremony.
 */
export interface ResumePoint {
  /**
   * `window_end` of the furthest-forward acknowledged briefing, or `null` when
   * the user has never tapped "I'm caught up".
   *
   * `null` is not an error — it is the first-run state, and the renderer answers
   * it with a default lookback.
   */
  windowStart: number | null;
  /**
   * A-4: how many "things changed" items to render before collapsing the rest
   * behind "show N more". Config-driven (NFR-7), from `briefing.maxChangedItems`.
   *
   * Applies to that list ONLY. Obligations are never capped — AC-3 targets
   * >= 90% recall and an obligation hidden by a display cap is a recall miss
   * the user cannot see.
   */
  maxChangedItems: number;
}

/** Fallback cap when no config is wired. Matches `config/default.json`. */
export const DEFAULT_MAX_CHANGED_ITEMS = 7;

/**
 * The whole of `briefing:resumePoint` — the F-2 fix.
 *
 * "Brief me on what I missed" previously took its start from a
 * `datetime-local` value the user had to set on the Settings page, defaulting
 * to 30 days ago and never moving. Pressing the button therefore re-briefed the
 * same thirty days every time, and "I'm caught up" — despite
 * `CaughtUpButton`'s own doc comment claiming it "marks the briefing's deltas
 * as seen so the next briefing starts from here" — only ever stamped
 * `caught_up_at` for the NFR-10 metric. This channel is what makes that comment
 * true.
 *
 * Never throws: a storage fault degrades to `{ windowStart: null }`, i.e. the
 * renderer's default lookback, rather than a rejected invoke that would leave
 * the primary button unusable.
 */
export function getResumePoint(deps: BriefingHandlerDeps): ResumePoint {
  const maxChangedItems =
    deps.maxChangedItems !== undefined && Number.isInteger(deps.maxChangedItems) && deps.maxChangedItems > 0
      ? deps.maxChangedItems
      : DEFAULT_MAX_CHANGED_ITEMS;

  if (deps.resume === undefined) return { windowStart: null, maxChangedItems };

  try {
    const windowStart = deps.resume.lastAcknowledgedWindowEnd();
    // A non-finite stored value would produce an unusable window downstream;
    // treating it as "never acknowledged" is the safe degradation.
    if (windowStart === null || !Number.isFinite(windowStart)) {
      return { windowStart: null, maxChangedItems };
    }
    return { windowStart, maxChangedItems };
  } catch (error) {
    console.error('[briefing] resume point read failed', error);
    return { windowStart: null, maxChangedItems };
  }
}

/**
 * Mint a briefing id, return it, and schedule generation — in that order.
 *
 * Returns `{ briefingId: '' }` for an unusable window and starts nothing. An
 * empty id is falsy and carries no listeners, which the renderer can test; the
 * alternative — throwing — reaches the renderer as an opaque
 * `Error invoking remote method …` string with a main-process stack pasted into
 * it, which is not a failure mode any UI can render.
 *
 * The `queueMicrotask` is load-bearing, not stylistic: it makes "the handle is
 * returned before generation begins" true by construction rather than by the
 * generator happening to be fast today.
 */
export function beginBriefing(arg: unknown, deps: BriefingHandlerDeps): BriefingHandle {
  const window = parseBriefingWindow(arg);
  if (window === null) return { briefingId: '' };

  const briefingId = (deps.mintBriefingId ?? newId)();

  queueMicrotask(() => {
    try {
      // The declared return is `void`, but a generator that quietly turns
      // `async` would otherwise reject into an unhandled-rejection crash of the
      // main process. Absorb it here; observing generation is not this handler's
      // job, and `briefing:done` is how the renderer learns the outcome.
      const started: unknown = deps.startGeneration(briefingId, window);
      if (started instanceof Promise) {
        started.catch((error: unknown) => {
          console.error('[briefing] generation failed', briefingId, error);
        });
      }
    } catch (error) {
      console.error('[briefing] generation failed to start', briefingId, error);
    }
  });

  return { briefingId };
}

/**
 * Register the first-paint channels, plus the manual resolve action.
 *
 * Safe to call before any window exists — none of the handlers need a
 * `BrowserWindow`. Every callback is a thin wrapper over the pure functions
 * above, which is where the tests aim.
 *
 * `briefing:pending` ignores its `briefingId` argument on purpose: open
 * obligations are a property of the user's inbox, not of one briefing, and there
 * is no per-briefing pending set to filter by. The argument is still validated,
 * because a call with no id is a renderer bug worth surfacing as an empty list
 * rather than a mystery.
 */
export function registerBriefingHandlers(deps: BriefingHandlerDeps): void {
  ipcMain.handle(PENDING_CHANNEL, (_event, arg: unknown): PendingItemView[] => {
    const briefingId: unknown = (arg as { briefingId?: unknown } | null)?.briefingId;
    if (typeof briefingId !== 'string' || briefingId === '') return [];

    try {
      return listPending(deps);
    } catch (error) {
      // A failed first paint must not surface as a rejected invoke: an empty
      // list degrades to "nothing pending", which the UI already renders.
      console.error('[briefing] pending read failed', error);
      return [];
    }
  });

  // Intentionally NOT `async`: the value is returned in the same turn the
  // renderer's invoke arrives.
  ipcMain.handle(REQUEST_CHANNEL, (_event, arg: unknown): BriefingHandle =>
    beginBriefing(arg, deps),
  );

  ipcMain.handle(RESOLVE_CHANNEL, (_event, arg: unknown): OkResult =>
    resolvePendingItem(arg, deps),
  );

  ipcMain.handle(SNAPSHOT_CHANNEL, (_event, arg: unknown): BriefingSnapshot =>
    getBriefingSnapshot(arg, deps),
  );

  // Takes no argument: "how far have you read?" is a property of the user's
  // history, not of any one briefing.
  ipcMain.handle(RESUME_POINT_CHANNEL, (): ResumePoint => getResumePoint(deps));
}
