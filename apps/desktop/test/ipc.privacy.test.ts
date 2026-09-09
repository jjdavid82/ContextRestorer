/**
 * `privacy:stats` / `privacy:deleteEverything` — `apps/desktop/src/ipc/privacy.ts`.
 *
 * `privacy.ts` imports `ipcMain` at module scope, which does not exist outside
 * a running Electron process — same `vi.mock('electron', …)` + dynamic-import
 * pattern as every other `ipc.*.test.ts` in this directory.
 *
 * The properties worth pinning here are about honesty rather than mechanics.
 * This is the only channel in the app that destroys data, so:
 *
 *   - it must not fire without the exact confirmation phrase;
 *   - a failed SQLite wipe must leave `ok: false` and no side effects;
 *   - a wipe whose SQLite half committed must report `ok: true` even when a
 *     later step failed, AND name what did not finish. Both halves of that are
 *     asserted, because either one alone is a lie the panel would then tell.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const {
  CONFIRM_PHRASE,
  PRIVACY_DELETE_CHANNEL,
  PRIVACY_STATS_CHANNEL,
  dataSummary,
  deleteEverythingNow,
  isConfirmed,
  registerPrivacyHandlers,
  retentionCutoff,
} = await import('../src/ipc/privacy.js');

type Module = typeof import('../src/ipc/privacy.js');
type Deps = Parameters<Module['dataSummary']>[0];

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

/** A `UserDataSummary` with every table present, as the real one always is. */
function summaryRows(overrides: Record<string, number> = {}) {
  const rows: Record<string, number> = {
    events: 0,
    state_deltas: 0,
    briefings: 0,
    pending_items: 0,
    artifacts: 0,
    ...overrides,
  };
  return rows;
}

interface StoreOptions {
  rows?: Record<string, number>;
  oldestEventAt?: number | null;
  expiredRawEvents?: number;
  vectorEventIds?: string[];
  narrativePaths?: string[];
  /** Rows the wipe reports removing. Defaults to the sum of `rows`. */
  rowsDeleted?: number;
  /** Make `deleteEverything` throw, standing in for a failed transaction. */
  deleteThrows?: boolean;
}

function makeStore(options: StoreOptions = {}): Deps['store'] {
  const rows = options.rows ?? summaryRows();
  const rowTotal = Object.values(rows).reduce((sum, n) => sum + n, 0);
  return {
    summary: () => ({
      rowsByTable: rows,
      totalRows: rowTotal,
      oldestEventAt: options.oldestEventAt ?? null,
      expiredRawEvents: options.expiredRawEvents ?? 0,
    }),
    deleteEverything: () => {
      if (options.deleteThrows === true) throw new Error('simulated disk failure');
      return {
        // The real `deleteEverything` returns the DELETEs' own row count.
        rowsDeleted: options.rowsDeleted ?? rowTotal,
        vectorEventIds: options.vectorEventIds ?? [],
        narrativePaths: options.narrativePaths ?? [],
      };
    },
  };
}

/** A vector-store double whose `deleteAll` returns `n` (or throws). */
function makeVectors(n: number | Error): { deleteAll: ReturnType<typeof vi.fn> } {
  return {
    deleteAll: vi.fn(async () => {
      if (n instanceof Error) throw n;
      return n;
    }),
  };
}

/** A vault double. `connected` decides what `load` reports. */
function makeVault(connected: readonly string[] = [], revokeThrowsFor?: string) {
  const revoked: string[] = [];
  return {
    revoked,
    vault: {
      load: async (source: string) => (connected.includes(source) ? { accessToken: 't' } : undefined),
      revoke: async (source: string) => {
        if (source === revokeThrowsFor) throw new Error('keychain locked');
        revoked.push(source);
      },
    } as unknown as Deps['vault'],
  };
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    store: makeStore(),
    vault: makeVault().vault,
    rawEventDays: 90,
    clock: { now: () => NOW },
    ...overrides,
  };
}

beforeEach(() => {
  handle.mockReset();
});

describe('registerPrivacyHandlers', () => {
  it('registers exactly the two channels the preload allowlists', () => {
    registerPrivacyHandlers(makeDeps());

    expect(handle.mock.calls.map((call) => call[0])).toEqual([
      PRIVACY_STATS_CHANNEL,
      PRIVACY_DELETE_CHANNEL,
    ]);
  });
});

describe('retentionCutoff', () => {
  it('is now minus rawEventDays — the same `@cr/store` rule the purge applies', () => {
    // Asserted against the arithmetic rather than against the store function,
    // so a change to that shared rule fails here loudly instead of moving both
    // sides of the comparison at once.
    expect(retentionCutoff({ rawEventDays: 90, clock: { now: () => NOW } })).toBe(
      NOW - 90 * DAY_MS,
    );
    expect(retentionCutoff({ rawEventDays: 7, clock: { now: () => NOW } })).toBe(
      NOW - 7 * DAY_MS,
    );
  });
});

describe('isConfirmed — the trust boundary', () => {
  it('accepts only the exact phrase', () => {
    expect(isConfirmed({ confirm: CONFIRM_PHRASE })).toBe(true);
  });

  it.each([
    ['lowercase', { confirm: 'delete' }],
    ['padded', { confirm: ' DELETE ' }],
    ['a near miss', { confirm: 'DELETE ALL' }],
    ['empty', { confirm: '' }],
    ['a non-string', { confirm: 1 }],
    ['a boolean stand-in', { confirm: true }],
    ['the wrong key', { confirmed: CONFIRM_PHRASE }],
    ['no argument at all', undefined],
    ['null', null],
  ])('rejects %s', (_label, arg) => {
    expect(isConfirmed(arg)).toBe(false);
  });
});

describe('dataSummary', () => {
  it('projects the store summary onto the panel\'s named counts', async () => {
    const deps = makeDeps({
      store: makeStore({
        rows: summaryRows({ events: 1_204, state_deltas: 87, briefings: 12, pending_items: 5 }),
        oldestEventAt: 1_600_000_000_000,
        expiredRawEvents: 300,
      }),
    });

    const summary = await dataSummary(deps);

    expect(summary.messages).toBe(1_204);
    expect(summary.summaries).toBe(87);
    expect(summary.briefings).toBe(12);
    expect(summary.obligations).toBe(5);
    // Deliberately the sum across EVERY table, not the four above: the wipe
    // empties more than the panel names, and the total is what discloses that.
    expect(summary.totalRows).toBe(1_204 + 87 + 12 + 5);
    expect(summary.oldestEventAt).toBe(1_600_000_000_000);
    expect(summary.expiredRawEvents).toBe(300);
    expect(summary.retentionDays).toBe(90);
  });

  it('reports which sources a wipe would disconnect', async () => {
    const summary = await dataSummary(makeDeps({ vault: makeVault(['slack']).vault }));

    expect(summary.connectedSources).toEqual(['slack']);
  });

  it('treats an unreadable vault as "not connected" rather than failing the read', async () => {
    const vault = {
      load: async () => {
        throw new Error('keychain unavailable');
      },
      revoke: async () => undefined,
    } as unknown as Deps['vault'];

    await expect(dataSummary(makeDeps({ vault }))).resolves.toMatchObject({
      connectedSources: [],
    });
  });

  it('propagates a store read failure instead of reporting zeroes', async () => {
    // The one place in this codebase where a read handler must NOT degrade: a
    // panel showing zeroes for a database it could not read tells the user
    // there is nothing of theirs to erase.
    const store = {
      ...makeStore(),
      summary: () => {
        throw new Error('database is locked');
      },
    };

    await expect(dataSummary(makeDeps({ store }))).rejects.toThrow(/database is locked/);
  });
});

describe('deleteEverythingNow', () => {
  it('refuses without the confirmation phrase, and touches nothing', async () => {
    let deleted = false;
    const store = {
      ...makeStore(),
      deleteEverything: () => {
        deleted = true;
        return { rowsDeleted: 0, vectorEventIds: [], narrativePaths: [] };
      },
    };
    const { vault, revoked } = makeVault(['slack', 'gmail']);

    const result = await deleteEverythingNow({ confirm: 'nope' }, makeDeps({ store, vault }));

    expect(result).toEqual({ ok: false, reason: 'not_confirmed' });
    expect(deleted).toBe(false);
    expect(revoked).toEqual([]);
  });

  it('runs all four steps and reports each one', async () => {
    const unlinked: string[] = [];
    const { vault, revoked } = makeVault(['slack', 'gmail']);
    const vectors = makeVectors(3);
    const deps = makeDeps({
      store: makeStore({
        rows: summaryRows({ events: 40, state_deltas: 2 }),
        narrativePaths: ['/data/briefings/b1.md', '/data/briefings/b2.md'],
      }),
      vectors,
      unlink: async (path: string) => {
        unlinked.push(path);
      },
      vault,
    });

    const result = await deleteEverythingNow({ confirm: CONFIRM_PHRASE }, deps);

    expect(result.ok).toBe(true);
    // Straight from the wipe's own DELETE counts, not a pre-scan.
    expect(result.rowsDeleted).toBe(42);
    expect(result.vectorsDeleted).toBe(3);
    // The whole table goes — `deleteAll` takes no event ids.
    expect(vectors.deleteAll).toHaveBeenCalledWith();
    expect(result.filesDeleted).toBe(2);
    expect(result.filesFailed).toBe(0);
    expect(result.credentialsRevoked).toEqual(['slack', 'gmail']);
    expect(result.incomplete).toEqual([]);
    expect(unlinked).toEqual(['/data/briefings/b1.md', '/data/briefings/b2.md']);
    expect(revoked).toEqual(['slack', 'gmail']);
  });

  it('does not claim to have disconnected a source that was never connected', async () => {
    // `vault.revoke` is a silent no-op on an absent entry, so revoking blindly
    // and reporting every attempt would tell a fresh install "disconnected
    // slack and gmail".
    const { vault, revoked } = makeVault(['slack']);

    const result = await deleteEverythingNow(
      { confirm: CONFIRM_PHRASE },
      makeDeps({ vectors: makeVectors(0), vault }),
    );

    // Revoke is still attempted on both (it clears a stale/unreadable blob)…
    expect(revoked).toEqual(['slack', 'gmail']);
    // …but only the one that actually held a credential is reported.
    expect(result.credentialsRevoked).toEqual(['slack']);
    expect(result.incomplete).toEqual([]);
  });

  it('reports no credentials revoked on an install with none connected', async () => {
    const { vault } = makeVault([]);

    const result = await deleteEverythingNow(
      { confirm: CONFIRM_PHRASE },
      makeDeps({ vectors: makeVectors(0), vault }),
    );

    expect(result.credentialsRevoked).toEqual([]);
    expect(result.incomplete).toEqual([]);
  });

  it('fails closed when the SQLite wipe throws, and skips every later step', async () => {
    const { vault, revoked } = makeVault(['slack']);
    const vectors = makeVectors(0);

    const result = await deleteEverythingNow(
      { confirm: CONFIRM_PHRASE },
      makeDeps({ store: makeStore({ deleteThrows: true }), vectors, vault }),
    );

    expect(result).toEqual({ ok: false, reason: 'store_error' });
    // Nothing outside SQLite may be erased on this path: the transaction rolled
    // back, so the database still holds the events those vectors belong to.
    expect(vectors.deleteAll).not.toHaveBeenCalled();
    expect(revoked).toEqual([]);
  });

  it('still reports ok when the vector eviction fails, and names it as incomplete', async () => {
    const deps = makeDeps({
      store: makeStore({ rows: summaryRows({ events: 5 }) }),
      vectors: makeVectors(new Error('lance table locked')),
    });

    const result = await deleteEverythingNow({ confirm: CONFIRM_PHRASE }, deps);

    // Both halves matter: the user's messages ARE gone (ok), and the leftover
    // index IS disclosed (incomplete). A retry can still finish it — `deleteAll`
    // needs no ids, and those are gone from SQLite by now.
    expect(result.ok).toBe(true);
    expect(result.vectorsDeleted).toBeNull();
    expect(result.incomplete).toEqual(['vectors']);
  });

  it('distinguishes "no vector store wired" from "nothing to evict"', async () => {
    const wired = await deleteEverythingNow(
      { confirm: CONFIRM_PHRASE },
      makeDeps({ vectors: makeVectors(0) }),
    );
    expect(wired.vectorsDeleted).toBe(0);
    expect(wired.incomplete).toEqual([]);

    const unwired = await deleteEverythingNow({ confirm: CONFIRM_PHRASE }, makeDeps());
    expect(unwired.vectorsDeleted).toBeNull();
    expect(unwired.incomplete).toEqual(['vectors']);
  });

  it('treats an already-missing narrative file as done, not as a failure', async () => {
    const deps = makeDeps({
      store: makeStore({ narrativePaths: ['/gone.md', '/there.md'] }),
      unlink: async (path: string) => {
        if (path === '/gone.md') {
          const error = new Error('ENOENT') as Error & { code?: string };
          error.code = 'ENOENT';
          throw error;
        }
      },
    });

    const result = await deleteEverythingNow({ confirm: CONFIRM_PHRASE }, deps);

    expect(result.filesDeleted).toBe(1);
    expect(result.filesFailed).toBe(0);
    expect(result.incomplete).not.toContain('files');
  });

  it('counts a real unlink failure and discloses it', async () => {
    const deps = makeDeps({
      store: makeStore({ narrativePaths: ['/locked.md'] }),
      unlink: async () => {
        const error = new Error('EPERM') as Error & { code?: string };
        error.code = 'EPERM';
        throw error;
      },
    });

    const result = await deleteEverythingNow({ confirm: CONFIRM_PHRASE }, deps);

    expect(result.ok).toBe(true);
    expect(result.filesFailed).toBe(1);
    expect(result.incomplete).toEqual(['vectors', 'files']);
  });

  it('discloses a connected credential that could not be revoked', async () => {
    const { vault } = makeVault(['slack', 'gmail'], 'gmail');

    const result = await deleteEverythingNow(
      { confirm: CONFIRM_PHRASE },
      makeDeps({ vectors: makeVectors(0), vault }),
    );

    expect(result.ok).toBe(true);
    expect(result.credentialsRevoked).toEqual(['slack']);
    expect(result.incomplete).toEqual(['credentials']);
  });

  it('does not flag credentials incomplete when only a never-connected source failed', async () => {
    // gmail's revoke throws, but gmail held no credential — nothing was lost.
    const { vault } = makeVault(['slack'], 'gmail');

    const result = await deleteEverythingNow(
      { confirm: CONFIRM_PHRASE },
      makeDeps({ vectors: makeVectors(0), vault }),
    );

    expect(result.credentialsRevoked).toEqual(['slack']);
    expect(result.incomplete).toEqual([]);
  });

  it('runs the afterDelete hook, and survives it throwing', async () => {
    const afterDelete = vi.fn();
    await deleteEverythingNow({ confirm: CONFIRM_PHRASE }, makeDeps({ afterDelete }));
    expect(afterDelete).toHaveBeenCalledOnce();

    const angry = await deleteEverythingNow(
      { confirm: CONFIRM_PHRASE },
      makeDeps({
        afterDelete: () => {
          throw new Error('resolver rebuild failed');
        },
      }),
    );
    // A host-side refresh hook must not turn a completed erasure into a
    // reported failure — the data really is gone either way.
    expect(angry.ok).toBe(true);
  });
});
