/**
 * Recurring-briefing scheduler (Task 3.8, FR-3 time-based half, OI-4) —
 * `apps/desktop/src/scheduler/briefingSchedule.ts`.
 *
 * The nine numbered behaviours from the task map onto the nine `describe`
 * blocks below, in order.
 *
 * ## Determinism
 *
 * Everything runs against a REAL `BriefingSchedulesRepo` / `BriefingsRepo` over
 * `openDb(':memory:')` + `migrate`, because "does a restart double-fire?" is a
 * question about durable state and an in-memory stub cannot answer it.
 *
 * Time is a `FakeClock` plus a PINNED IANA zone (`America/Denver`), never the
 * host's. Denver is chosen because it observes DST with well-known 2026
 * transitions (spring forward 2026-03-08, fall back 2026-11-01), so the DST
 * assertions are about real tz-database rules rather than a hand-rolled offset —
 * and they produce the same result on a CI box running UTC as on a laptop in
 * Berlin.
 *
 * Fixture instants for the DST tests are written as explicit ISO strings with
 * explicit UTC offsets (`2026-03-08T08:00:00-06:00`). That is deliberate: those
 * expectations must not be derived from the same `zonedEpochMs` they are meant
 * to be testing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { FakeClock } from '@cr/core';
import { BriefingSchedulesRepo, BriefingsRepo, migrate, openDb } from '@cr/store';
import type { BriefingSchedule } from '@cr/store';
import {
  BriefingScheduleRunner,
  DEFAULT_LOOKBACK_MS,
  TICK_INTERVAL_MS,
  isQuietAt,
  lastOccurrenceAtOrBefore,
  makeLocalTimeResolver,
  zonedEpochMs,
  type BriefingScheduleDeps,
  type BriefingWindow,
  type LocalTimeResolver,
  type ScheduledBriefingOutcome,
} from '../src/scheduler/briefingSchedule.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ZONE = 'America/Denver';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

let db: Database;
let schedules: BriefingSchedulesRepo;
let briefings: BriefingsRepo;
let clock: FakeClock;
let generate: ReturnType<typeof vi.fn>;
let notify: ReturnType<typeof vi.fn>;
let local: LocalTimeResolver;

/** Instants (epoch ms) at which `generate` was called, in call order. */
let firedAt: number[];

const OUTCOME: ScheduledBriefingOutcome = {
  briefingId: 'b-scheduled',
  claimsAccepted: 3,
  partial: false,
};

/** Epoch ms at which Denver's wall clock reads this date and time. */
function denver(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return zonedEpochMs(local, year, month, day, hour, minute);
}

/** An instant written with an explicit UTC offset — independent of the module. */
function iso(text: string): number {
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) throw new Error(`bad fixture instant: ${text}`);
  return parsed;
}

function makeRunner(over: Partial<BriefingScheduleDeps> = {}): BriefingScheduleRunner {
  return new BriefingScheduleRunner({
    clock,
    schedules,
    briefings,
    generate: generate as unknown as BriefingScheduleDeps['generate'],
    notify: notify as unknown as BriefingScheduleDeps['notify'],
    timeZone: ZONE,
    ...over,
  });
}

/** Seed one briefing so `getMostRecent()` has an answer. */
function seedBriefing(windowStart: number, windowEnd: number): void {
  briefings.create({
    windowStart,
    windowEnd,
    generatedAt: windowEnd,
    mode: 'llm',
    narrativePath: '/briefings/seed.md',
    deltaIds: [],
    threadsStillProcessing: 0,
  });
}

/**
 * Tick once per `stepMs` from `from` (inclusive) until `until` (exclusive).
 * Returns nothing; assertions read `firedAt`.
 */
async function tickThrough(
  runner: BriefingScheduleRunner,
  from: number,
  until: number,
  stepMs: number,
): Promise<void> {
  for (let t = from; t < until; t += stepMs) {
    clock.set(t);
    await runner.tick();
  }
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  schedules = new BriefingSchedulesRepo(db);
  briefings = new BriefingsRepo(db);
  local = makeLocalTimeResolver(ZONE);
  clock = new FakeClock(0);
  firedAt = [];
  generate = vi.fn((_window: BriefingWindow) => {
    firedAt.push(clock.now());
    return Promise.resolve(OUTCOME);
  });
  notify = vi.fn();
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* 1 — "weekdays 08:00" fires Mon-Fri, not weekends                           */
/* -------------------------------------------------------------------------- */

describe('1. a weekdays 08:00 schedule fires Monday-Friday and never at the weekend', () => {
  it('fires on exactly the ten weekdays in a fortnight', async () => {
    // Sunday 2026-06-07, so the fortnight starts on a weekend day.
    const start = denver(2026, 6, 7);
    schedules.create({
      cadence: 'weekdays',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: start,
    });

    const runner = makeRunner();
    const weekdaysFired: number[] = [];

    for (let day = 0; day < 14; day += 1) {
      const at = denver(2026, 6, 7 + day, 8, 0);
      clock.set(at);
      const before = firedAt.length;
      await runner.tick();
      if (firedAt.length > before) weekdaysFired.push(local(at).weekday);
    }

    expect(firedAt).toHaveLength(10);
    // 1 = Monday … 5 = Friday. No 0 (Sunday) and no 6 (Saturday).
    expect(new Set(weekdaysFired)).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(weekdaysFired).not.toContain(0);
    expect(weekdaysFired).not.toContain(6);
  });

  it('has no occurrence at all on a Saturday newer than Friday 08:00', () => {
    const schedule: BriefingSchedule = {
      scheduleId: 's',
      cadence: 'weekdays',
      hourLocal: 8,
      minuteLocal: 0,
      weekday: null,
      enabled: true,
      quietFrom: null,
      quietTo: null,
      lastFiredAt: null,
      createdAt: 0,
    };

    // Saturday 2026-06-13, 09:00 local — the most recent occurrence is the
    // PREVIOUS day's (Friday 2026-06-12), not one on the Saturday.
    const saturday = denver(2026, 6, 13, 9, 0);
    const occurrence = lastOccurrenceAtOrBefore(schedule, saturday, local);

    expect(occurrence).toBe(denver(2026, 6, 12, 8, 0));
  });
});

/* -------------------------------------------------------------------------- */
/* 2 — weekly fires once per week                                             */
/* -------------------------------------------------------------------------- */

describe('2. a weekly "Monday 08:00" schedule fires once per week, not every day', () => {
  it('fires twice across a fortnight, both times on a Monday', async () => {
    const start = denver(2026, 6, 7); // Sunday
    schedules.create({
      cadence: 'weekly',
      weekday: 1, // Monday
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: start,
    });

    const runner = makeRunner();

    // Ticked EVERY day at 08:00 — a daily-shaped trigger would fire 14 times.
    for (let day = 0; day < 14; day += 1) {
      clock.set(denver(2026, 6, 7 + day, 8, 0));
      await runner.tick();
    }

    expect(firedAt).toHaveLength(2);
    expect(firedAt).toEqual([denver(2026, 6, 8, 8, 0), denver(2026, 6, 15, 8, 0)]);
    expect(firedAt.map((t) => local(t).weekday)).toEqual([1, 1]);
    // Exactly seven days apart.
    expect((firedAt[1] as number) - (firedAt[0] as number)).toBe(7 * DAY_MS);
  });

  it('does not re-fire on later ticks the same Monday', async () => {
    schedules.create({
      cadence: 'weekly',
      weekday: 1,
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    const runner = makeRunner();
    await tickThrough(
      runner,
      denver(2026, 6, 8, 7, 0),
      denver(2026, 6, 9, 0, 0),
      TICK_INTERVAL_MS,
    );

    expect(firedAt).toEqual([denver(2026, 6, 8, 8, 0)]);
  });
});

/* -------------------------------------------------------------------------- */
/* 3 — the window chains from the previous briefing's window_end              */
/* -------------------------------------------------------------------------- */

describe('3. the covered window runs from the previous briefing window_end to now', () => {
  it('starts the window where the last briefing stopped, not 24h back', async () => {
    const previousEnd = denver(2026, 6, 5, 8, 0); // three days before the run
    seedBriefing(previousEnd - DAY_MS, previousEnd);

    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    const fireAt = denver(2026, 6, 8, 8, 0);
    clock.set(fireAt);
    await makeRunner().tick();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith({ windowStart: previousEnd, windowEnd: fireAt });
    // Emphatically NOT a fixed 24h: the missed days are covered, not dropped.
    expect(fireAt - previousEnd).toBeGreaterThan(DAY_MS);
  });

  it('falls back to a bounded 24h window when no briefing has ever run', async () => {
    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    const fireAt = denver(2026, 6, 8, 8, 0);
    clock.set(fireAt);
    await makeRunner().tick();

    expect(generate).toHaveBeenCalledWith({
      windowStart: fireAt - DEFAULT_LOOKBACK_MS,
      windowEnd: fireAt,
    });
    expect(DEFAULT_LOOKBACK_MS).toBe(24 * HOUR_MS);
  });

  it('falls back to 24h rather than emitting an inverted window under clock skew', () => {
    const now = denver(2026, 6, 8, 8, 0);
    // A briefing whose window ends in the future relative to `now`.
    seedBriefing(now, now + DAY_MS);

    expect(makeRunner().windowFor(now)).toEqual({
      windowStart: now - DEFAULT_LOOKBACK_MS,
      windowEnd: now,
    });
  });

  it('leaves no gap across consecutive scheduled runs', async () => {
    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    // Each generated briefing is persisted, exactly as Layer 3 does, so the
    // next run chains off it.
    const runner = makeRunner({
      generate: async (window: BriefingWindow) => {
        firedAt.push(clock.now());
        seedBriefing(window.windowStart, window.windowEnd);
        return OUTCOME;
      },
    });

    const windows: BriefingWindow[] = [];
    for (let day = 8; day <= 11; day += 1) {
      clock.set(denver(2026, 6, day, 8, 0));
      const before = briefings.getMostRecent()?.windowEnd;
      await runner.tick();
      const after = briefings.getMostRecent();
      if (after !== undefined && after.windowEnd === clock.now()) {
        windows.push({ windowStart: after.windowStart, windowEnd: after.windowEnd });
        if (before !== undefined) expect(after.windowStart).toBe(before);
      }
    }

    expect(windows).toHaveLength(4);
    for (let i = 1; i < windows.length; i += 1) {
      // Half-open and contiguous: nothing dropped, nothing reported twice.
      expect((windows[i] as BriefingWindow).windowStart).toBe(
        (windows[i - 1] as BriefingWindow).windowEnd,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4 — sleep/wake collapses missed runs into one                              */
/* -------------------------------------------------------------------------- */

describe('4. a firing missed while the machine slept runs ONCE on wake', () => {
  it('fires once after four missed days, not once per missed day', async () => {
    const created = denver(2026, 6, 7); // Sunday
    schedules.create({
      scheduleId: 's-daily',
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: created,
    });

    const runner = makeRunner();

    // Asleep: the clock advances four days with NO tick in between, so the
    // occurrences on the 8th, 9th, 10th and 11th all pass unobserved.
    const wake = denver(2026, 6, 11, 9, 30);
    clock.set(wake);

    await runner.tick();

    expect(generate).toHaveBeenCalledTimes(1);
    // One briefing, covering the whole slept-through stretch.
    expect(generate).toHaveBeenCalledWith({
      windowStart: wake - DEFAULT_LOOKBACK_MS,
      windowEnd: wake,
    });
  });

  it('collapses last_fired_at so the next checks do not replay the same missed window', async () => {
    schedules.create({
      scheduleId: 's-daily',
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    const runner = makeRunner();
    const wake = denver(2026, 6, 11, 9, 30);
    clock.set(wake);
    await runner.tick();

    expect(schedules.getById('s-daily')?.lastFiredAt).toBe(wake);

    // Keep ticking for the rest of that day: the missed occurrences are retired.
    await tickThrough(runner, wake, denver(2026, 6, 12, 0, 0), TICK_INTERVAL_MS);
    expect(generate).toHaveBeenCalledTimes(1);

    // …and the NEXT day's occurrence still fires, so nothing was over-retired.
    clock.set(denver(2026, 6, 12, 8, 0));
    await runner.tick();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('collapses a whole missed week for a weekly schedule too', async () => {
    schedules.create({
      cadence: 'weekly',
      weekday: 1,
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    const runner = makeRunner();
    // Three Mondays pass unobserved.
    clock.set(denver(2026, 6, 24, 12, 0));
    await runner.tick();

    expect(generate).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* 5 — quiet hours suppress the notification, not the briefing                */
/* -------------------------------------------------------------------------- */

describe('5. quiet hours suppress the notification but still generate the briefing', () => {
  it('generates without notifying when the fire time falls inside quiet hours', async () => {
    // 22:00 → 07:00 wraps midnight; the schedule fires at 03:00, inside it.
    schedules.create({
      cadence: 'daily',
      hourLocal: 3,
      minuteLocal: 0,
      quietFrom: 22,
      quietTo: 7,
      createdAt: denver(2026, 6, 7),
    });

    clock.set(denver(2026, 6, 8, 3, 0));
    await makeRunner().tick();

    // The briefing exists and is waiting; only the interruption was withheld.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies when the same schedule fires outside quiet hours', async () => {
    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      quietFrom: 22,
      quietTo: 7,
      createdAt: denver(2026, 6, 7),
    });

    clock.set(denver(2026, 6, 8, 8, 0));
    await makeRunner().tick();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ title: expect.any(String) });
  });

  it('notifies when no quiet hours are configured', async () => {
    schedules.create({
      cadence: 'daily',
      hourLocal: 3,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    clock.set(denver(2026, 6, 8, 3, 0));
    await makeRunner().tick();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('reads a wrapping range, an ordinary range, and an empty range correctly', () => {
    const base: BriefingSchedule = {
      scheduleId: 's',
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      weekday: null,
      enabled: true,
      quietFrom: null,
      quietTo: null,
      lastFiredAt: null,
      createdAt: 0,
    };

    const wrapping = { ...base, quietFrom: 22, quietTo: 7 };
    expect(isQuietAt(wrapping, 23)).toBe(true);
    expect(isQuietAt(wrapping, 0)).toBe(true);
    expect(isQuietAt(wrapping, 6)).toBe(true);
    expect(isQuietAt(wrapping, 7)).toBe(false); // exclusive upper bound
    expect(isQuietAt(wrapping, 22)).toBe(true); // inclusive lower bound
    expect(isQuietAt(wrapping, 12)).toBe(false);

    const ordinary = { ...base, quietFrom: 9, quietTo: 17 };
    expect(isQuietAt(ordinary, 9)).toBe(true);
    expect(isQuietAt(ordinary, 16)).toBe(true);
    expect(isQuietAt(ordinary, 17)).toBe(false);
    expect(isQuietAt(ordinary, 3)).toBe(false);

    // Equal bounds read as EMPTY, never as all-day: the safe reading of an
    // ambiguous mute is not to mute.
    const empty = { ...base, quietFrom: 8, quietTo: 8 };
    for (let hour = 0; hour < 24; hour += 1) expect(isQuietAt(empty, hour)).toBe(false);

    expect(isQuietAt(base, 3)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 6 — the same generate function, with the right window                      */
/* -------------------------------------------------------------------------- */

describe('6. a schedule fires the same generate function a manual request uses', () => {
  it('invokes the injected generator itself, with the computed window', async () => {
    const previousEnd = denver(2026, 6, 6, 17, 30);
    seedBriefing(previousEnd - DAY_MS, previousEnd);

    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 15,
      createdAt: denver(2026, 6, 7),
    });

    // The very same function object a `briefing:request` handler would be wired
    // to; the runner is given no other route to Layer 3.
    const manualEntryPoint = generate;
    const runner = makeRunner({
      generate: manualEntryPoint as unknown as BriefingScheduleDeps['generate'],
    });

    const fireAt = denver(2026, 6, 8, 8, 15);
    clock.set(fireAt);
    await runner.tick();

    expect(manualEntryPoint).toHaveBeenCalledTimes(1);
    // The argument, not merely the call, is the assertion: this proves the
    // TRIGGER computed the right window rather than just calling something.
    expect(manualEntryPoint.mock.calls[0]?.[0]).toEqual({
      windowStart: previousEnd,
      windowEnd: fireAt,
    });
    expect(manualEntryPoint.mock.calls[0]).toHaveLength(1);
  });

  it('passes a strictly positive half-open window, which the generator requires', async () => {
    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    clock.set(denver(2026, 6, 8, 8, 0));
    await makeRunner().tick();

    const window = generate.mock.calls[0]?.[0] as BriefingWindow;
    expect(window.windowStart).toBeLessThan(window.windowEnd);
    expect(Number.isFinite(window.windowStart)).toBe(true);
    expect(Number.isFinite(window.windowEnd)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 7 — disabling all schedules stops firing                                   */
/* -------------------------------------------------------------------------- */

describe('7. disabling all schedules stops scheduled firing entirely', () => {
  it('calls generate zero times across a full day of ticks', async () => {
    const a = schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });
    const b = schedules.create({
      cadence: 'weekdays',
      hourLocal: 17,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    schedules.setEnabled(a.scheduleId, false);
    schedules.setEnabled(b.scheduleId, false);

    const runner = makeRunner();
    await tickThrough(
      runner,
      denver(2026, 6, 8, 0, 0),
      denver(2026, 6, 9, 0, 0),
      15 * 60_000,
    );

    expect(generate).toHaveBeenCalledTimes(0);
    expect(notify).toHaveBeenCalledTimes(0);
    // On-demand generation is out of this class's reach by construction: the
    // only call site is `fire()`, and `listEnabled()` returned nothing.
    expect(schedules.listEnabled()).toEqual([]);
  });

  it('resumes on re-enable without back-filling the ticks it sat out', async () => {
    const a = schedules.create({
      scheduleId: 's-a',
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });
    schedules.setEnabled(a.scheduleId, false);

    const runner = makeRunner();
    await tickThrough(
      runner,
      denver(2026, 6, 8, 0, 0),
      denver(2026, 6, 10, 0, 0),
      HOUR_MS,
    );
    expect(generate).toHaveBeenCalledTimes(0);

    schedules.setEnabled(a.scheduleId, true);
    clock.set(denver(2026, 6, 10, 12, 0));
    await runner.tick();

    // One catch-up run for the most recent occurrence — not one per day it was off.
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('ignores a disabled schedule even when it is the only one due', async () => {
    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      enabled: false,
      createdAt: denver(2026, 6, 7),
    });

    clock.set(denver(2026, 6, 8, 8, 0));
    await makeRunner().tick();

    expect(generate).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* 8 — persisted state survives a restart without double-firing               */
/* -------------------------------------------------------------------------- */

describe('8. schedule state is persisted: a restart neither loses nor double-fires a run', () => {
  it('does not re-fire a schedule whose lastFiredAt was stamped before the restart', async () => {
    schedules.create({
      scheduleId: 's-daily',
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    const before = makeRunner();
    clock.set(denver(2026, 6, 8, 8, 0));
    await before.tick();
    expect(generate).toHaveBeenCalledTimes(1);

    // "Restart": a brand-new runner AND a brand-new repo instance, over the same
    // database file. Nothing in memory carries across.
    const afterRestartSchedules = new BriefingSchedulesRepo(db);
    const afterRestart = makeRunner({ schedules: afterRestartSchedules });

    await tickThrough(
      afterRestart,
      denver(2026, 6, 8, 8, 0),
      denver(2026, 6, 9, 0, 0),
      TICK_INTERVAL_MS,
    );

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('still serves the next occurrence after a restart, so nothing is lost', async () => {
    schedules.create({
      scheduleId: 's-daily',
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    clock.set(denver(2026, 6, 8, 8, 0));
    await makeRunner().tick();

    const afterRestart = makeRunner({ schedules: new BriefingSchedulesRepo(db) });
    clock.set(denver(2026, 6, 9, 8, 0));
    await afterRestart.tick();

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('serves a run whose occurrence passed while the app was closed', async () => {
    schedules.create({
      scheduleId: 's-daily',
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    // App closed all day; a fresh process starts at 21:00 and ticks once.
    const afterRestart = makeRunner({ schedules: new BriefingSchedulesRepo(db) });
    clock.set(denver(2026, 6, 8, 21, 0));
    await afterRestart.tick();

    expect(generate).toHaveBeenCalledTimes(1);
    expect(schedules.getById('s-daily')?.lastFiredAt).toBe(denver(2026, 6, 8, 21, 0));
  });

  it('stamps lastFiredAt BEFORE generating, so a crash mid-generation cannot replay', async () => {
    schedules.create({
      scheduleId: 's-daily',
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    let stampDuringGeneration: number | null | undefined;
    const runner = makeRunner({
      generate: async () => {
        stampDuringGeneration = schedules.getById('s-daily')?.lastFiredAt;
        throw new Error('layer 3 exploded');
      },
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    clock.set(denver(2026, 6, 8, 8, 0));
    await runner.tick();
    consoleError.mockRestore();

    expect(stampDuringGeneration).toBe(denver(2026, 6, 8, 8, 0));

    // A failed run is not retried every minute; it waits for the next occurrence.
    await tickThrough(
      makeRunner(),
      denver(2026, 6, 8, 8, 0),
      denver(2026, 6, 9, 0, 0),
      TICK_INTERVAL_MS,
    );
    expect(generate).toHaveBeenCalledTimes(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 9 — DST                                                                    */
/* -------------------------------------------------------------------------- */

describe('9. a DST transition neither skips nor duplicates a daily 08:00 firing', () => {
  /**
   * These assertions use the REAL mechanism the implementation uses —
   * `Intl.DateTimeFormat` against the pinned `America/Denver` zone — and compare
   * against instants written with explicit UTC offsets, so a regression to naive
   * "add 24h" arithmetic fails here rather than passing by construction.
   */
  it('fires exactly once a day across spring forward, at 08:00 local each time', async () => {
    // 2026-03-08: 02:00 MST → 03:00 MDT. The day is 23 hours long.
    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: iso('2026-03-06T00:00:00-07:00'),
    });

    const runner = makeRunner();
    await tickThrough(
      runner,
      iso('2026-03-06T00:00:00-07:00'),
      iso('2026-03-10T00:00:00-06:00'),
      15 * 60_000,
    );

    expect(firedAt).toEqual([
      iso('2026-03-06T08:00:00-07:00'), // Fri, MST
      iso('2026-03-07T08:00:00-07:00'), // Sat, MST
      iso('2026-03-08T08:00:00-06:00'), // Sun, MDT — the transition day
      iso('2026-03-09T08:00:00-06:00'), // Mon, MDT
    ]);

    // Every firing is at 08:00 local…
    for (const t of firedAt) expect(local(t)).toMatchObject({ hour: 8, minute: 0 });
    // …and the transition day is 23 real hours after the day before it. Naive
    // "previous firing + 24h" would land at 09:00 local and drift forever.
    expect((firedAt[2] as number) - (firedAt[1] as number)).toBe(23 * HOUR_MS);
    expect((firedAt[3] as number) - (firedAt[2] as number)).toBe(24 * HOUR_MS);
  });

  it('fires exactly once a day across fall back, at 08:00 local each time', async () => {
    // 2026-11-01: 02:00 MDT → 01:00 MST. The day is 25 hours long.
    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: iso('2026-10-30T00:00:00-06:00'),
    });

    const runner = makeRunner();
    await tickThrough(
      runner,
      iso('2026-10-30T00:00:00-06:00'),
      iso('2026-11-03T00:00:00-07:00'),
      15 * 60_000,
    );

    expect(firedAt).toEqual([
      iso('2026-10-30T08:00:00-06:00'), // Fri, MDT
      iso('2026-10-31T08:00:00-06:00'), // Sat, MDT
      iso('2026-11-01T08:00:00-07:00'), // Sun, MST — the transition day
      iso('2026-11-02T08:00:00-07:00'), // Mon, MST
    ]);

    for (const t of firedAt) expect(local(t)).toMatchObject({ hour: 8, minute: 0 });
    expect((firedAt[2] as number) - (firedAt[1] as number)).toBe(25 * HOUR_MS);
  });

  it('fires once, shifted forward, for a wall-clock time inside the spring-forward gap', async () => {
    // 02:30 simply does not happen on 2026-03-08 in Denver. Documented
    // behaviour: resolve forward past the gap rather than skip the day.
    schedules.create({
      cadence: 'daily',
      hourLocal: 2,
      minuteLocal: 30,
      createdAt: iso('2026-03-07T00:00:00-07:00'),
    });

    const runner = makeRunner();
    await tickThrough(
      runner,
      iso('2026-03-07T00:00:00-07:00'),
      iso('2026-03-09T00:00:00-06:00'),
      5 * 60_000,
    );

    expect(firedAt).toEqual([
      iso('2026-03-07T02:30:00-07:00'),
      // The first instant at or after the requested wall clock: 03:30 MDT.
      iso('2026-03-08T03:30:00-06:00'),
    ]);
    expect(local(firedAt[1] as number)).toMatchObject({ hour: 3, minute: 30 });
  });

  it('fires once, not twice, for a wall-clock time the fall-back repeats', async () => {
    // 01:30 happens twice on 2026-11-01 (once MDT, once MST).
    schedules.create({
      cadence: 'daily',
      hourLocal: 1,
      minuteLocal: 30,
      createdAt: iso('2026-10-31T00:00:00-06:00'),
    });

    const runner = makeRunner();
    await tickThrough(
      runner,
      iso('2026-10-31T00:00:00-06:00'),
      iso('2026-11-02T00:00:00-07:00'),
      5 * 60_000,
    );

    expect(firedAt).toEqual([
      iso('2026-10-31T01:30:00-06:00'),
      // The FIRST 01:30; the repeat an hour later does not fire again.
      iso('2026-11-01T01:30:00-06:00'),
    ]);
  });

  it('resolves an ordinary local time to a single unambiguous instant', () => {
    expect(zonedEpochMs(local, 2026, 6, 8, 8, 0)).toBe(iso('2026-06-08T08:00:00-06:00'));
    expect(zonedEpochMs(local, 2026, 1, 8, 8, 0)).toBe(iso('2026-01-08T08:00:00-07:00'));
  });
});

/* -------------------------------------------------------------------------- */
/* Timer wiring                                                               */
/* -------------------------------------------------------------------------- */

describe('tick scheduling', () => {
  it('arms a one-minute timer through the injected primitive and clears it on stop', () => {
    const scheduleTimer = vi.fn(() => 'handle-1');
    const clearTimer = vi.fn();
    const runner = makeRunner({ scheduleTimer, clearTimer });

    runner.start();
    expect(scheduleTimer).toHaveBeenCalledTimes(1);
    expect(scheduleTimer.mock.calls[0]?.[1]).toBe(TICK_INTERVAL_MS);
    expect(TICK_INTERVAL_MS).toBe(60_000);

    // Idempotent: a second start must not stack a second timer.
    runner.start();
    expect(scheduleTimer).toHaveBeenCalledTimes(1);

    runner.stop();
    expect(clearTimer).toHaveBeenCalledWith('handle-1');
    runner.stop(); // safe when already stopped
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it('re-arms after each tick under vitest fake timers with the default primitives', async () => {
    vi.useFakeTimers();
    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    const runner = makeRunner();
    clock.set(denver(2026, 6, 8, 7, 59));
    runner.start();

    // Not fired on start: the first tick is a minute away, by design.
    expect(generate).not.toHaveBeenCalled();

    clock.set(denver(2026, 6, 8, 8, 0));
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    expect(generate).toHaveBeenCalledTimes(1);

    // The chain re-armed, and the next tick does not double-fire.
    clock.set(denver(2026, 6, 8, 8, 1));
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);
    expect(generate).toHaveBeenCalledTimes(1);

    runner.stop();
    clock.set(denver(2026, 6, 9, 8, 0));
    await vi.advanceTimersByTimeAsync(10 * TICK_INTERVAL_MS);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not run two ticks concurrently', async () => {
    schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: denver(2026, 6, 7),
    });

    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(async () => {
      await blocked;
      return OUTCOME;
    });

    const runner = makeRunner({ generate: slow });
    clock.set(denver(2026, 6, 8, 8, 0));

    const first = runner.tick();
    await runner.tick(); // re-entrant: must be a no-op
    expect(slow).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
