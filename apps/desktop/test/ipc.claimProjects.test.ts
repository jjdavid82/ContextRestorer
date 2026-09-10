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
  DETECT_PROJECTS_CHANNEL,
  PROJECTS_CHANNEL,
  SET_PROJECT_CHANNEL,
  detectClaimProjects,
  listClaimProjects,
  parseClaimProjectsArg,
  parseDetectArg,
  parseSetProjectArg,
  registerClaimHandlers,
  setClaimProject,
} = await import('../src/ipc/claim.js');

type ClaimModule = typeof import('../src/ipc/claim.js');
type Deps = Parameters<ClaimModule['setClaimProject']>[1];

const CLOCK_NOW = 1_700_000_000_000;
const BRIEFING_ID = 'briefing-1';

/** An in-memory stand-in for `ClaimProjectsRepo`, satisfying `ClaimProjectStore`. */
function makeStore(
  seed: ReadonlyArray<{ artifactId: string; projectId: string; origin?: 'user' | 'auto' }> = [],
) {
  const rows = new Map(
    seed.map((row) => [row.artifactId, { projectId: row.projectId, origin: row.origin ?? 'user' }]),
  );
  return {
    rows,
    // Keyed on the artifact since migration 013, so labels span briefings. The
    // `origin` rides along so a guess is never reported as the user's filing.
    listAll: vi.fn(() =>
      [...rows].map(([artifactId, v]) => ({ artifactId, projectId: v.projectId, origin: v.origin })),
    ),
    setProject: vi.fn(
      (artifactId: string, projectId: string | null, _now: number, origin: 'user' | 'auto' = 'user') => {
        if (projectId === null) rows.delete(artifactId);
        else rows.set(artifactId, { projectId, origin });
      },
    ),
    // Mirrors the repo's `INSERT … WHERE NOT EXISTS`: writes only where absent,
    // and always as `'auto'` — this is the detection path.
    suggestProject: vi.fn((artifactId: string, projectId: string) => {
      if (rows.has(artifactId)) return false;
      rows.set(artifactId, { projectId, origin: 'auto' });
      return true;
    }),
  };
}

const PROJECTS = [
  { projectId: 'p-dsp', name: 'DSP' },
  { projectId: 'p-academy', name: 'AI Academy' },
];

/**
 * Deps with labelling wired.
 *
 * `artifacts`/`events` are unreachable from the label handlers but ARE reachable
 * from detection, which resolves a claim's thread the same way `claim:drilldown`
 * does — so `threadTexts` seeds a thread's message bodies per artifact id.
 */
function makeDeps(
  store = makeStore(),
  options: {
    projects?: ReadonlyArray<{ projectId: string; name: string }>;
    threadTexts?: Record<string, string[]>;
    /** artifact id → the project id its channel is tagged with (`belongs_to`). */
    tags?: Record<string, string>;
  } = {},
): Deps & { labels: ReturnType<typeof makeStore> } {
  const threadTexts = options.threadTexts ?? {};
  return {
    // Detection resolves artifact → `externalRef` (the thread key) → events.
    // Keying the fake thread on the artifact id keeps the fixtures readable.
    artifacts: {
      getArtifact: vi.fn((id: string) =>
        threadTexts[id] === undefined ? undefined : { artifactId: id, externalRef: id },
      ),
      getPerson: vi.fn(() => undefined),
    },
    events: {
      listByThread: vi.fn((threadKey: string) =>
        (threadTexts[threadKey] ?? []).map((text, index) => ({
          eventId: `${threadKey}-${index}`,
          source: 'slack',
          threadKey,
          occurredAt: CLOCK_NOW,
          payload: { text },
        })),
      ),
    },
    labels: store,
    clock: { now: () => CLOCK_NOW },
    ...(options.projects === undefined ? {} : { projects: { listProjects: () => options.projects } }),
    // The narrow `StakesReader` slice detection reads channel tags through —
    // the same shape, and in production the same object, the briefing badge uses.
    ...(options.tags === undefined
      ? {}
      : {
          tags: {
            relatedIds: (fromId: string, rel: string) =>
              rel === 'belongs_to' && options.tags![fromId] !== undefined
                ? [options.tags![fromId]!]
                : [],
            getProject: (projectId: string) => {
              const declared = (options.projects ?? []).find((p) => p.projectId === projectId);
              return declared === undefined ? undefined : { stakesWeight: 3, name: declared.name };
            },
          },
        }),
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
    // Artifact first: the briefing id is provenance, not identity (012).
    expect(deps.labels.setProject).toHaveBeenCalledWith(
      'a1',
      'p1',
      CLOCK_NOW,
      'user',
      BRIEFING_ID,
    );
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
      { claimId: 'a1', projectId: 'p1', origin: 'user' },
      { claimId: 'a2', projectId: 'p2', origin: 'user' },
    ]);
  });

  it('defaults a row with no stored origin to "user" (predates migration 013)', () => {
    const store = makeStore([{ artifactId: 'a1', projectId: 'p1' }]);
    store.listAll.mockImplementation(() => [{ artifactId: 'a1', projectId: 'p1' }]);

    expect(listClaimProjects({ briefingId: BRIEFING_ID }, makeDeps(store))).toEqual([
      { claimId: 'a1', projectId: 'p1', origin: 'user' },
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
    store.listAll.mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(listClaimProjects({ briefingId: BRIEFING_ID }, makeDeps(store))).toEqual([]);
  });
});

describe('parseDetectArg', () => {
  it('accepts a briefing id with a claim list', () => {
    expect(parseDetectArg({ briefingId: 'b1', claimIds: ['a1', 'a2'] })).toEqual({
      briefingId: 'b1',
      claimIds: ['a1', 'a2'],
    });
  });

  it('drops malformed entries rather than failing the whole batch', () => {
    // One bad id costs that row its suggestion; the others are still worth having.
    expect(parseDetectArg({ briefingId: 'b1', claimIds: ['a1', '', 42, null, 'a2'] })).toEqual({
      briefingId: 'b1',
      claimIds: ['a1', 'a2'],
    });
  });

  it('rejects a missing briefing id or a non-array claim list', () => {
    expect(parseDetectArg({ claimIds: ['a1'] })).toBeNull();
    expect(parseDetectArg({ briefingId: 'b1' })).toBeNull();
    expect(parseDetectArg({ briefingId: 'b1', claimIds: 'a1' })).toBeNull();
    expect(parseDetectArg(null)).toBeNull();
  });
});

describe('detectClaimProjects', () => {
  it('files a claim whose SOURCE TEXT names exactly one project', () => {
    const deps = makeDeps(makeStore(), {
      projects: PROJECTS,
      threadTexts: { a1: ['Morning all', 'Can you review the DSP dashboard today?'] },
    });

    expect(detectClaimProjects({ briefingId: BRIEFING_ID, claimIds: ['a1'] }, deps)).toEqual([
      // `origin: 'auto'` — the filter and the dropdown treat this as a
      // suggestion, never as the user's own filing (X-2).
      { claimId: 'a1', projectId: 'p-dsp', origin: 'auto' },
    ]);
    expect(deps.labels.suggestProject).toHaveBeenCalledWith('a1', 'p-dsp', CLOCK_NOW, BRIEFING_ID);
  });

  // The channel tag outranks the name matcher. Both still land as `origin:
  // 'auto'` — neither is a per-claim decision the user made — but a tag IS a
  // decision they made per channel, so suggesting the weaker signal while the
  // stronger one sat unread is what let one row show a badge naming one project
  // and a dropdown naming another.
  it('suggests the CHANNEL TAG in preference to what the text happens to name', () => {
    const deps = makeDeps(makeStore(), {
      projects: PROJECTS,
      // The text names AI Academy; the channel is tagged DSP. The tag wins.
      threadTexts: { a1: ['Blocked on the AI Academy launch.'] },
      tags: { a1: 'p-dsp' },
    });

    expect(detectClaimProjects({ briefingId: BRIEFING_ID, claimIds: ['a1'] }, deps)).toEqual([
      { claimId: 'a1', projectId: 'p-dsp', origin: 'auto' },
    ]);
    expect(deps.labels.suggestProject).toHaveBeenCalledWith('a1', 'p-dsp', CLOCK_NOW, BRIEFING_ID);
  });

  it('falls back to the name matcher when the thread carries no channel tag', () => {
    const deps = makeDeps(makeStore(), {
      projects: PROJECTS,
      threadTexts: { a1: ['Can you review the DSP dashboard today?'] },
      tags: {},
    });

    expect(detectClaimProjects({ briefingId: BRIEFING_ID, claimIds: ['a1'] }, deps)).toEqual([
      { claimId: 'a1', projectId: 'p-dsp', origin: 'auto' },
    ]);
  });

  // A channel keeps its tag after the project is deleted, so the edge can name
  // an id no dropdown option carries. Offering it would preselect a value the
  // user cannot see or confirm.
  it('ignores a tag pointing at a project that is no longer declared', () => {
    const deps = makeDeps(makeStore(), {
      projects: PROJECTS,
      threadTexts: { a1: ['Can you review the DSP dashboard today?'] },
      tags: { a1: 'p-deleted' },
    });

    expect(detectClaimProjects({ briefingId: BRIEFING_ID, claimIds: ['a1'] }, deps)).toEqual([
      { claimId: 'a1', projectId: 'p-dsp', origin: 'auto' },
    ]);
  });

  it('leaves a claim BLANK when the text names no project', () => {
    const deps = makeDeps(makeStore(), {
      projects: PROJECTS,
      threadTexts: { a1: ['Lunch is at noon.'] },
    });

    expect(detectClaimProjects({ briefingId: BRIEFING_ID, claimIds: ['a1'] }, deps)).toEqual([]);
    expect(deps.labels.suggestProject).not.toHaveBeenCalled();
  });

  it('leaves a claim BLANK when the text names two projects', () => {
    const deps = makeDeps(makeStore(), {
      projects: PROJECTS,
      threadTexts: { a1: ['The DSP work blocks the AI Academy launch.'] },
    });

    expect(detectClaimProjects({ briefingId: BRIEFING_ID, claimIds: ['a1'] }, deps)).toEqual([]);
    expect(deps.labels.suggestProject).not.toHaveBeenCalled();
  });

  it('NEVER overwrites a label the user already set', () => {
    // The single most important guarantee here: detection re-runs on every
    // briefing load, so a row the user filed (or deliberately re-filed) must
    // survive a suggestion that disagrees with it.
    const store = makeStore([{ artifactId: 'a1', projectId: 'p-academy' }]);
    const deps = makeDeps(store, {
      projects: PROJECTS,
      threadTexts: { a1: ['All about DSP.'] },
    });

    expect(detectClaimProjects({ briefingId: BRIEFING_ID, claimIds: ['a1'] }, deps)).toEqual([
      { claimId: 'a1', projectId: 'p-academy', origin: 'user' },
    ]);
    // Skipped before the text was even read.
    expect(deps.labels.suggestProject).not.toHaveBeenCalled();
    expect(store.rows.get('a1')).toEqual({ projectId: 'p-academy', origin: 'user' });
  });

  it('files what it can and leaves the rest, across a batch', () => {
    const deps = makeDeps(makeStore(), {
      projects: PROJECTS,
      threadTexts: {
        a1: ['DSP rollout is done.'],
        a2: ['Nothing identifying here.'],
        a3: ['Notes from the AI Academy cohort.'],
      },
    });

    expect(
      detectClaimProjects({ briefingId: BRIEFING_ID, claimIds: ['a1', 'a2', 'a3'] }, deps),
    ).toEqual([
      { claimId: 'a1', projectId: 'p-dsp', origin: 'auto' },
      { claimId: 'a3', projectId: 'p-academy', origin: 'auto' },
    ]);
  });

  it('suggests nothing when no projects are declared', () => {
    const deps = makeDeps(makeStore(), { threadTexts: { a1: ['All about DSP.'] } });

    expect(detectClaimProjects({ briefingId: BRIEFING_ID, claimIds: ['a1'] }, deps)).toEqual([]);
    expect(deps.labels.suggestProject).not.toHaveBeenCalled();
  });

  it('keeps going when one claim cannot be read', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = makeDeps(makeStore(), {
      projects: PROJECTS,
      threadTexts: { a2: ['DSP again.'] },
    });
    deps.events.listByThread = vi.fn((threadKey: string) => {
      if (threadKey === 'a1') throw new Error('thread read failed');
      return [{ eventId: 'e', source: 'slack', threadKey, occurredAt: CLOCK_NOW, payload: { text: 'DSP again.' } }];
    }) as unknown as typeof deps.events.listByThread;
    deps.artifacts.getArtifact = vi.fn((id: string) => ({
      artifactId: id,
      externalRef: id,
    })) as unknown as typeof deps.artifacts.getArtifact;

    expect(
      detectClaimProjects({ briefingId: BRIEFING_ID, claimIds: ['a1', 'a2'] }, deps),
    ).toEqual([{ claimId: 'a2', projectId: 'p-dsp', origin: 'auto' }]);
  });

  it('returns an empty list for a malformed argument or an unwired store', () => {
    expect(detectClaimProjects({}, makeDeps())).toEqual([]);
    expect(
      detectClaimProjects(
        { briefingId: BRIEFING_ID, claimIds: ['a1'] },
        { artifacts: {}, events: {} } as unknown as Deps,
      ),
    ).toEqual([]);
  });
});

describe('registerClaimHandlers', () => {
  it('registers both label channels when a store and clock are wired', () => {
    registerClaimHandlers(makeDeps());

    const channels = handle.mock.calls.map((call) => call[0] as string);
    expect(channels).toContain(SET_PROJECT_CHANNEL);
    expect(channels).toContain(PROJECTS_CHANNEL);
    expect(channels).toContain(DETECT_PROJECTS_CHANNEL);
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
    expect(channels).not.toContain(DETECT_PROJECTS_CHANNEL);
  });
});
