/**
 * `poll:refresh` — `apps/desktop/src/ipc/poll.ts`.
 *
 * `poll.ts` imports `ipcMain` at module scope, which does not exist outside a
 * running Electron process — same `vi.mock('electron', …)` + dynamic-import
 * pattern as `ipc.slackChannels.test.ts` / `oauth.test.ts`.
 *
 * The body under test, `requestManualRefresh`, is a pure decision given
 * `(arg, deps, lastAcceptedAt)`: every case builds its own `Map` and its own
 * fake clock, so there is no shared state to reset between them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const {
  MANUAL_REFRESH_COOLDOWN_MS,
  REFRESH_CHANNEL,
  parsePollSource,
  registerPollHandlers,
  requestManualRefresh,
} = await import('../src/ipc/poll.js');

type Module = typeof import('../src/ipc/poll.js');
type Deps = Parameters<Module['requestManualRefresh']>[1];
type Source = 'slack' | 'gmail';

const START = 1_700_000_000_000;

/** A `deps` with a settable clock and a spying `pollNow`. */
function makeDeps(overrides: Partial<Deps> & { nowRef?: { value: number } } = {}): {
  deps: Deps;
  pollNow: ReturnType<typeof vi.fn>;
  nowRef: { value: number };
} {
  const nowRef = overrides.nowRef ?? { value: START };
  const pollNow = vi.fn();
  const deps: Deps = {
    poller: { pollNow },
    clock: { now: () => nowRef.value },
    ...overrides,
  };
  return { deps, pollNow, nowRef };
}

beforeEach(() => {
  handle.mockClear();
});

describe('parsePollSource', () => {
  it('accepts the two source kinds', () => {
    expect(parsePollSource({ source: 'slack' })).toBe('slack');
    expect(parsePollSource({ source: 'gmail' })).toBe('gmail');
  });

  for (const bad of [undefined, null, {}, { source: 'email' }, { source: 3 }, 'slack', { source: '' }]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parsePollSource(bad)).toBeNull();
    });
  }
});

describe('requestManualRefresh', () => {
  it('rejects an unparseable argument without touching the poller', () => {
    const { deps, pollNow } = makeDeps();
    const res = requestManualRefresh({ source: 'email' }, deps, new Map());
    expect(res).toEqual({ ok: false, reason: 'invalid_source' });
    expect(pollNow).not.toHaveBeenCalled();
  });

  it('forwards the first refresh to the poller and reports the full cooldown', () => {
    const { deps, pollNow } = makeDeps();
    const state = new Map<Source, number>();

    const res = requestManualRefresh({ source: 'slack' }, deps, state);

    expect(res).toEqual({ ok: true, retryAfterMs: MANUAL_REFRESH_COOLDOWN_MS });
    expect(pollNow).toHaveBeenCalledTimes(1);
    expect(pollNow).toHaveBeenCalledWith('slack');
    expect(state.get('slack')).toBe(START);
  });

  it('rejects a second refresh inside the cooldown with the remaining time', () => {
    const { deps, pollNow, nowRef } = makeDeps();
    const state = new Map<Source, number>();

    requestManualRefresh({ source: 'slack' }, deps, state);
    pollNow.mockClear();

    nowRef.value = START + 10_000;
    const res = requestManualRefresh({ source: 'slack' }, deps, state);

    expect(res).toEqual({
      ok: false,
      reason: 'cooldown',
      retryAfterMs: MANUAL_REFRESH_COOLDOWN_MS - 10_000,
    });
    expect(pollNow).not.toHaveBeenCalled();
  });

  it('allows a refresh again once the cooldown has exactly elapsed', () => {
    const { deps, pollNow, nowRef } = makeDeps();
    const state = new Map<Source, number>();

    requestManualRefresh({ source: 'gmail' }, deps, state);
    pollNow.mockClear();

    nowRef.value = START + MANUAL_REFRESH_COOLDOWN_MS;
    const res = requestManualRefresh({ source: 'gmail' }, deps, state);

    expect(res.ok).toBe(true);
    expect(pollNow).toHaveBeenCalledTimes(1);
    expect(pollNow).toHaveBeenCalledWith('gmail');
  });

  it('tracks each source independently', () => {
    const { deps, pollNow } = makeDeps();
    const state = new Map<Source, number>();

    expect(requestManualRefresh({ source: 'slack' }, deps, state).ok).toBe(true);
    // Same instant, different source — not throttled by slack's timestamp.
    expect(requestManualRefresh({ source: 'gmail' }, deps, state).ok).toBe(true);
    expect(pollNow).toHaveBeenCalledTimes(2);
  });

  it('honours a cooldown override', () => {
    const { deps: base, nowRef } = makeDeps();
    const deps: Deps = { ...base, cooldownMs: 5_000 };
    const state = new Map<Source, number>();

    requestManualRefresh({ source: 'slack' }, deps, state);
    nowRef.value = START + 4_999;
    expect(requestManualRefresh({ source: 'slack' }, deps, state).ok).toBe(false);
    nowRef.value = START + 5_000;
    expect(requestManualRefresh({ source: 'slack' }, deps, state).ok).toBe(true);
  });

  it('reports internal_error and does NOT start the cooldown when pollNow throws', () => {
    const pollNow = vi.fn(() => {
      throw new Error('poller is paused');
    });
    const { deps } = makeDeps({ poller: { pollNow } });
    const state = new Map<Source, number>();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = requestManualRefresh({ source: 'slack' }, deps, state);

    expect(res).toEqual({ ok: false, reason: 'internal_error' });
    expect(state.has('slack')).toBe(false);

    // A retry is not locked out by the failed attempt.
    pollNow.mockImplementationOnce(() => {});
    expect(requestManualRefresh({ source: 'slack' }, deps, state).ok).toBe(true);

    errorSpy.mockRestore();
  });
});

describe('registerPollHandlers', () => {
  it('registers exactly the poll:refresh channel', () => {
    const { deps } = makeDeps();
    registerPollHandlers(deps);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(REFRESH_CHANNEL, expect.any(Function));
    expect(REFRESH_CHANNEL).toBe('poll:refresh');
  });

  it('the registered handler shares one cooldown across calls', () => {
    const { deps, pollNow } = makeDeps();
    registerPollHandlers(deps);
    const fn = handle.mock.calls[0]![1] as (e: unknown, arg: unknown) => unknown;

    expect(fn({}, { source: 'slack' })).toEqual({ ok: true, retryAfterMs: MANUAL_REFRESH_COOLDOWN_MS });
    expect(fn({}, { source: 'slack' })).toMatchObject({ ok: false, reason: 'cooldown' });
    expect(pollNow).toHaveBeenCalledTimes(1);
  });
});
