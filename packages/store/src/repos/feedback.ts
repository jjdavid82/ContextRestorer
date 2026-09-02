import type { Database } from 'better-sqlite3';
import { newId, type Feedback, type FeedbackVerdict } from '@cr/core';

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
   * The most recent verdict recorded for each of `claimIds`, across EVERY
   * briefing — not just one.
   *
   * A still-open pending item resurfaces in every briefing generated before it
   * is resolved, each under a fresh `briefingId`; the verdict the user gave it
   * is a fact about the claim, not about which briefing happened to show it.
   * Scoping this to one `briefingId` (as `listForBriefing` does) would forget
   * that fact on the very next briefing, and the user would see "Relevant" ask
   * to be answered again for something they already judged.
   *
   * A claim absent from the result has no feedback on file yet — the caller
   * treats that the same as "never asked", not as an error.
   */
  verdictsForClaims(claimIds: string[]): Record<string, FeedbackVerdict> {
    if (claimIds.length === 0) return {};

    const placeholders = claimIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT claim_id, verdict, created_at
           FROM feedback
          WHERE claim_id IN (${placeholders})
          ORDER BY created_at ASC`,
      )
      .all(...claimIds) as Array<Pick<FeedbackRow, 'claim_id' | 'verdict' | 'created_at'>>;

    const result: Record<string, FeedbackVerdict> = {};
    for (const row of rows) {
      // ASC order: a later row overwrites an earlier one, so a changed mind
      // (the user reclassified the same claim) reports the newest verdict.
      if (row.claim_id !== null) result[row.claim_id] = row.verdict as FeedbackVerdict;
    }
    return result;
  }
}
