/**
 * Per-claim project LABEL handlers (migration 010) —
 * `claim:setProject` / `claim:projects` in `apps/desktop/src/ipc/claim.ts`.
 *
 * Kept in its own file rather than folded into `ipc.claim.test.ts`: that file
 * is about provenance resolution over a real `GraphRepo`/`EventsRepo`, and
 * these handlers touch neither. What they DO need proving is the wire
 * narrowing, the not-wired guard, and the degradation contract — all of which a
 * hand-rolled store exercises better than a database would, since the storage
 * itself is already covered by `packages/store`'s repo test.
 *
 * `claim.ts` imports `ipcMain` at module scope, which does not exist outside a
 * running Electron process — same `vi.mock('electron', …)` + dynamic-import
 * pattern as the sibling IPC tests.
 *
 * THE KEY IS AN ARTIFACT ID, as everywhere else on this channel: the renderer
 * has no `briefing_claims.claim_id`, so `claimId` on the wire is
 * `citation.artifactId`. See `claim.ts`'s header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const {
  PROJECTS_CHANNEL,
  SET_PROJECT_CHANNEL,
  listClaimProjects,
  parseClaimProjectsArg,
  parseSetProjectArg,
  registerClaimHandlers,
  setClaimProject,
} = await import('../src/ipc/claim.js');

type ClaimModule = typeof import('../src/ipc/claim.js');
type Deps = Parameters<ClaimModule['setClaimProject']>[1];

const CLOCK_NOW = 1_700_000_000_000;
const BRIEFING_ID = 'briefing-1';

/** An in-memory stand-in for `ClaimProjectsRepo`, satisfying `ClaimProjectStore`. */
function makeStore(seed: ReadonlyArray<{ artifactId: string; projectId: string }> = []) {
  const rows = new Map(seed.map((row) => [row.artifactId, row.projectId]));
  return {
    rows,
    listForBriefing: vi.fn(() =>
      [...rows].map(([artifactId, projectId]) => ({ artifactId, projectId })),
    ),
    setProject: vi.fn((_briefingId: string, artifactId: string, projectId: string | null) => {
      if (projectId === null) rows.delete(artifactId);
      else rows.set(artifactId, projectId);
    }),
  };
}

/** Deps with labelling wired. `artifacts`/`events` are unreachable from these handlers. */
function makeDeps(store = makeStore()): Deps & { labels: ReturnType<typeof makeStore> } {
  return {
    artifacts: {
      getArtifact: vi.fn(() => undefined),
      getPerson: vi.fn(() => undefined),
    },
    events: { listByThread: vi.fn(() => []) },
    labels: store,
    clock: { now: () => CLOCK_NOW },
  } as unknown as Deps & { labels: ReturnType<typeof makeStore> };
}

beforeEach(() => {
  handle.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseSetProjectArg', () => {
  it('accepts a well-formed tag', () => {
    expect(
      parseSetProjectArg({ briefingId: 'b1', claimId: 'a1', projectId: 'p1' }),
    ).toEqual({ briefingId: 'b1', claimId: 'a1', projectId: 'p1' });
  });

  it('accepts an explicit null as "clear this label"', () => {
    expect(
      parseSetProjectArg({ briefingId: 'b1', claimId: 'a1', projectId: null }),
    ).toEqual({ briefingId: 'b1', claimId: 'a1', projectId: null });
  });

  for (const bad of [
    undefined,
    null,
    {},
    'nope',
    { briefingId: 'b1', claimId: 'a1' },
    { briefingId: '', claimId: 'a1', projectId: 'p1' },
    { briefingId: 'b1', claimId: '', projectId: 'p1' },
    { briefingId: 'b1', claimId: 'a1', projectId: '' },
    { briefingId: 'b1', claimId: 'a1', projectId: 42 },
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(parseSetProjectArg(bad)).toBeNull();
    });
  }

  it('rejects a MISSING projectId rather than reading it as a clear', () => {
    // A dropdown that failed to send its value must not read as the user
    // choosing "No project" — that would silently erase a label.
    expect(parseSetProjectArg({ briefingId: 'b1', claimId: 'a1' })).toBeNull();
    expect(
      parseSetProjectArg({ briefingId: 'b1', claimId: 'a1', projectId: undefined }),
    ).toBeNull();
  });
});

describe('parseClaimProjectsArg', () => {
  it('accepts a non-empty briefing id and rejects everything else', () => {
    expect(parseClaimProjectsArg({ briefingId: 'b1' })).toBe('b1');
    expect(parseClaimProjectsArg({ briefingId: '' })).toBeNull();
    expect(parseClaimProjectsArg({})).toBeNull();
    expect(parseClaimProjectsArg(null)).toBeNull();
    expect(parseClaimProjectsArg(42)).toBeNull();
  });
});

describe('setClaimProject', () => {
  it('writes the label with the injected clock', () => {
    const deps = makeDeps();

    expect(
      setClaimProject({ briefingId: BRIEFING_ID, claimId: 'a1', projectId: 'p1' }, deps),
    ).toEqual({ ok: true });
    expect(deps.labels.setProject).toHaveBeenCalledWith(BRIEFING_ID, 'a1', 'p1', CLOCK_NOW);
  });

  it('passes a null through as a clear', () => {
    const deps = makeDeps(makeStore([{ artifactId: 'a1', projectId: 'p1' }]));

    expect(
      setClaimProject({ briefingId: BRIEFING_ID, claimId: 'a1', projectId: null }, deps),
    ).toEqual({ ok: true });
    expect(deps.labels.rows.has('a1')).toBe(false);
  });

  it('rejects a malformed argument without touching the store', () => {
    const deps = makeDeps();

    expect(setClaimProject({ briefingId: '', claimId: 'a1', projectId: 'p1' }, deps)).toEqual({
      ok: false,
      reason: 'invalid_selection',
    });
    expect(deps.labels.setProject).not.toHaveBeenCalled();
  });

  it('reports not_wired when no label store is configured', () => {
    const deps = { artifacts: {}, events: {} } as unknown as Deps;

    expect(
      setClaimProject({ briefingId: BRIEFING_ID, claimId: 'a1', projectId: 'p1' }, deps),
    ).toEqual({ ok: false, reason: 'not_wired' });
  });

  it('degrades a store failure to internal_error rather than throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = makeStore();
    store.setProject.mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(
      setClaimProject({ briefingId: BRIEFING_ID, claimId: 'a1', projectId: 'p1' }, makeDeps(store)),
    ).toEqual({ ok: false, reason: 'internal_error' });
  });
});

describe('listClaimProjects', () => {
  it('maps stored labels onto the wire shape', () => {
    const deps = makeDeps(
      makeStore([
        { artifactId: 'a1', projectId: 'p1' },
        { artifactId: 'a2', projectId: 'p2' },
      ]),
    );

    expect(listClaimProjects({ briefingId: BRIEFING_ID }, deps)).toEqual([
      { claimId: 'a1', projectId: 'p1' },
      { claimId: 'a2', projectId: 'p2' },
    ]);
  });

  it('returns an empty list for a malformed argument or an unwired store', () => {
    expect(listClaimProjects({}, makeDeps())).toEqual([]);
    expect(
      listClaimProjects({ briefingId: BRIEFING_ID }, { artifacts: {}, events: {} } as unknown as Deps),
    ).toEqual([]);
  });

  it('degrades a failed read to an empty list rather than throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = makeStore();
    store.listForBriefing.mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(listClaimProjects({ briefingId: BRIEFING_ID }, makeDeps(store))).toEqual([]);
  });
});

describe('registerClaimHandlers', () => {
  it('registers both label channels when a store and clock are wired', () => {
    registerClaimHandlers(makeDeps());

    const channels = handle.mock.calls.map((call) => call[0] as string);
    expect(channels).toContain(SET_PROJECT_CHANNEL);
    expect(channels).toContain(PROJECTS_CHANNEL);
  });

  it('leaves them UNREGISTERED without a store, so the renderer sees an unhandled channel', () => {
    // Deliberately not "registered but inert": a handler with no store would
    // accept labels and drop them, which the UI cannot distinguish from success.
    registerClaimHandlers({
      artifacts: { getArtifact: () => undefined, getPerson: () => undefined },
      events: { listByThread: () => [] },
    } as unknown as Deps);

    const channels = handle.mock.calls.map((call) => call[0] as string);
    expect(channels).not.toContain(SET_PROJECT_CHANNEL);
    expect(channels).not.toContain(PROJECTS_CHANNEL);
  });
});
