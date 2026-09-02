import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { AppConfig } from '@cr/core';
import { openDb, migrate } from '../src/index.js';
import { WatermarkRepo } from '../src/repos/watermark.js';

let db: Database;
let repo: WatermarkRepo;

const THREAD = 'C1:1';
const QUIET_MS = 300_000; // 5 min
const HARD_CAP_MS = 1_800_000; // 30 min

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

    expect(due).toEqual([{ threadKey: THREAD, source: 'slack' }]);
  });

  it('returns a never-quiet thread once the hard cap has elapsed', () => {
    const now = 10_000_000;
    repo.touch(THREAD, 'slack', now - HARD_CAP_MS - 1); // arms oldest_unsynth_at long ago
    repo.touch(THREAD, 'slack', now - 60_000); // still chattering: quiet window NOT satisfied

    const wm = repo.get(THREAD);
    expect(now - (wm?.lastEventAt ?? 0)).toBeLessThan(QUIET_MS);

    const due = repo.due(now, config);

    expect(due).toEqual([{ threadKey: THREAD, source: 'slack' }]);
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
});

describe('WatermarkRepo.countPendingSynthesis — the OI-1 disclosure', () => {
  it('counts only threads whose oldest_unsynth_at is still armed', () => {
    expect(repo.countPendingSynthesis()).toBe(0);

    repo.touch('a', 'slack', 1_000);
    repo.touch('b', 'gmail', 2_000);
    expect(repo.countPendingSynthesis()).toBe(2);

    // Caught up: markSynthesized(…, null) disarms the hard cap.
    repo.markSynthesized('a', 3_000, null);
    expect(repo.countPendingSynthesis()).toBe(1);

    repo.markSynthesized('b', 3_000, null);
    expect(repo.countPendingSynthesis()).toBe(0);
  });

  it('still counts a thread whose synthesis was raced by a newer event', () => {
    repo.touch('a', 'slack', 1_000);
    // An event landed at 2_500 while synthesis was running: work remains.
    repo.markSynthesized('a', 3_000, 2_500);

    expect(repo.countPendingSynthesis()).toBe(1);
  });

  it('counts backed-up threads that are not yet DUE for synthesis', () => {
    const now = 10_000_000;
    repo.touch('chatty', 'slack', now - 1_000); // neither quiet nor capped out

    expect(repo.due(now, config)).toEqual([]);
    // "Not due" is not "nothing missing" — the user is told about it either way.
    expect(repo.countPendingSynthesis()).toBe(1);
  });
});
