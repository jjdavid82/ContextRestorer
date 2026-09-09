/**
 * The preload bridge — `apps/desktop/src/preload.cts`.
 *
 * This file exists because nothing covered that module, and the gap cost a
 * shipped feature. `slack.setSelected` rebuilt each row as
 * `{ channelId, name }` and dropped `projectId`, so channel → project tagging
 * (A-2, the entire write path behind the ranker's largest non-obligation
 * weight) silently did nothing from the UI: the save reported success, the
 * channel selection persisted, and the tag never did. `belongs_to` edges stayed
 * at zero on a real install for as long as the feature had existed.
 *
 * Nothing could have caught it. The renderer compiles against
 * `apps/ui/types/bridge.d.ts` and the main process against `preload.cts`;
 * neither imports the other, so the two hand-synced declarations can disagree
 * for months and typecheck cleanly. The SHAPE CONTRACT comment at the top of
 * both files is a request, not an enforcement.
 *
 * So the tests here assert what actually reaches `ipcRenderer.invoke` — the
 * bytes on the wire — for the channels where the payload is more than a
 * pass-through. A field a caller sets and the bridge quietly discards is
 * indistinguishable, from the UI, from a backend that ignored it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async () => ({ ok: true }));
const exposeInMainWorld = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
}));

// The preload calls `contextBridge.exposeInMainWorld` at module scope, so
// importing it IS the setup: the bridge object arrives as that call's argument.
await import('../src/preload.cjs');

/** The object the preload handed to `contextBridge`. */
function bridge(): {
  slack: {
    setSelected(
      channels: Array<{ channelId: string; name: string; projectId?: string | null }>,
    ): Promise<unknown>;
  };
} {
  const call = exposeInMainWorld.mock.calls[0];
  return call?.[1] as ReturnType<typeof bridge>;
}

/** The payload of the most recent `invoke`. */
function lastPayload(): Record<string, unknown> {
  const call = invoke.mock.calls[invoke.mock.calls.length - 1] as unknown as [
    string,
    Record<string, unknown>,
  ];
  return call[1];
}

beforeEach(() => {
  invoke.mockClear();
});

describe('the bridge is exposed once, under the documented global', () => {
  it('registers `contextRestorer`', () => {
    expect(exposeInMainWorld.mock.calls[0]?.[0]).toBe('contextRestorer');
  });
});

describe('slack.setSelected — the tri-state projectId (A-2 regression)', () => {
  it('FORWARDS a project tag instead of dropping it', async () => {
    // The bug this file was written for. Before the fix this arrived as
    // `{ channelId, name }` and the handler read the absent key as "leave the
    // tag alone", so tagging a channel in Settings did nothing at all.
    await bridge().slack.setSelected([
      { channelId: 'C1', name: 'general', projectId: 'proj-1' },
    ]);

    expect(lastPayload()).toEqual({
      channels: [{ channelId: 'C1', name: 'general', projectId: 'proj-1' }],
    });
  });

  it('forwards an explicit null, which is how a tag is CLEARED', async () => {
    await bridge().slack.setSelected([{ channelId: 'C1', name: 'general', projectId: null }]);

    expect(lastPayload()).toEqual({
      channels: [{ channelId: 'C1', name: 'general', projectId: null }],
    });
  });

  it('omits the key entirely when the caller omits it', async () => {
    // The plain checkbox save. An explicit `undefined` would cross the bridge
    // as a PRESENT key and mean the opposite — wipe every tag.
    await bridge().slack.setSelected([{ channelId: 'C1', name: 'general' }]);

    const [row] = (lastPayload()['channels'] as Array<Record<string, unknown>>);
    expect(row).toEqual({ channelId: 'C1', name: 'general' });
    expect(Object.hasOwn(row ?? {}, 'projectId')).toBe(false);
  });

  it('rejects a malformed projectId rather than sending it on', () => {
    // Thrown SYNCHRONOUSLY, before any promise exists: the shape gate runs
    // ahead of `ipcRenderer.invoke`, so a bad payload never reaches the wire.
    expect(() =>
      bridge().slack.setSelected([
        { channelId: 'C1', name: 'general', projectId: 7 as unknown as string },
      ]),
    ).toThrow(/invalid channel selection/);

    expect(() =>
      bridge().slack.setSelected([{ channelId: 'C1', name: 'general', projectId: '' }]),
    ).toThrow(/invalid channel selection/);

    expect(invoke).not.toHaveBeenCalled();
  });

  it('still rejects a malformed channel id or name', () => {
    expect(() => bridge().slack.setSelected([{ channelId: '', name: 'general' }])).toThrow(
      /invalid channel selection/,
    );
    expect(() => bridge().slack.setSelected([{ channelId: 'C1', name: '' }])).toThrow(
      /invalid channel selection/,
    );
  });

  it('accepts an empty selection — that is how Slack is set to idle', async () => {
    await bridge().slack.setSelected([]);

    expect(lastPayload()).toEqual({ channels: [] });
  });
});
