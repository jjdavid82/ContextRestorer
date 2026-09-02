import { describe, it, expect, afterEach, vi } from 'vitest';
import { assertLocal, createOllamaClient } from '../src/ollama.js';

const LOCAL = 'http://localhost:11434';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Response stub for a non-streaming /api/generate call. */
const generateOk = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ response: '{"a":1}', prompt_eval_count: 11, eval_count: 22 }),
    json: async () => ({ embedding: [0.1, 0.2] }),
  }));

describe('SEC-6 egress guard', () => {
  it('throws synchronously for a non-local base URL, before any fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(() => createOllamaClient('http://evil.example.com', 'm', 'e')).toThrow(/SEC-6/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-local hosts via assertLocal', () => {
    expect(() => assertLocal('http://evil.example.com/api/generate')).toThrow(
      "SEC-6: outbound inference to 'evil.example.com' is forbidden; local only",
    );
    expect(() => assertLocal('https://api.openai.com/v1/chat')).toThrow(/SEC-6/);
    expect(() => assertLocal('http://10.0.0.5:11434')).toThrow(/SEC-6/);
    expect(() => assertLocal('not-a-url')).toThrow(/SEC-6/);
  });

  it('accepts loopback hosts via assertLocal', () => {
    expect(() => assertLocal('http://localhost:11434/api/tags')).not.toThrow();
    expect(() => assertLocal('http://127.0.0.1:11434/api/tags')).not.toThrow();
  });

  it('constructs successfully for loopback base URLs', () => {
    expect(() => createOllamaClient(LOCAL, 'm', 'e')).not.toThrow();
    expect(() => createOllamaClient('http://127.0.0.1:11434', 'm', 'e')).not.toThrow();
  });
});

describe('per-call re-validation', () => {
  it('generateJson fetches only a validated loopback URL', async () => {
    const fetchMock = generateOk();
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'qwen2.5:14b', 'nomic-embed-text');
    const result = await client.generateJson<{ a: number }>({
      prompt: 'p',
      system: 's',
      schemaName: 'Demo',
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${LOCAL}/api/generate`);
    expect(() => assertLocal(url)).not.toThrow();
    expect(result.value).toEqual({ a: 1 });
    expect(result.tokensIn).toBe(11);
    expect(result.tokensOut).toBe(22);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('generateJson returns value:null with raw text on invalid model JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ response: 'not json at all' }),
      })),
    );

    const client = createOllamaClient(LOCAL, 'm', 'e');
    const result = await client.generateJson({ prompt: 'p', system: 's', schemaName: 'Demo' });

    expect(result.value).toBeNull();
    expect(result.raw).toBe('not json at all');
    expect(result.tokensIn).toBeUndefined();
    expect(result.tokensOut).toBeUndefined();
  });

  it('embed fetches only a validated loopback URL, once per text, in order', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return { ok: true, status: 200, json: async () => ({ embedding: [call, call] }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'nomic-embed-text');
    const vectors = await client.embed(['first', 'second']);

    expect(vectors).toEqual([
      [1, 1],
      [2, 2],
    ]);
    for (const [url] of fetchMock.mock.calls as unknown as Array<[string]>) {
      expect(url).toBe(`${LOCAL}/api/embeddings`);
      expect(() => assertLocal(url)).not.toThrow();
    }
  });

  it('generateStream fetches only a validated loopback URL and yields chunks', async () => {
    const ndjson = [
      JSON.stringify({ response: 'Hello' }),
      JSON.stringify({ response: ' world' }),
      JSON.stringify({ response: '', done: true }),
    ].join('\n');

    const encoded = new TextEncoder().encode(ndjson);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () =>
              sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: encoded }),
            releaseLock: () => undefined,
          };
        },
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createOllamaClient(LOCAL, 'm', 'e');
    const chunks: string[] = [];
    for await (const chunk of client.generateStream({ prompt: 'p', system: 's' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['Hello', ' world']);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${LOCAL}/api/generate`);
    expect(() => assertLocal(url)).not.toThrow();
  });

  it('generateStream forwards an AbortSignal to fetch', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
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
    for await (const _ of client.generateStream({
      prompt: 'p',
      system: 's',
      signal: controller.signal,
    })) {
      // no chunks expected
    }

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});
