/**
 * Persistence for per-claim project labels (migrations 011-013).
 *
 * A label store and nothing more: no `belongs_to` edge is written here, so
 * nothing in `ranker.ts` or `retrieval.ts` changes weight because a row landed
 * in this table. See the migration headers for why that separation is
 * deliberate.
 *
 * ## The key is the ARTIFACT
 *
 * A label says "this thread is about project X", so it is keyed on the artifact
 * and survives every re-render of the briefing it was set in. Migration 013
 * moved it there after the original `(briefing_id, artifact_id)` key made every
 * "Refresh" blank the dropdowns — see that file for the full account.
 *
 * `artifactId` is also the identifier the renderer actually holds for a briefing
 * row — `citation.artifactId`, the same value `claim:drilldown` resolves — not a
 * `briefing_claims.claim_id`. That is documented at length in
 * `apps/desktop/src/ipc/claim.ts`.
 */
import type { Database, Statement } from 'better-sqlite3';

/**
 * Who filed a claim under a project (migration 012).
 *
 * `'auto'` is a name match, not a judgement — see `detectProject()` in
 * `apps/desktop/src/ipc/projectMatch.ts`. Kept distinct from `'user'` so a
 * suggestion is never reported back as the user's own stated declaration (X-2).
 */
export type ClaimProjectOrigin = 'user' | 'auto';

/** One label: this thread belongs to this project. */
export interface ClaimProjectTag {
  /** An `artifacts.artifact_id` — see the module header. */
  artifactId: string;
  projectId: string;
  /** The briefing it was last set in. Provenance only; `null` once purged. */
  briefingId: string | null;
  taggedAt: number;
  origin: ClaimProjectOrigin;
}

interface TagRow {
  artifact_id: string;
  project_id: string;
  briefing_id: string | null;
  tagged_at: number;
  origin: ClaimProjectOrigin;
}

function toDomain(row: TagRow): ClaimProjectTag {
  return {
    artifactId: row.artifact_id,
    projectId: row.project_id,
    briefingId: row.briefing_id,
    taggedAt: row.tagged_at,
    origin: row.origin,
  };
}

const COLUMNS = 'artifact_id, project_id, briefing_id, tagged_at, origin';

/**
 * CRUD over `claim_projects`. Same shape as every other repository here:
 * constructed with a live `Database`, prepares its statements once, returns
 * domain objects.
 */
export class ClaimProjectsRepo {
  private readonly stmtListAll: Statement<unknown[], TagRow>;
  private readonly stmtListForProject: Statement<[string], TagRow>;
  private readonly stmtUpsert: Statement<unknown[], unknown>;
  private readonly stmtInsertIfAbsent: Statement<unknown[], unknown>;
  private readonly stmtDelete: Statement<[string], unknown>;

  constructor(private readonly db: Database) {
    this.stmtListAll = this.db.prepare<unknown[], TagRow>(
      `SELECT ${COLUMNS} FROM claim_projects ORDER BY tagged_at DESC, artifact_id ASC`,
    );
    this.stmtListForProject = this.db.prepare<[string], TagRow>(
      `SELECT ${COLUMNS} FROM claim_projects WHERE project_id = ?
        ORDER BY tagged_at DESC, artifact_id ASC`,
    );
    // Re-filing a thread is an edit, not a second label: the primary key
    // collapses it, and `tagged_at` moves to when the user last said it.
    this.stmtUpsert = this.db.prepare(
      `INSERT INTO claim_projects (artifact_id, project_id, briefing_id, tagged_at, origin)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(artifact_id)
       DO UPDATE SET project_id  = excluded.project_id,
                     briefing_id = excluded.briefing_id,
                     tagged_at   = excluded.tagged_at,
                     origin      = excluded.origin`,
    );
    // The auto-labeller's write. `WHERE NOT EXISTS` rather than an upsert: a
    // suggestion must never overwrite a label already on the row — not the
    // user's own filing, and not an earlier suggestion. Detection runs on every
    // briefing load, so "only if absent" is what stops it re-asserting itself
    // over a human decision.
    this.stmtInsertIfAbsent = this.db.prepare(
      `INSERT INTO claim_projects (artifact_id, project_id, briefing_id, tagged_at, origin)
       SELECT ?, ?, ?, ?, 'auto'
        WHERE NOT EXISTS (SELECT 1 FROM claim_projects WHERE artifact_id = ?)`,
    );
    this.stmtDelete = this.db.prepare<[string], unknown>(
      `DELETE FROM claim_projects WHERE artifact_id = ?`,
    );
  }

  /**
   * Every label on file, newest first.
   *
   * Returned whole rather than filtered per briefing: labels are per artifact
   * now, and a briefing's rows are only known once its claims have streamed in.
   * Handing the renderer the full map once is simpler than reconciling a
   * per-claim lookup against an arriving stream, and the table holds one row
   * per FILED thread — bounded by how much the user has actually categorised,
   * not by corpus size.
   */
  listAll(): ClaimProjectTag[] {
    return this.stmtListAll.all().map(toDomain);
  }

  /** Every claim filed under one project, newest first — the filter's read. */
  listForProject(projectId: string): ClaimProjectTag[] {
    return this.stmtListForProject.all(projectId).map(toDomain);
  }

  /**
   * File one thread under a project, or with `null` clear it.
   *
   * Tri-state at the call site collapses to two statements here: a project id
   * upserts, `null` deletes. Clearing a thread that was never filed is a no-op,
   * not an error — the dropdown's "No project" option must be idempotent.
   */
  setProject(
    artifactId: string,
    projectId: string | null,
    now: number,
    origin: ClaimProjectOrigin = 'user',
    briefingId: string | null = null,
  ): void {
    if (projectId === null) {
      this.stmtDelete.run(artifactId);
      return;
    }
    this.stmtUpsert.run(artifactId, projectId, briefingId, now, origin);
  }

  /**
   * Record an auto-detected label, but only where the thread has none.
   *
   * Detection re-runs every time a briefing is opened, so this must be a no-op
   * against any row that already carries a decision — otherwise a suggestion
   * would silently overwrite the user's own filing on the next load, which is
   * the single worst thing this feature could do.
   *
   * @returns whether a row was actually written, so the caller can report only
   * the labels it really applied rather than assuming its own suggestions took.
   */
  suggestProject(
    artifactId: string,
    projectId: string,
    now: number,
    briefingId: string | null = null,
  ): boolean {
    const result = this.stmtInsertIfAbsent.run(artifactId, projectId, briefingId, now, artifactId);
    return result.changes > 0;
  }
}
