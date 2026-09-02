/**
 * Stakes ranker — the enforcement point for FR-5.
 *
 * A briefing has room for a handful of items, and the whole product claim is
 * that what surfaces is what *matters* rather than what happened *last*. That
 * claim lives here: {@link scoreDelta} is deliberately built so the stakes term
 * (a delta on a user-declared project) and the obligation term (something is
 * waiting on the user) dominate the recency term, which exists only as a
 * tiebreaker between otherwise-equivalent deltas.
 *
 * Because every weight is >= 0 and every factor below is normalised to `[0, 1]`,
 * the ordering guarantee is structural rather than incidental: the *most* recency
 * can ever contribute is `wRecency`, so as long as the config keeps
 * `wRecency < wStakes < wPendingOnMe` (it does — see `config/default.json`), a
 * declared-project delta cannot be displaced by a fresher undeclared one, no
 * matter how large the age gap. Nothing here hard-codes that ordering, though:
 * the weights come from `AppConfig.ranking` and re-tuning them re-orders the
 * output (NFR-7), which is exactly what makes the ranking auditable.
 *
 * ### X-2: no behavioural signal, ever
 *
 * The POC ranks on *declared* stakes and *structural* graph facts only. Clicks,
 * dwell time, open/view counts, hover, scroll depth, and feedback verdicts are
 * out of scope — not "not yet implemented", but excluded, because a ranker
 * trained on engagement optimises for attention rather than for obligation and
 * has never been evaluated for this product. The guardrail is the type
 * signature: {@link RankableDelta} is the *entire* scoring input, so a signal
 * that has no field cannot be scored on. See the comment on that interface
 * before adding anything to it.
 */

import type { GraphRepo } from '@cr/store';
import type { PendingItem, StateDelta } from '@cr/core';

/** Edge kind joining an artifact to the project it belongs to. */
const PROJECT_REL = 'belongs_to';

/** Edge kind joining an artifact to a person who took part in it. */
const PARTICIPANT_REL = 'participant';

/** The only project origin that counts as "declared" for stakes purposes (X-2). */
const DECLARED_ORIGIN = 'declared';

/**
 * Half-life of the ranking recency decay: a 7-day-old delta contributes half the
 * recency of a brand-new one.
 *
 * Intentionally *not* shared with retrieval's decay (Task 2.4). Retrieval decays
 * chunk relevance inside a similarity product; this decays a small additive
 * tiebreaker in a weighted sum. They answer different questions and are free to
 * diverge, so coupling them would be a false economy.
 */
export const RANKING_RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Everything the ranker is allowed to know about a delta.
 *
 * ---------------------------------------------------------------------------
 * X-2 GUARDRAIL — READ BEFORE ADDING A FIELD.
 *
 * Adding any behavioural or engagement signal to this interface — click count,
 * open/view count, dwell or read time, hover, scroll depth, "last opened at",
 * thumbs-up/down or any other {@link import('@cr/core').FeedbackVerdict}-derived
 * value, or a model trained on any of those — VIOLATES X-2 and must not be done
 * as part of the POC. This interface is the complete scoring input by design:
 * if a signal cannot be expressed here, it cannot influence the ranking.
 *
 * What *is* permitted here: declared stakes (FR-8), open obligations, and
 * structural facts drawn from the entity graph (who participated, what links to
 * what, when it happened). Those describe the work, not the user's attention.
 * ---------------------------------------------------------------------------
 */
export interface RankableDelta {
  /** The delta being ranked; also the deterministic final tiebreaker. */
  deltaId: string;
  /** Conversation the delta summarises. */
  threadKey: string;
  /** Epoch ms at which the delta was synthesized. */
  createdAt: number;
  /**
   * True when this delta's artifact is linked to a user-*declared* project
   * (FR-8). Inferred/clustered project membership does not exist in the POC
   * (X-2), so this is a fact the user stated, not one the system guessed.
   */
  isDeclaredProject: boolean;
  /**
   * True when an *open* {@link import('@cr/core').PendingItem} hangs off this
   * delta — i.e. something is still owed. Resolved and dismissed items are not
   * obligations and must not set this.
   */
  hasPendingOnMe: boolean;
  /**
   * How many of this thread's artifacts record the user as a participant or
   * owner.
   *
   * This is a *structural graph fact* ("was I in the room?"), derived from
   * `relationships` edges and artifact ownership — not an engagement signal. It
   * says nothing about whether the user read, clicked or reacted to anything;
   * an unread thread the user is on the recipient list of counts exactly the
   * same as one they replied to. That distinction is what keeps it inside X-2.
   *
   * Optional: callers that cannot compute it omit it, and the term contributes
   * 0 rather than distorting the score.
   */
  selfParticipationCount?: number;
}

/** Ranking weights, mirroring `AppConfig.ranking` (NFR-7: config-driven, not hard-coded). */
export interface RankingWeights {
  /** Weight of "this is on a declared project". */
  wStakes: number;
  /** Weight of "something here is waiting on me". The largest weight by design. */
  wPendingOnMe: number;
  /** Weight of "I am a participant in this thread". */
  wSelfParticipation: number;
  /** Weight of the recency tiebreaker. The smallest weight by design. */
  wRecency: number;
}

/** A delta paired with the score it earned. */
export interface ScoredDelta {
  delta: RankableDelta;
  score: number;
}

/** A weight that is missing, NaN or negative contributes nothing rather than corrupting the sum. */
function usableWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

/**
 * `0.5 ^ (age / halfLife)`, mapping age onto `(0, 1]`.
 *
 * Monotonically decreasing in age, so an older delta never out-scores a newer
 * one on this term. Ages are clamped at 0, so a clock-skewed future timestamp
 * scores 1 instead of exploding; a non-finite age scores 0 (treated as
 * infinitely old) so bad data sinks rather than dominating.
 *
 * Exported because "how much did recency actually contribute?" is a question the
 * ranking-explanation surface needs to be able to answer.
 */
export function recencyDecay(ageMs: number, halfLifeMs = RANKING_RECENCY_HALF_LIFE_MS): number {
  if (!Number.isFinite(ageMs)) return 0;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 0;
  return Math.pow(0.5, Math.max(0, ageMs) / halfLifeMs);
}

/**
 * Saturating participation factor: `n / (1 + n)`, mapping `[0, ∞)` onto `[0, 1)`.
 *
 * Diminishing returns are the point. A raw count would let one very chatty
 * thread the user happens to be cc'd on outweigh a declared-project decision, so
 * the term saturates: 0 → 0, 1 → 0.5, 3 → 0.75, 100 → 0.99. Being *in* the
 * thread is most of the signal; being in it a lot adds little.
 */
function participationFactor(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count) || count <= 0) return 0;
  return count / (1 + count);
}

/**
 * Relevance score for one delta. Higher is more briefing-worthy.
 *
 * ```
 * score = wStakes           * (isDeclaredProject ? 1 : 0)
 *       + wPendingOnMe      * (hasPendingOnMe    ? 1 : 0)
 *       + wSelfParticipation* (n / (1 + n))                  // n = selfParticipationCount
 *       + wRecency          * 0.5 ^ (age / 7 days)
 * ```
 *
 * Every factor is in `[0, 1]`, so each term is bounded by its own weight and the
 * config's weight ordering *is* the priority ordering. In particular the recency
 * term can contribute at most `wRecency`, which is why it can break ties without
 * ever overturning stakes (FR-5).
 *
 * @param now Epoch ms, injected rather than read from a clock so scoring is pure
 * and a whole ranking pass shares one consistent instant.
 */
export function scoreDelta(delta: RankableDelta, weights: RankingWeights, now: number): number {
  const stakes = delta.isDeclaredProject ? 1 : 0;
  const pending = delta.hasPendingOnMe ? 1 : 0;
  const participation = participationFactor(delta.selfParticipationCount);
  const recency = Number.isFinite(delta.createdAt) ? recencyDecay(now - delta.createdAt) : 0;

  return (
    usableWeight(weights.wStakes) * stakes +
    usableWeight(weights.wPendingOnMe) * pending +
    usableWeight(weights.wSelfParticipation) * participation +
    usableWeight(weights.wRecency) * recency
  );
}

/**
 * Score every delta and return them highest-first.
 *
 * Pure: the input array is not mutated. Ties (identical scores, e.g. when
 * `wRecency` is 0) fall back to newer-first and then to `deltaId` ascending, so
 * the order is total and reproducible across runs — a briefing that reruns on
 * the same data must not shuffle.
 */
export function rankDeltas(
  deltas: readonly RankableDelta[],
  weights: RankingWeights,
  now: number,
): RankableDelta[] {
  return scoreAndRank(deltas, weights, now).map((entry) => entry.delta);
}

/**
 * As {@link rankDeltas}, but keeping each delta's score.
 *
 * Used where the ranking has to be *explained* rather than merely applied (why
 * did this item make the briefing and that one not?).
 */
export function scoreAndRank(
  deltas: readonly RankableDelta[],
  weights: RankingWeights,
  now: number,
): ScoredDelta[] {
  return deltas
    .map((delta) => ({ delta, score: scoreDelta(delta, weights, now) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.delta.createdAt - a.delta.createdAt ||
        a.delta.deltaId.localeCompare(b.delta.deltaId),
    );
}

/** Graph/pending context needed to derive a {@link RankableDelta} from a stored delta. */
export interface RankableDeltaContext {
  /** Entity graph, for project membership and participant edges. */
  graph: Pick<GraphRepo, 'getArtifact' | 'getProject' | 'relatedIds'>;
  /** Pending items belonging to this delta (any status; only `open` ones count). */
  pendingItems?: readonly PendingItem[];
  /** `personId` of the user, for the self-participation count. Omit to skip that term. */
  selfPersonId?: string;
}

/**
 * Project a stored {@link StateDelta} onto the ranker's input shape.
 *
 * Kept in this module so the mapping from graph rows to scoring inputs is
 * reviewable in the same place as the X-2 guardrail: this is the only function
 * that decides what the ranker gets to see.
 *
 * - `isDeclaredProject` — true when the delta's primary artifact (or any artifact
 *   it cites) is linked by a `belongs_to` edge to a project whose `origin` is
 *   `'declared'`. Any other origin is ignored: inferred projects do not exist in
 *   the POC and must never earn stakes weight (X-2).
 * - `hasPendingOnMe` — true when any supplied pending item is still `open`.
 *   `PendingItem` carries no assignee in the POC schema, so "on me" is
 *   approximated by "attached to a delta in my own briefing scope"; when an
 *   assignee lands, tighten the check here.
 * - `selfParticipationCount` — how many of the delta's artifacts have the user as
 *   owner or as a `participant` edge. Structural, not behavioural.
 */
export function toRankableDelta(delta: StateDelta, context: RankableDeltaContext): RankableDelta {
  const artifactIds = new Set<string>(delta.citationArtifactIds);
  if (delta.artifactId !== null && delta.artifactId !== '') artifactIds.add(delta.artifactId);

  let isDeclaredProject = false;
  let selfParticipationCount = 0;

  for (const artifactId of artifactIds) {
    if (!isDeclaredProject) {
      isDeclaredProject = context.graph
        .relatedIds(artifactId, PROJECT_REL)
        .some((projectId) => context.graph.getProject(projectId)?.origin === DECLARED_ORIGIN);
    }

    if (context.selfPersonId !== undefined && isSelfOn(artifactId, context)) {
      selfParticipationCount += 1;
    }
  }

  return {
    deltaId: delta.deltaId,
    threadKey: delta.threadKey,
    createdAt: delta.createdAt,
    isDeclaredProject,
    hasPendingOnMe: (context.pendingItems ?? []).some((item) => item.status === 'open'),
    selfParticipationCount,
  };
}

/** True when the user owns `artifactId` or has a `participant` edge to it. */
function isSelfOn(artifactId: string, context: RankableDeltaContext): boolean {
  const self = context.selfPersonId;
  if (self === undefined) return false;
  if (context.graph.getArtifact(artifactId)?.ownerId === self) return true;
  return context.graph.relatedIds(artifactId, PARTICIPANT_REL).includes(self);
}
