/**
 * Integration tests for the D-7 debounce scheduler.
 *
 * These run against a REAL in-memory SQLite database and a REAL `WatermarkRepo`
 * rather than a mock, because the properties under test are properties of the
 * scheduler *plus its durable state* — most obviously Property 3 (restart
 * durability), which is meaningless against a stubbed repository.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { FakeClock } from '@cr/core';
import { openDb, migrate, WatermarkRepo } from '@cr/store';
import {
  DebounceScheduler,
  type DebounceSchedulerDeps,
  type SchedulerTrace,
} from '../src/layer2/scheduler.js';

const MIN = 60_000;
const K = 'C1:1';

const cfg = {
  slack: { quietWindowMs: 5 * MIN, hardCapMs: 30 * MIN },
  gmail: { quietWindowMs: 5 * MIN, hardCapMs: 30 * MIN },
};

let db: Database;
let watermarks: WatermarkRepo;
let clock: FakeClock;
let synthesized: string[];
let traces: SchedulerTrace[];
let sched: DebounceScheduler;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  watermarks = new WatermarkRepo(db);
  clock = new FakeClock(0);
  synthesized = [];
  traces = [];
  sched = new DebounceScheduler({
    clock,
    config: cfg,
    watermarks,
    onSynthesize: async (k) => {
      synthesized.push(k);
    },
    onTrace: (t) => {
      traces.push(t);
    },
  });
});

afterEach(() => {
  db.close();
});

/** Reasons recorded for every thread that actually fired, in order. */
const fireReasons = (): string[] =>
  traces.filter((t) => t.event === 'fire').map((t) => (t.event === 'fire' ? t.reason : ''));

describe('DebounceScheduler — Property 1: a burst produces ONE delta, not N', () => {
  it('does not fire during a 14-message burst, then fires exactly once when it goes quiet', async () => {
    // 14 messages, 20s apart: ~4.3 minutes of chatter, all inside the 5-minute
    // quiet window. Naive per-message synthesis would produce 14 deltas here.
    for (let i = 0; i < 14; i++) {
      clock.set(i * 20_000);
      watermarks.touch(K, 'slack', clock.now());
      await sched.tick();
      expect(synthesized).toEqual([]);
    }

    // Still nothing one second short of the window.
    clock.set(13 * 20_000 + 5 * MIN - 1);
    await sched.tick();
    expect(synthesized).toEqual([]);

    clock.advance(1);
    await sched.tick();

    expect(synthesized).toEqual([K]);
    expect(fireReasons()).toEqual(['quiet']);

    // And it stays one delta: the watermark was cleared, so later ticks are no-ops.
    clock.advance(10 * MIN);
    await sched.tick();
    await sched.tick();
    expect(synthesized).toEqual([K]);
  });
});

describe('DebounceScheduler — Property 2: the hard cap fires on a never-quiet thread', () => {
  it('checkpoints a thread that gets a message every 30s for 30 minutes', async () => {
    // 60 messages, 30s apart. The quiet window NEVER elapses.
    for (let i = 0; i < 60; i++) {
      clock.set(i * 30_000);
      watermarks.touch(K, 'slack', clock.now());
      await sched.tick();
      expect(synthesized).toEqual([]);
    }

    clock.set(30 * MIN);
    watermarks.touch(K, 'slack', clock.now());
    await sched.tick();

    expect(synthesized).toEqual([K]);
    // Fired on the cap, not on quiet: a message landed this very millisecond.
    expect(fireReasons()).toEqual(['hard_cap']);
    expect(clock.now() - (watermarks.get(K)?.lastEventAt ?? 0)).toBeLessThan(cfg.slack.quietWindowMs);
  });

  it('measures the cap from the FIRST unsynthesized event — new events do not reset it', async () => {
    // A message every minute for 29 minutes. If any of these reset the hard-cap
    // clock the thread would never be synthesized at all.
    for (let m = 0; m <= 29; m++) {
      clock.set(m * MIN);
      watermarks.touch(K, 'slack', clock.now());
      await sched.tick();
    }
    expect(synthesized).toEqual([]);
    expect(watermarks.get(K)?.oldestUnsynthAt).toBe(0);
    expect(watermarks.get(K)?.lastEventAt).toBe(29 * MIN);

    clock.set(30 * MIN - 1);
    await sched.tick();
    expect(synthesized).toEqual([]);

    clock.set(30 * MIN + 1);
    await sched.tick();

    expect(synthesized).toEqual([K]);
    expect(fireReasons()).toEqual(['hard_cap']);
  });

  it('re-arms the cap only from the next event, and never touches the thread itself', async () => {
    clock.set(0);
    watermarks.touch(K, 'slack', 0);
    clock.set(6 * MIN);
    await sched.tick();
    expect(synthesized).toEqual([K]);

    const after = watermarks.get(K);
    expect(after?.oldestUnsynthAt).toBeNull();
    expect(after?.lastSynthesizedAt).toBe(6 * MIN);
    // The scheduler must not call touch(): pushing last_event_at forward would
    // silently restart the quiet window on every tick.
    expect(after?.lastEventAt).toBe(0);
  });
});

describe('DebounceScheduler — Property 3: trigger state survives restart', () => {
  it('a brand-new scheduler over the same database resumes the running clock', async () => {
    watermarks.touch(K, 'slack', 0);
    clock.advance(2 * MIN);
    await sched.tick();
    expect(synthesized).toEqual([]);

    // Crash: the scheduler object (and its in-memory state) is discarded. Only
    // the database survives — as it would across an app restart.
    const restarted = new DebounceScheduler({
      clock,
      config: cfg,
      watermarks: new WatermarkRepo(db),
      onSynthesize: async (k) => {
        synthesized.push(`restarted:${k}`);
      },
    });

    clock.advance(4 * MIN); // 6 minutes total quiet > the 5-minute window
    await restarted.tick();

    expect(synthesized).toEqual([`restarted:${K}`]);
    expect(watermarks.get(K)?.lastSynthesizedAt).toBe(6 * MIN);
  });

  it('a restarted scheduler still honours a hard cap armed before the crash', async () => {
    watermarks.touch(K, 'slack', 0);
    clock.advance(29 * MIN);
    watermarks.touch(K, 'slack', clock.now()); // still busy

    const restarted = new DebounceScheduler({
      clock,
      config: cfg,
      watermarks: new WatermarkRepo(db),
      onSynthesize: async (k) => {
        synthesized.push(k);
      },
    });

    await restarted.tick();
    expect(synthesized).toEqual([]);

    clock.advance(1 * MIN); // t = 30 min since the oldest unsynthesized event
    await restarted.tick();

    expect(synthesized).toEqual([K]);
  });
});

describe('DebounceScheduler — per-source configuration', () => {
  it('applies each source its own quiet window', async () => {
    const perSource = new DebounceScheduler({
      clock,
      config: {
        slack: { quietWindowMs: 2 * MIN, hardCapMs: 30 * MIN },
        gmail: { quietWindowMs: 10 * MIN, hardCapMs: 60 * MIN },
      },
      watermarks,
      onSynthesize: async (k) => {
        synthesized.push(k);
      },
    });

    watermarks.touch('slack-thread', 'slack', 0);
    watermarks.touch('gmail-thread', 'gmail', 0);

    clock.set(2 * MIN + 1);
    await perSource.tick();
    expect(synthesized).toEqual(['slack-thread']);

    clock.set(10 * MIN + 1);
    await perSource.tick();
    expect(synthesized).toEqual(['slack-thread', 'gmail-thread']);
  });
});

describe('DebounceScheduler — robustness', () => {
  it('does not double-fire a thread whose synthesis is still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];

    const slow = new DebounceScheduler({
      clock,
      config: cfg,
      watermarks,
      onSynthesize: async (k) => {
        calls.push(k);
        await gate;
      },
    });

    watermarks.touch(K, 'slack', 0);
    clock.advance(6 * MIN);

    const first = slow.tick(); // deliberately not awaited: still running
    expect(calls).toEqual([K]);
    expect(slow.pending).toEqual([K]);

    // The thread is still due (its watermark is only cleared on success), so
    // only the in-flight guard stops this second tick from duplicating work.
    clock.advance(30_000);
    await slow.tick();
    expect(calls).toEqual([K]);

    release();
    await first;
    expect(slow.pending).toEqual([]);

    clock.advance(30_000);
    await slow.tick();
    expect(calls).toEqual([K]);
  });

  it('counts a failed synthesis and leaves the thread eligible to retry', async () => {
    let fail = true;
    const flaky = new DebounceScheduler({
      clock,
      config: cfg,
      watermarks,
      onSynthesize: async (k) => {
        if (fail) throw new Error('ollama fell over');
        synthesized.push(k);
      },
    });

    watermarks.touch(K, 'slack', 0);
    clock.advance(6 * MIN);

    await expect(flaky.tick()).resolves.toBeUndefined(); // a bad thread never breaks the tick
    expect(synthesized).toEqual([]);
    expect(watermarks.get(K)?.attempts).toBe(1);
    // Still armed — the failure must not look like a completed synthesis.
    expect(watermarks.get(K)?.oldestUnsynthAt).toBe(0);
    expect(watermarks.get(K)?.lastSynthesizedAt).toBeNull();

    fail = false;
    clock.advance(30_000);
    await flaky.tick();

    expect(synthesized).toEqual([K]);
    expect(watermarks.get(K)?.lastSynthesizedAt).toBe(6 * MIN + 30_000);
    // A success wipes the failure history so old blips cannot retire the thread later.
    expect(watermarks.get(K)?.attempts).toBe(0);
  });

  it('parks a thread after maxAttempts consecutive failures', async () => {
    const calls: string[] = [];
    const doomed = new DebounceScheduler({
      clock,
      config: cfg,
      watermarks,
      maxAttempts: 2,
      onSynthesize: async (k) => {
        calls.push(k);
        throw new Error('poison thread');
      },
      onTrace: (t) => {
        traces.push(t);
      },
    });

    watermarks.touch(K, 'slack', 0);
    clock.advance(6 * MIN);

    await doomed.tick();
    clock.advance(30_000);
    await doomed.tick();
    expect(calls).toEqual([K, K]);
    expect(watermarks.get(K)?.attempts).toBe(2);

    // Still due by every clock, but the budget is spent.
    clock.advance(60 * MIN);
    await doomed.tick();

    expect(calls).toEqual([K, K]);
    expect(traces.some((t) => t.event === 'degraded' && t.threadKey === K)).toBe(true);
  });

  it('does nothing when no thread is due, including on an empty database', async () => {
    await expect(sched.tick()).resolves.toBeUndefined();
    expect(synthesized).toEqual([]);

    watermarks.touch(K, 'slack', 0);
    clock.advance(1 * MIN);
    await sched.tick();
    expect(synthesized).toEqual([]);
  });

  it('fires several due threads in one tick', async () => {
    watermarks.touch('t1', 'slack', 0);
    watermarks.touch('t2', 'gmail', 1_000);
    clock.advance(6 * MIN);

    await sched.tick();

    expect(synthesized.sort()).toEqual(['t1', 't2']);
    expect(watermarks.get('t1')?.oldestUnsynthAt).toBeNull();
    expect(watermarks.get('t2')?.oldestUnsynthAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 4.4 — the decision log
// ---------------------------------------------------------------------------

describe('DebounceScheduler — decision logging (Task 4.4, requirement 3)', () => {
  let logsDir: string;

  beforeEach(() => {
    logsDir = mkdtempSync(join(tmpdir(), 'cr-sched-trace-'));
  });

  afterEach(() => {
    rmSync(logsDir, { recursive: true, force: true });
  });

  /** Every JSON line the scheduler wrote, across every day-file. */
  const traceLines = (): Record<string, unknown>[] =>
    readdirSync(logsDir)
      .filter((f) => f.startsWith('trace-') && f.endsWith('.jsonl'))
      .flatMap((f) =>
        readFileSync(join(logsDir, f), 'utf8')
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      );

  const annotationsOf = (line: Record<string, unknown>): Record<string, unknown> =>
    line['annotations'] as Record<string, unknown>;

  function build(
    onSynthesize: DebounceSchedulerDeps['onSynthesize'],
    over: { eventCount?: (k: string) => number; logsDir?: string | undefined } = {},
  ): DebounceScheduler {
    return new DebounceScheduler({
      clock,
      config: cfg,
      watermarks,
      onSynthesize,
      onTrace: (t) => {
        traces.push(t);
      },
      ...(over.eventCount === undefined ? {} : { countThreadEvents: over.eventCount }),
      ...('logsDir' in over ? { logsDir: over.logsDir as string } : { logsDir }),
    });
  }

  it("records the fired condition, the thread's event count and the synthesis outcome", async () => {
    // A thread that goes quiet, with a real per-thread event count wired in.
    const counts: Record<string, number> = { [K]: 14 };
    const sut = build(async () => 'ok', { eventCount: (k) => counts[k] ?? 0 });

    watermarks.touch(K, 'slack', 0);
    clock.advance(6 * MIN);
    await sut.tick();

    const fire = traces.find((t) => t.event === 'fire');
    const success = traces.find((t) => t.event === 'success');

    expect(fire).toMatchObject({ threadKey: K, source: 'slack', reason: 'quiet', eventCount: 14 });
    // The TERMINAL record carries the whole story on its own: condition, event
    // count and what the synthesis actually did.
    expect(success).toMatchObject({
      threadKey: K,
      reason: 'quiet',
      eventCount: 14,
      outcome: 'ok',
    });
    // Both halves of one trigger share one correlation id.
    expect(fire?.event === 'fire' && success?.event === 'success').toBe(true);
    if (fire?.event === 'fire' && success?.event === 'success') {
      expect(success.traceId).toBe(fire.traceId);
    }
  });

  it("distinguishes a delta from 'nothing was meaningful' from an error", async () => {
    const outcomes: string[] = [];
    const capture = (): void => {
      for (const t of traces) {
        if (t.event === 'success' || t.event === 'failure') outcomes.push(t.outcome);
      }
      traces.length = 0;
    };

    // 1. a delta was written
    watermarks.touch('t-delta', 'slack', 0);
    clock.advance(6 * MIN);
    await build(async () => 'ok').tick();
    capture();

    // 2. the model declined — the expected common case, and previously
    //    indistinguishable from case 1 (both merely "resolved").
    watermarks.touch('t-quiet', 'slack', clock.now());
    clock.advance(6 * MIN);
    await build(async () => 'not_meaningful').tick();
    capture();

    // 3. the synthesis threw
    watermarks.touch('t-boom', 'slack', clock.now());
    clock.advance(6 * MIN);
    await build(async () => {
      throw new Error('ollama fell over');
    }).tick();
    capture();

    expect(outcomes).toEqual(['ok', 'not_meaningful', 'error']);
  });

  it('hands the trigger id to onSynthesize so layer 2 can log under it', async () => {
    const seen: Array<[string, string]> = [];
    const sut = build(async (threadKey, traceId) => {
      seen.push([threadKey, traceId]);
      return 'ok';
    });

    watermarks.touch(K, 'slack', 0);
    clock.advance(6 * MIN);
    await sut.tick();

    const fire = traces.find((t) => t.event === 'fire');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe(K);
    expect(seen[0]?.[1]).not.toBe('');
    if (fire?.event === 'fire') expect(seen[0]?.[1]).toBe(fire.traceId);
  });

  it('writes exactly one parseable JSON line per trigger', async () => {
    const sut = build(async () => 'not_meaningful', { eventCount: () => 3 });

    watermarks.touch('t1', 'slack', 0);
    watermarks.touch('t2', 'gmail', 0);
    clock.advance(6 * MIN);
    await sut.tick();

    const lines = traceLines();
    expect(lines).toHaveLength(2); // two threads fired, two lines

    for (const line of lines) {
      const a = annotationsOf(line);
      expect(a['event']).toBe('layer2_trigger');
      expect(a['reason']).toBe('quiet');
      expect(a['eventCount']).toBe(3);
      expect(a['outcome']).toBe('not_meaningful');
      expect(a['wroteDelta']).toBe(false);
      // The synthesis span is what makes the line a trace rather than a log row.
      expect((line['spans'] as { name: string }[]).map((s) => s.name)).toEqual(['synthesis']);
    }
    expect(new Set(lines.map((l) => l['traceId'])).size).toBe(2);
  });

  it('records a hard-cap trigger as hard_cap, with how long it had been backed up', async () => {
    const sut = build(async () => 'ok');

    // A message every minute for 30 minutes: the quiet window never elapses.
    for (let m = 0; m <= 30; m++) {
      clock.set(m * MIN);
      watermarks.touch(K, 'slack', clock.now());
      await sut.tick();
    }

    const lines = traceLines();
    expect(lines).toHaveLength(1);
    const a = annotationsOf(lines[0] as Record<string, unknown>);
    expect(a['reason']).toBe('hard_cap');
    expect(a['backloggedForMs']).toBe(30 * MIN);
    // Fired on the cap, not on quiet: a message landed this very millisecond.
    expect(a['quietForMs']).toBe(0);
  });

  it('records the error message, not an unserialisable Error object', async () => {
    const sut = build(async () => {
      throw new Error('ollama fell over');
    });

    watermarks.touch(K, 'slack', 0);
    clock.advance(6 * MIN);
    await sut.tick();

    const a = annotationsOf(traceLines()[0] as Record<string, unknown>);
    expect(a['outcome']).toBe('error');
    expect(a['attempts']).toBe(1);
    // `JSON.stringify(new Error('x'))` is `{}` — greppability is the whole point.
    expect(String(a['error'])).toContain('ollama fell over');
  });

  it('traces eventCount as null — not 0 — when no counter is wired', async () => {
    const sut = build(async () => 'ok');

    watermarks.touch(K, 'slack', 0);
    clock.advance(6 * MIN);
    await sut.tick();

    expect(traces.find((t) => t.event === 'fire')).toMatchObject({ eventCount: null });
    expect(annotationsOf(traceLines()[0] as Record<string, unknown>)['eventCount']).toBeNull();
  });

  it('writes no file at all when no logsDir is configured, but still mints an id', async () => {
    // Every existing call site omits `logsDir`; none of them may start writing
    // into the process CWD as a side effect of this task.
    const seen: string[] = [];
    const sut = build(
      async (_k, traceId) => {
        seen.push(traceId);
        return 'ok';
      },
      { logsDir: undefined },
    );

    watermarks.touch(K, 'slack', 0);
    clock.advance(6 * MIN);
    await sut.tick();

    expect(readdirSync(logsDir)).toEqual([]);
    expect(seen[0]).toBeTruthy();
  });
});
