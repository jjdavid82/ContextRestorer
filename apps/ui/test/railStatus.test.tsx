import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RailStatus } from '../components/RailStatus';
import type {
  ContextRestorerBridge,
  PipelineStatus,
  PollRefreshResult,
  SourceHealth,
} from '../types/bridge';

/**
 * The per-source "refresh now" button in the nav-rail status block
 * (`components/RailStatus.tsx`).
 *
 * The behaviour worth pinning is the cooldown echo: the main process
 * rate-limits `poll:refresh`, and the button disables itself for `retryAfterMs`
 * off the result — on an accepted call and on a `reason: 'cooldown'` rejection
 * alike — then re-enables on its own. Fake timers drive that ticker.
 *
 * Only the three bridge members `RailStatus` reads are stubbed; the object is
 * cast to the full bridge type at the `window` assignment.
 */

/** A deferred promise, for holding `poll.refresh` open to observe the busy state. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Harness {
  emitHealth: (health: SourceHealth[]) => void;
  emitPipeline: (status: PipelineStatus) => void;
}

function installBridge(refresh: (source: 'slack' | 'gmail') => Promise<PollRefreshResult>): Harness {
  let healthCb: ((h: SourceHealth[]) => void) | null = null;
  let pipelineCb: ((s: PipelineStatus) => void) | null = null;

  const bridge = {
    health: {
      onSources: (cb: (h: SourceHealth[]) => void) => {
        healthCb = cb;
        return () => {
          healthCb = null;
        };
      },
    },
    pipeline: {
      onStatus: (cb: (s: PipelineStatus) => void) => {
        pipelineCb = cb;
        return () => {
          pipelineCb = null;
        };
      },
    },
    poll: { refresh },
  };

  window.contextRestorer = bridge as unknown as ContextRestorerBridge;

  return {
    emitHealth: (health) => act(() => healthCb?.(health)),
    emitPipeline: (status) => act(() => pipelineCb?.(status)),
  };
}

/** Let the detached `handleRefresh` promise chain settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const OK_COOLDOWN: PollRefreshResult = { ok: true, retryAfterMs: 60_000 };

const HEALTH: SourceHealth[] = [
  { source: 'slack', status: 'ok', lagMs: 0 },
  { source: 'gmail', status: 'disconnected', lagMs: null },
];

const isDisabled = (el: Element): boolean => (el as HTMLButtonElement).disabled;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // @ts-expect-error — the global is declared always-present; tests own it.
  delete window.contextRestorer;
});

describe('RailStatus refresh button', () => {
  it('renders one refresh button per source once health arrives', () => {
    const h = installBridge(vi.fn(async () => OK_COOLDOWN));
    render(<RailStatus />);
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();

    h.emitHealth(HEALTH);

    expect(screen.getByRole('button', { name: 'Refresh slack now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh gmail now' })).toBeTruthy();
  });

  it('calls poll.refresh with the row source and spins while the call is in flight', async () => {
    const gate = deferred<PollRefreshResult>();
    const refresh = vi.fn(() => gate.promise);
    const h = installBridge(refresh);
    render(<RailStatus />);
    h.emitHealth(HEALTH);

    const button = screen.getByRole('button', { name: 'Refresh slack now' });
    fireEvent.click(button);

    expect(refresh).toHaveBeenCalledWith('slack');
    expect(isDisabled(button)).toBe(true);
    expect(button.querySelector('.cr-spin')).not.toBeNull();

    gate.resolve(OK_COOLDOWN);
    await flush();

    expect(button.querySelector('.cr-spin')).toBeNull();
  });

  it('disables the button for retryAfterMs after an accepted refresh, then re-enables it', async () => {
    const refresh = vi.fn(async () => OK_COOLDOWN);
    const h = installBridge(refresh);
    render(<RailStatus />);
    h.emitHealth(HEALTH);

    const button = screen.getByRole('button', { name: 'Refresh slack now' });
    fireEvent.click(button);
    await flush();

    expect(isDisabled(button)).toBe(true);
    expect(button.getAttribute('title')).toMatch(/available again in \d+s/);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(isDisabled(button)).toBe(false);
    expect(button.getAttribute('title')).toBe('Check slack for new activity now');
  });

  it('also honours a cooldown rejection', async () => {
    const refresh = vi.fn(
      async (): Promise<PollRefreshResult> => ({ ok: false, reason: 'cooldown', retryAfterMs: 30_000 }),
    );
    const h = installBridge(refresh);
    render(<RailStatus />);
    h.emitHealth(HEALTH);

    const button = screen.getByRole('button', { name: 'Refresh gmail now' });
    fireEvent.click(button);
    await flush();
    expect(isDisabled(button)).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(isDisabled(button)).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(isDisabled(button)).toBe(false);
  });

  it('surfaces a stuck-conversation warning only while parkedThreads > 0', () => {
    const h = installBridge(vi.fn(async () => OK_COOLDOWN));
    render(<RailStatus />);
    h.emitHealth(HEALTH);

    const base: PipelineStatus = {
      extractionBacklog: 0,
      synthesisDue: 0,
      synthesisInFlight: 0,
      parkedThreads: 0,
    };
    h.emitPipeline(base);
    expect(screen.queryByText(/stuck/i)).toBeNull();

    h.emitPipeline({ ...base, parkedThreads: 2 });
    const link = screen.getByText('2 conversations stuck — see Diagnostics');
    expect(link.getAttribute('href')).toBe('/settings');

    h.emitPipeline({ ...base, parkedThreads: 0 });
    expect(screen.queryByText(/stuck/i)).toBeNull();
  });

  it('shows the desktop-only note and no buttons without a bridge', () => {
    // @ts-expect-error — deliberately absent for this case.
    delete window.contextRestorer;
    render(<RailStatus />);
    expect(screen.getByText(/available in the desktop app/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
  });
});
