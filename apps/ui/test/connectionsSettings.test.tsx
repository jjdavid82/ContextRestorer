import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ConnectionsSettings from '../app/settings/connections';
import type { ContextRestorerBridge, OkResult, OnboardingStatus, SourceId } from '../types/bridge';

/**
 * Settings → Connections panel (`app/settings/connections.tsx`).
 *
 * The panel reads `onboarding:status` for connection state and drives
 * `oauth:connect` / `oauth:revoke`, re-reading status after each. What is worth
 * pinning: the button label follows connection state, disconnect only shows when
 * connected, and the clipboard hint appears on a connect attempt.
 */

interface BridgeParts {
  status: () => Promise<OnboardingStatus>;
  connect?: (source: SourceId) => Promise<OkResult>;
  revoke?: (source: SourceId) => Promise<OkResult>;
}

function installBridge(parts: BridgeParts): void {
  const bridge = {
    onboarding: { status: parts.status },
    oauth: {
      connect: parts.connect ?? vi.fn(async () => ({ ok: true })),
      revoke: parts.revoke ?? vi.fn(async () => ({ ok: true })),
    },
  };
  window.contextRestorer = bridge as unknown as ContextRestorerBridge;
}

const status = (connected: SourceId[]): OnboardingStatus => ({
  sourcesConnected: connected,
  projectsDeclared: [],
  ollamaReady: true,
});

afterEach(() => {
  cleanup();
  // @ts-expect-error — the global is declared always-present; tests own it.
  delete window.contextRestorer;
});

describe('ConnectionsSettings', () => {
  it('labels each source by connection state and only offers Disconnect when connected', async () => {
    installBridge({ status: vi.fn(async () => status(['slack'])) });
    render(<ConnectionsSettings />);

    expect(await screen.findByText('connected')).toBeTruthy();
    expect(screen.getByText('not connected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    // One Disconnect (slack), none for gmail.
    expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(1);
  });

  it('connects the not-connected source and shows the clipboard hint, then re-reads status', async () => {
    const st = vi
      .fn<() => Promise<OnboardingStatus>>()
      .mockResolvedValueOnce(status([]))
      .mockResolvedValue(status(['gmail']));
    // Held open so the in-flight clipboard hint is observable before `finally`
    // clears it.
    let release!: (v: OkResult) => void;
    const connect = vi.fn(
      () =>
        new Promise<OkResult>((resolve) => {
          release = resolve;
        }),
    );
    installBridge({ status: st, connect });
    render(<ConnectionsSettings />);

    const gmailConnect = (await screen.findAllByRole('button', { name: 'Connect' }))[1]!;
    fireEvent.click(gmailConnect);

    await waitFor(() => expect(connect).toHaveBeenCalledWith('gmail'));
    expect(screen.getByText(/copied to your clipboard/i)).toBeTruthy();

    release({ ok: true });
    await waitFor(() => expect(st).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/copied to your clipboard/i)).toBeNull());
  });

  it('disconnects a connected source through oauth.revoke', async () => {
    const revoke = vi.fn(async () => ({ ok: true }));
    installBridge({ status: vi.fn(async () => status(['slack'])), revoke });
    render(<ConnectionsSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('slack'));
  });

  it('surfaces a rejected connect', async () => {
    installBridge({
      status: vi.fn(async () => status([])),
      connect: vi.fn(async () => ({ ok: false, reason: 'not_configured' })),
    });
    render(<ConnectionsSettings />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Connect' }))[0]!);
    expect(await screen.findByText(/not_configured/)).toBeTruthy();
  });
});
