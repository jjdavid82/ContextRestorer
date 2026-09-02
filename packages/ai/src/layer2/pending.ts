/**
 * Layer 2 — PendingItem derivation (Task 2.6).
 *
 * A delta says *what changed*. A pending item says *what is now owed*, and it is
 * the only thing in the system that asks the user to act. That asymmetry is why
 * this module is far stricter than the delta path it hangs off:
 *
 * 1. **Only obligations owed by the user become items (FR-4 / AC-4).** "Waiting
 *    on someone else" is interesting narration and a terrible to-do; per the
 *    plan it is the single most common false-positive source. The obligee is
 *    signalled by the model's `pending_item.waiting_on` field — see
 *    {@link waitsOnSelf} for why the entity graph cannot answer this question.
 *
 * 2. **Never uncited.** `pending_items.citation_artifact_id` is a NOT NULL FK
 *    into `artifacts` and is what the UI links to. A derivation that cannot name
 *    the artifact proving the obligation produces nothing at all, exactly as an
 *    uncited delta does — a to-do the user cannot trace back to a message is
 *    indistinguishable from one we invented.
 *
 * 3. **Low confidence is displayed, not suppressed (§7.6).** A weakly-held but
 *    *cited* obligation is stored with its confidence intact so a later UI layer
 *    can flag it. Suppression is reserved for rule 2. Conflating the two would
 *    silently drop the items the user most needs to correct, and the feedback
 *    loop would never learn they existed. See {@link isLowConfidence}.
 *
 * 4. **Resolution closes, it never deletes.** When a superseding delta resolves
 *    a thread, prior open items move to `resolved` (D-6's append-only spirit
 *    applied to the one genuinely mutable table): "this was owed and got done"
 *    is signal, and a DELETE would erase it.
 *
 * Written as free functions over the repo's public surface rather than as a
 * class: every rule here is a pure decision plus at most one repo call, and
 * keeping them callable without a `Layer2Synthesizer` is what lets each rule be
 * tested against a real SQLite database in isolation.
 */

import { systemClock, type Clock, type PendingItem } from '@cr/core';
import type { PendingItemsRepo } from '@cr/store';

/**
 * Below this confidence a stored item should be *flagged* in the UI (§7.6).
 *
 * Deliberately not a rejection threshold. Nothing in this module compares
 * against it before writing; it exists so that "flag it" has a single named
 * definition instead of a magic number scattered across the presentation layer.
 */
export const LOW_CONFIDENCE_FLAG_THRESHOLD = 0.5;

/**
 * The repository capability this module needs.
 *
 * A `Pick` rather than the class so a test can hand in a hand-built double, and
 * so the write surface is visible at a glance: this module inserts and resolves;
 * it never dismisses and never deletes.
 */
export type PendingWriter = Pick<PendingItemsRepo, 'insert' | 'listOpen' | 'resolve'>;

/** Everything needed to decide whether an obligation becomes a stored item. */
export interface PendingDerivationInput {
  /** The delta this obligation was extracted from. Its FK parent. */
  deltaId: string;
  /** Carried for telemetry only — `pending_items` has no thread column. */
  threadKey: string;
  /**
   * The artifact proving the obligation. `null` (or blank) means the derivation
   * is uncited and must not be written — see rule 2.
   */
  citationArtifactId: string | null;
  /** The model's calibrated certainty, already gated to `[0, 1]` upstream. */
  confidence: number;
  /** One-line statement of what is owed. */
  description: string;
  /** True when the USER owes this. False for a third party — see rule 1. */
  waitingOnSelf: boolean;
}

/**
 * Values of `pending_item.waiting_on` that mean "the user".
 *
 * Compared case-insensitively after trimming. The list is small on purpose: a
 * value that is not recognisably the user is treated as a third party, which is
 * the safe direction for a precision requirement.
 */
const SELF_TOKENS: ReadonlySet<string> = new Set(['self', 'me', 'user', 'the user', 'i', 'us']);

/** A finite confidence inside `[0, 1]`; a junk value degrades to 0, never to 1. */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Interprets the model's `waiting_on` signal as "is this the user's obligation?".
 *
 * **Why this comes from the model and not from `GraphRepo`.** `is_self` is a
 * property of a *person*, and the graph can tell us which people participated in
 * an artifact — but participation is not obligation. The user takes part in
 * essentially every thread they can see, so "self participated" is true for
 * nearly all obligations, including the ones owed by someone else; using it here
 * would produce a check that is technically data-driven and practically always
 * true, which is the tautology AC-4 exists to prevent. Who *owes* a thing is
 * stated only in the thread's prose, so only the reader of that prose can
 * report it.
 *
 * An absent or unrecognised signal (including a missing field, a blank string,
 * or a third-party name like `"Dana"`/`"the vendor"`) resolves to `false`. This
 * is the safe direction for a precision requirement: rule 1 exists precisely to
 * suppress third-party obligations, and a model response that omits
 * `waiting_on` gives no evidence the obligation is the user's — defaulting to
 * `true` in that case would silently readmit the exact false positive this
 * module exists to reject. Only an explicit first-person token counts.
 */
export function waitsOnSelf(signal: unknown): boolean {
  if (typeof signal !== 'string') return false;
  const token = signal.trim().toLowerCase();
  if (token === '') return false;
  return SELF_TOKENS.has(token);
}

/**
 * True when `item` should be shown with a low-confidence flag (§7.6).
 *
 * Purely presentational. Callers must not use it to decide whether to store.
 */
export function isLowConfidence(item: Pick<PendingItem, 'confidence'>): boolean {
  return item.confidence < LOW_CONFIDENCE_FLAG_THRESHOLD;
}

/**
 * Derive and persist at most one pending item for a delta.
 *
 * @returns the item as written, or `null` when no item was created. `null`
 *   covers five distinct non-writes, all of them normal outcomes rather than
 *   errors — a failed derivation must never cost the delta it came from, which
 *   is already committed by the time this runs:
 *
 *   - the obligation is owed by a third party (rule 1);
 *   - it has no citation (rule 2);
 *   - its description is blank, so there is nothing to show the user;
 *   - an open item already exists for this exact `deltaId` (rule 5);
 *   - the INSERT was rejected by the database.
 *
 * The last case is the one that used to be a bare `catch {}` inside the
 * synthesizer. `citation_artifact_id` is a NOT NULL FK into `artifacts`, so an
 * artifact whose graph row ingest has not written yet aborts this insert, and
 * dropping the obligation silently made that indistinguishable from "the model
 * reported no obligation". It is still dropped — propagating would make the
 * scheduler retry and append a duplicate version of a delta that already landed
 * — but it is now loud.
 *
 * Note on rule 5: the guard reads `listOpen()`, so it blocks a duplicate of an
 * item that is still open. An item already `resolved`/`dismissed` for the same
 * delta cannot be recreated in practice, because reaching this function again
 * requires a fresh `DeltasRepo.append()`, and that always mints a new
 * `deltaId` (`thread_key` + the next version).
 */
export function derivePendingItem(
  input: PendingDerivationInput,
  pendingRepo: PendingWriter,
  clock: Clock = systemClock,
): PendingItem | null {
  // Rule 1 (FR-4 / AC-4). First, because it is the cheapest and the one that
  // rejects most often.
  if (!input.waitingOnSelf) return null;

  // Rule 2: never uncited. Blank is treated as absent, not as an id.
  const citationArtifactId = input.citationArtifactId?.trim() ?? '';
  if (citationArtifactId === '') return null;

  const description = input.description.trim();
  if (description === '') return null;

  // Rule 5: idempotent per delta.
  if (pendingRepo.listOpen().some((existing) => existing.deltaId === input.deltaId)) return null;

  try {
    // Rule 4: the confidence is written as given. There is no threshold check
    // on this path, and adding one would silently suppress §7.6's flagged items.
    return pendingRepo.insert({
      deltaId: input.deltaId,
      description,
      confidence: clampConfidence(input.confidence),
      citationArtifactId,
      createdAt: clock.now(),
    });
  } catch (error) {
    // No `description` in the log line: it is model-generated prose derived from
    // thread content, and free text never reaches a log sink (SEC-7).
    console.error('[layer2/pending] insert rejected; obligation dropped', {
      deltaId: input.deltaId,
      threadKey: input.threadKey,
      citationArtifactId,
      confidence: input.confidence,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Mark every still-open item belonging to `supersededDeltaIds` as `resolved`
 * (rule 3).
 *
 * Accepts a set rather than a single id because a thread's chain can grow past
 * the item that is being closed: `v1` may carry the obligation while `v2` is
 * unrelated progress and `v3` is the resolution, and `v3.supersedes` points only
 * at `v2`. Passing the chain's prior ids closes the item that actually exists
 * instead of the one that happens to be adjacent.
 *
 * `resolve` — never `dismiss`, never DELETE. The three states mean different
 * things to the feedback loop: `resolved` is "we were right and it got done",
 * `dismissed` is "we were wrong", and an absent row is "we never noticed".
 *
 * @returns the items that were closed, as they now stand.
 */
export function resolvePendingItemsForSupersededDelta(
  supersededDeltaIds: string | readonly string[],
  pendingRepo: PendingWriter,
  at: number,
): PendingItem[] {
  const ids = new Set(
    typeof supersededDeltaIds === 'string' ? [supersededDeltaIds] : supersededDeltaIds,
  );
  if (ids.size === 0) return [];

  const closed: PendingItem[] = [];
  // `listOpen()` is read once, up front: resolving mutates what a second read
  // would return, and iterating a live query while writing to it is how a
  // half-finished sweep happens.
  for (const item of pendingRepo.listOpen()) {
    if (!ids.has(item.deltaId)) continue;
    pendingRepo.resolve(item.pendingId, at);
    closed.push({ ...item, status: 'resolved', resolvedAt: at });
  }
  return closed;
}
