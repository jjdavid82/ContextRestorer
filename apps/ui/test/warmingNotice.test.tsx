import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { WarmingNotice } from '../components/WarmingNotice';
import type { ContextRestorerBridge, PipelineStatus } from '../types/bridge';

/**
 * The first-run backlog notice (`components/WarmingNotice.tsx`, F2).
 *
 * What is worth pinning here is entirely about what the component REFUSES to
 * say. It exists because a user who has just connected a real mailbox is hours
 * from a briefing worth reading, and an empty home page cannot be told apart
 * from a broken product. So the two failure modes it must not have are staying
 * on screen once the backlog clears, and inventing a duration before one has
 * been measured — `extractionEtaMs` is `null` at exactly the moment the user is
 * looking at this.
 */

interface Harness {
  emit: (status: PipelineStatus) => void;
  /** How many times the component subscribed, to catch a listener leak. */
  subscriptions: () => number;
}

function installBridge(): Harness {
  let cb: ((s: PipelineStatus) => void) | null = null;
  let subscriptions = 0;

  const bridge = {
    pipeline: {
      onStatus: (next: (s: PipelineStatus) => void) => {
        subscriptions += 1;
        cb = next;
        return () => {
          cb = null;
        };
      },
    },
  };

  window.contextRestorer = bridge as unknown as ContextRestorerBridge;

  return {
    emit: (status) => act(() => cb?.(status)),
    subscriptions: () => subscriptions,
  };
}

const status = (extractionBacklog: number, extractionEtaMs: number | null): PipelineStatus => ({
  extractionBacklog,
  synthesisDue: 0,
  synthesisInFlight: 0,
  parkedThreads: 0,
  extractionEtaMs,
});

afterEach(() => {
  cleanup();
  // @ts-expect-error — the global is declared always-present; tests own it.
  delete window.contextRestorer;
});

describe('WarmingNotice', () => {
  it('renders nothing before the first status arrives', () => {
    // A flash of "still reading" on every app open, before anything is known,
    // would be the same false signal in the other direction.
    installBridge();
    const { container } = render(<WarmingNotice />);

    expect(container.textContent).toBe('');
  });

  it('renders nothing once the backlog is clear', () => {
    const h = installBridge();
    const { container } = render(<WarmingNotice />);

    h.emit(status(0, null));

    // Transient state, not a permanent status widget — the nav rail carries the
    // always-on version.
    expect(container.textContent).toBe('');
  });

  it('states the count with no promise attached while the ETA is unmeasured', () => {
    const h = installBridge();
    render(<WarmingNotice />);

    h.emit(status(420, null));

    expect(screen.getByText(/Still reading 420 messages from your sources/)).toBeTruthy();
    // The load-bearing assertion: no invented duration on the first run.
    expect(screen.queryByText(/to go/)).toBeNull();
  });

  it('appends the estimate once one has been earned', () => {
    const h = installBridge();
    render(<WarmingNotice />);

    h.emit(status(420, 90 * 60_000));

    // `~` is the only hedge — no "about ~1.5 h".
    expect(screen.getByText(/— ~1\.5 h to go/)).toBeTruthy();
    expect(screen.queryByText(/about ~/)).toBeNull();
  });

  it('explains that newest messages are read first', () => {
    // The reason the wait is tolerable: recent conversations land before old
    // mail. Saying so is what makes newest-first extraction visible to the user.
    const h = installBridge();
    render(<WarmingNotice />);

    h.emit(status(5, null));

    expect(screen.getByText(/Newest messages are read first/)).toBeTruthy();
    expect(screen.getByText(/nothing is lost while you wait/)).toBeTruthy();
  });

  it('singularises one message', () => {
    const h = installBridge();
    render(<WarmingNotice />);

    h.emit(status(1, null));

    expect(screen.getByText(/Still reading 1 message from your sources/)).toBeTruthy();
  });

  it('disappears again when a later status clears the backlog', () => {
    const h = installBridge();
    const { container } = render(<WarmingNotice />);

    h.emit(status(12, null));
    expect(container.textContent).not.toBe('');

    h.emit(status(0, null));
    expect(container.textContent).toBe('');
  });

  it('subscribes once, not once per status', () => {
    const h = installBridge();
    render(<WarmingNotice />);

    h.emit(status(3, null));
    h.emit(status(2, null));

    // A `useEffect` that re-subscribes on every render stacks listeners on the
    // main process for the whole session.
    expect(h.subscriptions()).toBe(1);
  });

  it('renders nothing outside the desktop shell', () => {
    // No bridge at all — the static export is also served in a plain browser
    // during development, and `hasBridge()` is what keeps that from throwing.
    render(<WarmingNotice />);

    expect(screen.queryByText(/Still reading/)).toBeNull();
  });
});
