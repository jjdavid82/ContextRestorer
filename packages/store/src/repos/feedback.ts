import type { Database } from 'better-sqlite3';
import { newId, parseFeedbackClaimKey, type Feedback, type FeedbackVerdict } from '@cr/core';

/** Raw `feedback` row shape as returned by better-sqlite3. */
interface FeedbackRow {
  feedback_id: string;
  briefing_id: string;
  claim_id: string | null;
  verdict: string;
  note: string | null;
  created_at: number;
}

/**
 * The only verdicts the schema comment allows. Kept as a runtime value, not
 * just a type: feedback arrives from the renderer over IPC, where the compiler
 * has already stopped being a guarantee.
 */
const VALID_VERDICTS: readonly FeedbackVerdict[] = ['relevant', 'irrelevant', 'missed', 'wrong'];

export interface SubmitFeedbackInput {
  briefingId: string;
  /** Omitted for briefing-level verdicts such as `missed`. */
  claimId?: string;
  verdict: FeedbackVerdict;
  note?: string;
}

function isValidVerdict(value: unknown): value is FeedbackVerdict {
  return typeof value === 'string' && (VALID_VERDICTS as readonly string[]).includes(value);
}

function toFeedback(row: FeedbackRow): Feedback {
  return {
    feedbackId: row.feedback_id,
    briefingId: row.briefing_id,
    claimId: row.claim_id,
    verdict: row.verdict as FeedbackVerdict,
    ...(row.note === null ? {} : { note: row.note }),
    createdAt: row.created_at,
  };
}

/**
 * Persistence for user verdicts on briefings and individual claims (FR-12).
 *
 * `feedback` intentionally carries no foreign keys — feedback must survive a
 * retention sweep that removes the briefing it refers to, since the aggregate
 * signal outlives any single briefing. Validation therefore has to happen in
 * this layer; the database will not do it for us.
 */
/**
 * One recorded verdict with the claim it judged (FR-7's exportable shape).
 *
 * `claimText`/`section`/`citationArtifactId` are `null` when the claim itself
 * is gone — a briefing-level verdict (`missed` carries no `claimId`), or a
 * claim aged out by retention. Null rather than omitted, so a consumer must
 * decide what to do about it rather than silently seeing a shorter list.
 */
export interface LabeledVerdict {
  feedbackId: string;
  briefingId: string;
  claimId: string | null;
  verdict: FeedbackVerdict;
  note: string | null;
  createdAt: number;
  /** The sentence the user judged. */
  claimText: string | null;
  section: string | null;
  citationArtifactId: string | null;
}

/** Raw join row backing {@link LabeledVerdict}. */
interface LabeledRow {
  feedback_id: string;
  briefing_id: string;
  claim_id: string | null;
  verdict: string;
  note: string | null;
  created_at: number;
  claim_text: string | null;
  section: string | null;
  citation_artifact_id: string | null;
}

export class FeedbackRepo {
  constructor(private db: Database) {}

  /**
   * Record one verdict.
   *
   * Validates `verdict` *before* touching the database, so an unrecognized
   * value leaves no row behind rather than poisoning later aggregates with a
   * category nothing knows how to count.
   */
  submit(input: SubmitFeedbackInput): Feedback {
    if (!isValidVerdict(input.verdict)) {
      throw new Error(
        `store: invalid feedback verdict ${JSON.stringify(input.verdict)} ` +
          `(expected one of ${VALID_VERDICTS.join(', ')})`,
      );
    }

    const feedbackId = newId();
    const claimId = input.claimId ?? null;
    const note = input.note ?? null;
    const createdAt = Date.now();

    this.db
      .prepare(
        `INSERT INTO feedback (feedback_id, briefing_id, claim_id, verdict, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(feedbackId, input.briefingId, claimId, input.verdict, note, createdAt);

    return {
      feedbackId,
      briefingId: input.briefingId,
      claimId,
      verdict: input.verdict,
      ...(note === null ? {} : { note }),
      createdAt,
    };
  }

  /** All feedback for a briefing, oldest first. */
  listForBriefing(briefingId: string): Feedback[] {
    const rows = this.db
      .prepare(
        `SELECT feedback_id, briefing_id, claim_id, verdict, note, created_at
           FROM feedback
          WHERE briefing_id = ?
          ORDER BY created_at ASC`,
      )
      .all(briefingId) as FeedbackRow[];

    return rows.map(toFeedback);
  }

  /**
   * Every verdict the user has recorded, joined to the claim it judged.
   *
   * The `feedback` table alone is close to useless outside the UI: it stores a
   * `claim_id` and a word, and the sentence that was judged lives in
   * `briefing_claims`. Without the join, a verdict cannot be read by anything
   * that was not already looking at that briefing — which is why FR-7's
   * "feeds offline eval" had no reader at all: there was nothing legible to
   * feed it.
   *
   * ### What `feedback.claim_id` actually holds
   *
   * The renderer has no `briefing_claims.claim_id` on the wire — `briefing:chunk`
   * carries a `Citation`, not a claim row — so `FeedbackControls` submits a
   * `` (U+001F)-joined `<citation artifact id><sep><claim sentence>` key
   * (see `@cr/core`'s `feedbackClaimKey`). Joining `c.claim_id = f.claim_id`
   * therefore matched nothing in production: `briefing_claims.claim_id` is a
   * random `newId()`. The join reconstructs the same key from `briefing_claims`
   * with `citation_artifact_id || char(31) || text`, so it matches the exact
   * claim the verdict was given on — not merely the thread, which would fold a
   * "not relevant" onto every later, differently-worded claim about it.
   *
   * A LEFT JOIN, deliberately. Feedback carries no foreign key (it must outlive
   * the briefing it refers to, and the 90-day purge does not spare claims), so
   * a verdict whose claim has since been deleted — or a briefing-level `missed`
   * verdict with no `claim_id` at all — still comes back. Its sentence is
   * recovered from the key itself when the `briefing_claims` row is gone, so a
   * `wrong` verdict stays exportable past a retention sweep.
   *
   * @param sinceMs - Epoch ms lower bound (inclusive). Omit for everything.
   */
  listLabeled(sinceMs = 0): LabeledVerdict[] {
    const rows = this.db
      .prepare(
        `SELECT f.feedback_id, f.briefing_id, f.claim_id, f.verdict, f.note, f.created_at,
                c.text AS claim_text, c.section, c.citation_artifact_id
           FROM feedback f
           LEFT JOIN briefing_claims c
             ON c.briefing_id = f.briefing_id
            AND f.claim_id = c.citation_artifact_id || char(31) || c.text
          WHERE f.created_at >= ?
          ORDER BY f.created_at ASC`,
      )
      .all(sinceMs) as LabeledRow[];

    return rows.map((row) => {
      const fromKey = parseFeedbackClaimKey(row.claim_id);
      return {
        feedbackId: row.feedback_id,
        briefingId: row.briefing_id,
        claimId: row.claim_id,
        verdict: row.verdict as FeedbackVerdict,
        note: row.note,
        createdAt: row.created_at,
        // Prefer the live claim row; fall back to the sentence embedded in the
        // key so the export survives the briefing being purged.
        claimText: row.claim_text ?? fromKey?.claimText ?? null,
        section: row.section,
        citationArtifactId: row.citation_artifact_id ?? fromKey?.artifactId ?? null,
      };
    });
  }

  /**
   * How many verdicts of each kind were recorded since `sinceMs`.
   *
   * Feeds the Diagnostics panel, so the user can see that pressing those
   * buttons produced something. A verdict count is the smallest honest answer
   * to "did that do anything" — it does not claim the ranking changed, because
   * it did not (X-2).
   */
  countByVerdict(sinceMs = 0): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT verdict, COUNT(*) AS n FROM feedback WHERE created_at >= ? GROUP BY verdict`,
      )
      .all(sinceMs) as Array<{ verdict: string; n: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.verdict] = row.n;
    return counts;
  }

  /**
   * The most recent verdict recorded for each of `claimKeys`, across EVERY
   * briefing — not just one.
   *
   * Each key is a `feedbackClaimKey(artifactId, sentence)` (see `@cr/core`): a
   * still-open obligation resurfaces in every briefing until it is resolved,
   * each under a fresh `briefingId`, and the verdict is a fact about that claim
   * — but only while its wording is unchanged. A reworded claim about the same
   * thread is a different key and correctly gets no verdict back, so the user
   * sees the new development instead of it being silently pre-dismissed.
   *
   * A key absent from the result has no feedback on file yet — the caller
   * treats that the same as "never asked", not as an error.
   */
  verdictsForClaims(claimKeys: string[]): Record<string, FeedbackVerdict> {
    if (claimKeys.length === 0) return {};

    const placeholders = claimKeys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT claim_id, verdict, created_at
           FROM feedback
          WHERE claim_id IN (${placeholders})
          ORDER BY created_at ASC`,
      )
      .all(...claimKeys) as Array<Pick<FeedbackRow, 'claim_id' | 'verdict' | 'created_at'>>;

    const result: Record<string, FeedbackVerdict> = {};
    for (const row of rows) {
      // ASC order: a later row overwrites an earlier one, so a changed mind
      // (the user reclassified the same claim) reports the newest verdict.
      if (row.claim_id !== null) result[row.claim_id] = row.verdict as FeedbackVerdict;
    }
    return result;
  }
}
