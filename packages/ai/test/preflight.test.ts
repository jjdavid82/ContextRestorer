import { describe, it, expect, afterEach, vi } from 'vitest';
import { listInstalledModels, preflight } from '../src/preflight.js';

const BASE = 'http://localhost:11434';
const CHAT = 'qwen2.5:14b';
const EMBED = 'nomic-embed-text';

/** Builds a minimal ok Response-like stub whose `json()` yields `body`. */
const tagsOk = (models: Array<{ name?: string; model?: string }>) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ models }) }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('preflight', () => {
  it('reports unreachable when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const result = await preflight(BASE, CHAT, EMBED);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    if (!result.ok && result.reason === 'unreachable') {
      expect(result.message).toContain(BASE);
    }
  });

  it('reports model_missing when the chat model is absent', async () => {
    vi.stubGlobal('fetch', tagsOk([{ name: EMBED, model: EMBED }]));

    const result = await preflight(BASE, CHAT, EMBED);

    expect(result).toEqual({
      ok: false,
      reason: 'model_missing',
      remedy: `ollama pull ${CHAT}`,
    });
  });

  it('reports embed_model_missing when only the chat model is present', async () => {
    vi.stubGlobal('fetch', tagsOk([{ name: CHAT, model: CHAT }]));

    const result = await preflight(BASE, CHAT, EMBED);

    expect(result).toEqual({
      ok: false,
      reason: 'embed_model_missing',
      remedy: `ollama pull ${EMBED}`,
    });
  });

  it('returns ok when both models are present', async () => {
    const fetchMock = tagsOk([
      { name: CHAT, model: CHAT },
      { name: EMBED, model: EMBED },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await preflight(BASE, CHAT, EMBED);

    expect(result).toEqual({ ok: true });
    // Task 4.6: routed through guardedFetchUrl, so the request now carries
    // `redirect: 'manual'` (the SEC-6 redirect guard) rather than a bare fetch.
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/tags`, { redirect: 'manual' });
  });

  it('does not fuzzy-match tag suffixes', async () => {
    // A bare `qwen2.5` must not satisfy a configured `qwen2.5:14b`.
    vi.stubGlobal('fetch', tagsOk([{ name: 'qwen2.5', model: 'qwen2.5' }, { name: EMBED }]));

    const result = await preflight(BASE, CHAT, EMBED);

    expect(result).toMatchObject({ ok: false, reason: 'model_missing' });
  });

  it('matches an untagged config name against an installed :latest tag', async () => {
    // Real Ollama reports `nomic-embed-text:latest` for `ollama pull nomic-embed-text`.
    vi.stubGlobal(
      'fetch',
      tagsOk([
        { name: CHAT, model: CHAT },
        { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest' },
      ]),
    );

    await expect(preflight(BASE, CHAT, EMBED)).resolves.toEqual({ ok: true });
  });

  it('never throws on an unexpected error (malformed body)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      })),
    );

    // The assertion is that this resolves rather than rejects.
    const result = await preflight(BASE, CHAT, EMBED);

    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    await expect(preflight(BASE, CHAT, EMBED)).resolves.toBeDefined();
  });

  it('treats a non-2xx /api/tags response as unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    const result = await preflight(BASE, CHAT, EMBED);

    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});

describe('listInstalledModels', () => {
  it('returns every distinct model name, sorted', async () => {
    vi.stubGlobal(
      'fetch',
      tagsOk([{ name: 'qwen2.5:14b', model: 'qwen2.5:14b' }, { name: 'qwen2.5:3b' }]),
    );

    await expect(listInstalledModels(BASE)).resolves.toEqual(['qwen2.5:14b', 'qwen2.5:3b']);
  });

  it('de-duplicates when `name` and `model` agree', async () => {
    vi.stubGlobal('fetch', tagsOk([{ name: CHAT, model: CHAT }]));

    await expect(listInstalledModels(BASE)).resolves.toEqual([CHAT]);
  });

  it('degrades to an empty list rather than throwing when Ollama is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(listInstalledModels(BASE)).resolves.toEqual([]);
  });

  it('degrades to an empty list on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    await expect(listInstalledModels(BASE)).resolves.toEqual([]);
  });
});
