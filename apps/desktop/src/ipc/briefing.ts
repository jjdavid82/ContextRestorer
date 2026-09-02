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
import { newId, systemClock, type PendingItem } from '@cr/core';
import type {
  BriefingHandle,
  BriefingWindow,
  OkResult,
  PendingItem as PendingItemView,
} from '../preload.cjs';

export type { PendingItemView };

/** Invoke channel serving first-paint pending items. */
export const PENDING_CHANNEL = 'briefing:pending';

/** Invoke channel that reserves a briefing id and kicks off generation. */
export const REQUEST_CHANNEL = 'briefing:request';

/** Invoke channel for the user manually marking a pending item done. */
export const RESOLVE_CHANNEL = 'briefing:resolvePending';

/**
 * Edge kind joining an artifact to the project whose stakes weight applies.
 * Must match `PROJECT_REL` in `@cr/ai`'s retrieval — duplicated as a literal
 * rather than imported so this module keeps zero `@cr/ai` imports (see above).
 */
const PROJECT_REL = 'belongs_to';

/** Stakes weight for an item whose artifact belongs to no declared project. */
export const DEFAULT_STAKES_WEIGHT = 1.0;

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
  resolve(pendingId: string, at: number): void;
}

/**
 * The slice of `GraphRepo` needed to price an item's stakes. Optional throughout
 * — with no graph every item scores at {@link DEFAULT_STAKES_WEIGHT}, which
 * degrades ranking to "confidence, then oldest first" rather than failing.
 */
export interface StakesReader {
  relatedIds(fromId: string, rel: string): string[];
  getProject(projectId: string): { stakesWeight: number } | undefined;
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
  return scored.map(({ item }) => ({
    pendingId: item.pendingId,
    description: item.description,
    confidence: item.confidence,
    citationArtifactId: item.citationArtifactId,
  }));
}

/**
 * The whole of `briefing:pending`: one SELECT, one sort, one projection.
 *
 * Synchronous by construction. The `Promise` the renderer sees is manufactured
 * by `ipcMain.handle`, not by anything in here waiting on a model.
 */
export function listPending(deps: BriefingHandlerDeps): PendingItemView[] {
  return rankPendingItems(deps.pending.listOpen(), deps.graph);
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
    deps.pending.resolve(pendingId, (deps.clock ?? systemClock).now());
    return { ok: true };
  } catch (error) {
    console.error('[briefing] resolvePending failed', pendingId, error);
    return { ok: false, reason: 'internal_error' };
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
}
