/**
 * `projects:remove` — `apps/desktop/src/ipc/projects.ts`.
 *
 * `projects.ts` imports `ipcMain` at module scope, which does not exist outside
 * a running Electron process — same `vi.mock('electron', …)` + dynamic-import
 * pattern as every other `ipc.*.test.ts` here.
 *
 * Only the remove path is covered: `suggest` / `declare` / `list` /
 * `onboarding:status` reach into `@cr/ingest` and `@cr/ai` and are exercised
 * end-to-end elsewhere. The remove handler touches nothing but
 * `deps.graph.removeProject` and the `onProjectsChanged` hook.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const { registerProjectsHandlers, parseRemoveProjectArg } = await import('../src/ipc/projects.js');

type Module = typeof import('../src/ipc/projects.js');
type Deps = Parameters<Module['registerProjectsHandlers']>[0];

/** Minimal deps: only `graph.removeProject` and `onProjectsChanged` are read by this handler. */
function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    events: {} as Deps['events'],
    graph: { removeProject: vi.fn(() => true) } as unknown as Deps['graph'],
    config: { onboarding: { minDeclaredProjects: 0 } } as Deps['config'],
    vault: {} as Deps['vault'],
    ...overrides,
  };
}

/** Pull the registered `projects:remove` handler out of the `ipcMain.handle` calls. */
function removeHandler(): (event: unknown, arg: unknown) => Promise<{ ok: boolean; reason?: string }> {
  const call = handle.mock.calls.find((c) => c[0] === 'projects:remove');
  if (call === undefined) throw new Error('projects:remove was not registered');
  return call[1] as ReturnType<typeof removeHandler>;
}

beforeEach(() => {
  handle.mockReset();
});

describe('parseRemoveProjectArg', () => {
  it('accepts the exact shape the preload sends, trims, and rejects everything else', () => {
    expect(parseRemoveProjectArg({ projectId: 'p1' })).toBe('p1');
    expect(parseRemoveProjectArg({ projectId: '  p1  ' })).toBe('p1');
    expect(parseRemoveProjectArg({ projectId: '' })).toBeNull();
    expect(parseRemoveProjectArg({ projectId: 42 })).toBeNull();
    expect(parseRemoveProjectArg({})).toBeNull();
    expect(parseRemoveProjectArg(null)).toBeNull();
  });
});

describe('projects:remove', () => {
  it('removes the project and fires onProjectsChanged', async () => {
    const removeProject = vi.fn(() => true);
    const onProjectsChanged = vi.fn();
    registerProjectsHandlers(
      makeDeps({ graph: { removeProject } as unknown as Deps['graph'], onProjectsChanged }),
    );

    await expect(removeHandler()({}, { projectId: 'p1' })).resolves.toEqual({ ok: true });
    expect(removeProject).toHaveBeenCalledWith('p1');
    expect(onProjectsChanged).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed argument without touching the store', async () => {
    const removeProject = vi.fn(() => true);
    registerProjectsHandlers(makeDeps({ graph: { removeProject } as unknown as Deps['graph'] }));

    await expect(removeHandler()({}, { projectId: '' })).resolves.toEqual({
      ok: false,
      reason: 'invalid_project_id',
    });
    expect(removeProject).not.toHaveBeenCalled();
  });

  it('reports not_found when nothing was deleted, and skips the hook', async () => {
    const onProjectsChanged = vi.fn();
    registerProjectsHandlers(
      makeDeps({
        graph: { removeProject: vi.fn(() => false) } as unknown as Deps['graph'],
        onProjectsChanged,
      }),
    );

    await expect(removeHandler()({}, { projectId: 'gone' })).resolves.toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(onProjectsChanged).not.toHaveBeenCalled();
  });

  it('degrades a throwing store to a reported failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerProjectsHandlers(
      makeDeps({
        graph: {
          removeProject: vi.fn(() => {
            throw new Error('database is locked');
          }),
        } as unknown as Deps['graph'],
      }),
    );

    await expect(removeHandler()({}, { projectId: 'p1' })).resolves.toEqual({
      ok: false,
      reason: 'internal_error',
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does not turn a throwing onProjectsChanged hook into a failed removal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerProjectsHandlers(
      makeDeps({
        graph: { removeProject: vi.fn(() => true) } as unknown as Deps['graph'],
        onProjectsChanged: () => {
          throw new Error('relink blew up');
        },
      }),
    );

    await expect(removeHandler()({}, { projectId: 'p1' })).resolves.toEqual({ ok: true });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
