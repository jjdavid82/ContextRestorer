import type { Database, Statement } from 'better-sqlite3';
import { newId, type Extraction, type ExtractionClass } from '@cr/core';

/**
 * An extraction as it is about to be written. `extractionId` is optional because
 * extractions have no natural key — the repository mints one with `newId()` when
 * the caller does not supply one.
 */
export type NewExtraction = Omit<Extraction, 'extractionId'> & { extractionId?: string };

/** Raw `extractions` row shape, exactly as SQLite hands it back. */
interface ExtractionRow {
  extraction_id: string;
  event_id: string;
  class: string;
  confidence: number;
  participants_json: string;
  artifacts_json: string;
  model: string;
  prompt_version: string;
  created_at: number;
}

const INSERT_SQL = `
  INSERT INTO extractions
    (extraction_id, event_id, class, confidence, participants_json, artifacts_json,
     model, prompt_version, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_COLUMNS = `
  extraction_id, event_id, class, confidence, participants_json, artifacts_json,
  model, prompt_version, created_at
`;

/**
 * Decode a `*_json` column into a string array.
 *
 * Every caller of this repository expects `participants` / `artifacts` to be
 * real arrays; handing back the raw JSON text would type-check (both are
 * `string`-ish at the edges) and then fail far downstream, so the decode is
 * validated here at the storage boundary rather than trusted.
 */
function parseIdArray(raw: string, column: string, extractionId: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`extractions: ${column} for ${extractionId} is not valid JSON`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`extractions: ${column} for ${extractionId} is not a JSON array`);
  }
  return parsed.map((entry) => String(entry));
}

function toDomain(row: ExtractionRow): Extraction {
  return {
    extractionId: row.extraction_id,
    eventId: row.event_id,
    // The DB stores the enum as free text; the CHECK lives in the prompt schema,
    // not the DDL, so this is a narrowing assertion rather than a validation.
    class: row.class as ExtractionClass,
    confidence: row.confidence,
    participants: parseIdArray(row.participants_json, 'participants_json', row.extraction_id),
    artifacts: parseIdArray(row.artifacts_json, 'artifacts_json', row.extraction_id),
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

/**
 * Layer-1 output store: what a single event asserts.
 *
 * Plain append CRUD — extractions are never versioned or superseded (that is
 * `state_deltas`' job); a re-extraction of the same event simply produces a new
 * row with a new `model` / `prompt_version` pair, and lineage is recovered by
 * filtering on `event_id`.
 */
export class ExtractionsRepo {
  private readonly stmtInsert: Statement<unknown[], unknown>;
  private readonly stmtListByEvent: Statement<unknown[], ExtractionRow>;
  private readonly stmtGetById: Statement<unknown[], ExtractionRow>;

  constructor(private readonly db: Database) {
    this.stmtInsert = this.db.prepare(INSERT_SQL);
    this.stmtListByEvent = this.db.prepare<unknown[], ExtractionRow>(
      `SELECT ${SELECT_COLUMNS} FROM extractions WHERE event_id = ? ORDER BY created_at ASC`,
    );
    this.stmtGetById = this.db.prepare<unknown[], ExtractionRow>(
      `SELECT ${SELECT_COLUMNS} FROM extractions WHERE extraction_id = ?`,
    );
  }

  /**
   * Persist one extraction. `participants` / `artifacts` are serialized here so
   * that JSON encoding exists in exactly one place and callers only ever deal
   * in domain arrays.
   */
  insert(e: NewExtraction): void {
    this.stmtInsert.run(
      e.extractionId ?? newId(),
      e.eventId,
      e.class,
      e.confidence,
      JSON.stringify(e.participants),
      JSON.stringify(e.artifacts),
      e.model,
      e.promptVersion,
      e.createdAt,
    );
  }

  /** Every extraction derived from `eventId`, oldest first. */
  listByEvent(eventId: string): Extraction[] {
    return this.stmtListByEvent.all(eventId).map(toDomain);
  }

  /** `undefined` when no such extraction exists — an unknown id is not an error. */
  getById(id: string): Extraction | undefined {
    const row = this.stmtGetById.get(id);
    return row === undefined ? undefined : toDomain(row);
  }
}
