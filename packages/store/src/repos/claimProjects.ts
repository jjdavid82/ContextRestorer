/**
 * Persistence for per-claim project labels (migration 010).
 *
 * A label store and nothing more: no `belongs_to` edge is written here, so
 * nothing in `ranker.ts` or `retrieval.ts` changes weight because a row landed
 * in this table. See the migration header for why that separation is deliberate.
 *
 * `artifactId` is the identifier the renderer actually holds for a briefing row
 * — `citation.artifactId`, the same value `claim:drilldown` resolves — not a
 * `briefing_claims.claim_id`. That is documented at length in
 * `apps/desktop/src/ipc/claim.ts`; the naming here matches it rather than
 * pretending to a claim id the wire does not carry.
 */
import type { Database, Statement } from 'better-sqlite3';

/** One user-authored label: this briefing row belongs to this project. */
export interface ClaimProjectTag {
  briefingId: string;
  /** An `artifacts.artifact_id` — see the module header. */
  artifactId: string;
  projectId: string;
  taggedAt: number;
}

interface TagRow {
  briefing_id: string;
  artifact_id: string;
  project_id: string;
  tagged_at: number;
}

function toDomain(row: TagRow): ClaimProjectTag {
  return {
    briefingId: row.briefing_id,
    artifactId: row.artifact_id,
    projectId: row.project_id,
    taggedAt: row.tagged_at,
  };
}

/**
 * CRUD over `claim_projects`. Same shape as every other repository here:
 * constructed with a live `Database`, prepares its statements once, returns
 * domain objects.
 */
export class ClaimProjectsRepo {
  private readonly stmtListForBriefing: Statement<[string], TagRow>;
  private readonly stmtListForProject: Statement<[string], TagRow>;
  private readonly stmtUpsert: Statement<unknown[], unknown>;
  private readonly stmtDelete: Statement<[string, string], unknown>;

  constructor(private readonly db: Database) {
    this.stmtListForBriefing = this.db.prepare<[string], TagRow>(
      `SELECT briefing_id, artifact_id, project_id, tagged_at FROM claim_projects
        WHERE briefing_id = ? ORDER BY tagged_at ASC, artifact_id ASC`,
    );
    this.stmtListForProject = this.db.prepare<[string], TagRow>(
      `SELECT briefing_id, artifact_id, project_id, tagged_at FROM claim_projects
        WHERE project_id = ? ORDER BY tagged_at DESC, artifact_id ASC`,
    );
    // Re-tagging a row is an edit, not a second label: the primary key collapses
    // it, and `tagged_at` moves to when the user last said it.
    this.stmtUpsert = this.db.prepare(
      `INSERT INTO claim_projects (briefing_id, artifact_id, project_id, tagged_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(briefing_id, artifact_id)
       DO UPDATE SET project_id = excluded.project_id, tagged_at = excluded.tagged_at`,
    );
    this.stmtDelete = this.db.prepare<[string, string], unknown>(
      `DELETE FROM claim_projects WHERE briefing_id = ? AND artifact_id = ?`,
    );
  }

  /** Every label on one briefing — what the briefing view reads on load. */
  listForBriefing(briefingId: string): ClaimProjectTag[] {
    return this.stmtListForBriefing.all(briefingId).map(toDomain);
  }

  /**
   * Every claim ever labelled with one project, newest first.
   *
   * Unused by the current UI: this is the read the "filter results by project"
   * follow-up needs, and it is here so the index in migration 010 has the query
   * it was created for rather than being speculative.
   */
  listForProject(projectId: string): ClaimProjectTag[] {
    return this.stmtListForProject.all(projectId).map(toDomain);
  }

  /**
   * Tag one briefing row, or with `null` clear its tag.
   *
   * Tri-state at the call site collapses to two statements here: a project id
   * upserts, `null` deletes. Clearing a row that was never tagged is a no-op,
   * not an error — the dropdown's "None" option must be idempotent.
   */
  setProject(briefingId: string, artifactId: string, projectId: string | null, now: number): void {
    if (projectId === null) {
      this.stmtDelete.run(briefingId, artifactId);
      return;
    }
    this.stmtUpsert.run(briefingId, artifactId, projectId, now);
  }
}
