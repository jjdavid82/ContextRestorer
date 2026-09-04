/**
 * `slack:listAvailable` / `slack:getSelected` / `slack:setSelected` —
 * `apps/desktop/src/ipc/slackChannels.ts` (closes Task 1.7's gap).
 *
 * `slackChannels.ts` imports `ipcMain` at module scope, which does not exist
 * outside a running Electron process — same `vi.mock('electron', …)` +
 * dynamic-import pattern as `ipc.claim.test.ts`/`oauth.test.ts`.
 *
 * `listAvailableChannels` builds a real `SlackClient` from `@cr/ingest`
 * internally (there is no injection point for a test transport at this call
 * site — the token comes from the vault, not the caller), so `global.fetch`
 * is stubbed for the cases that reach it, the same way `SlackClient`'s own
 * tests script a transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const {
  getSelectedChannels,
  listAvailableChannels,
  parseSelection,
  setSelectedChannels,
} = await import('../src/ipc/slackChannels.js');

type Module = typeof import('../src/ipc/slackChannels.js');
type Deps = Parameters<Module['getSelectedChannels']>[0];

const CLOCK_NOW = 1_700_000_000_000;

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    vault: {
      load: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
    } as unknown as Deps['vault'],
    channels: {
      list: vi.fn(() => []),
      setSelected: vi.fn(),
    },
    clock: { now: () => CLOCK_NOW },
    ...overrides,
  };
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseSelection', () => {
  it('accepts a well-formed channel list', () => {
    expect(parseSelection({ channels: [{ channelId: 'C1', name: 'general' }] })).toEqual([
      { channelId: 'C1', name: 'general' },
    ]);
  });

  it('accepts an empty list — clearing the selection is a valid request', () => {
    expect(parseSelection({ channels: [] })).toEqual([]);
  });

  for (const bad of [
    undefined,
    null,
    {},
    { channels: 'nope' },
    { channels: [{ channelId: '', name: 'general' }] },
    { channels: [{ channelId: 'C1', name: '' }] },
    { channels: [{ channelId: 'C1' }] },
    { channels: [null] },
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parseSelection(bad)).toBeNull();
    });
  }
});

describe('getSelectedChannels', () => {
  it('returns the store contents', () => {
    const deps = makeDeps({
      channels: {
        list: vi.fn(() => [{ channelId: 'C1', name: 'general', addedAt: 1_000 }]),
        setSelected: vi.fn(),
      },
    });
    expect(getSelectedChannels(deps)).toEqual([{ channelId: 'C1', name: 'general', addedAt: 1_000 }]);
  });

  it('degrades a failed read to an empty list rather than throwing', () => {
    const deps = makeDeps({
      channels: {
        list: vi.fn(() => {
          throw new Error('database is locked');
        }),
        setSelected: vi.fn(),
      },
    });
    expect(getSelectedChannels(deps)).toEqual([]);
  });
});

describe('setSelectedChannels', () => {
  it('persists a valid selection with the injected clock', () => {
    const setSelected = vi.fn();
    const deps = makeDeps({ channels: { list: vi.fn(() => []), setSelected } });

    expect(setSelectedChannels({ channels: [{ channelId: 'C1', name: 'general' }] }, deps)).toEqual({
      ok: true,
    });
    expect(setSelected).toHaveBeenCalledWith([{ channelId: 'C1', name: 'general' }], CLOCK_NOW);
  });

  it('rejects a malformed argument without touching the store', () => {
    const setSelected = vi.fn();
    const deps = makeDeps({ channels: { list: vi.fn(() => []), setSelected } });

    expect(setSelectedChannels({ channels: [{ channelId: '' }] }, deps)).toEqual({
      ok: false,
      reason: 'invalid_selection',
    });
    expect(setSelected).not.toHaveBeenCalled();
  });

  it('degrades a store failure to an internal_error result rather than throwing', () => {
    const deps = makeDeps({
      channels: {
        list: vi.fn(() => []),
        setSelected: vi.fn(() => {
          throw new Error('database is locked');
        }),
      },
    });

    expect(setSelectedChannels({ channels: [{ channelId: 'C1', name: 'general' }] }, deps)).toEqual({
      ok: false,
      reason: 'internal_error',
    });
  });
});

describe('listAvailableChannels', () => {
  it('reports not_connected when Slack has never been connected — no fetch attempted', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const deps = makeDeps(); // vault.load resolves undefined by default

    await expect(listAvailableChannels(deps)).resolves.toEqual({
      ok: false,
      reason: 'not_connected',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('makes a live conversations.list call and maps the result when connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          channels: [{ id: 'C1', name: 'general', is_member: true }],
        }),
      ),
    );
    const deps = makeDeps({
      vault: {
        load: vi.fn(async () => ({
          accessToken: 'xoxp-token',
          refreshToken: '',
          expiresAt: CLOCK_NOW + 1_000,
          scope: 'channels:history,channels:read,im:history,users:read',
        })),
        store: vi.fn(async () => undefined),
        revoke: vi.fn(async () => undefined),
      } as unknown as Deps['vault'],
    });

    await expect(listAvailableChannels(deps)).resolves.toEqual({
      ok: true,
      channels: [{ id: 'C1', name: 'general', isMember: true }],
    });
  });

  it('degrades a thrown Slack API error to an internal_error result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, error: 'invalid_auth' })),
    );
    const deps = makeDeps({
      vault: {
        load: vi.fn(async () => ({
          accessToken: 'xoxp-revoked',
          refreshToken: '',
          expiresAt: CLOCK_NOW + 1_000,
          scope: 'channels:history,channels:read,im:history,users:read',
        })),
        store: vi.fn(async () => undefined),
        revoke: vi.fn(async () => undefined),
      } as unknown as Deps['vault'],
    });

    await expect(listAvailableChannels(deps)).resolves.toEqual({
      ok: false,
      reason: 'internal_error',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* A-2 — project tagging and the relink hook                                  */
/* -------------------------------------------------------------------------- */

describe('parseSelection project tags (A-2)', () => {
  it('omits projectId entirely when the payload does not carry one', () => {
    const parsed = parseSelection({ channels: [{ channelId: 'C1', name: 'general' }] });

    // Absent must stay ABSENT rather than becoming `null`: the repo reads the
    // difference as "leave the tag alone" vs "clear it", and the plain
    // checkbox save sends no tag at all.
    expect(parsed).toEqual([{ channelId: 'C1', name: 'general' }]);
    expect(parsed?.[0] && 'projectId' in parsed[0]).toBe(false);
  });

  it('accepts an explicit project id and an explicit null', () => {
    expect(
      parseSelection({
        channels: [
          { channelId: 'C1', name: 'general', projectId: 'proj-1' },
          { channelId: 'C2', name: 'random', projectId: null },
        ],
      }),
    ).toEqual([
      { channelId: 'C1', name: 'general', projectId: 'proj-1' },
      { channelId: 'C2', name: 'random', projectId: null },
    ]);
  });

  it('rejects a malformed projectId', () => {
    for (const projectId of [42, '', {}, []]) {
      expect(
        parseSelection({ channels: [{ channelId: 'C1', name: 'general', projectId }] }),
      ).toBeNull();
    }
  });
});

describe('setSelectedChannels relinks projects (A-2)', () => {
  it('rebuilds links from the freshly saved selection', () => {
    const saved = [{ channelId: 'C1', name: 'general', addedAt: 1_000, projectId: 'proj-1' }];
    const relinkProjects = vi.fn();
    const deps = makeDeps({
      channels: { list: vi.fn(() => saved), setSelected: vi.fn() },
      relinkProjects,
    });

    const result = setSelectedChannels(
      { channels: [{ channelId: 'C1', name: 'general', projectId: 'proj-1' }] },
      deps,
    );

    expect(result).toEqual({ ok: true });
    // Handed what the STORE now holds, not the request body: the repo's
    // tri-state merge means the two can differ, and the linker must act on the
    // persisted truth.
    expect(relinkProjects).toHaveBeenCalledWith(saved);
  });

  it('still reports success when the relink throws', () => {
    const relinkProjects = vi.fn(() => {
      throw new Error('graph is busy');
    });
    const deps = makeDeps({ relinkProjects });

    // The selection IS saved at this point. Reporting failure would tell the
    // user to re-save something that already persisted, and the next save (or
    // app start) rebuilds the links anyway — the rebuild is idempotent.
    expect(setSelectedChannels({ channels: [] }, deps)).toEqual({ ok: true });
    expect(relinkProjects).toHaveBeenCalled();
  });

  it('does not relink when the save itself failed', () => {
    const relinkProjects = vi.fn();
    const deps = makeDeps({
      channels: {
        list: vi.fn(() => []),
        setSelected: vi.fn(() => {
          throw new Error('disk full');
        }),
      },
      relinkProjects,
    });

    expect(setSelectedChannels({ channels: [] }, deps)).toEqual({
      ok: false,
      reason: 'internal_error',
    });
    expect(relinkProjects).not.toHaveBeenCalled();
  });

  it('saves normally with no linker wired', () => {
    expect(setSelectedChannels({ channels: [] }, makeDeps())).toEqual({ ok: true });
  });
});
