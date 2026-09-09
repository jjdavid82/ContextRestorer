import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RailStatus, formatEta } from '../components/RailStatus';
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
  localStorage.clear();
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

    // The spin is floored (`REFRESH_MIN_SPIN_MS`) so a fast IPC round-trip still
    // shows it: still spinning right after the call settles...
    expect(button.querySelector('.cr-spin')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    // ...and stopped once the floor elapses.
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
      extractionEtaMs: null,
    };
    h.emitPipeline(base);
    expect(screen.queryByText(/stuck/i)).toBeNull();

    h.emitPipeline({ ...base, parkedThreads: 2 });
    const link = screen.getByText('2 conversations stuck — see Diagnostics');
    expect(link.getAttribute('href')).toBe('/settings/index.html#diagnostics');

    h.emitPipeline({ ...base, parkedThreads: 0 });
    expect(screen.queryByText(/stuck/i)).toBeNull();
  });

  const PIPELINE_BASE: PipelineStatus = {
    extractionBacklog: 0,
    synthesisDue: 0,
    synthesisInFlight: 0,
    parkedThreads: 0,
    extractionEtaMs: null,
  };

  it('dismisses the stuck notice, then re-shows it only once the backlog grows past the dismissed count', () => {
    const h = installBridge(vi.fn(async () => OK_COOLDOWN));
    render(<RailStatus />);
    h.emitHealth(HEALTH);

    h.emitPipeline({ ...PIPELINE_BASE, parkedThreads: 3 });
    expect(screen.getByText('3 conversations stuck — see Diagnostics')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss stuck-conversation notice' }));
    expect(screen.queryByText(/stuck/i)).toBeNull();

    // Same or smaller backlog stays hidden.
    h.emitPipeline({ ...PIPELINE_BASE, parkedThreads: 3 });
    h.emitPipeline({ ...PIPELINE_BASE, parkedThreads: 2 });
    expect(screen.queryByText(/stuck/i)).toBeNull();

    // A worse backlog brings it back.
    h.emitPipeline({ ...PIPELINE_BASE, parkedThreads: 5 });
    expect(screen.getByText('5 conversations stuck — see Diagnostics')).toBeTruthy();
  });

  it('persists the dismissal across remounts and forgets it once the backlog clears', () => {
    const h1 = installBridge(vi.fn(async () => OK_COOLDOWN));
    const first = render(<RailStatus />);
    h1.emitHealth(HEALTH);
    h1.emitPipeline({ ...PIPELINE_BASE, parkedThreads: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss stuck-conversation notice' }));
    expect(screen.queryByText(/stuck/i)).toBeNull();

    first.unmount();

    const h2 = installBridge(vi.fn(async () => OK_COOLDOWN));
    render(<RailStatus />);
    h2.emitHealth(HEALTH);
    h2.emitPipeline({ ...PIPELINE_BASE, parkedThreads: 2 });
    expect(screen.queryByText(/stuck/i)).toBeNull(); // still dismissed

    // Backlog clears, then the same count returns — no longer suppressed.
    h2.emitPipeline({ ...PIPELINE_BASE, parkedThreads: 0 });
    h2.emitPipeline({ ...PIPELINE_BASE, parkedThreads: 2 });
    expect(screen.getByText('2 conversations stuck — see Diagnostics')).toBeTruthy();
  });

  it('shows the desktop-only note and no buttons without a bridge', () => {
    // @ts-expect-error — deliberately absent for this case.
    delete window.contextRestorer;
    render(<RailStatus />);
    expect(screen.getByText(/available in the desktop app/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
  });
});

describe('the extraction ETA (F2)', () => {
  const backlog = (extractionBacklog: number, extractionEtaMs: number | null): PipelineStatus => ({
    extractionBacklog,
    synthesisDue: 0,
    synthesisInFlight: 0,
    parkedThreads: 0,
    extractionEtaMs,
  });

  it('states the count alone while no estimate has been earned', () => {
    // The first-run state: no completed Layer-1 calls to average, so there is
    // no honest number to quote. The count still tells the user work is moving.
    const h = installBridge(vi.fn(async () => OK_COOLDOWN));
    render(<RailStatus />);
    h.emitHealth(HEALTH);

    h.emitPipeline(backlog(420, null));

    expect(screen.getByText('Reading 420 new messages…')).toBeTruthy();
  });

  it('appends the estimate once one exists', () => {
    const h = installBridge(vi.fn(async () => OK_COOLDOWN));
    render(<RailStatus />);
    h.emitHealth(HEALTH);

    h.emitPipeline(backlog(420, 12 * 60_000));

    expect(screen.getByText('Reading 420 new messages… ~12 min left')).toBeTruthy();
  });

  it('singularises one message', () => {
    const h = installBridge(vi.fn(async () => OK_COOLDOWN));
    render(<RailStatus />);
    h.emitHealth(HEALTH);

    h.emitPipeline(backlog(1, null));

    expect(screen.getByText('Reading 1 new message…')).toBeTruthy();
  });
});

describe('formatEta', () => {
  it('rounds to the roughest honest unit', () => {
    // Deliberately coarse past the first hour: the ETA answers "minutes or
    // hours", and quoting it to the minute would dress an estimate as a schedule.
    expect(formatEta(20_000)).toBe('under a minute');
    expect(formatEta(9 * 60_000)).toBe('~9 min');
    expect(formatEta(59 * 60_000)).toBe('~59 min');
    expect(formatEta(90 * 60_000)).toBe('~1.5 h');
    expect(formatEta(3 * 3_600_000)).toBe('~3 h');
    expect(formatEta(14 * 3_600_000)).toBe('~14 h');
  });
});
