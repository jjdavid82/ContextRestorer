import type { Database } from 'better-sqlite3';
import {
  newId,
  type Briefing,
  type BriefingClaim,
  type BriefingMode,
  type ClaimProvenance,
} from '@cr/core';

/** Raw `briefings` row shape as returned by better-sqlite3. */
interface BriefingRow {
  briefing_id: string;
  window_start: number;
  window_end: number;
  generated_at: number;
  mode: string;
  narrative_path: string;
  delta_ids_json: string;
  threads_still_processing: number;
  caught_up_at: number | null;
  first_token_ms: number | null;
  total_ms: number | null;
  /** SQLite has no boolean: 0/1, added by migration 003. */
  partial: number;
}

/** Raw `briefing_claims` row shape as returned by better-sqlite3. */
interface ClaimRow {
  claim_id: string;
  briefing_id: string;
  ordinal: number;
  section: string;
  text: string;
  citation_artifact_id: string | null;
  delta_id: string | null;
  /** Migration 007. Defaults to 'template' for rows written before it. */
  produced_by: string;
}

export interface CreateBriefingInput {
  /**
   * OPTIONAL. Supply an id minted by the caller instead of letting the repo
   * generate one.
   *
   * Exists because `narrative_path` is derived from the briefing id
   * (`briefings/<id>.md`), which is otherwise circular: the caller cannot name
   * the file until the row exists, and the row cannot be written without the
   * file's path. Omit it and the repo mints an id as before.
   */
  briefingId?: string;
  windowStart: number;
  windowEnd: number;
  generatedAt: number;
  mode: BriefingMode;
  narrativePath: string;
  deltaIds: string[];
  threadsStillProcessing: number;
  /** Defaults to `false`; see {@link BriefingsRepo.markPartial}. */
  partial?: boolean;
  /**
   * Why this briefing exists (P0). Defaults to `'delivered'` — a briefing a
   * user asked for. `'precompute'` marks a background pass whose only product
   * is prose for a later request to reuse, and which is excluded from
   * {@link BriefingsRepo.latencyStats}.
   */
  purpose?: BriefingPurpose;
}

/** Why a briefing row exists (P0). See {@link CreateBriefingInput.purpose}. */
export type BriefingPurpose = 'delivered' | 'precompute';

/**
 * A latency distribution, for the local metrics view.
 *
 * `p50Ms`/`p95Ms` are `null` — not 0 — when no observation qualifies. Zero is a
 * real, achievable latency, so it must not double as "no data".
 */
export interface DurationStats {
  /** Observations the percentiles were computed from. */
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface AddClaimInput {
  briefingId: string;
  ordinal: number;
  section: string;
  text: string;
  /**
   * Must reference an existing `artifacts.artifact_id`. A bad id raises a
   * SQLite FOREIGN KEY constraint error, which this repo deliberately lets
   * escape — see `addClaim`.
   */
  citationArtifactId: string;
  deltaId?: string | null;
  /**
   * Who wrote this claim (P0). Defaults to `'template'` — under
   * deterministic-first that is the normal case, and prose is the addition.
   */
  producedBy?: ClaimProvenance;
}

/** Parse `delta_ids_json`, tolerating (but not inventing) malformed payloads. */
function parseDeltaIds(json: string): string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error(`store: briefings.delta_ids_json is not an array (got ${typeof parsed})`);
  }
  return parsed.map(String);
}

function toBriefing(row: BriefingRow): Briefing {
  return {
    briefingId: row.briefing_id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    generatedAt: row.generated_at,
    mode: row.mode as BriefingMode,
    narrativePath: row.narrative_path,
    deltaIds: parseDeltaIds(row.delta_ids_json),
    threadsStillProcessing: row.threads_still_processing,
    caughtUpAt: row.caught_up_at,
    firstTokenMs: row.first_token_ms,
    totalMs: row.total_ms,
    partial: row.partial !== 0,
  };
}

function toClaim(row: ClaimRow): BriefingClaim {
  return {
    claimId: row.claim_id,
    briefingId: row.briefing_id,
    ordinal: row.ordinal,
    section: row.section,
    text: row.text,
    citationArtifactId: row.citation_artifact_id,
    deltaId: row.delta_id,
    producedBy: row.produced_by as ClaimProvenance,
  };
}

/**
 * Persistence for Layer-3 briefings and their individually citable claims.
 *
 * Two invariants live here rather than in calling code:
 *
 * 1. **Every claim cites a real artifact (AC-2, structural half).** `addClaim`
 *    inserts straight into `briefing_claims`, whose `citation_artifact_id` is a
 *    NOT NULL foreign key into `artifacts`. With `foreign_keys = ON` (set by
 *    `openDb`) a dangling citation aborts the insert. That error is *not*
 *    caught here: swallowing it would let an uncited claim silently vanish
 *    from — or worse, appear in — a briefing the user is told is fully cited.
 *
 * 2. **Ordinal is the narrative order.** Claims may be written in any order
 *    (generation is streamed and partly concurrent); `listClaims` is the single
 *    place that re-imposes `ORDER BY ordinal ASC`.
 */
export class BriefingsRepo {
  constructor(private db: Database) {}

  /** Insert a new briefing row and return the materialized domain object. */
  create(input: CreateBriefingInput): Briefing {
    const briefingId = input.briefingId ?? newId();
    const partial = input.partial ?? false;

    this.db
      .prepare(
        `INSERT INTO briefings
           (briefing_id, window_start, window_end, generated_at, mode, narrative_path,
            delta_ids_json, threads_still_processing, caught_up_at, first_token_ms, total_ms,
            partial, purpose)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        briefingId,
        input.windowStart,
        input.windowEnd,
        input.generatedAt,
        input.mode,
        input.narrativePath,
        JSON.stringify(input.deltaIds),
        input.threadsStillProcessing,
        partial ? 1 : 0,
        input.purpose ?? 'delivered',
      );

    return {
      briefingId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      generatedAt: input.generatedAt,
      mode: input.mode,
      partial,
      narrativePath: input.narrativePath,
      deltaIds: [...input.deltaIds],
      threadsStillProcessing: input.threadsStillProcessing,
      caughtUpAt: null,
      firstTokenMs: null,
      totalMs: null,
    };
  }

  /**
   * Flag a briefing as cut short (§7.8).
   *
   * Called *after* `create`, because the generator only learns it blew the
   * `budgets.generationMs` deadline part-way through streaming — by which point
   * the row must already exist for its claims' foreign keys to resolve.
   *
   * Deliberately one-way: `partial` records that a specific generation attempt
   * was truncated, and nothing later in the run can make that untrue.
   */
  markPartial(briefingId: string): void {
    const result = this.db
      .prepare(`UPDATE briefings SET partial = 1 WHERE briefing_id = ?`)
      .run(briefingId);

    if (result.changes === 0) {
      throw new Error(`store: markPartial: no briefing with id ${briefingId}`);
    }
  }

  /**
   * Relabel a briefing as template-written (§7.8 fallback, Task 4.3).
   *
   * Called when the LLM path produced nothing the user can read and the
   * deterministic template supplied the entire briefing. The row was created as
   * `'llm'` — it had to be, because the claims' foreign keys need it to exist
   * before generation starts — and leaving it that way would tell the UI a model
   * wrote content that no model produced, which is exactly the banner the user
   * needs to see suppressed.
   *
   * Deliberately one-way, like {@link markPartial}: `template` records that the
   * fallback is what actually spoke, and nothing later can make that untrue. A
   * briefing the model *did* contribute to keeps `mode = 'llm'` and reports its
   * incompleteness through `partial` instead.
   */
  markTemplateMode(briefingId: string): void {
    const result = this.db
      .prepare(`UPDATE briefings SET mode = 'template' WHERE briefing_id = ?`)
      .run(briefingId);

    if (result.changes === 0) {
      throw new Error(`store: markTemplateMode: no briefing with id ${briefingId}`);
    }
  }

  /**
   * Attach one claim to a briefing.
   *
   * Throws (SQLite `SQLITE_CONSTRAINT_FOREIGNKEY`) when `citationArtifactId`
   * does not exist in `artifacts`. The error propagates unchanged by design:
   * it is the enforcement point for "100% of claims are cited".
   */
  addClaim(input: AddClaimInput): BriefingClaim {
    const claimId = newId();
    const deltaId = input.deltaId ?? null;
    const producedBy: ClaimProvenance = input.producedBy ?? 'template';

    this.db
      .prepare(
        `INSERT INTO briefing_claims
           (claim_id, briefing_id, ordinal, section, text, citation_artifact_id, delta_id,
            produced_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        claimId,
        input.briefingId,
        input.ordinal,
        input.section,
        input.text,
        input.citationArtifactId,
        deltaId,
        producedBy,
      );

    return {
      claimId,
      briefingId: input.briefingId,
      ordinal: input.ordinal,
      section: input.section,
      text: input.text,
      citationArtifactId: input.citationArtifactId,
      deltaId,
      producedBy,
    };
  }

  /**
   * Delta ids in `[start, end)` that have no model-written claim yet (P0).
   *
   * The pre-computer's work queue. A delta drops out of it the moment any
   * briefing — delivered or precompute — carries an `'llm'` claim for it, so
   * prose written by the FR-3 scheduler counts and is not redone.
   *
   * Ordered oldest-first: a delta that has waited longest for prose is the one
   * most likely to be read next, since briefing windows extend backwards.
   */
  deltasNeedingProse(start: number, end: number, limit: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT d.delta_id FROM state_deltas d
          WHERE d.created_at >= ? AND d.created_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM briefing_claims c
               WHERE c.delta_id = d.delta_id AND c.produced_by = 'llm'
            )
          ORDER BY d.created_at ASC, d.delta_id ASC
          LIMIT ?`,
      )
      .all(start, end, Math.max(0, Math.trunc(limit))) as Array<{ delta_id: string }>;

    return rows.map((row) => row.delta_id);
  }

  /**
   * The most recent model-written claim for each of `deltaIds` (P0).
   *
   * The synchronous path's reuse lookup: a delta the background pre-computer
   * has already written prose for is rendered with THAT sentence rather than
   * the deterministic restatement of its `summary`. One query for the whole
   * window rather than one per delta, because this is on the request path.
   *
   * "Most recent" is by `rowid`, which for an append-only insert order is the
   * newest write. A delta re-narrated by a later pre-computation pass should
   * read as its latest version, not its first.
   */
  proseByDelta(deltaIds: readonly string[]): Map<string, { section: string; text: string }> {
    const out = new Map<string, { section: string; text: string }>();
    if (deltaIds.length === 0) return out;

    const placeholders = deltaIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT delta_id, section, text FROM briefing_claims
          WHERE produced_by = 'llm' AND delta_id IN (${placeholders})
          ORDER BY rowid ASC`,
      )
      .all(...deltaIds) as Array<{ delta_id: string; section: string; text: string }>;

    // Ascending order plus unconditional overwrite leaves the LAST (newest) row
    // per delta in the map.
    for (const row of rows) out.set(row.delta_id, { section: row.section, text: row.text });
    return out;
  }

  /**
   * Delta ids on this window that ALREADY have model-written prose (P0).
   *
   * The synchronous path calls this once per request to decide, per delta,
   * whether to reuse a background-written claim or render the deterministic one.
   * Indexed by `(delta_id, produced_by)` because it is on the hot path.
   */
  deltasWithProse(deltaIds: readonly string[]): Set<string> {
    if (deltaIds.length === 0) return new Set();

    const placeholders = deltaIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT delta_id FROM briefing_claims
          WHERE produced_by = 'llm' AND delta_id IN (${placeholders})`,
      )
      .all(...deltaIds) as Array<{ delta_id: string }>;

    return new Set(rows.map((row) => row.delta_id));
  }

  /** All claims for a briefing, in narrative order (`ordinal` ascending). */
  listClaims(briefingId: string): BriefingClaim[] {
    const rows = this.db
      .prepare(
        `SELECT claim_id, briefing_id, ordinal, section, text, citation_artifact_id, delta_id,
                produced_by
           FROM briefing_claims
          WHERE briefing_id = ?
          ORDER BY ordinal ASC`,
      )
      .all(briefingId) as ClaimRow[];

    return rows.map(toClaim);
  }

  /**
   * Stamp the moment the user finished catching up (FR-11). Feeds NFR-10's
   * time-to-re-entry metric via `timeToReEntryMs`.
   */
  markCaughtUp(briefingId: string, at: number): void {
    const result = this.db
      .prepare(`UPDATE briefings SET caught_up_at = ? WHERE briefing_id = ?`)
      .run(at, briefingId);

    if (result.changes === 0) {
      throw new Error(`store: markCaughtUp: no briefing with id ${briefingId}`);
    }
  }

  /**
   * NFR-10: elapsed ms between generating the briefing and the user declaring
   * themselves caught up. `null` when the briefing is unknown or still open.
   */
  timeToReEntryMs(briefingId: string): number | null {
    const row = this.db
      .prepare(`SELECT generated_at, caught_up_at FROM briefings WHERE briefing_id = ?`)
      .get(briefingId) as { generated_at: number; caught_up_at: number | null } | undefined;

    if (row === undefined || row.caught_up_at === null) return null;
    return row.caught_up_at - row.generated_at;
  }

  /**
   * OI-1: the distribution of end-to-end briefing latency (Task 4.4, step 4).
   *
   * Reads `total_ms`, which `recordTimings` writes once generation completes;
   * briefings still in flight (and any written before that column existed) have
   * it NULL and are excluded, because "not finished" is not a latency.
   */
  latencyStats(): DurationStats {
    return this.percentiles(
      // P0: background pre-computation rows are EXCLUDED. AC-1 is a claim about
      // how long a user waited, and a background run nobody was watching is not
      // a wait. Including it would move the number this change exists to move,
      // in the flattering direction.
      `SELECT total_ms AS ms FROM briefings
        WHERE total_ms IS NOT NULL AND purpose = 'delivered'
        ORDER BY total_ms ASC`,
    );
  }

  /**
   * NFR-10 across every briefing: how long re-entry takes (Task 4.4, step 4).
   *
   * Rows the user never marked caught-up are excluded rather than counted as
   * zero or as infinity. `ipc/feedback.ts`'s `briefing:metrics` answers the same
   * question per briefing; this is the aggregate, computed from the same two
   * columns so the two cannot disagree.
   */
  reEntryStats(): DurationStats {
    return this.percentiles(
      `SELECT (caught_up_at - generated_at) AS ms FROM briefings
        WHERE caught_up_at IS NOT NULL
        ORDER BY ms ASC`,
    );
  }

  /**
   * Nearest-rank percentiles over an ORDERED, single-column `ms` query.
   *
   * Computed in JS rather than SQL because SQLite has no percentile function
   * without an extension, and the alternative — a correlated subquery with
   * LIMIT/OFFSET arithmetic — is harder to read and no faster at this scale
   * (one row per briefing on one user's machine).
   *
   * Nearest-rank, not interpolated: with a handful of briefings an interpolated
   * P95 is a number no observation supports, and every value here is meant to be
   * traceable to a real run.
   */
  private percentiles(sql: string): DurationStats {
    const values = (this.db.prepare(sql).all() as { ms: number | null }[])
      .map((row) => row.ms)
      .filter((ms): ms is number => ms !== null && Number.isFinite(ms));

    if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null };

    const at = (fraction: number): number => {
      const index = Math.min(values.length - 1, Math.ceil(fraction * values.length) - 1);
      return values[Math.max(0, index)] as number;
    };

    return { count: values.length, p50Ms: at(0.5), p95Ms: at(0.95) };
  }

  /** Persist streaming latency telemetry once generation completes. */
  recordTimings(briefingId: string, firstTokenMs: number, totalMs: number): void {
    const result = this.db
      .prepare(`UPDATE briefings SET first_token_ms = ?, total_ms = ? WHERE briefing_id = ?`)
      .run(firstTokenMs, totalMs, briefingId);

    if (result.changes === 0) {
      throw new Error(`store: recordTimings: no briefing with id ${briefingId}`);
    }
  }

  getById(briefingId: string): Briefing | undefined {
    const row = this.db.prepare(`SELECT * FROM briefings WHERE briefing_id = ?`).get(briefingId) as
      | BriefingRow
      | undefined;

    return row === undefined ? undefined : toBriefing(row);
  }

  /**
   * The briefing whose window reaches furthest forward in time, or `undefined`
   * when none has ever been generated.
   *
   * Added for the recurring-briefing scheduler (FR-3), which starts each
   * scheduled window at the previous briefing's `window_end` so a run missed
   * while the machine was asleep does not leave a hole in the coverage.
   *
   * Ordered by `window_end`, not `generated_at`, on purpose: those two disagree
   * whenever a briefing is generated for an explicitly-chosen past window (the
   * renderer can request any `[start, end)` it likes). "Where does the covered
   * ground end?" is a question about windows, and answering it with the most
   * recently *generated* row would re-cover ground a later-windowed briefing had
   * already reported. `generated_at` then `rowid` break ties so the result is
   * deterministic rather than dependent on SQLite's page layout.
   */
  getMostRecent(): Briefing | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM briefings
          ORDER BY window_end DESC, generated_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get() as BriefingRow | undefined;

    return row === undefined ? undefined : toBriefing(row);
  }

  /**
   * `window_end` of the furthest-forward briefing the user actually acknowledged
   * (FR-11), or `null` when they never have.
   *
   * This is "how far have you read?", and it is the start of the next
   * user-initiated briefing (F-2). Two choices in it are deliberate:
   *
   * - **`window_end`, not `caught_up_at`.** The obvious reading of "start where
   *   I left off" is the moment the user tapped the button, but that moment is
   *   strictly *after* the window they read. A briefing covering `[T-3d, T)`
   *   acknowledged at `T+5min` has told the user nothing about `(T, T+5min)`, so
   *   starting the next window at the tap time silently skips that gap. The
   *   window they were shown is what they have actually read.
   * - **Gated on `caught_up_at IS NOT NULL`, unlike {@link getMostRecent}.** The
   *   scheduler may generate briefings the user never opens; treating those as
   *   read would drop their contents on the floor. Only an acknowledgement moves
   *   this watermark. That is the difference between the two methods, and the
   *   reason both exist.
   *
   * Ordered by `window_end` for the same reason `getMostRecent` is: the renderer
   * may request any window it likes, so the most recently *acknowledged* row is
   * not necessarily the one covering the furthest ground.
   */
  lastAcknowledgedWindowEnd(): number | null {
    const row = this.db
      .prepare(
        `SELECT window_end FROM briefings
          WHERE caught_up_at IS NOT NULL
          ORDER BY window_end DESC, caught_up_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get() as { window_end: number } | undefined;

    return row === undefined ? null : row.window_end;
  }
}
