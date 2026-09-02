/**
 * Persistence for recurring briefing schedules (FR-3, time-based half; OI-4).
 *
 * The `briefing_schedules` table already exists from Phase 0's initial schema,
 * so this repository is purely additive — no migration accompanies it.
 *
 * Two properties matter more than the CRUD:
 *
 * 1. **`last_fired_at` is the whole anti-replay mechanism.** The scheduler asks
 *    "what is the most recent occurrence of this schedule at or before now?" and
 *    fires only when that occurrence is newer than `last_fired_at`. A machine
 *    asleep for three days therefore produces ONE catch-up run, not three: the
 *    missed occurrences collapse into the newest one. That only works because
 *    the timestamp lives on disk rather than in a timer — an in-memory schedule
 *    would forget every missed run on relaunch and, worse, could re-fire one it
 *    had already served.
 *
 * 2. **`created_at` is the floor for a schedule that has never fired.** Without
 *    it, a "daily 08:00" created at 14:00 would fire immediately, because 08:00
 *    this morning is a perfectly good "most recent occurrence at or before now".
 *    `created_at` makes a fresh schedule wait for its first *future* occurrence.
 *
 * Local-time semantics (`hour_local`, `minute_local`, `quiet_from`, `quiet_to`)
 * are deliberately NOT interpreted here. This repository stores wall-clock
 * numbers; resolving them against a timezone is the scheduler's job
 * (`apps/desktop/src/scheduler/briefingSchedule.ts`), and duplicating that
 * arithmetic in two places is exactly how a DST bug is born.
 */
import type { Database, Statement } from 'better-sqlite3';
import { newId } from '@cr/core';

/** Recurrence vocabulary. Mirrors the `briefing_schedules.cadence` column. */
export type BriefingCadence = 'daily' | 'weekdays' | 'weekly';

/** Every cadence the repo accepts, in UI display order. */
export const BRIEFING_CADENCES: readonly BriefingCadence[] = ['daily', 'weekdays', 'weekly'];

export interface BriefingSchedule {
  scheduleId: string;
  cadence: BriefingCadence;
  /** Wall-clock hour, 0–23, in the user's local zone. */
  hourLocal: number;
  /** Wall-clock minute, 0–59. */
  minuteLocal: number;
  /** 0 = Sunday … 6 = Saturday. Non-null only when `cadence === 'weekly'`. */
  weekday: number | null;
  enabled: boolean;
  /** Local hour the quiet period opens, inclusive. Null when unset. */
  quietFrom: number | null;
  /** Local hour the quiet period closes, exclusive. Null when unset. */
  quietTo: number | null;
  /** Epoch ms of the last run this schedule triggered; null until it first fires. */
  lastFiredAt: number | null;
  createdAt: number;
}

export interface CreateBriefingScheduleInput {
  /** Optional caller-minted id; the repo mints one when omitted. */
  scheduleId?: string;
  cadence: BriefingCadence;
  hourLocal: number;
  minuteLocal: number;
  /** Required (0–6) for `weekly`; forced to null for every other cadence. */
  weekday?: number | null;
  /** Defaults to `true` — a schedule the user just created is one they want. */
  enabled?: boolean;
  /** Quiet-hours bounds. Supply both or neither. */
  quietFrom?: number | null;
  quietTo?: number | null;
  /** Epoch ms. Required: nothing in the store may call `Date.now()`. */
  createdAt: number;
}

/** Raw `briefing_schedules` row shape, exactly as SQLite hands it back. */
interface ScheduleRow {
  schedule_id: string;
  cadence: string;
  hour_local: number;
  minute_local: number;
  weekday: number | null;
  enabled: number;
  quiet_from: number | null;
  quiet_to: number | null;
  last_fired_at: number | null;
  created_at: number;
}

const SELECT_COLUMNS = `
  schedule_id, cadence, hour_local, minute_local, weekday, enabled,
  quiet_from, quiet_to, last_fired_at, created_at
`;

const INSERT_SQL = `
  INSERT INTO briefing_schedules
    (schedule_id, cadence, hour_local, minute_local, weekday, enabled,
     quiet_from, quiet_to, last_fired_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
`;

/**
 * Enabled schedules only, in a stable order.
 *
 * Ordered by wall-clock time then id so a tick that fires several schedules
 * does so in a predictable sequence — the alternative is a list whose order
 * depends on SQLite's page layout, which makes a multi-schedule bug
 * irreproducible.
 */
const LIST_ENABLED_SQL = `
  SELECT ${SELECT_COLUMNS} FROM briefing_schedules
  WHERE enabled = 1
  ORDER BY hour_local ASC, minute_local ASC, schedule_id ASC
`;

const LIST_SQL = `
  SELECT ${SELECT_COLUMNS} FROM briefing_schedules
  ORDER BY created_at ASC, schedule_id ASC
`;

function toDomain(row: ScheduleRow): BriefingSchedule {
  return {
    scheduleId: row.schedule_id,
    cadence: row.cadence as BriefingCadence,
    hourLocal: row.hour_local,
    minuteLocal: row.minute_local,
    weekday: row.weekday,
    enabled: row.enabled !== 0,
    quietFrom: row.quiet_from,
    quietTo: row.quiet_to,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
  };
}

/** True for a whole number inside `[min, max]`. */
function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Reject a schedule the scheduler could never evaluate.
 *
 * Validation lives here rather than in the IPC handler because the handler is
 * not the only writer (tests, migrations, a future import path), and a row with
 * `hour_local = 25` is not a bad request — it is a schedule that silently never
 * fires, which is the hardest possible failure to notice.
 */
function validate(input: CreateBriefingScheduleInput): {
  weekday: number | null;
  quietFrom: number | null;
  quietTo: number | null;
} {
  if (!BRIEFING_CADENCES.includes(input.cadence)) {
    throw new Error(`store: invalid cadence ${String(input.cadence)}`);
  }
  if (!isIntegerInRange(input.hourLocal, 0, 23)) {
    throw new Error(`store: invalid hourLocal ${String(input.hourLocal)} (expected 0-23)`);
  }
  if (!isIntegerInRange(input.minuteLocal, 0, 59)) {
    throw new Error(`store: invalid minuteLocal ${String(input.minuteLocal)} (expected 0-59)`);
  }
  if (!Number.isFinite(input.createdAt)) {
    throw new Error('store: invalid createdAt');
  }

  // `weekday` is meaningful for exactly one cadence. For the others it is
  // nulled rather than rejected: a UI that keeps the last-picked weekday in
  // state while the user flips to "daily" is sending a harmless leftover, not a
  // malformed schedule.
  let weekday: number | null = null;
  if (input.cadence === 'weekly') {
    if (!isIntegerInRange(input.weekday, 0, 6)) {
      throw new Error(
        `store: cadence 'weekly' requires weekday 0-6 (got ${String(input.weekday)})`,
      );
    }
    weekday = input.weekday;
  }

  const quietFrom = input.quietFrom ?? null;
  const quietTo = input.quietTo ?? null;
  if ((quietFrom === null) !== (quietTo === null)) {
    // A half-specified range has no defensible interpretation, and guessing one
    // would silently suppress notifications the user never asked to suppress.
    throw new Error('store: quiet hours need both quietFrom and quietTo, or neither');
  }
  if (quietFrom !== null && !isIntegerInRange(quietFrom, 0, 23)) {
    throw new Error(`store: invalid quietFrom ${String(quietFrom)} (expected 0-23)`);
  }
  if (quietTo !== null && !isIntegerInRange(quietTo, 0, 23)) {
    throw new Error(`store: invalid quietTo ${String(quietTo)} (expected 0-23)`);
  }

  return { weekday, quietFrom, quietTo };
}

/**
 * CRUD over `briefing_schedules`.
 *
 * Same shape as every other repository in this package: constructed with a live
 * `Database`, prepares its statements once, and returns domain objects rather
 * than rows.
 */
export class BriefingSchedulesRepo {
  private readonly stmtInsert: Statement<unknown[], unknown>;
  private readonly stmtListEnabled: Statement<unknown[], ScheduleRow>;
  private readonly stmtList: Statement<unknown[], ScheduleRow>;
  private readonly stmtGet: Statement<unknown[], ScheduleRow>;
  private readonly stmtSetLastFired: Statement<unknown[], unknown>;
  private readonly stmtSetEnabled: Statement<unknown[], unknown>;
  private readonly stmtDelete: Statement<unknown[], unknown>;

  constructor(private readonly db: Database) {
    this.stmtInsert = this.db.prepare(INSERT_SQL);
    this.stmtListEnabled = this.db.prepare<unknown[], ScheduleRow>(LIST_ENABLED_SQL);
    this.stmtList = this.db.prepare<unknown[], ScheduleRow>(LIST_SQL);
    this.stmtGet = this.db.prepare<unknown[], ScheduleRow>(
      `SELECT ${SELECT_COLUMNS} FROM briefing_schedules WHERE schedule_id = ?`,
    );
    this.stmtSetLastFired = this.db.prepare(
      `UPDATE briefing_schedules SET last_fired_at = ? WHERE schedule_id = ?`,
    );
    this.stmtSetEnabled = this.db.prepare(
      `UPDATE briefing_schedules SET enabled = ? WHERE schedule_id = ?`,
    );
    this.stmtDelete = this.db.prepare(`DELETE FROM briefing_schedules WHERE schedule_id = ?`);
  }

  /**
   * Insert a schedule and return the materialized domain object.
   *
   * `lastFiredAt` always starts null; see the module note on why `createdAt`
   * then acts as the floor for the first run.
   */
  create(input: CreateBriefingScheduleInput): BriefingSchedule {
    const { weekday, quietFrom, quietTo } = validate(input);
    const scheduleId = input.scheduleId ?? newId();
    const enabled = input.enabled ?? true;

    this.stmtInsert.run(
      scheduleId,
      input.cadence,
      input.hourLocal,
      input.minuteLocal,
      weekday,
      enabled ? 1 : 0,
      quietFrom,
      quietTo,
      input.createdAt,
    );

    return {
      scheduleId,
      cadence: input.cadence,
      hourLocal: input.hourLocal,
      minuteLocal: input.minuteLocal,
      weekday,
      enabled,
      quietFrom,
      quietTo,
      lastFiredAt: null,
      createdAt: input.createdAt,
    };
  }

  /**
   * Schedules the scheduler should evaluate on this tick.
   *
   * Disabled rows are filtered in SQL rather than in the caller so "disabled"
   * cannot be forgotten at one call site — turning every schedule off is the
   * documented way to stop scheduled briefings entirely (FR-3).
   */
  listEnabled(): BriefingSchedule[] {
    return this.stmtListEnabled.all().map(toDomain);
  }

  /** Every schedule, enabled or not — the settings UI's read. */
  list(): BriefingSchedule[] {
    return this.stmtList.all().map(toDomain);
  }

  getById(scheduleId: string): BriefingSchedule | undefined {
    const row = this.stmtGet.get(scheduleId);
    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * Record that this schedule fired at `at`.
   *
   * Stamped with the moment the run STARTED, not the occurrence it served: the
   * comparison the scheduler makes is `occurrence > lastFiredAt`, and the start
   * time is always at or after the occurrence, so a single stamp retires every
   * occurrence that was missed while the machine was asleep.
   */
  setLastFired(scheduleId: string, at: number): void {
    const result = this.stmtSetLastFired.run(at, scheduleId);
    if (result.changes === 0) {
      throw new Error(`store: setLastFired: no schedule with id ${scheduleId}`);
    }
  }

  /**
   * Turn a schedule on or off.
   *
   * Deliberately does NOT touch `last_fired_at`: re-enabling a schedule must not
   * make it re-serve a window it already covered while it was on.
   */
  setEnabled(scheduleId: string, enabled: boolean): void {
    const result = this.stmtSetEnabled.run(enabled ? 1 : 0, scheduleId);
    if (result.changes === 0) {
      throw new Error(`store: setEnabled: no schedule with id ${scheduleId}`);
    }
  }

  /** Remove a schedule outright. Returns false when the id was unknown. */
  remove(scheduleId: string): boolean {
    return this.stmtDelete.run(scheduleId).changes > 0;
  }
}
