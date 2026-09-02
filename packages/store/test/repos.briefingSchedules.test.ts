/**
 * `BriefingSchedulesRepo` (FR-3 time-based half, OI-4).
 *
 * Run against a real `openDb(':memory:')` + `migrate`, like every other repo
 * test in this package — `briefing_schedules` ships with migration 001, so a
 * failure here is either the repo's SQL or a schema drift, and both are worth
 * catching.
 *
 * Also covers `BriefingsRepo.getMostRecent()`, added alongside this repo: it is
 * the "where does covered ground end?" read the scheduler builds its window on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { BriefingSchedulesRepo, BRIEFING_CADENCES } from '../src/repos/briefingSchedules.js';
import { BriefingsRepo } from '../src/repos/briefings.js';

let db: Database;
let schedules: BriefingSchedulesRepo;
let briefings: BriefingsRepo;

const CREATED_AT = 1_700_000_000_000;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  schedules = new BriefingSchedulesRepo(db);
  briefings = new BriefingsRepo(db);
});

afterEach(() => {
  db.close();
});

describe('BriefingSchedulesRepo.create', () => {
  it('round-trips a daily schedule through getById', () => {
    const created = schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: CREATED_AT,
    });

    expect(created).toMatchObject({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      weekday: null,
      enabled: true,
      quietFrom: null,
      quietTo: null,
      lastFiredAt: null,
      createdAt: CREATED_AT,
    });
    expect(created.scheduleId).not.toBe('');
    expect(schedules.getById(created.scheduleId)).toEqual(created);
  });

  it('persists quiet hours as a pair', () => {
    const created = schedules.create({
      cadence: 'weekdays',
      hourLocal: 7,
      minuteLocal: 30,
      quietFrom: 22,
      quietTo: 7,
      createdAt: CREATED_AT,
    });

    const loaded = schedules.getById(created.scheduleId);
    expect(loaded?.quietFrom).toBe(22);
    expect(loaded?.quietTo).toBe(7);
  });

  it('keeps weekday for a weekly cadence and nulls it for every other', () => {
    const weekly = schedules.create({
      cadence: 'weekly',
      hourLocal: 8,
      minuteLocal: 0,
      weekday: 1,
      createdAt: CREATED_AT,
    });
    expect(weekly.weekday).toBe(1);

    // A UI that keeps the last-picked weekday in state while the user flips to
    // "daily" sends a harmless leftover, not a malformed schedule.
    const daily = schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      weekday: 3,
      createdAt: CREATED_AT,
    });
    expect(daily.weekday).toBeNull();
    expect(schedules.getById(daily.scheduleId)?.weekday).toBeNull();
  });

  it('accepts a caller-minted scheduleId', () => {
    const created = schedules.create({
      scheduleId: 's-fixed',
      cadence: 'daily',
      hourLocal: 9,
      minuteLocal: 15,
      createdAt: CREATED_AT,
    });

    expect(created.scheduleId).toBe('s-fixed');
    expect(schedules.getById('s-fixed')).toEqual(created);
  });

  it('honours enabled: false without writing an enabled row', () => {
    const created = schedules.create({
      cadence: 'daily',
      hourLocal: 6,
      minuteLocal: 0,
      enabled: false,
      createdAt: CREATED_AT,
    });

    expect(created.enabled).toBe(false);
    expect(schedules.getById(created.scheduleId)?.enabled).toBe(false);
    expect(schedules.listEnabled()).toEqual([]);
  });

  it('rejects an unusable schedule rather than storing one that never fires', () => {
    const base = { hourLocal: 8, minuteLocal: 0, createdAt: CREATED_AT } as const;

    expect(() => schedules.create({ ...base, cadence: 'hourly' as never })).toThrow(
      /invalid cadence/i,
    );
    expect(() => schedules.create({ ...base, cadence: 'daily', hourLocal: 24 })).toThrow(
      /invalid hourLocal/i,
    );
    expect(() => schedules.create({ ...base, cadence: 'daily', hourLocal: -1 })).toThrow(
      /invalid hourLocal/i,
    );
    expect(() => schedules.create({ ...base, cadence: 'daily', minuteLocal: 60 })).toThrow(
      /invalid minuteLocal/i,
    );
    expect(() => schedules.create({ ...base, cadence: 'daily', hourLocal: 8.5 })).toThrow(
      /invalid hourLocal/i,
    );
    expect(() => schedules.create({ ...base, cadence: 'weekly' })).toThrow(/requires weekday/i);
    expect(() => schedules.create({ ...base, cadence: 'weekly', weekday: 7 })).toThrow(
      /requires weekday/i,
    );
    // Half a quiet range has no defensible interpretation.
    expect(() => schedules.create({ ...base, cadence: 'daily', quietFrom: 22 })).toThrow(
      /both quietFrom and quietTo/i,
    );
    expect(() => schedules.create({ ...base, cadence: 'daily', quietTo: 7 })).toThrow(
      /both quietFrom and quietTo/i,
    );
    expect(() =>
      schedules.create({ ...base, cadence: 'daily', quietFrom: 22, quietTo: 24 }),
    ).toThrow(/invalid quietTo/i);

    // Nothing landed.
    expect(schedules.list()).toEqual([]);
  });

  it('accepts every cadence it advertises', () => {
    for (const cadence of BRIEFING_CADENCES) {
      const created = schedules.create({
        cadence,
        hourLocal: 8,
        minuteLocal: 0,
        weekday: cadence === 'weekly' ? 2 : null,
        createdAt: CREATED_AT,
      });
      expect(created.cadence).toBe(cadence);
    }
    expect(schedules.list()).toHaveLength(BRIEFING_CADENCES.length);
  });
});

describe('BriefingSchedulesRepo.listEnabled', () => {
  it('returns only enabled schedules, ordered by wall-clock time', () => {
    schedules.create({
      scheduleId: 's-late',
      cadence: 'daily',
      hourLocal: 17,
      minuteLocal: 0,
      createdAt: CREATED_AT,
    });
    schedules.create({
      scheduleId: 's-early',
      cadence: 'weekdays',
      hourLocal: 8,
      minuteLocal: 30,
      createdAt: CREATED_AT,
    });
    schedules.create({
      scheduleId: 's-earliest',
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: CREATED_AT,
    });
    schedules.create({
      scheduleId: 's-off',
      cadence: 'daily',
      hourLocal: 1,
      minuteLocal: 0,
      enabled: false,
      createdAt: CREATED_AT,
    });

    expect(schedules.listEnabled().map((s) => s.scheduleId)).toEqual([
      's-earliest',
      's-early',
      's-late',
    ]);
  });

  it('is empty when every schedule is disabled', () => {
    const a = schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: CREATED_AT,
    });
    const b = schedules.create({
      cadence: 'weekly',
      hourLocal: 9,
      minuteLocal: 0,
      weekday: 1,
      createdAt: CREATED_AT,
    });

    schedules.setEnabled(a.scheduleId, false);
    schedules.setEnabled(b.scheduleId, false);

    expect(schedules.listEnabled()).toEqual([]);
    // …but they are still there to be turned back on.
    expect(schedules.list()).toHaveLength(2);
  });
});

describe('BriefingSchedulesRepo.setLastFired', () => {
  it('persists the stamp so a new repo instance sees it (restart safety)', () => {
    const created = schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: CREATED_AT,
    });
    expect(created.lastFiredAt).toBeNull();

    schedules.setLastFired(created.scheduleId, CREATED_AT + 3_600_000);

    // A fresh repo over the same db is exactly what a relaunch produces.
    const afterRestart = new BriefingSchedulesRepo(db);
    expect(afterRestart.getById(created.scheduleId)?.lastFiredAt).toBe(CREATED_AT + 3_600_000);
    expect(afterRestart.listEnabled()[0]?.lastFiredAt).toBe(CREATED_AT + 3_600_000);
  });

  it('throws for an unknown schedule id', () => {
    expect(() => schedules.setLastFired('no-such-schedule', CREATED_AT)).toThrow(
      /no schedule with id/i,
    );
  });
});

describe('BriefingSchedulesRepo.setEnabled', () => {
  it('toggles enabled without disturbing lastFiredAt', () => {
    const created = schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: CREATED_AT,
    });
    schedules.setLastFired(created.scheduleId, CREATED_AT + 1_000);

    schedules.setEnabled(created.scheduleId, false);
    expect(schedules.getById(created.scheduleId)?.enabled).toBe(false);

    schedules.setEnabled(created.scheduleId, true);
    const loaded = schedules.getById(created.scheduleId);
    expect(loaded?.enabled).toBe(true);
    // Re-enabling must not make it re-serve a window it already covered.
    expect(loaded?.lastFiredAt).toBe(CREATED_AT + 1_000);
  });

  it('throws for an unknown schedule id', () => {
    expect(() => schedules.setEnabled('no-such-schedule', false)).toThrow(/no schedule with id/i);
  });
});

describe('BriefingSchedulesRepo.remove', () => {
  it('deletes a schedule and reports whether anything was removed', () => {
    const created = schedules.create({
      cadence: 'daily',
      hourLocal: 8,
      minuteLocal: 0,
      createdAt: CREATED_AT,
    });

    expect(schedules.remove(created.scheduleId)).toBe(true);
    expect(schedules.getById(created.scheduleId)).toBeUndefined();
    expect(schedules.remove(created.scheduleId)).toBe(false);
  });
});

describe('BriefingsRepo.getMostRecent', () => {
  function createBriefing(id: string, windowStart: number, windowEnd: number, generatedAt: number) {
    return briefings.create({
      briefingId: id,
      windowStart,
      windowEnd,
      generatedAt,
      mode: 'llm',
      narrativePath: `/briefings/${id}.md`,
      deltaIds: [],
      threadsStillProcessing: 0,
    });
  }

  it('returns undefined when no briefing has ever been generated', () => {
    expect(briefings.getMostRecent()).toBeUndefined();
  });

  it('returns the briefing whose window reaches furthest forward', () => {
    createBriefing('b-old', 1_000, 2_000, 2_000);
    const newest = createBriefing('b-new', 2_000, 5_000, 5_000);
    createBriefing('b-mid', 1_500, 3_000, 3_000);

    expect(briefings.getMostRecent()).toEqual(newest);
  });

  it('prefers the furthest window end over the latest generation time', () => {
    // A briefing generated later for an explicitly-chosen PAST window must not
    // rewind the covered ground.
    createBriefing('b-forward', 1_000, 9_000, 9_000);
    createBriefing('b-backfill', 100, 500, 20_000);

    expect(briefings.getMostRecent()?.briefingId).toBe('b-forward');
    expect(briefings.getMostRecent()?.windowEnd).toBe(9_000);
  });
});
