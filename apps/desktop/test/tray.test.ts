import { describe, expect, it, vi } from 'vitest';

// `tray.ts` imports `electron` at module scope. Outside an Electron process the
// `electron` package resolves to a CJS shim that default-exports the path to the
// binary, so the named imports would fail. `deriveTrayStatus` touches none of them.
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  Tray: vi.fn(),
  nativeImage: { createFromBitmap: vi.fn() },
}));

const { deriveTrayStatus } = await import('../src/tray.js');

type Health = Parameters<typeof deriveTrayStatus>[0][number];

const health = (source: Health['source'], status: Health['status']): Health => ({
  source,
  status,
  lagMs: null,
});

describe('deriveTrayStatus', () => {
  it('reports ok only when every source is ok', () => {
    expect(deriveTrayStatus([health('slack', 'ok'), health('gmail', 'ok')], false)).toBe('ok');
  });

  it('reports syncing before the first health push arrives', () => {
    // Deliberately not `ok`: an empty array means "unknown", not "healthy".
    expect(deriveTrayStatus([], false)).toBe('syncing');
  });

  it('reports auth needed when any source is disconnected', () => {
    expect(deriveTrayStatus([health('slack', 'disconnected'), health('gmail', 'ok')], false)).toBe(
      'auth needed',
    );
  });

  it('reports backoff for a degraded source', () => {
    expect(deriveTrayStatus([health('slack', 'ok'), health('gmail', 'degraded')], false)).toBe(
      'backoff',
    );
  });

  it('reports backoff for a rate-limited source', () => {
    expect(deriveTrayStatus([health('slack', 'rate-limited')], false)).toBe('backoff');
  });

  it('ranks a disconnected source above a rate-limited one', () => {
    // Only `disconnected` is user-actionable; a throttle resolves itself, so the
    // single tray line must be spent on the former.
    expect(
      deriveTrayStatus([health('slack', 'rate-limited'), health('gmail', 'disconnected')], false),
    ).toBe('auth needed');
  });

  it('reports paused regardless of any source state', () => {
    expect(deriveTrayStatus([health('slack', 'disconnected')], true)).toBe('paused');
    expect(deriveTrayStatus([health('slack', 'ok')], true)).toBe('paused');
  });
});
