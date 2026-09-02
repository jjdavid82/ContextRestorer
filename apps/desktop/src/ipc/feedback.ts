/**
 * `feedback:submit` / `briefing:caughtUp` / `briefing:metrics` main-process
 * handlers (Task 3.7) — the **completion signal** (FR-11) and the **verdict
 * capture** (FR-12) behind it.
 *
 * Three channels, one module, because they share one story: the user finishes
 * reading, taps "I'm caught up", and tells us whether what they read was worth
 * reading. The first tap is what NFR-10 measures; the verdicts are what tunes
 * the ranker later.
 *
 * ## `briefing:caughtUp` is idempotent, and that is enforced HERE
 *
 * `BriefingsRepo.markCaughtUp` is an unconditional
 * `UPDATE briefings SET caught_up_at = ?` — it overwrites on every call. That is
 * the right primitive for a repo (it is not the repo's business to decide that a
 * correction is illegal), but it is the wrong behaviour for this channel: the
 * button is a single visible control that a user can double-tap, that React can
 * re-fire on a re-render, and that a stale window can re-send after a reload.
 * Under a bare `markCaughtUp` every one of those rewrites `caught_up_at` to the
 * present moment, and NFR-10's time-to-re-entry silently inflates to "however
 * long the window happened to stay open" — a metric that measures our own bug.
 *
 * So {@link markBriefingCaughtUp} does check-before-write: it reads the briefing,
 * and calls `markCaughtUp` **only when `caughtUpAt` is currently null**. Every
 * later call is a no-op that reports the FIRST timestamp back. The check and the
 * write are not in an explicit transaction, and do not need to be: the only
 * writer of this column is this handler, on the main process's single thread,
 * and the failure mode a transaction would prevent (two concurrent first-taps)
 * cannot be constructed from one renderer button.
 *
 * Deliberately NOT solved with SQL (`... WHERE caught_up_at IS NULL`): that
 * would need a repo change, and the repo is shared with Layer 3. The rule
 * "the first completion signal wins" is a property of this channel, so it lives
 * on this channel.
 *
 * ## Nothing throws out of an `ipcMain.handle` callback
 *
 * A rejection reaches the renderer as an opaque `Error invoking remote method …`
 * with a main-process stack pasted into it. `FeedbackControls` renders
 * `result.reason` instead, so failures come back as `{ ok: false, reason }` —
 * the same contract the OAuth, projects and schedule handlers use.
 *
 * ## AC-9: a verdict is persisted in under a second
 *
 * Met structurally, not by tuning: {@link FeedbackHandlerDeps} contains no model
 * client, no network client and no retriever, and this file imports nothing from
 * `@cr/ai`. `submitFeedback` is one prepared INSERT into local SQLite and
 * returns synchronously; the `Promise` the renderer sees is manufactured by
 * `ipcMain.handle`. There is nothing in scope for it to wait on.
 */
import { ipcMain } from 'electron';
import type {
  BriefingMetric,
  CaughtUpResult,
  FeedbackVerdict,
  OkResult,
} from '../preload.cjs';

export type { BriefingMetric, CaughtUpResult };

/** Invoke channel recording one user verdict (FR-12). */
export const SUBMIT_CHANNEL = 'feedback:submit';

/** Invoke channel stamping the completion signal (FR-11). */
export const CAUGHT_UP_CHANNEL = 'briefing:caughtUp';

/** Invoke channel serving time-to-re-entry per briefing (NFR-10). */
export const METRICS_CHANNEL = 'briefing:metrics';

/**
 * Invoke channel serving the verdicts already on file for a set of claims.
 *
 * Exists so a restarted app (or a still-open pending item resurfacing in a
 * later briefing under a fresh `briefingId`) can seed "✓ recorded" instead of
 * asking the user to re-judge something they already answered.
 */
export const CLAIM_VERDICTS_CHANNEL = 'feedback:claimVerdicts';

/**
 * The verdicts the store's CHECK constraint allows.
 *
 * Duplicated from `FeedbackRepo`'s own list on purpose: this is the trust
 * boundary, and the value arriving here came from a renderer that displays
 * untrusted ingested text. Validating before the repo call means an unknown
 * verdict comes back as `{ ok: false, reason: 'invalid_verdict' }` — something
 * the UI can render — rather than as a thrown SQLite constraint error.
 */
const VERDICTS: readonly FeedbackVerdict[] = ['relevant', 'irrelevant', 'missed', 'wrong'];

/**
 * Maximum characters of free-text note accepted with a verdict.
 *
 * The note is user-typed and goes straight into the database; without a bound, a
 * scripted renderer could write a multi-megabyte row per click. Truncated rather
 * than rejected — losing the tail of an over-long note is better than losing the
 * verdict it was attached to.
 */
export const MAX_NOTE_CHARS = 2_000;

/**
 * How many briefings one `briefing:metrics` call may ask about.
 *
 * Each id is a separate prepared-statement read, and the result is
 * structured-cloned across the bridge. The cap keeps a malformed (or malicious)
 * request from turning one invoke into an unbounded scan.
 */
export const MAX_METRICS_IDS = 200;

/**
 * How many claim ids one `feedback:claimVerdicts` call may ask about.
 *
 * Same reasoning as {@link MAX_METRICS_IDS}: each id is a separate `IN (...)`
 * placeholder, and the cap keeps a malformed request from turning one invoke
 * into an unbounded scan.
 */
export const MAX_CLAIM_IDS = 200;

/**
 * The slice of `FeedbackRepo` this module writes through — and, for
 * `feedback:claimVerdicts`, reads back through.
 *
 * Structural, so the real repo satisfies it with no adapter and a test can pass
 * a hand-rolled store. `listForBriefing` still has no channel of its own: a
 * dependency nobody uses is a dependency that invites use.
 */
export interface FeedbackStore {
  submit(input: {
    briefingId: string;
    claimId?: string;
    verdict: FeedbackVerdict;
    note?: string;
  }): { feedbackId: string };
  /** The most recent verdict for each claim id, across every briefing. */
  verdictsForClaims(claimIds: string[]): Record<string, FeedbackVerdict>;
}

/**
 * The slice of `BriefingsRepo` this module uses.
 *
 * `getById` is here specifically to make the idempotency check possible — see
 * the module header. `timeToReEntryMs` is the repo's own NFR-10 computation
 * (`caught_up_at - generated_at`), used rather than re-derived so there is
 * exactly one definition of the metric in the codebase.
 */
export interface BriefingCompletionStore {
  getById(briefingId: string): { generatedAt: number; caughtUpAt: number | null } | undefined;
  markCaughtUp(briefingId: string, at: number): void;
  timeToReEntryMs(briefingId: string): number | null;
}

/** Everything the completion/feedback handlers need. Note the absence of any model client. */
export interface FeedbackHandlerDeps {
  /** Verdict sink; `FeedbackRepo` in production. */
  feedback: FeedbackStore;
  /** Briefing reader/stamper; `BriefingsRepo` in production. */
  briefings: BriefingCompletionStore;
  /** Injected time source for `caught_up_at`; nothing here calls `Date.now()`. */
  clock: { now(): number };
}

/* -------------------------------------------------------------------------- */
/* feedback:submit (FR-12, AC-9)                                              */
/* -------------------------------------------------------------------------- */

/** The cleaned, trusted form of a renderer-supplied verdict. */
export interface ParsedFeedback {
  briefingId: string;
  claimId?: string;
  verdict: FeedbackVerdict;
  note?: string;
}

/**
 * Re-validate the renderer-supplied feedback.
 *
 * The preload's `assertFeedback` checks the same things, but a compromised
 * renderer controls what it sends, so the preload is a convenience gate and this
 * is the trust boundary.
 *
 * Matches the shape `FeedbackControls` actually sends today: `{ briefingId,
 * verdict }` for the briefing-level "I missed something", and `{ briefingId,
 * claimId, verdict }` for the three claim-level verdicts. No `note` is sent by
 * any control yet — it is accepted (and bounded) because the wire type carries
 * it and a future note field must not need a main-process change to work.
 *
 * @returns The cleaned input, or `null` when it is not a verdict worth storing.
 */
export function parseFeedbackArg(arg: unknown): ParsedFeedback | null {
  const candidate = arg as
    | { briefingId?: unknown; claimId?: unknown; verdict?: unknown; note?: unknown }
    | null;
  if (candidate === null || typeof candidate !== 'object') return null;

  const { briefingId, claimId, verdict, note } = candidate;
  if (typeof briefingId !== 'string' || briefingId === '') return null;
  if (!(VERDICTS as readonly unknown[]).includes(verdict)) return null;

  // An absent claim id is briefing-level feedback, which is a first-class case
  // (FR-7 "I missed something"). A PRESENT but empty one is a renderer bug, and
  // storing `''` would create a claim-level row pointing at no claim.
  if (claimId !== undefined && (typeof claimId !== 'string' || claimId === '')) return null;
  if (note !== undefined && typeof note !== 'string') return null;

  const trimmedNote =
    typeof note === 'string' && note.length > MAX_NOTE_CHARS
      ? note.slice(0, MAX_NOTE_CHARS)
      : note;

  // `exactOptionalPropertyTypes`: an absent field is an absent KEY, not
  // `claimId: undefined` — the repo branches on `?? null`.
  return {
    briefingId,
    verdict: verdict as FeedbackVerdict,
    ...(typeof claimId === 'string' ? { claimId } : {}),
    ...(typeof trimmedNote === 'string' ? { note: trimmedNote } : {}),
  };
}

/**
 * The whole of `feedback:submit`: validate, one INSERT, acknowledge.
 *
 * Synchronous by construction — see the module header on AC-9. Never throws.
 */
export function submitFeedback(arg: unknown, deps: FeedbackHandlerDeps): OkResult {
  const parsed = parseFeedbackArg(arg);
  if (parsed === null) return { ok: false, reason: 'invalid_feedback' };

  try {
    deps.feedback.submit(parsed);
    return { ok: true };
  } catch (error) {
    // `feedback` carries no foreign keys (it must outlive the briefing it refers
    // to), so there is no "unknown briefing" failure to distinguish here; a
    // throw at this point is a genuine storage fault.
    console.error('[feedback] submit failed', parsed.briefingId, error);
    return { ok: false, reason: 'internal_error' };
  }
}

/* -------------------------------------------------------------------------- */
/* briefing:caughtUp (FR-11, NFR-10)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Re-validate the `{ briefingId }` argument shared by the two briefing channels.
 *
 * @returns The id, or `null` when the argument is unusable.
 */
export function parseBriefingIdArg(arg: unknown): string | null {
  const briefingId: unknown = (arg as { briefingId?: unknown } | null)?.briefingId;
  if (typeof briefingId !== 'string' || briefingId === '') return null;
  return briefingId;
}

/**
 * The whole of `briefing:caughtUp`: read, stamp **only if unstamped**, report.
 *
 * The idempotency is the point of this function — see the module header. A
 * second call, even one arriving with a much later clock, takes the
 * already-stamped branch and returns the FIRST `caughtUpAt` together with the
 * time-to-re-entry derived from it. The caller cannot tell the two apart, and
 * should not need to: "you are caught up, and it took this long" is true either
 * way.
 *
 * Never throws.
 */
export function markBriefingCaughtUp(arg: unknown, deps: FeedbackHandlerDeps): CaughtUpResult {
  const briefingId = parseBriefingIdArg(arg);
  if (briefingId === null) return { ok: false, reason: 'invalid_id' };

  try {
    const briefing = deps.briefings.getById(briefingId);
    if (briefing === undefined) {
      // A stale renderer can hold an id across a retention purge; that is not a
      // crash, and `markCaughtUp` would throw for it.
      console.info('[feedback] caughtUp for unknown briefing', briefingId);
      return { ok: false, reason: 'unknown_briefing' };
    }

    // THE IDEMPOTENCY GUARD. Do not "simplify" this to an unconditional write:
    // `markCaughtUp` overwrites, and the second tap would move the stamp.
    let caughtUpAt = briefing.caughtUpAt;
    if (caughtUpAt === null) {
      caughtUpAt = deps.clock.now();
      deps.briefings.markCaughtUp(briefingId, caughtUpAt);
    }

    // Read back through the repo rather than computing it from `caughtUpAt`
    // locally: it is the single definition of NFR-10, and going through it also
    // proves the row really carries the stamp we are about to report.
    const timeToReEntryMs = deps.briefings.timeToReEntryMs(briefingId);

    return {
      ok: true,
      // Absent KEY rather than `undefined` value, per `exactOptionalPropertyTypes`.
      ...(caughtUpAt !== null ? { caughtUpAt } : {}),
      ...(timeToReEntryMs !== null ? { timeToReEntryMs } : {}),
    };
  } catch (error) {
    console.error('[feedback] caughtUp failed', briefingId, error);
    return { ok: false, reason: 'internal_error' };
  }
}

/* -------------------------------------------------------------------------- */
/* briefing:metrics (NFR-10 view)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Narrow the renderer-supplied id list.
 *
 * @returns Distinct, non-empty ids, capped at {@link MAX_METRICS_IDS}, or `null`
 *   when the argument is not an id list at all. An empty array is a valid
 *   request whose valid answer is `[]`.
 */
export function parseMetricsArg(arg: unknown): string[] | null {
  const ids: unknown = (arg as { briefingIds?: unknown } | null)?.briefingIds;
  if (!Array.isArray(ids)) return null;

  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const id of ids as unknown[]) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
    if (cleaned.length >= MAX_METRICS_IDS) break;
  }
  return cleaned;
}

/**
 * The whole of `briefing:metrics`: the NFR-10 time-to-re-entry view.
 *
 * This is the reachable path the metric is *read* through — `timeToReEntryMs`
 * would otherwise be a repo method nothing ever called. The full metrics UI is
 * out of scope for this task; the channel is not, because a metric with no
 * reader is not a metric.
 *
 * Unknown ids are omitted rather than returned as a row of nulls: "this briefing
 * was purged" and "this briefing is still open" are different facts, and only
 * the second one belongs in an average. Order follows the request, so a caller
 * can zip the result back against its own list.
 *
 * Never throws — a failed read degrades to a shorter list.
 */
export function briefingMetrics(arg: unknown, deps: FeedbackHandlerDeps): BriefingMetric[] {
  const ids = parseMetricsArg(arg);
  if (ids === null) return [];

  const metrics: BriefingMetric[] = [];
  for (const briefingId of ids) {
    try {
      const briefing = deps.briefings.getById(briefingId);
      if (briefing === undefined) continue;

      metrics.push({
        briefingId,
        generatedAt: briefing.generatedAt,
        caughtUpAt: briefing.caughtUpAt,
        // The repo's own definition, not `caughtUpAt - generatedAt` recomputed
        // here: one metric, one implementation.
        timeToReEntryMs: deps.briefings.timeToReEntryMs(briefingId),
      });
    } catch (error) {
      console.error('[feedback] metrics read failed', briefingId, error);
    }
  }
  return metrics;
}

/* -------------------------------------------------------------------------- */
/* feedback:claimVerdicts — replay across restarts and across briefings       */
/* -------------------------------------------------------------------------- */

/**
 * Narrow the renderer-supplied claim id list. Same shape and same dedupe/cap
 * reasoning as {@link parseMetricsArg}; kept as a separate function because the
 * two lists mean different things and a shared name would blur that.
 *
 * @returns Distinct, non-empty ids, capped at {@link MAX_CLAIM_IDS}, or `null`
 *   when the argument is not an id list at all. An empty array is a valid
 *   request whose valid answer is `{}`.
 */
export function parseClaimIdsArg(arg: unknown): string[] | null {
  const ids: unknown = (arg as { claimIds?: unknown } | null)?.claimIds;
  if (!Array.isArray(ids)) return null;

  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const id of ids as unknown[]) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
    if (cleaned.length >= MAX_CLAIM_IDS) break;
  }
  return cleaned;
}

/**
 * The whole of `feedback:claimVerdicts`: look up what the user already said
 * about each claim, regardless of which briefing asked.
 *
 * Never throws — a failed read degrades to an empty map, which the renderer
 * already treats as "nothing recorded yet" rather than as an error.
 */
export function claimVerdicts(
  arg: unknown,
  deps: FeedbackHandlerDeps,
): Record<string, FeedbackVerdict> {
  const claimIds = parseClaimIdsArg(arg);
  if (claimIds === null) return {};

  try {
    return deps.feedback.verdictsForClaims(claimIds);
  } catch (error) {
    console.error('[feedback] claimVerdicts read failed', error);
    return {};
  }
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Register the completion/feedback channels.
 *
 * Safe to call before any window exists — none of them needs a `BrowserWindow`.
 * Every callback is a thin wrapper over the pure functions above, which is
 * where the tests aim.
 *
 * None is `async`: every value is produced in the same turn the renderer's
 * invoke arrives, which is what makes AC-9's one-second budget a non-event.
 */
export function registerFeedbackHandlers(deps: FeedbackHandlerDeps): void {
  ipcMain.handle(SUBMIT_CHANNEL, (_event, arg: unknown): OkResult => submitFeedback(arg, deps));

  ipcMain.handle(
    CAUGHT_UP_CHANNEL,
    (_event, arg: unknown): CaughtUpResult => markBriefingCaughtUp(arg, deps),
  );

  ipcMain.handle(
    METRICS_CHANNEL,
    (_event, arg: unknown): BriefingMetric[] => briefingMetrics(arg, deps),
  );

  ipcMain.handle(
    CLAIM_VERDICTS_CHANNEL,
    (_event, arg: unknown): Record<string, FeedbackVerdict> => claimVerdicts(arg, deps),
  );
}
