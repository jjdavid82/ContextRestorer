import type { Database, Statement } from 'better-sqlite3';
import { newId, type PendingItem, type PendingStatus } from '@cr/core';

/**
 * A pending item as it is about to be written. `pendingId` is optional (minted
 * with `newId()` when absent), `status` defaults to `'open'`, and `resolvedAt`
 * is meaningless on insert — an item that starts life resolved is a bug, not a
 * use case.
 */
export type NewPendingItem = Omit<PendingItem, 'pendingId' | 'status' | 'resolvedAt'> & {
  pendingId?: string;
  status?: PendingStatus;
};

/** Raw `pending_items` row shape, exactly as SQLite hands it back. */
interface PendingRow {
  pending_id: string;
  delta_id: string;
  description: string;
  confidence: number;
  citation_artifact_id: string | null;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

const SELECT_COLUMNS = `
  pending_id, delta_id, description, confidence, citation_artifact_id,
  status, created_at, resolved_at
`;

const INSERT_SQL = `
  INSERT INTO pending_items
    (pending_id, delta_id, description, confidence, citation_artifact_id,
     status, created_at, resolved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
`;

/** Both terminal transitions are the same write with a different label. */
const CLOSE_SQL = `
  UPDATE pending_items SET status = ?, resolved_at = ? WHERE pending_id = ?
`;

function toDomain(row: PendingRow): PendingItem {
  return {
    pendingId: row.pending_id,
    deltaId: row.delta_id,
    description: row.description,
    confidence: row.confidence,
    citationArtifactId: row.citation_artifact_id,
    status: row.status as PendingStatus,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Outstanding obligations extracted from deltas.
 *
 * Unlike `events` and `state_deltas` this table is genuinely mutable — an item's
 * whole point is to move from `open` to `resolved`/`dismissed` — so there is no
 * append-only trigger on it and status changes are plain UPDATEs.
 */
export class PendingItemsRepo {
  private readonly stmtInsert: Statement<unknown[], unknown>;
  private readonly stmtListOpen: Statement<unknown[], PendingRow>;
  private readonly stmtGetById: Statement<unknown[], PendingRow>;
  private readonly stmtClose: Statement<unknown[], unknown>;

  constructor(private readonly db: Database) {
    this.stmtInsert = this.db.prepare(INSERT_SQL);
    this.stmtListOpen = this.db.prepare<unknown[], PendingRow>(
      `SELECT ${SELECT_COLUMNS} FROM pending_items WHERE status = 'open' ORDER BY created_at ASC`,
    );
    this.stmtGetById = this.db.prepare<unknown[], PendingRow>(
      `SELECT ${SELECT_COLUMNS} FROM pending_items WHERE pending_id = ?`,
    );
    this.stmtClose = this.db.prepare(CLOSE_SQL);
  }

  /** Persist one item and return it as written, including the minted id. */
  insert(p: NewPendingItem): PendingItem {
    const pendingId = p.pendingId ?? newId();
    const status: PendingStatus = p.status ?? 'open';

    this.stmtInsert.run(
      pendingId,
      p.deltaId,
      p.description,
      p.confidence,
      p.citationArtifactId,
      status,
      p.createdAt,
    );

    return {
      pendingId,
      deltaId: p.deltaId,
      description: p.description,
      confidence: p.confidence,
      citationArtifactId: p.citationArtifactId,
      status,
      createdAt: p.createdAt,
      resolvedAt: null,
    };
  }

  /** Every still-open item, oldest first — the "what's on me" briefing read. */
  listOpen(): PendingItem[] {
    return this.stmtListOpen.all().map(toDomain);
  }

  /** `undefined` when no such item exists — an unknown id is not an error. */
  getById(pendingId: string): PendingItem | undefined {
    const row = this.stmtGetById.get(pendingId);
    return row === undefined ? undefined : toDomain(row);
  }

  /** The obligation was met. */
  resolve(pendingId: string, at: number): void {
    this.stmtClose.run('resolved', at, pendingId);
  }

  /**
   * The obligation was never real (a false positive from synthesis). Recorded
   * distinctly from `resolved` so feedback can tell "we were wrong" apart from
   * "we were right and it got done".
   */
  dismiss(pendingId: string, at: number): void {
    this.stmtClose.run('dismissed', at, pendingId);
  }
}
