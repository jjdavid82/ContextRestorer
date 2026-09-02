import { describe, expect, it, vi } from 'vitest';
import type { SourceHealth as PollerSourceHealth } from '@cr/ingest';

// `ipc/health.ts` only imports `electron` for types, but the module graph is
// mocked defensively for the same reason as `tray.test.ts`.
vi.mock('electron', () => ({}));

const { toHealthPayload } = await import('../src/ipc/health.js');

const entry = (
  status: PollerSourceHealth['status'],
  lagMs: number | null = null,
): PollerSourceHealth => ({ status, lastSyncAt: null, lagMs, newEventCount: 0 });

describe('toHealthPayload', () => {
  it('always emits both sources, in a stable order', () => {
    const payload = toHealthPayload({ slack: entry('ok'), gmail: entry('ok') });
    expect(payload.map((p) => p.source)).toEqual(['slack', 'gmail']);
  });

  it('keeps rate limiting distinct from a generic degradation (R-5)', () => {
    const payload = toHealthPayload({ slack: entry('rate_limited'), gmail: entry('backoff') });
    expect(payload[0]?.status).toBe('rate-limited');
    expect(payload[1]?.status).toBe('degraded');
  });

  it('maps both "no usable data" states onto disconnected', () => {
    const payload = toHealthPayload({ slack: entry('auth_error'), gmail: entry('never_synced') });
    expect(payload[0]?.status).toBe('disconnected');
    expect(payload[1]?.status).toBe('disconnected');
  });

  it('passes lag through verbatim, including null', () => {
    const payload = toHealthPayload({ slack: entry('ok', 90_000), gmail: entry('ok') });
    expect(payload[0]?.lagMs).toBe(90_000);
    expect(payload[1]?.lagMs).toBeNull();
  });

  it('omits retryAfter, which the poller does not expose', () => {
    const payload = toHealthPayload({ slack: entry('rate_limited'), gmail: entry('ok') });
    expect(payload[0]).not.toHaveProperty('retryAfter');
  });
});
