import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { AppConfig, Event } from '@cr/core';
import { openDb, migrate } from '../src/index.js';
import { EventsRepo } from '../src/repos/events.js';
import { ExtractionsRepo } from '../src/repos/extractions.js';
import { WatermarkRepo } from '../src/repos/watermark.js';

let db: Database;
let repo: WatermarkRepo;

const THREAD = 'C1:1';
const QUIET_MS = 300_000; // 5 min
const HARD_CAP_MS = 1_800_000; // 30 min
/** Mirrors `DebounceScheduler.DEFAULT_MAX_ATTEMPTS`; kept local to avoid an `@cr/ai` test dependency. */
const MAX_ATTEMPTS = 3;

/**
 * Only `debounce` matters to `due()`; the rest of AppConfig is irrelevant here
 * and spelling it out in full would just be noise that rots with the schema.
 */
const config = {
  debounce: {
    slack: { quietWindowMs: QUIET_MS, hardCapMs: HARD_CAP_MS },
    gmail: { quietWindowMs: 600_000, hardCapMs: 3_600_000 },
  },
} as unknown as AppConfig;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new WatermarkRepo(db);
});

afterEach(() => {
  db.close();
});

describe('WatermarkRepo.touch — D-7 clock arming', () => {
  it('starts both clocks together on a new thread', () => {
    repo.touch(THREAD, 'slack', 1_000);

    const wm = repo.get(THREAD);
    expect(wm?.lastEventAt).toBe(1_000);
    expect(wm?.oldestUnsynthAt).toBe(1_000);
    expect(wm?.source).toBe('slack');
    expect(wm?.lastSynthesizedAt).toBeNull();
    expect(wm?.attempts).toBe(0);
  });

  it('advances last_event_at but leaves oldest_unsynth_at pinned on a later touch', () => {
    // This is the test that protects the 30-minute hard cap. If a second touch
    // also pushed oldest_unsynth_at forward, a thread receiving a message every
    // four minutes would reset BOTH clocks forever: the quiet window would never
    // elapse, the hard cap would never elapse, and the thread would never be
    // synthesized at all.
    repo.touch(THREAD, 'slack', 1_000);
    repo.touch(THREAD, 'slack', 9_000);

    const wm = repo.get(THREAD);
    expect(wm?.lastEventAt).toBe(9_000);
    expect(wm?.oldestUnsynthAt).toBe(1_000);
  });

  it('keeps oldest_unsynth_at pinned across many touches', () => {
    repo.touch(THREAD, 'slack', 1_000);
    for (const at of [2_000, 3_000, 4_000, 5_000]) repo.touch(THREAD, 'slack', at);

    const wm = repo.get(THREAD);
    expect(wm?.lastEventAt).toBe(5_000);
    expect(wm?.oldestUnsynthAt).toBe(1_000);
  });

  it('returns undefined for a thread that has never been touched', () => {
    expect(repo.get('never-seen')).toBeUndefined();
  });
});

describe('WatermarkRepo.markSynthesized', () => {
  it('clears oldest_unsynth_at and stamps last_synthesized_at', () => {
    repo.touch(THREAD, 'slack', 1_000);

    repo.markSynthesized(THREAD, 5_000, null);

    const wm = repo.get(THREAD);
    expect(wm?.oldestUnsynthAt).toBeNull();
    expect(wm?.lastSynthesizedAt).toBe(5_000);
    expect(wm?.lastEventAt).toBe(1_000);
  });

  it('re-arms a FRESH oldest_unsynth_at on the next touch after a synth cycle', () => {
    repo.touch(THREAD, 'slack', 1_000);
    repo.markSynthesized(THREAD, 5_000, null);

    repo.touch(THREAD, 'slack', 7_000);

    const wm = repo.get(THREAD);
    // Not 1_000: the "write only if NULL" rule re-engages once the cycle cleared it,
    // so the hard cap for the *next* batch is measured from the next batch's first event.
    expect(wm?.oldestUnsynthAt).toBe(7_000);
    expect(wm?.lastEventAt).toBe(7_000);
    expect(wm?.lastSynthesizedAt).toBe(5_000);
  });

  it('keeps the hard cap running from carried-over work when given a timestamp', () => {
    repo.touch(THREAD, 'slack', 1_000);
    // An event landed at 4_000 while synthesis was in flight.
    repo.markSynthesized(THREAD, 5_000, 4_000);

    repo.touch(THREAD, 'slack', 7_000);

    // 4_000 survives — racing work is not granted a brand-new 30-minute cap.
    expect(repo.get(THREAD)?.oldestUnsynthAt).toBe(4_000);
  });
});

describe('WatermarkRepo attempt accounting', () => {
  it('increments attempts without disturbing either clock', () => {
    repo.touch(THREAD, 'slack', 1_000);
    repo.touch(THREAD, 'slack', 4_000);

    repo.incrementAttempts(THREAD);
    repo.incrementAttempts(THREAD);

    const wm = repo.get(THREAD);
    expect(wm?.attempts).toBe(2);
    // A failed synthesis must leave the thread exactly as due as it was.
    expect(wm?.oldestUnsynthAt).toBe(1_000);
    expect(wm?.lastEventAt).toBe(4_000);
    expect(wm?.lastSynthesizedAt).toBeNull();
  });

  it('resets attempts to zero', () => {
    repo.touch(THREAD, 'slack', 1_000);
    repo.incrementAttempts(THREAD);
    repo.incrementAttempts(THREAD);

    repo.resetAttempts(THREAD);

    expect(repo.get(THREAD)?.attempts).toBe(0);
  });

  it('is a no-op on an unknown thread', () => {
    expect(() => repo.incrementAttempts('never-seen')).not.toThrow();
    expect(() => repo.resetAttempts('never-seen')).not.toThrow();
    expect(repo.get('never-seen')).toBeUndefined();
  });
});

describe('WatermarkRepo.due', () => {
  it('returns a thread that has been quiet for at least the quiet window', () => {
    const now = 10_000_000;
    repo.touch(THREAD, 'slack', now - QUIET_MS - 1); // quiet, but well inside the hard cap

    const due = repo.due(now, config);

    expect(due).toEqual([{ threadKey: THREAD, source: 'slack', attempts: 0 }]);
  });

  it('returns a never-quiet thread once the hard cap has elapsed', () => {
    const now = 10_000_000;
    repo.touch(THREAD, 'slack', now - HARD_CAP_MS - 1); // arms oldest_unsynth_at long ago
    repo.touch(THREAD, 'slack', now - 60_000); // still chattering: quiet window NOT satisfied

    const wm = repo.get(THREAD);
    expect(now - (wm?.lastEventAt ?? 0)).toBeLessThan(QUIET_MS);

    const due = repo.due(now, config);

    expect(due).toEqual([{ threadKey: THREAD, source: 'slack', attempts: 0 }]);
  });

  it('excludes a thread that is neither quiet enough nor capped out', () => {
    const now = 10_000_000;
    repo.touch(THREAD, 'slack', now - 60_000);

    expect(repo.due(now, config)).toEqual([]);
  });

  it('applies each source its own thresholds', () => {
    const now = 10_000_000;
    // 5 min of quiet: past Slack's window, still inside Gmail's 10-minute one.
    repo.touch('slack-thread', 'slack', now - QUIET_MS);
    repo.touch('gmail-thread', 'gmail', now - QUIET_MS);

    const due = repo.due(now, config);

    expect(due.map((d) => d.threadKey)).toEqual(['slack-thread']);
  });

  it('still returns a parked thread, with its attempt count, for the caller to filter', () => {
    // `due()` answers "is the clock predicate satisfied", not "should this be
    // retried" — that second question belongs to whoever reads `attempts`
    // (the scheduler parks; `pipeline:status` excludes from its own count).
    const now = 10_000_000;
    repo.touch(THREAD, 'slack', now - QUIET_MS - 1);
    repo.incrementAttempts(THREAD);
    repo.incrementAttempts(THREAD);
    repo.incrementAttempts(THREAD);

    expect(repo.due(now, config)).toEqual([{ threadKey: THREAD, source: 'slack', attempts: 3 }]);
  });
});

/**
 * `due()` must not call a thread due while Layer 1 still owes it an extraction.
 * Firing early makes retrieval come back empty and Layer 2 answer `no_context`;
 * the scheduler now leaves such a thread armed and counts an attempt, but on
 * slow hardware — where one Layer 1 call is minutes — a thread would burn its
 * whole retry budget in ~90s of ticks and be parked before its extraction ever
 * lands. Not being due at all until extraction is done is what keeps the retry
 * budget for threads that genuinely have no context, which is what it is for.
 *
 * Both clocks are in source time, so on a backfill a thread is "quiet for
 * hours" the moment it lands and the hard cap has "elapsed" too. The quiet
 * branch therefore requires full extraction outright. The hard cap is gated on
 * wall-clock instead: it holds only while some unextracted event was ingested
 * less than a cap ago, or while Layer 1 has written any extraction within the
 * last cap (a queue that is moving is not a stall). Once neither is true the
 * thread fires anyway, so a backlog cannot starve it.
 */
describe('WatermarkRepo.due — the Layer 1 gate', () => {
  const now = 10_000_000;
  /** Old enough to be past every quiet window, young enough to be inside every hard cap. */
  const quietAgo = now - QUIET_MS - 1;

  let events: EventsRepo;
  let extractions: ExtractionsRepo;

  beforeEach(() => {
    events = new EventsRepo(db);
    extractions = new ExtractionsRepo(db);
  });

  /** Minimal valid event; every field is overridable per-test. */
  const makeEvent = (over: Partial<Event> = {}): Event => ({
    eventId: 'e1',
    source: 'slack',
    sourceEventId: 's1',
    threadKey: THREAD,
    actorId: 'U1',
    occurredAt: quietAgo,
    ingestedAt: quietAgo + 50,
    payload: { text: 'hello' },
    redactionCount: 0,
    ...over,
  });

  /**
   * The row Layer 1 writes when it is done with an event. `createdAt` matters
   * to the hard-cap gate: a recent row anywhere is proof Layer 1 is alive.
   */
  const extracted = (eventId: string, createdAt = quietAgo + 100): void =>
    extractions.insert({
      eventId,
      class: 'status_update',
      confidence: 0.9,
      participants: [],
      artifacts: [],
      model: 'm',
      promptVersion: 'v1',
      createdAt,
    });

  const dueKeys = (layer1ActiveSince?: number): string[] =>
    repo.due(now, config, layer1ActiveSince).map((d) => d.threadKey);

  it('holds a quiet thread back while one of its events is still unextracted', () => {
    events.insertIfAbsent(makeEvent());
    repo.touch(THREAD, 'slack', quietAgo);

    // Quiet by the clock — and it would have been due before the gate.
    expect(now - (repo.get(THREAD)?.lastEventAt ?? 0)).toBeGreaterThan(QUIET_MS);
    expect(dueKeys()).toEqual([]);
  });

  it('releases the thread once every event on it has an extraction row', () => {
    events.insertIfAbsent(makeEvent());
    repo.touch(THREAD, 'slack', quietAgo);
    expect(dueKeys()).toEqual([]);

    extracted('e1');

    expect(dueKeys()).toEqual([THREAD]);
  });

  it('holds the thread while ANY of several events is unextracted, not just the newest', () => {
    events.insertIfAbsent(makeEvent({ eventId: 'e1', sourceEventId: 's1', occurredAt: quietAgo - 2 }));
    events.insertIfAbsent(makeEvent({ eventId: 'e2', sourceEventId: 's2', occurredAt: quietAgo - 1 }));
    events.insertIfAbsent(makeEvent({ eventId: 'e3', sourceEventId: 's3', occurredAt: quietAgo }));
    repo.touch(THREAD, 'slack', quietAgo);

    extracted('e1');
    extracted('e3');
    expect(dueKeys()).toEqual([]);

    extracted('e2');
    expect(dueKeys()).toEqual([THREAD]);
  });

  it("gates per thread: one thread's backlog does not hold back another", () => {
    events.insertIfAbsent(makeEvent({ eventId: 'e-a', sourceEventId: 's-a', threadKey: 'A' }));
    events.insertIfAbsent(makeEvent({ eventId: 'e-b', sourceEventId: 's-b', threadKey: 'B' }));
    repo.touch('A', 'slack', quietAgo);
    repo.touch('B', 'slack', quietAgo);

    extracted('e-b');

    expect(dueKeys()).toEqual(['B']);
  });

  it('does not hold back a thread that has no events at all', () => {
    // Every other `due()` test in this file relies on this: a watermark with no
    // event rows behind it has nothing unextracted, and is due as before.
    repo.touch(THREAD, 'slack', quietAgo);

    expect(dueKeys()).toEqual([THREAD]);
  });

  it('holds a backfilled thread past the hard cap while a just-ingested event is unextracted', () => {
    // The backfill shape: hours old at the source, seconds old on this machine.
    // Both clocks say "long overdue"; Layer 1 has had one poll cycle on it.
    const longAgo = now - HARD_CAP_MS - 1;
    events.insertIfAbsent(makeEvent({ occurredAt: longAgo, ingestedAt: now - 1_000 }));
    repo.touch(THREAD, 'slack', longAgo);

    expect(now - (repo.get(THREAD)?.oldestUnsynthAt ?? 0)).toBeGreaterThan(HARD_CAP_MS);
    expect(dueKeys()).toEqual([]);

    extracted('e1');
    expect(dueKeys()).toEqual([THREAD]);
  });

  it('holds a thread past the hard cap while Layer 1 is still draining the queue elsewhere', () => {
    // This thread's event has waited longer than a cap, but Layer 1 wrote a row
    // on some OTHER thread moments ago. A queue that is moving is not a stall;
    // on slow hardware a backfill is hours of Layer 1, and firing here would
    // disarm most of it with no context, just later.
    const longAgo = now - HARD_CAP_MS - 1;
    events.insertIfAbsent(makeEvent({ occurredAt: longAgo, ingestedAt: longAgo }));
    repo.touch(THREAD, 'slack', longAgo);
    repo.touch(THREAD, 'slack', now - 60_000); // chattering: quiet branch cannot fire

    events.insertIfAbsent(makeEvent({ eventId: 'e-other', sourceEventId: 's-other', threadKey: 'other' }));
    extracted('e-other', now - 1_000);

    expect(dueKeys()).toEqual([]);

    // Once THIS thread is extracted it fires on the hard cap like any other.
    extracted('e1', now - 500);
    expect(dueKeys()).toEqual([THREAD]);
  });

  it('treats Layer 1 as wedged only when it has written nothing for a whole cap', () => {
    const longAgo = now - HARD_CAP_MS - 1;
    events.insertIfAbsent(makeEvent({ occurredAt: longAgo, ingestedAt: longAgo }));
    repo.touch(THREAD, 'slack', longAgo);
    repo.touch(THREAD, 'slack', now - 60_000);
    events.insertIfAbsent(makeEvent({ eventId: 'e-other', sourceEventId: 's-other', threadKey: 'other' }));

    // The last row Layer 1 ever wrote is older than the cap: nothing has moved
    // for thirty minutes while work is outstanding. That is a stall, and the
    // thread fires with what it has rather than never.
    extracted('e-other', now - HARD_CAP_MS - 1);
    expect(dueKeys()).toEqual([THREAD]);
  });

  it('applies the hard-cap gate per source threshold', () => {
    // Gmail's cap is 3_600_000 here. Both events were ingested 2_000_000 ago and
    // Layer 1 last wrote a row 2_500_000 ago. For Slack (cap 1_800_000) that is
    // a thread that has waited a cap with Layer 1 silent for a cap: a stall.
    // For Gmail (cap 3_600_000) the event is still freshly queued AND Layer 1
    // was active within the cap: a queue.
    const longAgo = now - 3_600_000 - 1;
    const midAgo = now - 2_000_000;
    events.insertIfAbsent(makeEvent({ eventId: 'e-s', sourceEventId: 's-s', threadKey: 'S', occurredAt: longAgo, ingestedAt: midAgo }));
    events.insertIfAbsent(makeEvent({ eventId: 'e-g', sourceEventId: 's-g', threadKey: 'G', source: 'gmail', occurredAt: longAgo, ingestedAt: midAgo }));
    events.insertIfAbsent(makeEvent({ eventId: 'e-other', sourceEventId: 's-other', threadKey: 'other' }));
    extracted('e-other', now - 2_500_000);
    repo.touch('S', 'slack', longAgo);
    repo.touch('S', 'slack', now - 60_000);
    repo.touch('G', 'gmail', longAgo);
    repo.touch('G', 'gmail', now - 60_000);

    expect(dueKeys()).toEqual(['S']);
  });

  /**
   * The cold-start guard (condition (3) in `DUE_SQL`). On the first ticks after
   * the app is reopened, nothing has been extracted "lately" — because nothing
   * was running. Without `layer1ActiveSince`, the hard-cap branch reads that as
   * a stalled Layer 1 and fires every backlogged thread at once; each retrieves
   * nothing and the scheduler parks the lot. The guard holds those threads
   * until Layer 1 has actually had a cap of wall-clock time to work.
   */
  describe('the cold-start guard', () => {
    /** A backfilled thread: long overdue on both clocks, its event never extracted. */
    const backlogThread = (): void => {
      const longAgo = now - HARD_CAP_MS - 1;
      events.insertIfAbsent(makeEvent({ occurredAt: longAgo, ingestedAt: longAgo }));
      repo.touch(THREAD, 'slack', longAgo);
      repo.touch(THREAD, 'slack', now - 60_000); // chattering: quiet branch cannot fire
    };

    it('fires (old behaviour) when layer1ActiveSince is omitted', () => {
      backlogThread();
      expect(dueKeys()).toEqual([THREAD]);
    });

    it('holds the thread back while Layer 1 has been running less than a cap', () => {
      backlogThread();
      // App relaunched a minute ago; the catch-up sweep has barely started.
      expect(dueKeys(now - 60_000)).toEqual([]);
    });

    it('releases the thread once Layer 1 has run a full cap with nothing to show', () => {
      backlogThread();
      expect(dueKeys(now - HARD_CAP_MS + 1)).toEqual([]); // just short of a cap
      expect(dueKeys(now - HARD_CAP_MS)).toEqual([THREAD]); // a full cap: a real stall
    });

    it('does not delay a thread whose backlog Layer 1 has since cleared', () => {
      backlogThread();
      extracted('e1', now - 1_000);
      // Fully extracted — the stall test is not even reached.
      expect(dueKeys(now - 60_000)).toEqual([THREAD]);
    });

    it('is irrelevant while Layer 1 is demonstrably alive elsewhere', () => {
      backlogThread();
      events.insertIfAbsent(
        makeEvent({ eventId: 'e-other', sourceEventId: 's-other', threadKey: 'other' }),
      );
      extracted('e-other', now - 1_000); // a fresh row on another thread
      // A moving queue, not a stall: this thread stays held whatever the uptime,
      // and a long uptime does not release it either.
      expect(dueKeys(now - 60_000)).toEqual([]);
      expect(dueKeys(now - HARD_CAP_MS - 1)).toEqual([]);
    });
  });
});

describe('WatermarkRepo.countPendingSynthesis — the OI-1 disclosure', () => {
  it('counts only threads whose oldest_unsynth_at is still armed', () => {
    expect(repo.countPendingSynthesis(MAX_ATTEMPTS)).toBe(0);

    repo.touch('a', 'slack', 1_000);
    repo.touch('b', 'gmail', 2_000);
    expect(repo.countPendingSynthesis(MAX_ATTEMPTS)).toBe(2);

    // Caught up: markSynthesized(…, null) disarms the hard cap.
    repo.markSynthesized('a', 3_000, null);
    expect(repo.countPendingSynthesis(MAX_ATTEMPTS)).toBe(1);

    repo.markSynthesized('b', 3_000, null);
    expect(repo.countPendingSynthesis(MAX_ATTEMPTS)).toBe(0);
  });

  it('still counts a thread whose synthesis was raced by a newer event', () => {
    repo.touch('a', 'slack', 1_000);
    // An event landed at 2_500 while synthesis was running: work remains.
    repo.markSynthesized('a', 3_000, 2_500);

    expect(repo.countPendingSynthesis(MAX_ATTEMPTS)).toBe(1);
  });

  it('counts backed-up threads that are not yet DUE for synthesis', () => {
    const now = 10_000_000;
    repo.touch('chatty', 'slack', now - 1_000); // neither quiet nor capped out

    expect(repo.due(now, config)).toEqual([]);
    // "Not due" is not "nothing missing" — the user is told about it either way.
    expect(repo.countPendingSynthesis(MAX_ATTEMPTS)).toBe(1);
  });

  it('excludes a thread the scheduler has parked (attempts >= maxAttempts)', () => {
    repo.touch('doomed', 'gmail', 1_000);
    repo.touch('healthy', 'slack', 1_000);

    for (let i = 0; i < MAX_ATTEMPTS; i++) repo.incrementAttempts('doomed');

    // Still "unsynthesized" — just no longer being retried, so it must drop
    // out of a count whose whole point is "work still in flight".
    expect(repo.get('doomed')?.oldestUnsynthAt).not.toBeNull();
    expect(repo.countPendingSynthesis(MAX_ATTEMPTS)).toBe(1);

    // A lower threshold parks 'healthy' too, at the caller's discretion.
    expect(repo.countPendingSynthesis(0)).toBe(0);
  });
});

describe('WatermarkRepo.markParked / reviveWithSignal — parking is no longer terminal', () => {
  /**
   * Parking used to be permanent: `due()` filters out anything at or above the
   * cap, only a success clears the counter, and a thread that is never offered
   * can never succeed. A thread parked while it held nothing but `noise` was
   * therefore deaf to a real message arriving on it later — no delta, no
   * obligation, nothing in the briefing, and the Diagnostics panel meanwhile
   * claiming it would be "picked up again automatically".
   *
   * The revive is deliberately narrower than "the thread has signal", and the
   * poison-thread cases below are why: a thread that failed repeatedly usually
   * HAS context (that is what it kept failing on), so the broad predicate would
   * un-park it every tick, forever.
   */
  let events: EventsRepo;
  let extractions: ExtractionsRepo;

  const PARKED_AT = 5_000;

  beforeEach(() => {
    events = new EventsRepo(db);
    extractions = new ExtractionsRepo(db);
  });

  /** One event on `THREAD`, extracted as `cls` at `createdAt`. */
  const eventWithClass = (
    eventId: string,
    cls: 'noise' | 'status_update',
    createdAt: number,
  ): void => {
    events.insertIfAbsent({
      eventId,
      source: 'slack',
      sourceEventId: `s-${eventId}`,
      threadKey: THREAD,
      actorId: 'U1',
      occurredAt: 1_000,
      ingestedAt: 1_000,
      payload: { text: 'hello' },
      redactionCount: 0,
    });
    extractions.insert({
      eventId,
      class: cls,
      confidence: 0.9,
      participants: [],
      artifacts: [],
      model: 'm',
      promptVersion: 'v1',
      createdAt,
    });
  };

  /** Park `THREAD` at `PARKED_AT` with a full attempt budget spent. */
  const park = (): void => {
    repo.touch(THREAD, 'slack', 1_000);
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) repo.incrementAttempts(THREAD);
    repo.markParked(THREAD, PARKED_AT);
  };

  it('uses parked_at as the reference point the revive compares against', () => {
    park();
    eventWithClass('e-new', 'status_update', PARKED_AT + 1);

    // Newer than the park: revives.
    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(1);

    // Re-park with the reference point moved PAST that extraction, and the same
    // content no longer counts as new. `markParked` is an unconditional write
    // because the scheduler calls it exactly once per park cycle — see the SQL.
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) repo.incrementAttempts(THREAD);
    repo.markParked(THREAD, PARKED_AT + 500);
    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(0);
  });

  it('revives an all-noise thread once real signal arrives after the park', () => {
    eventWithClass('e-noise', 'noise', PARKED_AT - 100);
    park();

    // Nothing to work with yet: still all noise.
    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(0);
    expect(repo.get(THREAD)?.attempts).toBe(MAX_ATTEMPTS);

    // A real message lands and Layer 1 classifies it as something citable.
    eventWithClass('e-real', 'status_update', PARKED_AT + 1);

    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(1);
    const wm = repo.get(THREAD);
    expect(wm?.attempts).toBe(0);
    // And it is offered again, which is the whole point.
    expect(
      repo.due(1_000 + QUIET_MS + 1, config, 0).map((row) => row.threadKey),
    ).toContain(THREAD);
  });

  it('leaves a poison thread parked when its signal PREDATES the park', () => {
    // The case the naive "has signal" predicate breaks on: this thread has
    // context, which is exactly what it kept failing to synthesize.
    eventWithClass('e-real', 'status_update', PARKED_AT - 100);
    park();

    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(0);
    expect(repo.get(THREAD)?.attempts).toBe(MAX_ATTEMPTS);
    // Repeated ticks must not change that — this is the loop that would have
    // burned the synthesis budget forever.
    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(0);
    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(0);
  });

  it('gives a poison thread one fresh budget when NEW content arrives, and cannot loop', () => {
    eventWithClass('e-old', 'status_update', PARKED_AT - 100);
    park();
    eventWithClass('e-new', 'status_update', PARKED_AT + 1);

    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(1);
    expect(repo.get(THREAD)?.attempts).toBe(0);

    // It fails again and re-parks — with a NEWER reference point, so the same
    // content cannot revive it a second time.
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) repo.incrementAttempts(THREAD);
    repo.markParked(THREAD, PARKED_AT + 100);

    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(0);
  });

  it('never revives a thread with no parked_at at all', () => {
    // NULL means "not parked": the scheduler stamps on the crossing, so a row
    // at the cap with no stamp can only be one that predates the column — and
    // migration 010 backfills those. Comparing against NULL matching nothing is
    // what keeps an un-stamped row from being revived by signal it already had.
    repo.touch(THREAD, 'slack', 1_000);
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) repo.incrementAttempts(THREAD);
    eventWithClass('e-real', 'status_update', 9_999);

    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(0);
  });

  it('ignores threads still inside their retry budget', () => {
    repo.touch(THREAD, 'slack', 1_000);
    repo.incrementAttempts(THREAD);
    eventWithClass('e-real', 'status_update', 9_999);

    // `due()` will offer it again on the next tick anyway; touching its counter
    // here would hand it extra retries it has not earned.
    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(0);
    expect(repo.get(THREAD)?.attempts).toBe(1);
  });

  it('clears parked_at on a successful synthesis, so the next park starts fresh', () => {
    eventWithClass('e-real', 'status_update', PARKED_AT - 100);
    park();

    repo.resetAttempts(THREAD);
    // Re-park with no new content. A stale `parked_at` would have made this
    // thread's revive window start in the past and un-park it immediately.
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) repo.incrementAttempts(THREAD);
    repo.markParked(THREAD, PARKED_AT + 1_000);

    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(0);
  });

  it('is a no-op on an unknown thread key', () => {
    expect(() => repo.markParked('nope', 1)).not.toThrow();
    expect(repo.reviveWithSignal(MAX_ATTEMPTS)).toBe(0);
  });
});
