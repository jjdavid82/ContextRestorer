/**
 * `schedule:list` / `schedule:create` / `schedule:setEnabled` — the settings
 * surface for recurring briefings (Task 3.8, FR-3 time-based half; OI-4).
 *
 * Three deliberate properties:
 *
 * 1. **No cron syntax crosses this boundary.** The wire format is
 *    `{ cadence, hourLocal, minuteLocal, weekday?, quietFrom?, quietTo? }` —
 *    the same vocabulary the UI's radio buttons and time inputs speak. A cron
 *    string would push the burden of understanding `0 8 * * 1-5` onto the user
 *    and give this handler an expression language to parse.
 *
 * 2. **Wall-clock fields are stored, not resolved.** Converting `08:00` into an
 *    instant is the scheduler's job (`scheduler/briefingSchedule.ts`), which
 *    does it zone-aware and per-occurrence. Resolving it here would freeze one
 *    UTC offset into the row and break the schedule at the next DST transition.
 *
 * 3. **Nothing throws out of an `ipcMain.handle` callback.** A rejection reaches
 *    the renderer as an opaque `Error invoking remote method …` with a
 *    main-process stack pasted in; failures are returned as `{ ok: false,
 *    reason }` instead, exactly as the OAuth and projects handlers do.
 *
 * Validation runs twice on purpose. The preload's check is a convenience gate
 * (a compromised renderer controls what it sends), this one is the trust
 * boundary, and `BriefingSchedulesRepo` validates a third time because it is not
 * the only writer.
 */
import { ipcMain } from 'electron';
import type { BriefingSchedule } from '@cr/store';
import type {
  BriefingCadence,
  BriefingScheduleInput,
  BriefingScheduleResult,
  BriefingScheduleView,
  OkResult,
} from '../preload.cjs';

/** Invoke channel returning every saved schedule. */
export const LIST_CHANNEL = 'schedule:list';

/** Invoke channel that saves a new schedule. */
export const CREATE_CHANNEL = 'schedule:create';

/** Invoke channel that turns one schedule on or off. */
export const SET_ENABLED_CHANNEL = 'schedule:setEnabled';

const CADENCES: readonly BriefingCadence[] = ['daily', 'weekdays', 'weekly'];

/**
 * The slice of `BriefingSchedulesRepo` these handlers use.
 *
 * Structural, so the real repo satisfies it with no adapter and a test can pass
 * a hand-rolled store. `remove` is deliberately absent: deleting a schedule is
 * not part of this task's surface, and "off" is the reversible way to stop one.
 */
export interface ScheduleStore {
  list(): BriefingSchedule[];
  create(input: {
    cadence: BriefingCadence;
    hourLocal: number;
    minuteLocal: number;
    weekday?: number | null;
    quietFrom?: number | null;
    quietTo?: number | null;
    createdAt: number;
  }): BriefingSchedule;
  setEnabled(scheduleId: string, enabled: boolean): void;
}

export interface ScheduleHandlerDeps {
  /** `BriefingSchedulesRepo` in production. */
  schedules: ScheduleStore;
  /** Injected time source for `created_at`; nothing here calls `Date.now()`. */
  clock: { now(): number };
}

/** True for a whole number inside `[0, max]`. */
function isBoundedInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * Narrow the renderer-supplied schedule.
 *
 * @returns The cleaned input, or `null` when it is not a schedule the scheduler
 *   could ever evaluate.
 */
export function parseScheduleInput(arg: unknown): Required<BriefingScheduleInput> | null {
  const candidate = arg as Partial<BriefingScheduleInput> | null;
  if (candidate === null || typeof candidate !== 'object') return null;

  const cadence = candidate.cadence as BriefingCadence;
  if (!CADENCES.includes(cadence)) return null;
  if (!isBoundedInt(candidate.hourLocal, 23)) return null;
  if (!isBoundedInt(candidate.minuteLocal, 59)) return null;

  // `weekday` is required for `weekly` and ignored otherwise — a UI that keeps
  // the last-picked day in state while the user flips to "daily" is sending a
  // leftover, not a malformed schedule.
  let weekday: number | null = null;
  if (cadence === 'weekly') {
    if (!isBoundedInt(candidate.weekday, 6)) return null;
    weekday = candidate.weekday;
  }

  const quietFrom = candidate.quietFrom ?? null;
  const quietTo = candidate.quietTo ?? null;
  if (quietFrom !== null && !isBoundedInt(quietFrom, 23)) return null;
  if (quietTo !== null && !isBoundedInt(quietTo, 23)) return null;
  // Both or neither: half a range has no defensible reading, and guessing one
  // would silently mute notifications the user never asked to mute.
  if ((quietFrom === null) !== (quietTo === null)) return null;

  return {
    cadence,
    hourLocal: candidate.hourLocal,
    minuteLocal: candidate.minuteLocal,
    weekday,
    quietFrom,
    quietTo,
  };
}

/**
 * Project a stored schedule onto the renderer's view shape.
 *
 * `createdAt` stays behind: it is internal machinery (the floor for a schedule
 * that has never fired) and the UI has nothing to say about it.
 */
export function toScheduleView(schedule: BriefingSchedule): BriefingScheduleView {
  return {
    scheduleId: schedule.scheduleId,
    cadence: schedule.cadence,
    hourLocal: schedule.hourLocal,
    minuteLocal: schedule.minuteLocal,
    weekday: schedule.weekday,
    enabled: schedule.enabled,
    quietFrom: schedule.quietFrom,
    quietTo: schedule.quietTo,
    lastFiredAt: schedule.lastFiredAt,
  };
}

/** `schedule:list` body. Degrades a failed read to an empty list. */
export function listSchedules(deps: ScheduleHandlerDeps): BriefingScheduleView[] {
  try {
    return deps.schedules.list().map(toScheduleView);
  } catch (error) {
    console.error('[schedule] list failed', error);
    return [];
  }
}

/** `schedule:create` body. */
export function createSchedule(arg: unknown, deps: ScheduleHandlerDeps): BriefingScheduleResult {
  const parsed = parseScheduleInput(arg);
  if (parsed === null) return { ok: false, reason: 'invalid_schedule' };

  try {
    const created = deps.schedules.create({ ...parsed, createdAt: deps.clock.now() });
    return { ok: true, schedule: toScheduleView(created) };
  } catch (error) {
    console.error('[schedule] create failed', error);
    return { ok: false, reason: 'internal_error' };
  }
}

/** `schedule:setEnabled` body. */
export function setScheduleEnabled(arg: unknown, deps: ScheduleHandlerDeps): OkResult {
  const candidate = arg as { scheduleId?: unknown; enabled?: unknown } | null;
  const scheduleId: unknown = candidate?.scheduleId;
  const enabled: unknown = candidate?.enabled;

  if (typeof scheduleId !== 'string' || scheduleId === '') return { ok: false, reason: 'invalid_id' };
  if (typeof enabled !== 'boolean') return { ok: false, reason: 'invalid_enabled' };

  try {
    deps.schedules.setEnabled(scheduleId, enabled);
    return { ok: true };
  } catch (error) {
    // The repo throws for an unknown id; that is a stale renderer, not a crash.
    console.error('[schedule] setEnabled failed', error);
    return { ok: false, reason: 'unknown_schedule' };
  }
}

/**
 * Register the three schedule channels. Safe to call before any window exists —
 * none of them needs a `BrowserWindow`.
 */
export function registerScheduleHandlers(deps: ScheduleHandlerDeps): void {
  ipcMain.handle(LIST_CHANNEL, (): BriefingScheduleView[] => listSchedules(deps));
  ipcMain.handle(CREATE_CHANNEL, (_event, arg: unknown): BriefingScheduleResult =>
    createSchedule(arg, deps),
  );
  ipcMain.handle(SET_ENABLED_CHANNEL, (_event, arg: unknown): OkResult =>
    setScheduleEnabled(arg, deps),
  );
}
