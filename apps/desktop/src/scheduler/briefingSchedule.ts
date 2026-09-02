/**
 * Recurring-briefing scheduler — FR-3, time-based half (OI-4).
 *
 * ## What this is, and what it is deliberately not
 *
 * This module adds a **trigger**, not a second briefing pipeline. A scheduled
 * briefing runs the exact function a manual `briefing:request` runs — the
 * generator is injected as {@link BriefingScheduleDeps.generate}, so there is
 * structurally no "scheduled generation path" that could drift from the manual
 * one. Everything here decides *when* and *over which window*; nothing here
 * decides what a briefing contains.
 *
 * Calendar-return detection (fire when the user's calendar says they are back)
 * is explicitly out of scope and deferred (X-1). Only wall-clock recurrence.
 *
 * ## How firing is decided
 *
 * Not "does the current minute equal 08:00". That test is brittle in exactly the
 * cases that matter: a laptop asleep at 08:00, a tick delayed by a busy main
 * process, a DST jump. Instead, each tick asks a question with a stable answer:
 *
 *   > What is the most recent occurrence of this schedule at or before now?
 *
 * and fires when that occurrence is newer than `last_fired_at` (or, for a
 * schedule that has never fired, newer than `created_at`). Three consequences,
 * all of them requirements:
 *
 *  - **Missed runs collapse.** Asleep from Monday to Thursday, one tick on wake
 *    sees Thursday 08:00 as the most recent occurrence and fires ONCE. Monday's
 *    and Tuesday's occurrences are older than the stamp that run writes, so they
 *    are never replayed.
 *  - **A restart cannot double-fire.** The stamp is in SQLite, not in a timer.
 *    A new {@link BriefingScheduleRunner} over the same repo resumes exactly
 *    where the old one stopped.
 *  - **A late tick still fires.** The occurrence does not have to coincide with
 *    a tick; it only has to be in the past.
 *
 * ## Local time and DST — what is actually implemented
 *
 * Wall-clock fields (`hourLocal`, `minuteLocal`, `quietFrom`, `quietTo`) are
 * resolved against a **named IANA timezone** through `Intl.DateTimeFormat`, via
 * the injectable {@link LocalTimeResolver}. That means DST is handled by the
 * platform's tz database, not by a fixed UTC offset: "daily 08:00" is 08:00
 * local on both sides of a transition, and the interval between two firings
 * across a spring-forward is 23 real hours rather than 24.
 *
 * The zone is injectable (`deps.timeZone`), defaulting to the host's zone, so
 * tests pin a zone with real DST rules and are deterministic wherever they run.
 *
 * Honest limits of that claim:
 *
 *  - Correctness is only as good as the tzdata shipped with the running Node /
 *    Electron build. A stale ICU gets stale transition dates. Nothing here can
 *    detect that.
 *  - A schedule set inside a spring-forward **gap** (e.g. 02:30 on a day where
 *    02:00→03:00 never happens) names a wall-clock time that does not exist. It
 *    is resolved *forward* to the first instant after the gap — the same
 *    disambiguation `Temporal`'s `'compatible'` mode uses. It fires once, an
 *    hour "late" in wall-clock terms, rather than being skipped.
 *  - A schedule inside a fall-back **ambiguity** (a wall-clock time that happens
 *    twice) resolves to the FIRST occurrence, and the second pass over the same
 *    wall clock does not re-fire, because the occurrence instant it computes is
 *    older than the stamp already written.
 *  - The zone is read once when the runner is constructed. A user who changes
 *    their machine's timezone mid-session keeps the old zone until relaunch.
 *  - Sub-minute precision is not modelled: occurrences are minute-aligned and
 *    the tick interval is a minute.
 */
import type { BriefingGenerationResult } from '@cr/ai';
import type { BriefingSchedule } from '@cr/store';

/** Half-open briefing window `[windowStart, windowEnd)`, epoch ms. */
export interface BriefingWindow {
  windowStart: number;
  windowEnd: number;
}

/** Injected time source; nothing in this module calls `Date.now()`. */
export interface Clock {
  now(): number;
}

/**
 * The slice of `@cr/ai`'s `BriefingGenerationResult` this module reads.
 *
 * A subset rather than the type itself so the real
 * `BriefingGenerator.generate` is assignable unchanged (return types are
 * covariant) while a test can hand over a two-line stub instead of fabricating
 * trace timings. `test/briefingSchedule.test.ts` pins that assignability with a
 * compile-time assertion.
 */
export interface ScheduledBriefingOutcome {
  briefingId: string;
  /** Claims that survived the citation gate. Rendered in the notification. */
  claimsAccepted: number;
  /** §7.8: generation was cut short at the latency budget. */
  partial: boolean;
}

/** The same entry point a manual `briefing:request` invokes. */
export type GenerateBriefing = (window: BriefingWindow) => Promise<ScheduledBriefingOutcome>;

/** Fails to compile unless `T` is exactly `true`. */
type AssertTrue<T extends true> = T;

/**
 * Compile-time proof that `BriefingGenerator.generate` (Layer 3, `@cr/ai`) is a
 * valid {@link GenerateBriefing} with no adapter.
 *
 * This is the enforcement point for "a scheduled briefing fires the SAME
 * generation path as a manual one". If Layer 3's result type ever drifts out of
 * the shape this module reads, `tsc -b` fails here rather than the scheduler
 * quietly acquiring a bespoke second pipeline.
 */
type _RealGeneratorSatisfiesGenerateBriefing = AssertTrue<
  ((window: BriefingWindow) => Promise<BriefingGenerationResult>) extends GenerateBriefing
    ? true
    : false
>;

/** The slice of `BriefingSchedulesRepo` the runner uses. */
export interface ScheduleStore {
  listEnabled(): BriefingSchedule[];
  setLastFired(scheduleId: string, at: number): void;
}

/**
 * The slice of `BriefingsRepo` the runner uses: where does covered ground end?
 */
export interface LatestBriefingReader {
  getMostRecent(): { windowEnd: number } | undefined;
}

/** Matches `notify` in `../notifications.js`. */
export type Notify = (opts: { title: string; body: string }) => void;

/** Broken-out local wall-clock fields for one instant in one zone. */
export interface LocalTimeParts {
  /** Full year, e.g. 2026. */
  year: number;
  /** 1–12 (NOT the 0-based month `Date` uses). */
  month: number;
  /** 1–31. */
  day: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** 0–23. */
  hour: number;
  /** 0–59. */
  minute: number;
}

/** Maps an epoch-ms instant onto local wall-clock fields. */
export type LocalTimeResolver = (epochMs: number) => LocalTimeParts;

/** Main-process poll interval; matches the Layer-2 scheduler's cadence granularity. */
export const TICK_INTERVAL_MS = 60_000;

/**
 * Window used when NO briefing has ever been generated.
 *
 * Bounded on purpose. "Everything since the beginning of time" is not a
 * briefing, it is a retrospective: it would sweep in the entire 90-day
 * retention window on a machine that has been ingesting for months, blow the
 * generation budget, and produce a document nobody reads. 24 hours is the
 * smallest window that still answers "what happened while I was away" for the
 * common case (an overnight schedule) — and it only ever applies once, because
 * the very first briefing leaves a `window_end` for every later run to chain
 * from.
 */
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

/** Days scanned backwards for a matching occurrence; 8 covers any weekly cadence. */
const MAX_LOOKBACK_DAYS = 8;

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

/* -------------------------------------------------------------------------- */
/* Local time                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The host's IANA zone, e.g. `America/Denver`.
 *
 * Read lazily rather than at module load so importing this file has no
 * environment dependency (and so a test that pins a zone never pays for it).
 */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Build a resolver for `timeZone` backed by `Intl.DateTimeFormat`.
 *
 * The formatter is created once and reused; constructing one per call is the
 * single most expensive thing this module could do on a per-minute tick.
 *
 * `weekday` is derived arithmetically from the resolved y/m/d rather than read
 * from the formatter: parsing a localized weekday name is a locale dependency
 * with no upside, and calendar arithmetic on a date triple has no DST exposure.
 */
export function makeLocalTimeResolver(timeZone: string): LocalTimeResolver {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (epochMs: number): LocalTimeParts => {
    const parts = format.formatToParts(epochMs);
    const read = (type: Intl.DateTimeFormatPartTypes): number => {
      const part = parts.find((candidate) => candidate.type === type);
      if (part === undefined) {
        throw new Error(`briefingSchedule: timezone ${timeZone} produced no ${type}`);
      }
      return Number(part.value);
    };

    const year = read('year');
    const month = read('month');
    const day = read('day');
    // `hourCycle: 'h23'` should never emit 24, but some ICU builds have; a
    // 24:00 hour would silently shift every comparison by a day.
    const hour = read('hour') % 24;
    const minute = read('minute');

    return { year, month, day, weekday: weekdayOf(year, month, day), hour, minute };
  };
}

/** Day of week (0 = Sunday) for a calendar date. Pure arithmetic, no zone. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Reinterpret local wall-clock fields as if they were UTC. */
function asUtcMs(parts: LocalTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

/**
 * The zone's UTC offset (ms) at `epochMs`.
 *
 * Floored to the minute first: the resolver drops seconds, so an unfloored
 * subtraction would report an offset up to 59.999s wrong. Every modern zone
 * offset is a whole number of minutes, so nothing is lost.
 */
function offsetMsAt(resolver: LocalTimeResolver, epochMs: number): number {
  const floored = Math.floor(epochMs / MS_PER_MINUTE) * MS_PER_MINUTE;
  return asUtcMs(resolver(floored)) - floored;
}

/**
 * The instant at which the zone's wall clock reads `year-month-day hour:minute`.
 *
 * Two passes, because the offset needed to convert local→UTC is itself a
 * function of the instant being computed. The first guess uses the offset in
 * force at the naive UTC reading; the second re-reads the offset at that guess.
 * On any ordinary day both agree and the first answer stands.
 *
 * Around a transition they disagree, and the two candidates are disambiguated by
 * round-tripping each one back through the resolver:
 *
 *  - **Both valid** (fall-back: the wall clock reads this time twice) → the
 *    EARLIER instant. The later pass over the same wall clock then computes this
 *    same earlier instant, which is already older than the stamp written when it
 *    fired, so it cannot fire twice.
 *  - **Neither valid** (spring-forward: this wall-clock time never happens) →
 *    the LATER instant, i.e. shifted forward past the gap. The run happens once,
 *    an hour late in wall-clock terms, rather than being skipped for that day.
 */
export function zonedEpochMs(
  resolver: LocalTimeResolver,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute);

  const first = target - offsetMsAt(resolver, target);
  const second = target - offsetMsAt(resolver, first);
  const candidates = first === second ? [first] : [first, second];

  const valid = candidates.filter((candidate) => asUtcMs(resolver(candidate)) === target);
  return valid.length === 0 ? Math.max(...candidates) : Math.min(...valid);
}

/* -------------------------------------------------------------------------- */
/* Occurrences                                                                */
/* -------------------------------------------------------------------------- */

/** Does `weekday` (0 = Sunday) satisfy this schedule's cadence? */
export function cadenceMatches(schedule: BriefingSchedule, weekday: number): boolean {
  switch (schedule.cadence) {
    case 'daily':
      return true;
    case 'weekdays':
      // Monday (1) through Friday (5). Weekends are the point of the cadence.
      return weekday >= 1 && weekday <= 5;
    case 'weekly':
      return schedule.weekday !== null && weekday === schedule.weekday;
    default:
      // Unreachable for a row this app wrote (the repo validates cadence), but
      // an unknown cadence must never be treated as "fires every day".
      return false;
  }
}

/**
 * The most recent instant at or before `now` at which `schedule` was due, or
 * `null` when it has none inside the lookback.
 *
 * Walks backwards a calendar day at a time from the local date of `now`. The
 * day arithmetic is done on the (year, month, day) triple in UTC terms, which
 * is pure calendar math and cannot be perturbed by a 23- or 25-hour local day;
 * only the final local→instant conversion is zone-aware.
 */
export function lastOccurrenceAtOrBefore(
  schedule: BriefingSchedule,
  now: number,
  resolver: LocalTimeResolver,
): number | null {
  const local = resolver(now);
  const startOfDayUtc = Date.UTC(local.year, local.month - 1, local.day);

  for (let daysBack = 0; daysBack <= MAX_LOOKBACK_DAYS; daysBack += 1) {
    const cursor = new Date(startOfDayUtc - daysBack * MS_PER_DAY);
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();

    if (!cadenceMatches(schedule, cursor.getUTCDay())) continue;

    const occurrence = zonedEpochMs(
      resolver,
      year,
      month,
      day,
      schedule.hourLocal,
      schedule.minuteLocal,
    );
    if (occurrence <= now) return occurrence;
  }

  return null;
}

/**
 * True when notifications are suppressed at local hour `hour` (FR-3 quiet
 * hours).
 *
 * Quiet hours suppress the NOTIFICATION ONLY. The briefing is still generated
 * and still persisted, so the user finds it waiting rather than discovering
 * that "do not disturb" quietly cost them a morning's context.
 *
 * The range is `[quietFrom, quietTo)` in local hours and wraps midnight when
 * `quietFrom > quietTo` (22 → 7 means 22, 23, 0 … 6). `quietFrom === quietTo` is
 * read as an EMPTY range, not an all-day one: "quiet from 8 to 8" is far more
 * likely to be a half-finished edit than a request to mute every notification
 * forever, and the safe reading of an ambiguous mute is to not mute.
 */
export function isQuietAt(schedule: BriefingSchedule, hour: number): boolean {
  const { quietFrom, quietTo } = schedule;
  if (quietFrom === null || quietTo === null) return false;
  if (quietFrom === quietTo) return false;
  if (quietFrom < quietTo) return hour >= quietFrom && hour < quietTo;
  return hour >= quietFrom || hour < quietTo;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

export interface BriefingScheduleDeps {
  clock: Clock;
  /** Durable recurrence state; `BriefingSchedulesRepo` in production. */
  schedules: ScheduleStore;
  /** Supplies the previous window's end; `BriefingsRepo` in production. */
  briefings: LatestBriefingReader;
  /**
   * The SAME generator a manual request uses. Injected rather than constructed
   * here so there is exactly one generation path in the app.
   */
  generate: GenerateBriefing;
  /** Desktop notification sink; `notify` from `../notifications.js`. */
  notify: Notify;
  /**
   * IANA zone the wall-clock fields are read in. Defaults to the host's zone.
   * Tests pin a zone with real DST rules so they are host-independent.
   */
  timeZone?: string;
  /**
   * Local-time derivation, overridable wholesale. Defaults to an
   * `Intl.DateTimeFormat` resolver for {@link BriefingScheduleDeps.timeZone}.
   */
  localTime?: LocalTimeResolver;
  /** Timer primitive; defaults to `setTimeout`. Injectable for fake-timer tests. */
  scheduleTimer?: (fn: () => void, ms: number) => unknown;
  /** Timer disposer; defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
}

/**
 * Fires scheduled briefings. One instance per main process.
 *
 * Disposable in the same sense as the Layer-2 `DebounceScheduler`: all durable
 * state lives in SQLite, so throwing an instance away and building a new one
 * against the same repos resumes cleanly.
 */
export class BriefingScheduleRunner {
  private readonly localTime: LocalTimeResolver;
  private readonly scheduleTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  /**
   * Same-process re-entrancy guard.
   *
   * `tick()` awaits generation, which can take tens of seconds, while the
   * interval keeps arriving every minute. Without this a second tick could see
   * a schedule whose stamp had not yet been written and start a duplicate run.
   * (The stamp is in fact written before generation starts — see `fire` — so
   * this is belt and braces, and it also keeps concurrent generations from
   * piling onto one Ollama instance.)
   */
  private ticking = false;

  private timer: unknown = null;

  constructor(private readonly deps: BriefingScheduleDeps) {
    this.localTime =
      deps.localTime ?? makeLocalTimeResolver(deps.timeZone ?? hostTimeZone());
    this.scheduleTimer = deps.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Begin ticking every {@link TICK_INTERVAL_MS}.
   *
   * Chained one-shot timers rather than an interval: the next tick is armed only
   * once the previous one has settled, so a slow generation cannot build a
   * backlog of queued ticks that all fire at once when it finishes.
   *
   * Does NOT tick immediately. A tick on launch would fire every schedule whose
   * occurrence passed while the app was closed, which is correct — but it would
   * do so while the poller is still warming up and the store still holds
   * yesterday's events, producing a briefing about nothing. One minute of
   * ingestion first is the cheaper trade.
   */
  start(): void {
    if (this.timer !== null) return;
    this.arm();
  }

  /** Stop ticking. Safe to call when not started, and idempotent. */
  stop(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.timer = this.scheduleTimer(() => {
      void this.tick().finally(() => {
        // Only re-arm if `stop()` has not run in the meantime.
        if (this.timer !== null) this.arm();
      });
    }, TICK_INTERVAL_MS);
  }

  /**
   * One scheduling pass: check every enabled schedule against the current local
   * time and fire the ones that are due.
   *
   * Never rejects. A schedule whose generation fails is logged and skipped —
   * one broken schedule must not take down the interval that drives the others.
   *
   * Schedules fire sequentially, not concurrently: two briefings generated at
   * once would contend for the same local model and, worse, would compute
   * overlapping windows from the same stale `getMostRecent()` read.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;

    try {
      const now = this.deps.clock.now();

      for (const schedule of this.deps.schedules.listEnabled()) {
        const occurrence = lastOccurrenceAtOrBefore(schedule, now, this.localTime);
        if (occurrence === null) continue;

        // `created_at` is the floor for a schedule that has never fired: without
        // it, a "daily 08:00" created at 14:00 would fire the moment it was
        // saved, for a window the user never asked about.
        const since = schedule.lastFiredAt ?? schedule.createdAt;
        if (occurrence <= since) continue;

        await this.fire(schedule, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Run one scheduled briefing.
   *
   * The stamp is written BEFORE generation starts, deliberately. If it were
   * written after, a crash (or a quit) mid-generation would leave the schedule
   * looking un-fired, and the next launch would replay it — precisely the
   * "double-fire a pending run" failure this task forbids. The cost is that a
   * failed generation is not retried until the schedule's next occurrence,
   * which is the right trade: retrying a broken model every 60 seconds burns
   * the machine and still produces nothing.
   */
  private async fire(schedule: BriefingSchedule, now: number): Promise<void> {
    this.deps.schedules.setLastFired(schedule.scheduleId, now);

    const window = this.windowFor(now);

    let outcome: ScheduledBriefingOutcome;
    try {
      outcome = await this.deps.generate(window);
    } catch (error) {
      console.error('[briefingSchedule] scheduled generation failed', schedule.scheduleId, error);
      return;
    }

    // Quiet hours gate the notification and NOTHING else — the briefing above
    // has already been generated and persisted by this point.
    if (isQuietAt(schedule, this.localTime(now).hour)) return;

    this.deps.notify({
      title: 'Your briefing is ready',
      body: describeOutcome(outcome, window),
    });
  }

  /**
   * The window a scheduled run should cover: from where the last briefing
   * stopped, to now.
   *
   * NOT a fixed 24 hours. Chaining from the previous `window_end` is what makes
   * a missed run harmless — three days asleep produces one briefing covering
   * three days, with no gap and nothing reported twice. A fixed lookback would
   * silently drop everything older than it.
   *
   * A degenerate result (no previous briefing, or one whose window somehow ends
   * at or after `now` — clock skew, or a briefing explicitly requested for a
   * future window) falls back to {@link DEFAULT_LOOKBACK_MS}, because the
   * generator's contract requires a strictly positive window and re-covering a
   * day is a far smaller harm than emitting an invalid one.
   */
  windowFor(now: number): BriefingWindow {
    const previousEnd = this.deps.briefings.getMostRecent()?.windowEnd;
    const windowStart =
      previousEnd === undefined || previousEnd >= now ? now - DEFAULT_LOOKBACK_MS : previousEnd;

    return { windowStart, windowEnd: now };
  }
}

/** Notification body. Honest about a truncated run (§7.8). */
function describeOutcome(outcome: ScheduledBriefingOutcome, window: BriefingWindow): string {
  const hours = Math.max(1, Math.round((window.windowEnd - window.windowStart) / 3_600_000));
  const claims = outcome.claimsAccepted === 1 ? '1 item' : `${outcome.claimsAccepted} items`;
  const suffix = outcome.partial ? ' (cut short at the time budget)' : '';
  return `${claims} from the last ${hours}h${suffix}.`;
}
