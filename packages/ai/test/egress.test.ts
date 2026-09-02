/**
 * Task 4.6 — egress allowlist enforcement: the REDIRECT half of SEC-6.
 *
 * Scope boundary with `ollama.egress.test.ts` (Phase 0), deliberately kept
 * separate rather than merged: that file owns the *request-time* gate (a
 * non-local base URL cannot construct a client, and each method fetches only a
 * validated loopback URL). This file owns the *response-time* gate — a `3xx`
 * from the loopback endpoint must not be able to walk the client off-machine.
 * The two are different failure modes with different mocks, and a reader
 * chasing "can a 302 exfiltrate a prompt?" should not have to read the
 * happy-path envelope-parsing tests to find out.
 *
 * The load-bearing assertion in every case below is the same: the mocked
 * `fetch` was NEVER called with the external URL. "It threw" is not by itself
 * proof of containment — it could have thrown *after* the request went out.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createOllamaClient } from '../src/ollama.js';

const LOCAL = 'http://localhost:11434';
const EVIL = 'http://evil.example.com/api/generate';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A `fetch` double that answers the first call with a redirect to `location`. */
function redirectingFetch(location: string, status = 302) {
  return vi.fn(async (_url: string) => ({
    ok: false,
    status,
    headers: new Headers({ location }),
    text: async () => '',
    json: async () => ({}),
  }));
}

/** Every URL the double was asked for, in call order. */
function requestedUrls(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

/** Drives `generateStream` to completion, since it is lazy until iterated. */
async function drain(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('SEC-6 redirect defense: an external Location is never followed', () => {
  it('generateJson refuses a 302 pointing off-machine, and never requests it', async () => {
    const fetchMock = redirectingFetch(EVIL);
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'e');
    await expect(
      client.generateJson({ prompt: 'secret prompt', system: 's', schemaName: 'Demo' }),
    ).rejects.toThrow(/SEC-6/);

    // The only request issued was the loopback one.
    expect(requestedUrls(fetchMock)).toEqual([`${LOCAL}/api/generate`]);
    expect(fetchMock).not.toHaveBeenCalledWith(EVIL, expect.anything());
    for (const url of requestedUrls(fetchMock)) {
      expect(url).not.toContain('evil.example.com');
    }
  });

  it('generateStream refuses a 302 pointing off-machine, and never requests it', async () => {
    const fetchMock = redirectingFetch(EVIL);
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'e');
    await expect(drain(client.generateStream({ prompt: 'p', system: 's' }))).rejects.toThrow(
      /SEC-6/,
    );

    expect(requestedUrls(fetchMock)).toEqual([`${LOCAL}/api/generate`]);
  });

  it('embed refuses a 302 pointing off-machine, and never requests it', async () => {
    const fetchMock = redirectingFetch(EVIL);
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'nomic-embed-text');
    await expect(client.embed(['confidential text'])).rejects.toThrow(/SEC-6/);

    // One request, loopback, and no second text was attempted either.
    expect(requestedUrls(fetchMock)).toEqual([`${LOCAL}/api/embeddings`]);
  });

  it('refuses every redirect status, not just 302', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const fetchMock = redirectingFetch(EVIL, status);
      vi.stubGlobal('fetch', fetchMock);

      const client = createOllamaClient(LOCAL, 'm', 'e');
      await expect(
        client.generateJson({ prompt: 'p', system: 's', schemaName: 'Demo' }),
      ).rejects.toThrow(/SEC-6/);
      expect(requestedUrls(fetchMock)).toEqual([`${LOCAL}/api/generate`]);
    }
  });

  it('refuses a protocol-relative Location, which resolves to a remote host', async () => {
    // `//evil.example.com/x` LOOKS relative; `new URL` resolves it to a remote
    // origin, which is exactly why the guard validates the resolved target.
    const fetchMock = redirectingFetch('//evil.example.com/api/generate');
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'e');
    await expect(
      client.generateJson({ prompt: 'p', system: 's', schemaName: 'Demo' }),
    ).rejects.toThrow(/SEC-6/);
    expect(requestedUrls(fetchMock)).toEqual([`${LOCAL}/api/generate`]);
  });

  it('refuses an https redirect to a hosted inference API', async () => {
    const fetchMock = redirectingFetch('https://api.openai.com/v1/chat/completions');
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'e');
    await expect(
      client.generateJson({ prompt: 'p', system: 's', schemaName: 'Demo' }),
    ).rejects.toThrow(/SEC-6/);
    expect(requestedUrls(fetchMock)).toEqual([`${LOCAL}/api/generate`]);
  });
});

describe('SEC-6 redirect defense: transport never follows on our behalf', () => {
  it("issues every request with redirect: 'manual'", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ response: '{"a":1}' }),
      json: async () => ({ embedding: [1] }),
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          releaseLock: () => undefined,
        }),
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'e');
    await client.generateJson({ prompt: 'p', system: 's', schemaName: 'Demo' });
    await drain(client.generateStream({ prompt: 'p', system: 's' }));
    await client.embed(['t']);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(call[1].redirect).toBe('manual');
    }
  });

  it('preserves an AbortSignal alongside the manual-redirect option', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          releaseLock: () => undefined,
        }),
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const client = createOllamaClient(LOCAL, 'm', 'e');
    await drain(client.generateStream({ prompt: 'p', system: 's', signal: controller.signal }));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
    expect(init.redirect).toBe('manual');
  });
});

describe('SEC-6 redirect defense: loopback redirects still work', () => {
  it('follows a redirect that stays on loopback and returns the final response', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `${LOCAL}/api/generate`) {
        return {
          ok: false,
          status: 307,
          headers: new Headers({ location: 'http://127.0.0.1:11434/api/generate' }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({ response: '{"a":1}' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'e');
    const result = await client.generateJson<{ a: number }>({
      prompt: 'p',
      system: 's',
      schemaName: 'Demo',
    });

    expect(result.value).toEqual({ a: 1 });
    expect(requestedUrls(fetchMock)).toEqual([
      `${LOCAL}/api/generate`,
      'http://127.0.0.1:11434/api/generate',
    ]);
  });

  it('caps a loopback redirect loop instead of spinning forever', async () => {
    // Every hop points at the other loopback spelling, so the guard passes and
    // only the hop cap can stop it.
    const fetchMock = vi.fn(async (url: string) => ({
      ok: false,
      status: 302,
      headers: new Headers({
        location: url.includes('127.0.0.1')
          ? `${LOCAL}/api/generate`
          : 'http://127.0.0.1:11434/api/generate',
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'e');
    await expect(
      client.generateJson({ prompt: 'p', system: 's', schemaName: 'Demo' }),
    ).rejects.toThrow(/too many redirects/);
    // Bounded: 4 requests (hops 0..3), then refusal.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('fails loudly on a redirect with no Location header', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 302,
      headers: new Headers(),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'e');
    await expect(
      client.generateJson({ prompt: 'p', system: 's', schemaName: 'Demo' }),
    ).rejects.toThrow(/carried no Location header/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
