import { FakeClock, type AppConfig } from '@cr/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Poller,
  isAuthError,
  isRateLimitError,
  rateLimitRetryAfterMs,
  type PollSourceKind,
  type PollerDeps,
} from '../src/poller.js';
import type { RawSourceEvent, SourceClient, SourceFetchResult } from '../src/sources/types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

/**
 * Minimal `AppConfig` — only `polling` is read by the poller, and building the
 * real thing would drag in the whole config schema for no extra coverage.
 */
const configWith = (polling: AppConfig['polling']): AppConfig =>
  ({ polling }) as unknown as AppConfig;

const pollingCfg = (
  slack: { intervalMs: number; maxBackoffMs: number },
  gmail: { intervalMs: number; maxBackoffMs: number },
): AppConfig => configWith({ slack, gmail });

const event = (
  source: PollSourceKind,
  sourceEventId: string,
  occurredAt: number,
): RawSourceEvent => ({
  source,
  sourceEventId,
  threadKey: `${sourceEventId}-thread`,
  occurredAt,
  text: 'redacted body',
});

type Handler = (cursor: unknown, callIndex: number) => Promise<SourceFetchResult<unknown>>;

interface MockSource {
  client: SourceClient<unknown>;
  /** The cursor argument of every `fetchSince` call, in order. */
  cursors: unknown[];
  get calls(): number;
}

const mockSource = (source: PollSourceKind, handler: Handler): MockSource => {
  const cursors: unknown[] = [];
  const client: SourceClient<unknown> = {
    source,
    fetchSince: (cursor) => {
      cursors.push(cursor);
      return handler(cursor, cursors.length - 1);
    },
  };
  return {
    client,
    cursors,
    get calls() {
      return cursors.length;
    },
  };
};

/** A source that always succeeds with nothing new. */
const idleSource = (source: PollSourceKind): MockSource =>
  mockSource(source, () => Promise.resolve({ events: [] }));

/** An interval long enough that the "other" source never fires mid-test. */
const NEVER = { intervalMs: 10_000_000, maxBackoffMs: 20_000_000 };

interface Harness {
  poller: Poller;
  clock: FakeClock;
  /** Advance fake timers AND the injected clock together. */
  advance: (ms: number) => Promise<void>;
  events: Array<{ source: PollSourceKind; events: RawSourceEvent[] }>;
}

const makePoller = (
  opts: {
    config: AppConfig;
    slack?: SourceClient<unknown>;
    gmail?: SourceClient<unknown>;
    random?: () => number;
    onEvents?: PollerDeps['onEvents'];
  },
): Harness => {
  const clock = new FakeClock(T0);
  const seen: Array<{ source: PollSourceKind; events: RawSourceEvent[] }> = [];

  const poller = new Poller({
    clock,
    config: opts.config,
    sources: {
      slack: opts.slack ?? idleSource('slack').client,
      gmail: opts.gmail ?? idleSource('gmail').client,
    },
    onEvents: async (source, events) => {
      seen.push({ source, events });
      if (opts.onEvents) await opts.onEvents(source, events);
    },
    random: opts.random ?? (() => 0),
  });

  return {
    poller,
    clock,
    events: seen,
    advance: async (ms: number) => {
      clock.advance(ms);
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// R1 — independent per-source scheduling
// ---------------------------------------------------------------------------

describe('Poller: independent per-source scheduling', () => {
  it('polls each source on its own configured interval', async () => {
    const slack = mockSource('slack', () => Promise.resolve({ events: [] }));
    const gmail = mockSource('gmail', () => Promise.resolve({ events: [] }));
    const h = makePoller({
      config: pollingCfg(
        { intervalMs: 1_000, maxBackoffMs: 60_000 },
        { intervalMs: 250, maxBackoffMs: 60_000 },
      ),
      slack: slack.client,
      gmail: gmail.client,
    });

    h.poller.start();
    await h.advance(0); // immediate first cycle for both

    expect(slack.calls).toBe(1);
    expect(gmail.calls).toBe(1);

    await h.advance(1_000);

    // Gmail ran 4x more in the same window Slack ran 1x more.
    expect(slack.calls).toBe(2);
    expect(gmail.calls).toBe(5);
  });

  it('does not let a hanging Slack poll delay or skip Gmail polls', async () => {
    // Slack's fetch never settles — the pathological case for a shared loop.
    const slack = mockSource('slack', () => new Promise<SourceFetchResult<unknown>>(() => {}));
    const gmail = mockSource('gmail', () => Promise.resolve({ events: [] }));
    const h = makePoller({
      config: pollingCfg(
        { intervalMs: 1_000, maxBackoffMs: 60_000 },
        { intervalMs: 300, maxBackoffMs: 60_000 },
      ),
      slack: slack.client,
      gmail: gmail.client,
    });

    h.poller.start();
    await h.advance(0);
    await h.advance(3_000);

    // Slack is still stuck in its first cycle and was never re-entered...
    expect(slack.calls).toBe(1);
    // ...while Gmail kept its own 300ms cadence: t=0 plus 300..3000.
    expect(gmail.calls).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// R2 — Retry-After
// ---------------------------------------------------------------------------

describe('Poller: Retry-After handling', () => {
  const rateLimited = (extra: Record<string, unknown>): Error =>
    Object.assign(new Error('Slack conversations.history failed: ratelimited'), {
      name: 'SlackApiError',
      slackError: 'ratelimited',
      status: 429,
      ...extra,
    });

  it('schedules the next poll after the advertised delay, not the interval', async () => {
    const slack = mockSource('slack', (_cursor, call) =>
      call === 0
        ? Promise.reject(rateLimited({ retryAfterSeconds: 30 }))
        : Promise.resolve({ events: [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 1_000, maxBackoffMs: 600_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    expect(slack.calls).toBe(1);
    expect(h.poller.health().slack.status).toBe('rate_limited');

    // The normal interval elapses many times over with no poll.
    await h.advance(29_999);
    expect(slack.calls).toBe(1);

    await h.advance(1);
    expect(slack.calls).toBe(2);
    expect(h.poller.health().slack.status).toBe('ok');
  });

  it('reads Retry-After from a header bag as well as an explicit ms field', async () => {
    expect(rateLimitRetryAfterMs(rateLimited({ retryAfterMs: 4_500 }))).toBe(4_500);
    expect(rateLimitRetryAfterMs(rateLimited({ retryAfter: '12' }))).toBe(12_000);
    expect(
      rateLimitRetryAfterMs(rateLimited({ headers: new Headers({ 'retry-after': '7' }) })),
    ).toBe(7_000);
    // A bare 429 carries no instruction: fall through to exponential backoff.
    expect(rateLimitRetryAfterMs(rateLimited({}))).toBeNull();
    expect(rateLimitRetryAfterMs(new Error('network down'))).toBeNull();
  });

  it('caps an absurd Retry-After at maxBackoffMs', async () => {
    const slack = mockSource('slack', (_cursor, call) =>
      call === 0
        ? Promise.reject(rateLimited({ retryAfterSeconds: 86_400 }))
        : Promise.resolve({ events: [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 1_000, maxBackoffMs: 60_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    await h.advance(59_999);
    expect(slack.calls).toBe(1);
    await h.advance(1);
    expect(slack.calls).toBe(2);
  });

  it('does not grow the backoff exponent while merely throttled', async () => {
    // Three throttles in a row must each wait exactly 5s, not 5s/10s/20s.
    const slack = mockSource('slack', (_cursor, call) =>
      call < 3
        ? Promise.reject(rateLimited({ retryAfterSeconds: 5 }))
        : Promise.resolve({ events: [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 1_000, maxBackoffMs: 600_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    for (const expected of [2, 3, 4]) {
      await h.advance(4_999);
      expect(slack.calls).toBe(expected - 1);
      await h.advance(1);
      expect(slack.calls).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// R3 — exponential backoff with jitter
// ---------------------------------------------------------------------------

describe('Poller: exponential backoff with jitter', () => {
  /** Records the gap between consecutive polls of a permanently failing source. */
  const measureGaps = async (
    random: () => number,
    cfg: { intervalMs: number; maxBackoffMs: number },
    cycles: number,
  ): Promise<number[]> => {
    const gaps: number[] = [];
    let last = 0;
    let elapsed = 0;
    const slack = mockSource('slack', () => Promise.reject(new Error('ECONNRESET')));
    const h = makePoller({
      config: pollingCfg(cfg, NEVER),
      slack: slack.client,
      random,
    });

    h.poller.start();
    await h.advance(0);

    // Step 1ms at a time so each poll's exact instant is observable.
    while (gaps.length < cycles) {
      await h.advance(1);
      elapsed += 1;
      if (slack.calls > gaps.length + 1) {
        gaps.push(elapsed - last);
        last = elapsed;
      }
      if (elapsed > cfg.maxBackoffMs * (cycles + 2)) break;
    }
    return gaps;
  };

  it('doubles the delay on each consecutive failure (jitter pinned to 0)', async () => {
    const gaps = await measureGaps(() => 0, { intervalMs: 100, maxBackoffMs: 100_000 }, 4);
    expect(gaps).toEqual([200, 400, 800, 1_600]);
  });

  it('adds a positive jitter component on top of the doubled delay', async () => {
    // random() === 1 is the upper bound of the jitter window: +20%.
    const gaps = await measureGaps(() => 1, { intervalMs: 100, maxBackoffMs: 100_000 }, 3);
    expect(gaps).toEqual([240, 480, 960]);
  });

  it('caps the backoff at maxBackoffMs even with maximal jitter', async () => {
    const gaps = await measureGaps(() => 1, { intervalMs: 100, maxBackoffMs: 500 }, 4);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(500);
    expect(gaps.at(-1)).toBe(500);
  });

  it('never schedules a retry sooner than the base interval, for any jitter value', async () => {
    // The classic bug: multiplicative jitter like d*(0.8+0.4r) can undercut the
    // healthy interval, hammering a service that is already failing.
    for (const r of [0, 0.001, 0.25, 0.5, 0.999, 1]) {
      const gaps = await measureGaps(() => r, { intervalMs: 100, maxBackoffMs: 100_000 }, 2);
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(100);
    }
  });

  it('produces different delays across instances when jitter is random', async () => {
    const values = [0.05, 0.95];
    const gaps = await Promise.all(
      values.map((v) => measureGaps(() => v, { intervalMs: 100, maxBackoffMs: 100_000 }, 1)),
    );
    expect(gaps[0]?.[0]).not.toBe(gaps[1]?.[0]);
  });
});

// ---------------------------------------------------------------------------
// R4 — backoff resets after one success
// ---------------------------------------------------------------------------

describe('Poller: backoff reset', () => {
  it('returns to the base interval after a single successful poll', async () => {
    // Fail 3x (delays 200/400/800 with jitter 0), then succeed.
    const slack = mockSource('slack', (_cursor, call) =>
      call < 3 ? Promise.reject(new Error('boom')) : Promise.resolve({ events: [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 100_000 }, NEVER),
      slack: slack.client,
      random: () => 0,
    });

    h.poller.start();
    await h.advance(0);
    expect(slack.calls).toBe(1);

    await h.advance(200);
    expect(slack.calls).toBe(2);
    await h.advance(400);
    expect(slack.calls).toBe(3);
    await h.advance(800);
    expect(slack.calls).toBe(4); // this one succeeds
    expect(h.poller.health().slack.status).toBe('ok');

    // Back to 100ms, not 1600ms.
    await h.advance(99);
    expect(slack.calls).toBe(4);
    await h.advance(1);
    expect(slack.calls).toBe(5);
  });

  it('restarts the exponent from the base interval after a later failure run', async () => {
    // fail, succeed, fail — the second failure must wait 200ms (2x base), not 400ms.
    const script = [false, true, false, true];
    const slack = mockSource('slack', (_cursor, call) =>
      script[call] === false
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ events: [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 100_000 }, NEVER),
      slack: slack.client,
      random: () => 0,
    });

    h.poller.start();
    await h.advance(0);
    await h.advance(200); // retry after first failure
    expect(slack.calls).toBe(2);
    await h.advance(100); // normal interval after success
    expect(slack.calls).toBe(3);

    await h.advance(199);
    expect(slack.calls).toBe(3);
    await h.advance(1);
    expect(slack.calls).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// R5 — pause / resume
// ---------------------------------------------------------------------------

describe('Poller: pause and resume', () => {
  it('stops all polling on pause and restarts it on resume', async () => {
    const slack = mockSource('slack', () => Promise.resolve({ events: [] }));
    const gmail = mockSource('gmail', () => Promise.resolve({ events: [] }));
    const h = makePoller({
      config: pollingCfg(
        { intervalMs: 100, maxBackoffMs: 10_000 },
        { intervalMs: 100, maxBackoffMs: 10_000 },
      ),
      slack: slack.client,
      gmail: gmail.client,
    });

    h.poller.start();
    await h.advance(0);
    expect(slack.calls).toBe(1);
    expect(gmail.calls).toBe(1);

    h.poller.pause();
    await h.advance(10_000);
    expect(slack.calls).toBe(1);
    expect(gmail.calls).toBe(1);

    h.poller.resume();
    await h.advance(100);
    expect(slack.calls).toBe(2);
    expect(gmail.calls).toBe(2);
  });

  it('preserves each source cursor across pause/resume', async () => {
    // A client whose cursor lives inside itself, like the real Gmail client's
    // historyId: it blows up if the poller ever "restarts" it from scratch.
    const gmail = mockSource('gmail', (cursor, call) => {
      if (call > 0 && cursor !== `history-${call}`) {
        return Promise.reject(new Error(`cursor lost: got ${String(cursor)}`));
      }
      return Promise.resolve({ events: [], cursor: `history-${call + 1}` });
    });
    const h = makePoller({
      config: pollingCfg(NEVER, { intervalMs: 100, maxBackoffMs: 10_000 }),
      gmail: gmail.client,
    });

    h.poller.start();
    await h.advance(0);
    await h.advance(100);
    expect(gmail.cursors).toEqual([undefined, 'history-1']);

    h.poller.pause();
    await h.advance(5_000);
    h.poller.resume();
    await h.advance(100);

    expect(gmail.cursors).toEqual([undefined, 'history-1', 'history-2']);
    expect(h.poller.health().gmail.status).toBe('ok');
  });

  it('keeps the very same SourceClient instances across pause/resume', async () => {
    // A stateful client: `#seq` is internal state that only survives if the
    // poller holds the SAME object and never reconstructs it.
    class StatefulClient implements SourceClient<unknown> {
      readonly source = 'slack' as const;
      seq = 0;
      instances: number[] = [];
      fetchSince(): Promise<SourceFetchResult<unknown>> {
        this.seq += 1;
        this.instances.push(this.seq);
        return Promise.resolve({ events: [] });
      }
    }
    const client = new StatefulClient();
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: client,
    });

    h.poller.start();
    await h.advance(0);
    h.poller.pause();
    await h.advance(5_000);
    h.poller.resume();
    await h.advance(100);
    await h.advance(100);

    // Monotonic sequence with no restart at 1 → the instance was never replaced.
    expect(client.instances).toEqual([1, 2, 3]);
  });

  it('preserves the current backoff level across pause/resume', async () => {
    const slack = mockSource('slack', () => Promise.reject(new Error('boom')));
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 100_000 }, NEVER),
      slack: slack.client,
      random: () => 0,
    });

    h.poller.start();
    await h.advance(0);
    await h.advance(200); // 2nd call: failures = 2, next delay 400
    expect(slack.calls).toBe(2);
    expect(h.poller.health().slack.status).toBe('backoff');

    h.poller.pause();
    h.poller.resume();

    // Resumes at 400ms — the backoff was not reset to the base interval.
    await h.advance(399);
    expect(slack.calls).toBe(2);
    await h.advance(1);
    expect(slack.calls).toBe(3);
  });

  it('does not double-schedule when resume races an in-flight poll', async () => {
    let release!: (result: SourceFetchResult<unknown>) => void;
    const slack = mockSource('slack', (_cursor, call) =>
      call === 0
        ? new Promise<SourceFetchResult<unknown>>((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ events: [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    expect(slack.calls).toBe(1);

    h.poller.pause();
    h.poller.resume(); // while cycle 1 is still in flight
    release({ events: [] });
    await h.advance(100);

    // Exactly one follow-up, not two competing timers.
    expect(slack.calls).toBe(2);
  });

  it('ignores a completing cycle scheduled before pause', async () => {
    let release!: (result: SourceFetchResult<unknown>) => void;
    const slack = mockSource('slack', (_cursor, call) =>
      call === 0
        ? new Promise<SourceFetchResult<unknown>>((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ events: [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    h.poller.pause();
    release({ events: [] });
    await h.advance(10_000);

    expect(slack.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R6 — source isolation
// ---------------------------------------------------------------------------

describe('Poller: source isolation', () => {
  it('keeps polling Gmail while every Slack poll throws', async () => {
    const slack = mockSource('slack', () => {
      throw new Error('synchronous explosion');
    });
    const gmail = mockSource('gmail', () => Promise.resolve({ events: [] }));
    const h = makePoller({
      config: pollingCfg(
        { intervalMs: 100, maxBackoffMs: 100_000 },
        { intervalMs: 100, maxBackoffMs: 100_000 },
      ),
      slack: slack.client,
      gmail: gmail.client,
      random: () => 0,
    });

    h.poller.start();
    await h.advance(0);
    await h.advance(1_000);

    expect(gmail.calls).toBe(11);
    expect(h.poller.health().gmail.status).toBe('ok');
    expect(h.poller.health().slack.status).toBe('backoff');
    // Slack backed off (t=0, 200, 600, next at 1400) instead of taking Gmail
    // down with it.
    expect(slack.calls).toBe(3);
  });

  it('survives a rejected onEvents hand-off without stopping the other source', async () => {
    const slack = mockSource('slack', () =>
      Promise.resolve({ events: [event('slack', 'm1', T0)] }),
    );
    const gmail = mockSource('gmail', () => Promise.resolve({ events: [] }));
    const h = makePoller({
      config: pollingCfg(
        { intervalMs: 100, maxBackoffMs: 100_000 },
        { intervalMs: 100, maxBackoffMs: 100_000 },
      ),
      slack: slack.client,
      gmail: gmail.client,
      random: () => 0,
      onEvents: (source) => {
        if (source === 'slack') return Promise.reject(new Error('pipeline down'));
        return Promise.resolve();
      },
    });

    h.poller.start();
    await h.advance(0);
    await h.advance(500);

    expect(gmail.calls).toBe(6);
    expect(h.poller.health().gmail.status).toBe('ok');
    // A failed hand-off is a failed cycle: never claim a successful sync.
    expect(h.poller.health().slack.status).toBe('backoff');
    expect(h.poller.health().slack.lastSyncAt).toBeNull();
  });

  it('does not let one source rejection cause an unhandled rejection', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const slack = mockSource('slack', () => Promise.reject(new Error('boom')));
      const h = makePoller({
        config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
        slack: slack.client,
      });
      h.poller.start();
      await h.advance(0);
      await h.advance(1_000);
      await Promise.resolve();
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

// ---------------------------------------------------------------------------
// R7 — health reporting
// ---------------------------------------------------------------------------

describe('Poller: health reporting', () => {
  it('reports never_synced before the first poll completes', () => {
    const h = makePoller({
      config: pollingCfg(
        { intervalMs: 100, maxBackoffMs: 10_000 },
        { intervalMs: 100, maxBackoffMs: 10_000 },
      ),
    });

    expect(h.poller.health()).toEqual({
      slack: { status: 'never_synced', lastSyncAt: null, lagMs: null, newEventCount: 0 },
      gmail: { status: 'never_synced', lastSyncAt: null, lagMs: null, newEventCount: 0 },
    });
  });

  it('reports ok, lastSyncAt and newEventCount from the most recent cycle', async () => {
    const slack = mockSource('slack', (_cursor, call) =>
      Promise.resolve({
        events:
          call === 0
            ? [event('slack', 'a', T0 - 10), event('slack', 'b', T0 - 5)]
            : [event('slack', 'c', T0 + 100)],
      }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    expect(h.poller.health().slack).toMatchObject({
      status: 'ok',
      lastSyncAt: T0,
      newEventCount: 2,
    });

    await h.advance(100);
    // newEventCount is per-cycle, not cumulative.
    expect(h.poller.health().slack).toMatchObject({
      status: 'ok',
      lastSyncAt: T0 + 100,
      newEventCount: 1,
    });
  });

  it('reports backoff while waiting out an exponential retry', async () => {
    const slack = mockSource('slack', () => Promise.reject(new Error('ETIMEDOUT')));
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    expect(h.poller.health().slack.status).toBe('backoff');
    expect(h.poller.health().slack.lastSyncAt).toBeNull();
  });

  it('reports rate_limited while honouring a Retry-After wait', async () => {
    const slack = mockSource('slack', (_cursor, call) =>
      call === 0
        ? Promise.reject(
            Object.assign(new Error('ratelimited'), {
              status: 429,
              slackError: 'ratelimited',
              retryAfterSeconds: 3,
            }),
          )
        : Promise.resolve({ events: [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    expect(h.poller.health().slack.status).toBe('rate_limited');
    await h.advance(3_000);
    expect(h.poller.health().slack.status).toBe('ok');
  });

  it('reports rate_limited for a bare 429 with no Retry-After', async () => {
    const slack = mockSource('slack', () =>
      Promise.reject(Object.assign(new Error('429'), { status: 429 })),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    expect(h.poller.health().slack.status).toBe('rate_limited');
    // …and it still backs off: 2x base, not the base interval.
    await h.advance(199);
    expect(slack.calls).toBe(1);
  });

  it('reports auth_error for 401/403 and for Slack invalid_auth', async () => {
    const cases: Array<[string, unknown]> = [
      ['gmail 401', Object.assign(new Error('Gmail API 401'), { status: 401, name: 'GmailApiError' })],
      ['gmail 403', Object.assign(new Error('Gmail API 403'), { status: 403 })],
      [
        'slack invalid_auth',
        Object.assign(new Error('invalid_auth'), { slackError: 'invalid_auth', status: 200 }),
      ],
      [
        'google reason',
        Object.assign(new Error('nope'), {
          status: 400,
          body: { error: { errors: [{ reason: 'authError' }] } },
        }),
      ],
    ];

    for (const [, error] of cases) {
      const slack = mockSource('slack', () => Promise.reject(error));
      const h = makePoller({
        config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
        slack: slack.client,
      });
      h.poller.start();
      await h.advance(0);
      expect(h.poller.health().slack.status).toBe('auth_error');
      h.poller.pause();
    }
  });

  it('classifies errors independently of the poller', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError({ slackError: 'ratelimited' })).toBe(true);
    expect(isRateLimitError({ status: 500 })).toBe(false);
    expect(isRateLimitError(null)).toBe(false);

    expect(isAuthError({ status: 401 })).toBe(true);
    expect(isAuthError({ slackError: 'token_revoked' })).toBe(true);
    expect(isAuthError({ body: { error: { status: 'UNAUTHENTICATED' } } })).toBe(true);
    expect(isAuthError({ status: 500 })).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });

  it('recovers from auth_error to ok once the credential works again', async () => {
    const slack = mockSource('slack', (_cursor, call) =>
      call === 0
        ? Promise.reject(Object.assign(new Error('invalid_auth'), { slackError: 'invalid_auth' }))
        : Promise.resolve({ events: [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
      random: () => 0,
    });

    h.poller.start();
    await h.advance(0);
    expect(h.poller.health().slack.status).toBe('auth_error');
    await h.advance(200);
    expect(h.poller.health().slack.status).toBe('ok');
  });

  it('tracks the two sources health independently', async () => {
    const slack = mockSource('slack', () => Promise.reject(new Error('boom')));
    const gmail = mockSource('gmail', () =>
      Promise.resolve({ events: [event('gmail', 'g1', T0)] }),
    );
    const h = makePoller({
      config: pollingCfg(
        { intervalMs: 100, maxBackoffMs: 10_000 },
        { intervalMs: 100, maxBackoffMs: 10_000 },
      ),
      slack: slack.client,
      gmail: gmail.client,
    });

    h.poller.start();
    await h.advance(0);

    const health = h.poller.health();
    expect(health.slack.status).toBe('backoff');
    expect(health.slack.lastSyncAt).toBeNull();
    expect(health.gmail.status).toBe('ok');
    expect(health.gmail.newEventCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R8 — lagMs (NFR-2 / AC-8)
// ---------------------------------------------------------------------------

describe('Poller: lagMs measures data staleness, not poll recency', () => {
  it('computes lag from the NEWEST ingested event occurredAt, not the poll time', async () => {
    const twoHours = 2 * 60 * 60 * 1_000;
    const oneHour = 60 * 60 * 1_000;

    // A backlog drain: the poll happens "now" but the freshest event it carries
    // is an hour old.
    const slack = mockSource('slack', () =>
      Promise.resolve({
        events: [
          event('slack', 'old', T0 - twoHours),
          event('slack', 'newest', T0 - oneHour),
          event('slack', 'middle', T0 - oneHour - 1_000),
        ],
      }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);

    const health = h.poller.health().slack;
    expect(health.lastSyncAt).toBe(T0); // the poll itself just ran…
    expect(health.lagMs).toBe(oneHour); // …but the data is an hour stale.
    // The naive "now - lastSyncAt" answer would have been 0.
    expect(health.lagMs).not.toBe(h.clock.now() - (health.lastSyncAt ?? 0));
  });

  it('grows lag with wall-clock time between polls', async () => {
    const slack = mockSource('slack', (_cursor, call) =>
      Promise.resolve({ events: call === 0 ? [event('slack', 'a', T0 - 5_000)] : [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100_000, maxBackoffMs: 200_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    expect(h.poller.health().slack.lagMs).toBe(5_000);

    h.clock.advance(30_000); // time passes, no new poll
    expect(h.poller.health().slack.lagMs).toBe(35_000);
  });

  it('keeps the newest occurredAt when a later poll returns nothing', async () => {
    const slack = mockSource('slack', (_cursor, call) =>
      Promise.resolve({ events: call === 0 ? [event('slack', 'a', T0 - 1_000)] : [] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    await h.advance(100);

    const health = h.poller.health().slack;
    expect(health.newEventCount).toBe(0);
    // An empty poll is not evidence of freshness — lag keeps growing.
    expect(health.lagMs).toBe(1_100);
  });

  it('never regresses the newest occurredAt when an older event arrives late', async () => {
    const slack = mockSource('slack', (_cursor, call) =>
      Promise.resolve({
        events:
          call === 0
            ? [event('slack', 'fresh', T0 - 1_000)]
            : [event('slack', 'late-old', T0 - 60_000)],
      }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);
    await h.advance(100);

    expect(h.poller.health().slack.lagMs).toBe(1_100);
  });

  it('is null until an event has actually been observed', async () => {
    const slack = mockSource('slack', () => Promise.resolve({ events: [] }));
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);

    expect(h.poller.health().slack).toMatchObject({
      status: 'ok',
      lastSyncAt: T0,
      lagMs: null,
      newEventCount: 0,
    });
  });

  it('clamps a source clock running ahead to zero rather than reporting negative lag', async () => {
    const slack = mockSource('slack', () =>
      Promise.resolve({ events: [event('slack', 'future', T0 + 5_000)] }),
    );
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    await h.advance(0);

    expect(h.poller.health().slack.lagMs).toBe(0);
  });

  it('tracks lag per source', async () => {
    const slack = mockSource('slack', () =>
      Promise.resolve({ events: [event('slack', 's', T0 - 1_000)] }),
    );
    const gmail = mockSource('gmail', () =>
      Promise.resolve({ events: [event('gmail', 'g', T0 - 90_000)] }),
    );
    const h = makePoller({
      config: pollingCfg(
        { intervalMs: 100_000, maxBackoffMs: 200_000 },
        { intervalMs: 100_000, maxBackoffMs: 200_000 },
      ),
      slack: slack.client,
      gmail: gmail.client,
    });

    h.poller.start();
    await h.advance(0);

    expect(h.poller.health().slack.lagMs).toBe(1_000);
    expect(h.poller.health().gmail.lagMs).toBe(90_000);
  });
});

// ---------------------------------------------------------------------------
// Hand-off contract
// ---------------------------------------------------------------------------

describe('Poller: pipeline hand-off', () => {
  it('passes fetched events to onEvents tagged with their source and persists nothing itself', async () => {
    const slackEvents = [event('slack', 's1', T0 - 10)];
    const gmailEvents = [event('gmail', 'g1', T0 - 20)];
    const slack = mockSource('slack', (_c, call) =>
      Promise.resolve({ events: call === 0 ? slackEvents : [] }),
    );
    const gmail = mockSource('gmail', (_c, call) =>
      Promise.resolve({ events: call === 0 ? gmailEvents : [] }),
    );
    const h = makePoller({
      config: pollingCfg(
        { intervalMs: 100_000, maxBackoffMs: 200_000 },
        { intervalMs: 100_000, maxBackoffMs: 200_000 },
      ),
      slack: slack.client,
      gmail: gmail.client,
    });

    h.poller.start();
    await h.advance(0);

    expect(h.events).toEqual([
      { source: 'slack', events: slackEvents },
      { source: 'gmail', events: gmailEvents },
    ]);
  });

  it('is idempotent on repeated start()', async () => {
    const slack = mockSource('slack', () => Promise.resolve({ events: [] }));
    const h = makePoller({
      config: pollingCfg({ intervalMs: 100, maxBackoffMs: 10_000 }, NEVER),
      slack: slack.client,
    });

    h.poller.start();
    h.poller.start();
    await h.advance(0);
    await h.advance(100);

    expect(slack.calls).toBe(2);
  });
});
