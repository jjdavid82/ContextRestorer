import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { FeedbackRepo } from '../src/repos/feedback.js';

/**
 * The read side of `FeedbackRepo` (FR-7).
 *
 * Until these existed the table had no reader outside the UI redrawing the
 * button that wrote it, so "feedback feeds the offline eval" was a requirement
 * with no mechanism behind it. The join is what makes a verdict legible: the
 * table stores a `claim_id` and a word, and the sentence lives elsewhere.
 */

let db: Database;
let repo: FeedbackRepo;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new FeedbackRepo(db);
});

afterEach(() => {
  db.close();
});

/** A briefing + one claim, so a verdict has something to join against. */
function seedClaim(claimId: string, text: string, briefingId = 'b-1'): void {
  db.prepare(
    `INSERT OR IGNORE INTO artifacts
       (artifact_id, source, kind, external_ref, first_seen_at, last_seen_at)
     VALUES ('art-1', 'slack', 'thread', 'ref-1', 1000, 1000)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO briefings
       (briefing_id, window_start, window_end, generated_at, mode, narrative_path,
        delta_ids_json, threads_still_processing)
     VALUES (?, 0, 1000, 1000, 'template', '/tmp/b.md', '[]', 0)`,
  ).run(briefingId);
  db.prepare(
    `INSERT INTO briefing_claims
       (claim_id, briefing_id, ordinal, section, text, citation_artifact_id)
     VALUES (?, ?, 1, 'Worth knowing', ?, 'art-1')`,
  ).run(claimId, briefingId, text);
}

describe('FeedbackRepo.listLabeled', () => {
  it('joins each verdict to the sentence it judged', () => {
    seedClaim('c-1', 'The team postponed the migration to Q4.');
    repo.submit({ briefingId: 'b-1', claimId: 'c-1', verdict: 'wrong' });

    const [row] = repo.listLabeled();

    expect(row).toMatchObject({
      claimId: 'c-1',
      verdict: 'wrong',
      claimText: 'The team postponed the migration to Q4.',
      section: 'Worth knowing',
      citationArtifactId: 'art-1',
    });
  });

  it('keeps a verdict whose claim is gone, with a null text', () => {
    // `feedback` carries no foreign key — it must outlive the briefing it
    // refers to, and the 90-day purge does not spare claims. Dropping the row
    // would quietly shrink a count the user believes is complete.
    repo.submit({ briefingId: 'b-gone', claimId: 'c-gone', verdict: 'irrelevant' });

    const [row] = repo.listLabeled();

    expect(row?.claimId).toBe('c-gone');
    expect(row?.claimText).toBeNull();
  });

  it('keeps a briefing-level verdict, which has no claim at all', () => {
    repo.submit({ briefingId: 'b-1', verdict: 'missed', note: 'the vendor call' });

    const [row] = repo.listLabeled();

    expect(row?.claimId).toBeNull();
    expect(row?.note).toBe('the vendor call');
  });

  it('honours the since bound and returns oldest first', () => {
    seedClaim('c-1', 'first');
    repo.submit({ briefingId: 'b-1', claimId: 'c-1', verdict: 'relevant' });
    const first = repo.listLabeled()[0]?.createdAt ?? 0;

    db.prepare(
      `INSERT INTO feedback (feedback_id, briefing_id, claim_id, verdict, note, created_at)
       VALUES ('f-later', 'b-1', 'c-1', 'wrong', NULL, ?)`,
    ).run(first + 10_000);

    expect(repo.listLabeled().map((r) => r.verdict)).toEqual(['relevant', 'wrong']);
    expect(repo.listLabeled(first + 1).map((r) => r.verdict)).toEqual(['wrong']);
  });
});

describe('FeedbackRepo.countByVerdict', () => {
  it('counts each kind, omitting the ones never used', () => {
    seedClaim('c-1', 'a');
    repo.submit({ briefingId: 'b-1', claimId: 'c-1', verdict: 'wrong' });
    repo.submit({ briefingId: 'b-1', claimId: 'c-1', verdict: 'wrong' });
    repo.submit({ briefingId: 'b-1', claimId: 'c-1', verdict: 'relevant' });

    expect(repo.countByVerdict()).toEqual({ wrong: 2, relevant: 1 });
  });

  it('is empty when nothing has been judged', () => {
    expect(repo.countByVerdict()).toEqual({});
  });
});
