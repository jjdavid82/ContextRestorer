import { describe, it, expect } from 'vitest';
import { startLoopbackServer } from '../src/oauth/loopback.js';

const STATE = 'expected-state-value';

const callback = async (port: number, query: string): Promise<number> => {
  const res = await fetch(`http://127.0.0.1:${port}/callback?${query}`);
  await res.text();
  return res.status;
};

describe('loopback OAuth catcher', () => {
  it('binds to 127.0.0.1 on an ephemeral port, never 0.0.0.0 or ::', async () => {
    const { host, port, result } = await startLoopbackServer(STATE, 50);

    // `host` is taken straight from server.address().address.
    expect(host).toBe('127.0.0.1');
    expect(host).not.toBe('0.0.0.0');
    expect(host).not.toBe('::');
    expect(port).toBeGreaterThan(0);

    await expect(result).rejects.toThrow(/timed out/i);
  });

  it('resolves with the code and state from a matching callback, answering 200', async () => {
    const { port, result } = await startLoopbackServer(STATE, 2000);
    const status = await callback(port, `code=abc&state=${encodeURIComponent(STATE)}`);

    expect(status).toBe(200);
    await expect(result).resolves.toEqual({ code: 'abc', state: STATE });
  });

  it('rejects on state mismatch and stays closed to a later legitimate callback', async () => {
    const { port, result } = await startLoopbackServer(STATE, 2000);
    const rejection = expect(result).rejects.toThrow(/state mismatch/i);

    await callback(port, 'code=abc&state=attacker-state');
    await rejection;

    // Server is gone: a follow-up "good" callback must not connect, let alone resolve.
    await expect(
      callback(port, `code=second&state=${encodeURIComponent(STATE)}`),
    ).rejects.toThrow();
    await expect(result).rejects.toThrow(/state mismatch/i);
  });

  it('rejects with a timeout error when no callback arrives', async () => {
    const { result } = await startLoopbackServer(STATE, 50);

    await expect(result).rejects.toThrow(/timed out/i);
  }, 5000);

  it('releases the port so a second server can bind afterwards', async () => {
    const first = await startLoopbackServer(STATE, 2000);
    await callback(first.port, `code=abc&state=${encodeURIComponent(STATE)}`);
    await expect(first.result).resolves.toEqual({ code: 'abc', state: STATE });

    const second = await startLoopbackServer(STATE, 50);
    expect(second.port).toBeGreaterThan(0);
    await expect(second.result).rejects.toThrow(/timed out/i);

    const third = await startLoopbackServer(STATE, 2000);
    expect(third.port).toBeGreaterThan(0);
    await callback(third.port, `code=xyz&state=${encodeURIComponent(STATE)}`);
    await expect(third.result).resolves.toEqual({ code: 'xyz', state: STATE });
  }, 10000);

  it('ignores stray requests that carry no OAuth params', async () => {
    const { port, result } = await startLoopbackServer(STATE, 2000);

    const probe = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    await probe.text();
    expect(probe.status).toBe(404);

    // The single shot was not consumed by the probe.
    await callback(port, `code=abc&state=${encodeURIComponent(STATE)}`);
    await expect(result).resolves.toEqual({ code: 'abc', state: STATE });
  });
});
