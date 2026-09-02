/**
 * `model:get` / `model:setChat` — `apps/desktop/src/ipc/modelSettings.ts`.
 *
 * `modelSettings.ts` imports `ipcMain` at module scope, which does not exist
 * outside a running Electron process — same `vi.mock('electron', …)` +
 * dynamic-import pattern as every other `ipc.*.test.ts` in this directory.
 *
 * `getModelInfo` calls `@cr/ai`'s `listInstalledModels`, which goes through
 * `guardedFetchUrl` — `global.fetch` is stubbed for the cases that reach it,
 * the same way `preflight.test.ts` scripts Ollama's `/api/tags`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const {
  CHAT_MODEL_SETTING_KEY,
  MODEL_GET_CHANNEL,
  MODEL_SET_CHAT_CHANNEL,
  getModelInfo,
  parseSetChatArg,
  registerModelSettingsHandlers,
  setChatModel,
} = await import('../src/ipc/modelSettings.js');

type Module = typeof import('../src/ipc/modelSettings.js');
type Deps = Parameters<Module['getModelInfo']>[0];

const BASE = 'http://localhost:11434';

/** In-memory stand-in for `AppSettingsRepo`. */
function makeStore(initial: Record<string, string> = {}): Deps['settings'] {
  const values = new Map(Object.entries(initial));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    settings: makeStore(),
    defaultChatModel: 'qwen2.5:14b',
    ollamaBaseUrl: BASE,
    ...overrides,
  };
}

const tagsOk = (models: Array<{ name?: string; model?: string }>) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ models }) }));

beforeEach(() => {
  handle.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('model:get', () => {
  it('reports the config default when nothing has been overridden', async () => {
    vi.stubGlobal('fetch', tagsOk([{ name: 'qwen2.5:14b' }]));

    const info = await getModelInfo(makeDeps());

    expect(info).toEqual({
      chat: 'qwen2.5:14b',
      defaultChat: 'qwen2.5:14b',
      available: ['qwen2.5:14b'],
    });
  });

  it('reports the persisted override instead of the config default', async () => {
    vi.stubGlobal('fetch', tagsOk([{ name: 'qwen2.5:14b' }, { name: 'qwen2.5:3b' }]));
    const settings = makeStore({ [CHAT_MODEL_SETTING_KEY]: 'qwen2.5:3b' });

    const info = await getModelInfo(makeDeps({ settings }));

    expect(info.chat).toBe('qwen2.5:3b');
    expect(info.defaultChat).toBe('qwen2.5:14b');
    expect(info.available).toEqual(['qwen2.5:14b', 'qwen2.5:3b']);
  });

  it('degrades to an empty available list when Ollama is unreachable, without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const info = await getModelInfo(makeDeps());

    expect(info.available).toEqual([]);
    expect(info.chat).toBe('qwen2.5:14b');
  });
});

describe('model:setChat', () => {
  it('persists the given model and reports ok', () => {
    const settings = makeStore();

    expect(setChatModel({ model: 'qwen2.5:3b' }, makeDeps({ settings }))).toEqual({ ok: true });
    expect(settings.get(CHAT_MODEL_SETTING_KEY)).toBe('qwen2.5:3b');
  });

  it('rejects a missing, empty, or non-string model without writing anything', () => {
    const settings = makeStore();
    const deps = makeDeps({ settings });

    expect(setChatModel(null, deps)).toEqual({ ok: false, reason: 'invalid_model' });
    expect(setChatModel({}, deps)).toEqual({ ok: false, reason: 'invalid_model' });
    expect(setChatModel({ model: '' }, deps)).toEqual({ ok: false, reason: 'invalid_model' });
    expect(setChatModel({ model: 42 }, deps)).toEqual({ ok: false, reason: 'invalid_model' });
    expect(settings.get(CHAT_MODEL_SETTING_KEY)).toBeNull();
  });

  it('degrades a storage fault to a reported failure instead of throwing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: Deps['settings'] = {
      get: () => null,
      set: () => {
        throw new Error('database is locked');
      },
    };

    expect(setChatModel({ model: 'qwen2.5:3b' }, makeDeps({ settings: broken }))).toEqual({
      ok: false,
      reason: 'internal_error',
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('parses the exact shape the preload sends', () => {
    expect(parseSetChatArg({ model: 'qwen2.5:3b' })).toBe('qwen2.5:3b');
    expect(parseSetChatArg(null)).toBeNull();
    expect(parseSetChatArg({})).toBeNull();
  });
});

describe('registerModelSettingsHandlers', () => {
  it('registers both channels and routes them through to the store', async () => {
    vi.stubGlobal('fetch', tagsOk([{ name: 'qwen2.5:14b' }]));
    const settings = makeStore();
    registerModelSettingsHandlers(makeDeps({ settings }));

    expect(handle.mock.calls.map((call) => call[0] as string)).toEqual([
      MODEL_GET_CHANNEL,
      MODEL_SET_CHAT_CHANNEL,
    ]);

    const getHandler = handle.mock.calls.find((c) => c[0] === MODEL_GET_CHANNEL)?.[1] as (
      event: unknown,
    ) => Promise<unknown>;
    await expect(getHandler({})).resolves.toEqual({
      chat: 'qwen2.5:14b',
      defaultChat: 'qwen2.5:14b',
      available: ['qwen2.5:14b'],
    });

    const setHandler = handle.mock.calls.find((c) => c[0] === MODEL_SET_CHAT_CHANNEL)?.[1] as (
      event: unknown,
      arg: unknown,
    ) => unknown;
    expect(setHandler({}, { model: 'qwen2.5:3b' })).toEqual({ ok: true });
    expect(settings.get(CHAT_MODEL_SETTING_KEY)).toBe('qwen2.5:3b');
  });
});
