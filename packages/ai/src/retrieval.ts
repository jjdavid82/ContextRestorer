/**
 * Retrieval service — the context supplier for Layer 2 synthesis (Task 2.5) and
 * Layer 3 briefing generation (Phase 3).
 *
 * Two properties of this module are load-bearing well beyond retrieval quality:
 *
 * 1. **Its output is the citation allowlist.** Layer 3's citation gate checks
 *    every generated claim against the artifact ids that retrieval actually
 *    returned. A chunk that reaches a caller without a usable `artifactId` is
 *    therefore a latent citation bug, so such chunks are dropped here rather
 *    than forwarded with an empty id. See {@link isCitable}.
 *
 * 2. **It must not blow the OI-1 latency budget.** `config.retrieval.budgetMs`
 *    is a hard deadline, not a hint: every awaited step races a timer, and when
 *    the deadline passes the service returns whatever it has already collected
 *    with `partial: true`. It never throws and never waits on a hung store.
 *
 * ### Scoring
 *
 * `score = similarity × recency × stakesWeight`, sorted descending.
 *
 * - `similarity = 1 / (1 + distance)` — LanceDB returns an L2 distance where
 *   smaller is more similar; this maps `[0, ∞)` onto `(0, 1]` monotonically
 *   decreasing, so a nearer chunk always scores higher. A non-finite distance
 *   (no index, malformed row) is treated as maximally distant.
 * - `recency = 0.5 ^ (ageMs / RECENCY_HALF_LIFE_MS)` — exponential decay with a
 *   7-day half-life, strictly decreasing in age, so an older chunk always
 *   scores lower all else being equal. Ages are clamped at 0, so a
 *   clock-skewed future timestamp scores 1 rather than exploding.
 * - `stakesWeight` — the weight of the artifact's declared project (FR-8), or
 *   {@link DEFAULT_STAKES_WEIGHT} when the artifact belongs to no project.
 *   A project with `stakesWeight = 0` "contributes nothing": its chunks are
 *   **excluded from the result entirely** rather than ranked last, so they can
 *   never dilute a top-K slice or enter the citation allowlist.
 *
 * The `config.ranking.*` weights are deliberately *not* applied here. Those
 * tune the briefing *ranker* (which additionally knows about pending items and
 * self-participation); retrieval's job is the plain similarity/recency/stakes
 * product the plan specifies.
 */

import { systemClock, type AppConfig, type Clock } from '@cr/core';
import type { GraphRepo, SearchResult, VectorStore } from '@cr/store';

/** Edge kind joining an artifact to the project whose stakes weight applies. */
const PROJECT_REL = 'belongs_to';

/** Edge kind joining an artifact to a person who took part in it. */
const PARTICIPANT_REL = 'participant';

/** Stakes weight for an artifact with no declared project association. */
const DEFAULT_STAKES_WEIGHT = 1.0;

/** Half-life of the recency decay: a 7-day-old chunk scores half a fresh one. */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Over-fetch multiplier for candidate pools.
 *
 * Post-filters (window end, zero-stakes projects, missing artifact ids, graph
 * linkage) only ever *remove* rows, so the vector search asks for more than
 * `topK` to leave the final slice a fair chance of being full.
 */
const CANDIDATE_FANOUT = 4;

/**
 * Query text embedded for a briefing sweep. The window itself is expressed as a
 * filter; this only steers the *ordering* of chunks within that window towards
 * the things a briefing is about.
 */
const BRIEFING_QUERY_TEXT = 'What was decided, what changed, and what is waiting on me?';

/** One chunk of retrieved context, ready to be cited. */
export interface RetrievedChunk {
  /**
   * Artifact this chunk came from. Guaranteed non-empty on every returned
   * chunk — this is what makes the chunk citable.
   */
  artifactId: string;
  /** Event the chunk was derived from (lineage back to the raw event store). */
  eventId: string;
  /** Conversation the chunk belongs to. */
  threadKey: string;
  /** Event time in epoch milliseconds. */
  occurredAt: number;
  /** The chunk text. */
  text: string;
  /** `similarity × recency × stakesWeight`; results are sorted descending. */
  score: number;
}

/** Outcome of one retrieval call. */
export interface RetrievalResult {
  /** Scored chunks, highest score first. Possibly empty. */
  chunks: RetrievedChunk[];
  /**
   * True when the `config.retrieval.budgetMs` deadline elapsed before retrieval
   * finished. `chunks` then holds whatever had already been collected — which
   * may be nothing — rather than the full result set. Callers surface this as
   * the OI-1 "still processing" disclosure.
   */
  partial: boolean;
}

/** Half-open time window `[start, end)`, matching `EventsRepo.listWindow`. */
export interface RetrievalWindow {
  start: number;
  end: number;
}

/** Embedding function supplied by the caller (in production, Ollama). */
export type EmbedFn = (text: string) => Promise<number[]>;

/** Tuning knobs; every field has a production default. */
export interface RetrievalOptions {
  /** Time source. Injected so recency decay is deterministic under test. */
  clock?: Clock;
  /** Half-life of the recency decay in ms. Defaults to 7 days. */
  recencyHalfLifeMs?: number;
}

/** Internal: a search hit paired with the score it earned. */
interface ScoredHit {
  hit: SearchResult;
  score: number;
}

/** Internal: outcome of racing one promise against the retrieval deadline. */
type Deadlined<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * True when `hit` carries an artifact id that a citation could point at.
 *
 * The vector store's schema seed writes an empty `artifact_id`, and a connector
 * bug could do the same, so emptiness is checked rather than assumed away.
 */
function isCitable(hit: SearchResult): boolean {
  return typeof hit.artifactId === 'string' && hit.artifactId.trim() !== '';
}

/**
 * Race `work` against the remaining budget.
 *
 * Resolves `{ timedOut: true }` the moment `remainingMs` elapses, leaving the
 * underlying promise to settle (and be ignored) in its own time — a hung vector
 * store call cannot be cancelled, only abandoned. Rejections are folded into a
 * timeout: a failed search yields no results, which is exactly the partial-
 * result path, and retrieval never propagates an exception to the caller.
 */
function withDeadline<T>(work: Promise<T>, remainingMs: number): Promise<Deadlined<T>> {
  if (remainingMs <= 0) return Promise.resolve({ timedOut: true });

  return new Promise<Deadlined<T>>((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), remainingMs);
    // Do not let a pending retrieval timer keep the process alive.
    timer.unref?.();

    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      () => {
        clearTimeout(timer);
        resolve({ timedOut: true });
      },
    );
  });
}

/** Element-wise mean of `vectors`, or `undefined` when there is nothing to average. */
function centroid(vectors: readonly number[][]): number[] | undefined {
  const usable = vectors.filter((v) => v.length > 0);
  const first = usable[0];
  if (first === undefined) return undefined;

  const width = first.length;
  const sums = new Array<number>(width).fill(0);
  let counted = 0;
  for (const vector of usable) {
    if (vector.length !== width) continue; // defensive: mixed widths cannot be averaged
    for (let i = 0; i < width; i += 1) sums[i] = (sums[i] ?? 0) + (vector[i] ?? 0);
    counted += 1;
  }
  if (counted === 0) return undefined;
  return sums.map((sum) => sum / counted);
}

export class RetrievalService {
  private readonly clock: Clock;
  private readonly halfLifeMs: number;

  /**
   * Memoised `artifactId → stakesWeight`, cleared at the start of each call so
   * a long-lived service picks up newly declared projects. Overlapping calls may
   * clear each other's cache; that costs a few extra SQLite reads and can never
   * change a result, since every entry is re-derived from the same rows.
   */
  private stakesCache = new Map<string, number>();

  constructor(
    private vectors: VectorStore,
    private graph: GraphRepo,
    private config: AppConfig,
    private embed: EmbedFn,
    options: RetrievalOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.halfLifeMs = options.recencyHalfLifeMs ?? RECENCY_HALF_LIFE_MS;
  }

  /**
   * Context for one conversation: the thread's own chunks plus its graph
   * neighbours.
   *
   * **Neighbour definition.** A chunk from a *different* thread is a neighbour
   * of `threadKey` when its artifact is linked to the thread's own artifacts by
   * either of the two joins the entity graph supports:
   *
   * - **shared artifact** — the candidate's `artifactId` is one of the artifact
   *   ids the thread itself touches (the same doc/ticket discussed in two
   *   places); or
   * - **shared participant** — the candidate's artifact and one of the thread's
   *   artifacts have a person in common, where an artifact's participants are
   *   its `ownerId` plus every `artifact --participant--> person` edge in
   *   `relationships`.
   *
   * Neighbours are ranked by similarity to the *centroid* of the thread's own
   * chunk vectors (falling back to the embedding of `threadKey` when the thread
   * has no chunks yet), so "related to this conversation" is measured against
   * what the conversation actually says rather than against its opaque key.
   *
   * The combined result is scored, sorted and capped at `config.retrieval.topK`
   * like any other retrieval, so one busy thread cannot hand Layer 2 an
   * unbounded context.
   */
  async forThread(threadKey: string): Promise<RetrievalResult> {
    const deadline = this.clock.now() + this.config.retrieval.budgetMs;
    this.stakesCache = new Map();

    const seed = await withDeadline(this.embed(threadKey), deadline - this.clock.now());
    if (seed.timedOut) return { chunks: [], partial: true };

    const k = Math.max(1, this.config.retrieval.topK);
    const own = await withDeadline(
      this.vectors.search(seed.value, k * CANDIDATE_FANOUT, { threadKey }),
      deadline - this.clock.now(),
    );
    if (own.timedOut) return { chunks: [], partial: true };

    const ownHits = own.value.filter(isCitable);
    const ownScored = this.score(ownHits);

    // Anything already known is returned even if the neighbour sweep runs out
    // of budget below — partial context beats no context (OI-1).
    const neighbourQuery = centroid(ownHits.map((hit) => hit.vector)) ?? seed.value;
    const candidates = await withDeadline(
      this.vectors.search(neighbourQuery, k * CANDIDATE_FANOUT),
      deadline - this.clock.now(),
    );
    if (candidates.timedOut) {
      return { chunks: this.finish(ownScored), partial: true };
    }

    const linked = this.linkedNeighbours(threadKey, ownHits, candidates.value);
    return { chunks: this.finish([...ownScored, ...this.score(linked)]), partial: false };
  }

  /**
   * Context for a briefing over the half-open window `[start, end)`.
   *
   * Returns at most `config.retrieval.topK` chunks, highest score first. The
   * store filters on `occurredAt >= start` before the nearest-neighbour search;
   * the exclusive upper bound is applied here, because the store's filter API
   * has no `until`.
   */
  async forBriefing(window: RetrievalWindow): Promise<RetrievalResult> {
    const deadline = this.clock.now() + this.config.retrieval.budgetMs;
    this.stakesCache = new Map();

    const query = await withDeadline(this.embed(BRIEFING_QUERY_TEXT), deadline - this.clock.now());
    if (query.timedOut) return { chunks: [], partial: true };

    const k = Math.max(1, this.config.retrieval.topK);
    const found = await withDeadline(
      this.vectors.search(query.value, k * CANDIDATE_FANOUT, { since: window.start }),
      deadline - this.clock.now(),
    );
    if (found.timedOut) return { chunks: [], partial: true };

    const inWindow = found.value.filter((hit) => isCitable(hit) && hit.occurredAt < window.end);
    return { chunks: this.finish(this.score(inWindow)), partial: false };
  }

  /**
   * Candidates from other threads that share an artifact or a participant with
   * `threadKey`. See {@link forThread} for the definition this implements.
   */
  private linkedNeighbours(
    threadKey: string,
    ownHits: readonly SearchResult[],
    candidates: readonly SearchResult[],
  ): SearchResult[] {
    const ownArtifacts = new Set(ownHits.map((hit) => hit.artifactId));
    const ownPeople = new Set<string>();
    for (const artifactId of ownArtifacts) {
      for (const personId of this.participantsOf(artifactId)) ownPeople.add(personId);
    }

    return candidates.filter((hit) => {
      if (hit.threadKey === threadKey) return false; // already in `ownHits`
      if (!isCitable(hit)) return false;
      if (ownArtifacts.has(hit.artifactId)) return true;
      return this.participantsOf(hit.artifactId).some((personId) => ownPeople.has(personId));
    });
  }

  /** People attached to `artifactId`: its owner plus its participant edges. */
  private participantsOf(artifactId: string): string[] {
    const owner = this.graph.getArtifact(artifactId)?.ownerId;
    const participants = this.graph.relatedIds(artifactId, PARTICIPANT_REL);
    return owner === null || owner === undefined || owner === '' ? participants : [owner, ...participants];
  }

  /**
   * Stakes weight for `artifactId` — its declared project's weight, or
   * {@link DEFAULT_STAKES_WEIGHT} when it belongs to no project.
   *
   * When an artifact is linked to several projects the *highest* weight wins:
   * being attached to something that matters must never be diluted by also
   * being attached to something that does not.
   */
  private stakesWeightFor(artifactId: string): number {
    const cached = this.stakesCache.get(artifactId);
    if (cached !== undefined) return cached;

    const projectIds = this.graph.relatedIds(artifactId, PROJECT_REL);
    const weights = projectIds
      .map((projectId) => this.graph.getProject(projectId)?.stakesWeight)
      .filter((weight): weight is number => typeof weight === 'number' && Number.isFinite(weight));

    const weight = weights.length === 0 ? DEFAULT_STAKES_WEIGHT : Math.max(...weights);
    this.stakesCache.set(artifactId, weight);
    return weight;
  }

  /** `1 / (1 + distance)`; a non-finite distance is treated as infinitely far. */
  private similarityOf(distance: number): number {
    if (!Number.isFinite(distance)) return 0;
    return 1 / (1 + Math.max(0, distance));
  }

  /** `0.5 ^ (age / halfLife)`; strictly decreasing in age, clamped at age 0. */
  private recencyOf(occurredAt: number): number {
    const age = Math.max(0, this.clock.now() - occurredAt);
    return Math.pow(0.5, age / this.halfLifeMs);
  }

  /**
   * Score hits, dropping those a zero-weight project has silenced.
   *
   * Exclusion (rather than a score of 0) is intentional: "contributes nothing"
   * means the chunk must not appear in the citation allowlist at all.
   */
  private score(hits: readonly SearchResult[]): ScoredHit[] {
    const scored: ScoredHit[] = [];
    for (const hit of hits) {
      const stakes = this.stakesWeightFor(hit.artifactId);
      if (stakes <= 0) continue;
      scored.push({
        hit,
        score: this.similarityOf(hit.distance) * this.recencyOf(hit.occurredAt) * stakes,
      });
    }
    return scored;
  }

  /**
   * De-duplicate by chunk id (keeping the best score), sort descending and cap
   * at `topK`. Ties break on `occurredAt` then chunk id so the order is total
   * and stable across runs.
   */
  private finish(scored: readonly ScoredHit[]): RetrievedChunk[] {
    const best = new Map<string, ScoredHit>();
    for (const entry of scored) {
      const existing = best.get(entry.hit.id);
      if (existing === undefined || entry.score > existing.score) best.set(entry.hit.id, entry);
    }

    return [...best.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.hit.occurredAt - a.hit.occurredAt ||
          a.hit.id.localeCompare(b.hit.id),
      )
      .slice(0, Math.max(1, this.config.retrieval.topK))
      .map(({ hit, score }) => ({
        artifactId: hit.artifactId,
        eventId: hit.eventId,
        threadKey: hit.threadKey,
        occurredAt: hit.occurredAt,
        text: hit.text,
        score,
      }));
  }
}
