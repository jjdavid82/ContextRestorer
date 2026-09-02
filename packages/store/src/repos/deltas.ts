import type { Database, Statement, Transaction } from 'better-sqlite3';
import { deltaId, type DeltaKind, type StateDelta } from '@cr/core';

/**
 * A delta as the synthesis worker produces it.
 *
 * `deltaId`, `version` and `supersedes` are deliberately *not* callable inputs:
 * they are the versioning chain, and letting a caller pass them in is exactly
 * how two workers end up both writing "version 3". `append()` derives all three
 * from the database inside a transaction.
 */
export type NewStateDelta = Omit<StateDelta, 'deltaId' | 'version' | 'supersedes'>;

/** Raw `state_deltas` row shape, exactly as SQLite hands it back. */
interface DeltaRow {
  delta_id: string;
  thread_key: string;
  artifact_id: string | null;
  version: number;
  supersedes: string | null;
  summary: string;
  kind: string;
  confidence: number;
  source_event_ids_json: string;
  citation_artifact_ids_json: string;
  model: string;
  prompt_version: string;
  created_at: number;
}

/** Named bind parameters for the insert — mirrors `DeltaRow` one-for-one. */
interface DeltaInsertParams {
  delta_id: string;
  thread_key: string;
  artifact_id: string | null;
  version: number;
  supersedes: string | null;
  summary: string;
  kind: string;
  confidence: number;
  source_event_ids_json: string;
  citation_artifact_ids_json: string;
  model: string;
  prompt_version: string;
  created_at: number;
}

const SELECT_COLUMNS = `
  delta_id, thread_key, artifact_id, version, supersedes, summary, kind, confidence,
  source_event_ids_json, citation_artifact_ids_json, model, prompt_version, created_at
`;

const INSERT_SQL = `
  INSERT INTO state_deltas
    (delta_id, thread_key, artifact_id, version, supersedes, summary, kind, confidence,
     source_event_ids_json, citation_artifact_ids_json, model, prompt_version, created_at)
  VALUES
    (@delta_id, @thread_key, @artifact_id, @version, @supersedes, @summary, @kind, @confidence,
     @source_event_ids_json, @citation_artifact_ids_json, @model, @prompt_version, @created_at)
`;

/** The tip of a thread's chain: the highest `version` written so far. */
const LATEST_SQL = `
  SELECT delta_id, version FROM state_deltas
  WHERE thread_key = ?
  ORDER BY version DESC
  LIMIT 1
`;

function parseIdArray(raw: string, column: string, id: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`state_deltas: ${column} for ${id} is not valid JSON`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`state_deltas: ${column} for ${id} is not a JSON array`);
  }
  return parsed.map((entry) => String(entry));
}

function toDomain(row: DeltaRow): StateDelta {
  return {
    deltaId: row.delta_id,
    threadKey: row.thread_key,
    artifactId: row.artifact_id,
    version: row.version,
    supersedes: row.supersedes,
    summary: row.summary,
    kind: row.kind as DeltaKind,
    confidence: row.confidence,
    sourceEventIds: parseIdArray(row.source_event_ids_json, 'source_event_ids_json', row.delta_id),
    citationArtifactIds: parseIdArray(
      row.citation_artifact_ids_json,
      'citation_artifact_ids_json',
      row.delta_id,
    ),
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

/**
 * Layer-2 output store — the D-6 enforcement point.
 *
 * `state_deltas` is append-only in the engine (the `deltas_no_update` trigger),
 * so a thread's history is never edited: a correction is a *new* row whose
 * `supersedes` points at the row it replaces. That gives two reads:
 *
 *   - `currentForWindow()` — the tip of every chain, via `current_state_deltas`.
 *   - `chainFor()`         — the whole history, so a briefing can say "we decided
 *                            X on Monday, then reversed to Y on Wednesday".
 */
export class DeltasRepo {
  private readonly stmtLatest: Statement<unknown[], { delta_id: string; version: number }>;
  private readonly stmtInsert: Statement<[DeltaInsertParams], unknown>;
  private readonly stmtCurrentForWindow: Statement<unknown[], DeltaRow>;
  private readonly stmtChainFor: Statement<unknown[], DeltaRow>;
  private readonly txAppend: Transaction<(input: NewStateDelta) => StateDelta>;

  constructor(private readonly db: Database) {
    this.stmtLatest = this.db.prepare<unknown[], { delta_id: string; version: number }>(LATEST_SQL);
    this.stmtInsert = this.db.prepare<DeltaInsertParams, unknown>(INSERT_SQL);
    this.stmtCurrentForWindow = this.db.prepare<unknown[], DeltaRow>(
      `SELECT ${SELECT_COLUMNS} FROM current_state_deltas
       WHERE created_at >= ? AND created_at < ?
       ORDER BY created_at ASC, thread_key ASC, version ASC`,
    );
    this.stmtChainFor = this.db.prepare<unknown[], DeltaRow>(
      `SELECT ${SELECT_COLUMNS} FROM state_deltas WHERE thread_key = ? ORDER BY version ASC`,
    );

    // Built once, in the constructor: better-sqlite3 prepares BEGIN/COMMIT/ROLLBACK
    // statements when the transaction is created, and `append()` is on the hot
    // path of every synthesis cycle.
    this.txAppend = this.db.transaction((input: NewStateDelta): StateDelta => {
      const prev = this.stmtLatest.get(input.threadKey);
      const version = (prev?.version ?? 0) + 1;
      const supersedes = prev?.delta_id ?? null;
      const id = deltaId(input.threadKey, version);

      this.stmtInsert.run({
        delta_id: id,
        thread_key: input.threadKey,
        artifact_id: input.artifactId,
        version,
        supersedes,
        summary: input.summary,
        kind: input.kind,
        confidence: input.confidence,
        source_event_ids_json: JSON.stringify(input.sourceEventIds),
        citation_artifact_ids_json: JSON.stringify(input.citationArtifactIds),
        model: input.model,
        prompt_version: input.promptVersion,
        created_at: input.createdAt,
      });

      return { ...input, deltaId: id, version, supersedes };
    });
  }

  /**
   * Append the next version of `input.threadKey`'s chain and return the row as
   * written (with the derived `deltaId` / `version` / `supersedes`).
   *
   * The "read the latest version, then insert version+1" pair runs inside a
   * single IMMEDIATE transaction, and that is load-bearing, not tidiness. Two
   * synthesis workers finishing on the same thread at the same moment would
   * otherwise both read version 2, both compute 3, and one would silently lose
   * its delta (or trip `UNIQUE (thread_key, version)` and abort a whole batch) —
   * precisely the reproducibility failure D-6 exists to prevent.
   *
   * IMMEDIATE (rather than the default DEFERRED) takes SQLite's write lock at
   * BEGIN instead of at the first write, so a competing writer blocks on
   * `busy_timeout` *before* it reads a stale version rather than failing with
   * SQLITE_BUSY after it has already computed one.
   */
  append(input: NewStateDelta): StateDelta {
    return this.txAppend.immediate(input);
  }

  /**
   * Tip-of-chain deltas created in `[start, end)` — the briefing window read.
   *
   * Sourced from the `current_state_deltas` view, so a delta that has since been
   * superseded is excluded even though its row is still on disk: a briefing must
   * narrate the current state, not every intermediate belief.
   *
   * `end` is exclusive so that back-to-back windows neither drop nor duplicate a
   * delta landing exactly on the boundary.
   */
  currentForWindow(start: number, end: number): StateDelta[] {
    return this.stmtCurrentForWindow.all(start, end).map(toDomain);
  }

  /** Full ordered history for a thread, v1 first — includes superseded versions. */
  chainFor(threadKey: string): StateDelta[] {
    return this.stmtChainFor.all(threadKey).map(toDomain);
  }
}
