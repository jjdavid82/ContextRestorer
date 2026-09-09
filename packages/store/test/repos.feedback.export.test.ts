import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { feedbackClaimKey } from '@cr/core';
import { openDb, migrate } from '../src/index.js';
import { FeedbackRepo } from '../src/repos/feedback.js';

/**
 * The read side of `FeedbackRepo` (FR-7).
 *
 * Until these existed the table had no reader outside the UI redrawing the
 * button that wrote it, so "feedback feeds the offline eval" was a requirement
 * with no mechanism behind it. The join is what makes a verdict legible: the
 * table stores a `` (U+001F)-joined `<artifact id><sep><sentence>` key, and
 * the join reconstructs that key from `briefing_claims` to recover section /
 * live text.
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

/**
 * A briefing + one claim, so a verdict has something to join against.
 *
 * `feedback.claim_id` in production is `feedbackClaimKey(artifactId, sentence)`
 * (that is all the renderer has on the wire — see `BriefingView`), so the
 * verdicts these tests submit pass that key, not the `briefing_claims` primary
 * key.
 */
function seedClaim(
  opts: {
    text: string;
    artifactId?: string;
    briefingId?: string;
    claimId?: string;
    ordinal?: number;
  },
): void {
  const { text } = opts;
  const artifactId = opts.artifactId ?? 'art-1';
  const briefingId = opts.briefingId ?? 'b-1';
  const claimId = opts.claimId ?? `claim-${artifactId}-${opts.ordinal ?? 1}`;
  db.prepare(
    `INSERT OR IGNORE INTO artifacts
       (artifact_id, source, kind, external_ref, first_seen_at, last_seen_at)
     VALUES (?, 'slack', 'thread', ?, 1000, 1000)`,
  ).run(artifactId, `ref-${artifactId}`);
  db.prepare(
    `INSERT OR IGNORE INTO briefings
       (briefing_id, window_start, window_end, generated_at, mode, narrative_path,
        delta_ids_json, threads_still_processing)
     VALUES (?, 0, 1000, 1000, 'template', '/tmp/b.md', '[]', 0)`,
  ).run(briefingId);
  db.prepare(
    `INSERT INTO briefing_claims
       (claim_id, briefing_id, ordinal, section, text, citation_artifact_id)
     VALUES (?, ?, ?, 'Worth knowing', ?, ?)`,
  ).run(claimId, briefingId, opts.ordinal ?? 1, text, artifactId);
}

describe('FeedbackRepo.listLabeled', () => {
  it('joins each verdict to the exact sentence it judged', () => {
    const text = 'The team postponed the migration to Q4.';
    seedClaim({ text });
    repo.submit({ briefingId: 'b-1', claimId: feedbackClaimKey('art-1', text), verdict: 'wrong' });

    const [row] = repo.listLabeled();

    expect(row).toMatchObject({
      verdict: 'wrong',
      claimText: text,
      section: 'Worth knowing',
      citationArtifactId: 'art-1',
    });
  });

  it('scopes the verdict to one sibling when an artifact backs several claims', () => {
    // One thread's artifact backs a different claim in each briefing it recurs
    // in. A verdict on the first must not attach to the second.
    seedClaim({ text: 'first claim about art-1', ordinal: 1, claimId: 'k1' });
    seedClaim({ text: 'second claim about art-1', ordinal: 2, claimId: 'k2' });
    repo.submit({
      briefingId: 'b-1',
      claimId: feedbackClaimKey('art-1', 'first claim about art-1'),
      verdict: 'irrelevant',
    });

    const rows = repo.listLabeled();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.claimText).toBe('first claim about art-1');
  });

  it('recovers the sentence from the key when the claim row is gone', () => {
    // `feedback` carries no foreign key — it must outlive the briefing it
    // refers to, and the 90-day purge does not spare claims. The sentence rides
    // along in the key so a `wrong` verdict stays exportable.
    repo.submit({
      briefingId: 'b-gone',
      claimId: feedbackClaimKey('art-gone', 'a claim whose briefing was purged'),
      verdict: 'wrong',
    });

    const [row] = repo.listLabeled();

    expect(row?.claimText).toBe('a claim whose briefing was purged');
    expect(row?.citationArtifactId).toBe('art-gone');
    expect(row?.section).toBeNull();
  });

  it('keeps a briefing-level verdict, which has no claim at all', () => {
    repo.submit({ briefingId: 'b-1', verdict: 'missed', note: 'the vendor call' });

    const [row] = repo.listLabeled();

    expect(row?.claimId).toBeNull();
    expect(row?.note).toBe('the vendor call');
  });

  it('honours the since bound and returns oldest first', () => {
    seedClaim({ text: 'first' });
    repo.submit({ briefingId: 'b-1', claimId: 'art-1', verdict: 'relevant' });
    const first = repo.listLabeled()[0]?.createdAt ?? 0;

    db.prepare(
      `INSERT INTO feedback (feedback_id, briefing_id, claim_id, verdict, note, created_at)
       VALUES ('f-later', 'b-1', 'art-1', 'wrong', NULL, ?)`,
    ).run(first + 10_000);

    expect(repo.listLabeled().map((r) => r.verdict)).toEqual(['relevant', 'wrong']);
    expect(repo.listLabeled(first + 1).map((r) => r.verdict)).toEqual(['wrong']);
  });
});

describe('FeedbackRepo.countByVerdict', () => {
  it('counts each kind, omitting the ones never used', () => {
    seedClaim({ text: 'a' });
    repo.submit({ briefingId: 'b-1', claimId: 'art-1', verdict: 'wrong' });
    repo.submit({ briefingId: 'b-1', claimId: 'art-1', verdict: 'wrong' });
    repo.submit({ briefingId: 'b-1', claimId: 'art-1', verdict: 'relevant' });

    expect(repo.countByVerdict()).toEqual({ wrong: 2, relevant: 1 });
  });

  it('is empty when nothing has been judged', () => {
    expect(repo.countByVerdict()).toEqual({});
  });
});
