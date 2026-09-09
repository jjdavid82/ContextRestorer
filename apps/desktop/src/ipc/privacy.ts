/**
 * `privacy:stats` / `privacy:deleteEverything` — the SEC-8 right to delete, and
 * the read-only view of what there is to delete.
 *
 * `packages/store/src/retention.ts` has held both halves of this requirement,
 * fully tested, since Phase 0; nothing ever called either one. The README
 * promises the recipient of a build that "raw event payloads age out after 90
 * days" and that "a right-to-delete operation is available", so until this
 * module existed both sentences were false of the shipped app. This is the call
 * site, and `scheduler/retentionPurge.ts` is the other one.
 *
 * ### Why the erase is not just `deleteEverything()`
 *
 * That function is SQLite-only by design (it will not mix a filesystem unlink
 * into a SQL transaction), and returns a manifest of what it could not reach.
 * SEC-8 requires the relational store, the vector index and the token vault to
 * go together, so completing the request means four steps, in this order:
 *
 *   1. wipe SQLite and take the manifest;
 *   2. evict the manifest's event ids from LanceDB;
 *   3. unlink the manifest's narrative `.md` files;
 *   4. revoke every credential in the vault.
 *
 * SQLite goes first because it is the only atomic step: if the process dies
 * between 1 and 4 the user is left with orphaned vectors and tokens rather than
 * with a database still full of their messages. Steps 2-4 are therefore
 * best-effort *and reported* — {@link DeleteEverythingReport} names what each
 * step actually managed, and a step that fails does not stop the ones after it.
 * A "deleted" claim this module cannot substantiate is worse than a partial
 * result the panel can show honestly.
 *
 * ### Why the confirmation phrase crosses the bridge
 *
 * The renderer displays untrusted ingested text (SEC-4's whole premise), so a
 * channel that erases everything on a bare call is one XSS away from being a
 * data-loss bug. The handler requires the literal {@link CONFIRM_PHRASE} in its
 * argument: the UI's typed confirmation is the usability half, and this check is
 * the trust boundary — the same division every other handler here uses.
 */
import { ipcMain } from 'electron';
import type { SourceId } from '@cr/core';
import { retentionCutoffMs } from '@cr/store';
import type { DeleteEverythingResult, UserDataSummary } from '@cr/store';

/** Invoke channel reporting what is stored (read-only). */
export const PRIVACY_STATS_CHANNEL = 'privacy:stats';

/** Invoke channel erasing everything (SEC-8). Requires {@link CONFIRM_PHRASE}. */
export const PRIVACY_DELETE_CHANNEL = 'privacy:deleteEverything';

/**
 * The exact string a caller must send to erase everything.
 *
 * Uppercase and untranslated on purpose: it is a shibboleth, not copy. The
 * panel shows the user which word to type; nothing derives it from locale.
 */
export const CONFIRM_PHRASE = 'DELETE';

/** The sources whose credentials a wipe must revoke (SEC-8 covers the vault). */
const VAULT_SOURCES: readonly SourceId[] = ['slack', 'gmail'];

/**
 * The `retention.ts` surface this module drives, as a structural type.
 *
 * A `Pick`-style interface rather than the module itself, so `main.ts` supplies
 * the bound-to-`db` adapter and a test hands in a double — the same pattern
 * `ModelSettingsStore` and `ScheduleStore` use. It also keeps `better-sqlite3`
 * out of this file entirely.
 */
export interface PrivacyStore {
  /** `userDataSummary(db, cutoffMs)`. */
  summary(rawEventCutoffMs: number): UserDataSummary;
  /** `deleteEverything(db)`. */
  deleteEverything(): DeleteEverythingResult;
}

/** The one `VectorStore` method a wipe needs. */
export interface VectorEvictor {
  deleteByEventIds(eventIds: string[]): Promise<number>;
}

/**
 * The `TokenVault` slice this module uses: `revoke` to complete a wipe (SEC-3
 * already deletes the file when the last entry goes), and `load` so the panel
 * can warn that erasing also disconnects the sources.
 *
 * `TokenVault` satisfies both structurally, so `main.ts` passes it straight
 * through with no adapter.
 */
export interface CredentialPurger {
  revoke(source: SourceId): Promise<void>;
  load(source: SourceId): Promise<unknown>;
}

/** `fs.promises.unlink`, injected so the delete path is testable without a disk. */
export type FileRemover = (path: string) => Promise<void>;

export interface PrivacyDeps {
  /** Bound to the live `better-sqlite3` handle in `main.ts`. */
  store: PrivacyStore;
  /**
   * LanceDB. Optional: a host whose vector gate failed still owes the user a
   * SQLite wipe, and {@link DeleteEverythingReport.vectorsDeleted} reports
   * `null` rather than `0` so "not wired" never reads as "nothing to evict".
   */
  vectors?: VectorEvictor;
  /** OAuth token vault (SEC-2). Always present in `main.ts`. */
  vault: CredentialPurger;
  /** Defaults to `fs.promises.unlink`. */
  unlink?: FileRemover;
  /** `config.retention.rawEventDays`. */
  rawEventDays: number;
  /** Time source for the retention cutoff. */
  clock: { now(): number };
  /**
   * Run after a successful wipe, before the result is returned.
   *
   * `main.ts` uses it to rebuild the channel → project resolver from the
   * now-empty selection: that object is held in a closure the ingestion
   * pipeline reads, so leaving it pointing at deleted project ids would have
   * the next poll cycle tag fresh artifacts onto projects the user just erased.
   */
  afterDelete?: () => void;
}

/** `privacy:stats` — what the app is holding right now. */
export interface DataSummary {
  /** Raw source messages stored (`events`). */
  messages: number;
  /** Derived state changes (`state_deltas`) — the summaries a wipe also removes. */
  summaries: number;
  /** Briefings written (`briefings`). */
  briefings: number;
  /** Open and closed obligations (`pending_items`). */
  obligations: number;
  /** Every row a wipe would delete, across every table. */
  totalRows: number;
  /** Epoch ms of the oldest stored message; `null` when nothing is stored. */
  oldestEventAt: number | null;
  /** Messages already past the retention cutoff, i.e. what the next purge takes. */
  expiredRawEvents: number;
  /** `config.retention.rawEventDays`, so the panel states the promise, not a guess. */
  retentionDays: number;
  /** Sources holding a live credential a wipe would revoke. */
  connectedSources: SourceId[];
}

/** `privacy:deleteEverything` — what each of the four steps actually managed. */
export interface DeleteEverythingReport {
  ok: boolean;
  /** Machine-readable cause when `ok` is false. Rendered, not branched on. */
  reason?: string;
  /** Rows removed from SQLite. Present only when step 1 succeeded. */
  rowsDeleted?: number;
  /**
   * Vectors evicted from LanceDB. `null` means the step could not run (no
   * vector store wired, or the eviction threw) — deliberately distinct from
   * `0`, which is a real count for a database that held no events.
   */
  vectorsDeleted?: number | null;
  /** Narrative `.md` files unlinked. */
  filesDeleted?: number;
  /** Narrative files that could not be unlinked, by count. */
  filesFailed?: number;
  /** Sources whose credentials were revoked. */
  credentialsRevoked?: SourceId[];
  /**
   * Steps that did not complete, as short slugs (`vectors`, `files`,
   * `credentials`). Empty on a clean wipe. `ok` stays true when SQLite was
   * wiped — the user's messages are gone, which is the substance of the
   * request — and the panel discloses the remainder.
   */
  incomplete?: string[];
}

/** Re-validate the renderer-supplied confirmation. The trust boundary (rule 2). */
export function isConfirmed(arg: unknown): boolean {
  const confirm = (arg as { confirm?: unknown } | null)?.confirm;
  return confirm === CONFIRM_PHRASE;
}

/**
 * The cutoff this panel reports against.
 *
 * Delegates to `@cr/store`'s `retentionCutoffMs` rather than recomputing it, so
 * the number the panel shows as "expiring" and the number the daily sweep
 * actually deletes come from one rule. A second copy of the arithmetic here
 * would be a promise the app could quietly break.
 */
export function retentionCutoff(deps: Pick<PrivacyDeps, 'rawEventDays' | 'clock'>): number {
  return retentionCutoffMs(deps.clock.now(), deps.rawEventDays);
}

/**
 * The whole of `privacy:stats`.
 *
 * Deliberately allowed to reject rather than degrading to a summary of zeroes,
 * which is the opposite of every other read handler in this directory. A panel
 * showing zeroes for a database it could not read would tell the user there is
 * nothing of theirs to erase — the one lie this particular screen must not
 * tell. The renderer shows "could not read your data" instead.
 */
export async function dataSummary(deps: PrivacyDeps): Promise<DataSummary> {
  const summary = deps.store.summary(retentionCutoff(deps));

  const connected: SourceId[] = [];
  for (const source of VAULT_SOURCES) {
    if (await isConnected(deps.vault, source)) connected.push(source);
  }

  return {
    messages: summary.rowsByTable['events'] ?? 0,
    summaries: summary.rowsByTable['state_deltas'] ?? 0,
    briefings: summary.rowsByTable['briefings'] ?? 0,
    obligations: summary.rowsByTable['pending_items'] ?? 0,
    totalRows: summary.totalRows,
    oldestEventAt: summary.oldestEventAt,
    expiredRawEvents: summary.expiredRawEvents,
    retentionDays: deps.rawEventDays,
    connectedSources: connected,
  };
}

/** Whether a source holds a credential a wipe would revoke. */
async function isConnected(vault: CredentialPurger, source: SourceId): Promise<boolean> {
  try {
    return (await vault.load(source)) !== undefined;
  } catch {
    // A vault whose file is unreadable is not a connected source, and the
    // summary must not fail over one line item of it.
    return false;
  }
}

/**
 * The whole of `privacy:deleteEverything`: the four steps in order, each
 * reported (see the module header).
 *
 * Only step 1 can fail the request outright. Once SQLite is empty the user's
 * data is gone in every sense that matters to them, and the honest thing to do
 * with a failed eviction is to name it — not to roll anything back (nothing can
 * be) and not to hide it.
 */
export async function deleteEverythingNow(
  arg: unknown,
  deps: PrivacyDeps,
): Promise<DeleteEverythingReport> {
  if (!isConfirmed(arg)) return { ok: false, reason: 'not_confirmed' };

  let manifest: DeleteEverythingResult;
  let rowsDeleted: number;
  try {
    // Counted BEFORE the wipe: afterwards every table is empty and there is
    // nothing left to total.
    rowsDeleted = deps.store.summary(retentionCutoff(deps)).totalRows;
    manifest = deps.store.deleteEverything();
  } catch (error) {
    // The transaction rolled back and the append-only triggers are back on
    // (see `retention.ts`), so the store is exactly as it was.
    console.error('[privacy] deleteEverything failed; nothing was erased', error);
    return { ok: false, reason: 'store_error' };
  }

  const incomplete: string[] = [];

  let vectorsDeleted: number | null = null;
  if (deps.vectors !== undefined) {
    try {
      vectorsDeleted = await deps.vectors.deleteByEventIds(manifest.vectorEventIds);
    } catch (error) {
      console.error('[privacy] vector eviction failed after the SQLite wipe', error);
      incomplete.push('vectors');
    }
  } else {
    incomplete.push('vectors');
  }

  const unlink = deps.unlink ?? defaultUnlink;
  let filesDeleted = 0;
  let filesFailed = 0;
  for (const path of manifest.narrativePaths) {
    try {
      await unlink(path);
      filesDeleted += 1;
    } catch (error) {
      // A file already gone is not a failure — the outcome the caller asked
      // for is the outcome they have.
      if (isMissingFile(error)) continue;
      console.error('[privacy] could not unlink a narrative file', error);
      filesFailed += 1;
    }
  }
  if (filesFailed > 0) incomplete.push('files');

  const credentialsRevoked: SourceId[] = [];
  for (const source of VAULT_SOURCES) {
    try {
      await deps.vault.revoke(source);
      credentialsRevoked.push(source);
    } catch (error) {
      console.error(`[privacy] could not revoke ${source} credentials`, error);
    }
  }
  if (credentialsRevoked.length < VAULT_SOURCES.length) incomplete.push('credentials');

  try {
    deps.afterDelete?.();
  } catch (error) {
    // A host-side refresh hook must not turn a completed erasure into a
    // reported failure.
    console.error('[privacy] afterDelete hook threw', error);
  }

  return {
    ok: true,
    rowsDeleted,
    vectorsDeleted,
    filesDeleted,
    filesFailed,
    credentialsRevoked,
    incomplete,
  };
}

/** `fs.promises.unlink`, imported lazily so this module loads under plain Node. */
async function defaultUnlink(path: string): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  await unlink(path);
}

/** Whether a thrown filesystem error means "already gone". */
function isMissingFile(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Register both channels. Safe to call before any window exists — neither
 * handler needs a `BrowserWindow`.
 */
export function registerPrivacyHandlers(deps: PrivacyDeps): void {
  ipcMain.handle(PRIVACY_STATS_CHANNEL, (): Promise<DataSummary> => dataSummary(deps));

  ipcMain.handle(
    PRIVACY_DELETE_CHANNEL,
    (_event, arg: unknown): Promise<DeleteEverythingReport> => deleteEverythingNow(arg, deps),
  );
}
