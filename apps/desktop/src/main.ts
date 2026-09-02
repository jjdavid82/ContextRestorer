/**
 * Electron main process entry point.
 *
 * Responsibilities: create the (tray-resident) main window, serve the UI over `app://`,
 * install the IPC handler table, and register the login item.
 */
import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, newId, systemClock, type AppConfig } from '@cr/core';
import {
  BriefingGenerator,
  CitationGate,
  DebounceScheduler,
  Layer1Extractor,
  Layer2Synthesizer,
  RetrievalService,
  TemplateBriefingRenderer,
  createOllamaClient,
  generateWithFallback,
  preflight,
  type AcceptedClaimChunk,
  type EmbedFn,
  type OllamaClient,
} from '@cr/ai';
import {
  AiCallsRepo,
  AppSettingsRepo,
  BriefingSchedulesRepo,
  BriefingsRepo,
  DeltasRepo,
  EventsRepo,
  ExtractionsRepo,
  FeedbackRepo,
  GraphRepo,
  PendingItemsRepo,
  SlackChannelsRepo,
  WatermarkRepo,
  migrate,
  openDb,
  openVectors,
  type VectorStore,
} from '@cr/store';
import {
  GmailClient,
  IngestionPipeline,
  Poller,
  SlackClient,
  TokenVault,
  type EnqueueExtraction,
  type PollSourceKind,
  type RawSourceEvent,
  type SourceClient,
  type SourceFetchResult,
} from '@cr/ingest';
import { registerAppProtocol, registerAppSchemePrivileges } from './protocol.js';
import {
  installNavigationLockdown,
  registerContentSecurityPolicy,
} from './security/csp.js';
import { createTray, destroyTray, updateTrayStatus } from './tray.js';
import { registerAutostart } from './autostart.js';
import { CHAT_MODEL_SETTING_KEY, registerIpcHandlers, startHealthPush } from './ipc/index.js';
import { deepLinkFor, resolveEvents } from './ipc/claim.js';
import { ensureFreshTokens } from './ipc/oauth.js';
import { registerPipelineStatusPush } from './ipc/pipelineStatus.js';
import { BriefingScheduleRunner } from './scheduler/briefingSchedule.js';
import { notify } from './notifications.js';
import type { BriefingChunk, BriefingDone, Citation } from './preload.cjs';

/** Absolute path to this file's directory (ESM has no `__dirname`). */
const here = import.meta.dirname;

/** Directory holding the built UI bundle, served as the `app://local` root. */
const UI_ROOT = join(here, '../ui');

/**
 * Absolute path to `config/default.json`.
 *
 * Two layouts, because a packaged app does not have a repo root to walk up to:
 *
 *   - **Dev / from source**: `loadConfig()`'s own default is relative to
 *     `process.cwd()`, which is `apps/desktop` under `npm run start`
 *     (`electron .`) — not the repo root. This file is emitted to
 *     `apps/desktop/dist/main.js`, so three levels up from `dist/` is the repo root.
 *   - **Packaged**: `electron-builder.yml`'s `extraResources` copies `config/`
 *     to `resources/config/` unpacked (i.e. NOT inside `app.asar`), specifically
 *     so this file stays a plain, user-editable JSON file after install — a
 *     shared build's recipient fills in their own OAuth client id here, and an
 *     asar-packed copy would be much less obviously editable.
 */
const CONFIG_PATH = app.isPackaged
  ? join(process.resourcesPath, 'config', 'default.json')
  : join(here, '../../../config/default.json');

/** Filename of the relational store inside `userData` (design doc §4.1). */
const DB_FILENAME = 'context-restorer.db';

/** Filename of the encrypted OAuth vault inside `userData` (design doc §4.1). */
const VAULT_FILENAME = 'tokens.enc';

/** LanceDB table directory inside `userData` (design doc §4.1: `vectors/`). */
const VECTORS_DIRNAME = 'vectors';

/** Trace JSONL sink inside `userData` (design doc §4.1: `logs/trace-*.jsonl`). */
const LOGS_DIRNAME = 'logs';

/**
 * Streaming briefing channels.
 *
 * `send`s, not invokes: the renderer subscribes through the preload's allowlist
 * (`briefing.onChunk` / `briefing.onDone`) and the main process pushes. Spelled
 * out here because these two strings must match `src/preload.cts`'s allowlist
 * exactly — a typo is a channel nobody is listening on, i.e. a silent stream.
 */
const CHUNK_CHANNEL = 'briefing:chunk';
const DONE_CHANNEL = 'briefing:done';

/**
 * The `better-sqlite3` handle type, derived from `openDb`'s return type.
 *
 * Taken this way on purpose: `@cr/store` owns the `better-sqlite3` dependency and does
 * not re-export its types, and the desktop app only ever holds the handle — so there is
 * no reason to add a redundant direct dependency here just to name the type.
 */
type Db = ReturnType<typeof openDb>;

let win: BrowserWindow | null = null;

/**
 * Live handle to the relational store, held for the process lifetime.
 *
 * Module-level so it survives startup (a local would be collected, closing the db) and
 * so later phases can hand it to the repo layer / IPC handlers. Closed on `before-quit`.
 */
let db: Db | null = null;

/**
 * The loaded config, retained from the preflight gate.
 *
 * Previously `runPreflightGate` loaded and discarded it; the poller (intervals,
 * backoff caps) and the OAuth handlers (client ids) both need it, and re-reading
 * the file per consumer would let them disagree about what "the config" is.
 */
let config: AppConfig | null = null;

/**
 * `config.model.chat` exactly as `config/default.json` shipped it, captured
 * BEFORE any persisted override (`model:setChat`, Settings page) is applied
 * to `config` below. Kept so the settings UI can label the config file's own
 * choice as the default rather than losing it once an override is in effect.
 */
let defaultChatModel: string | null = null;

/** Generic app-settings store (currently: the chat-model override). Migration 005. */
let appSettings: AppSettingsRepo | null = null;

/** Encrypted-at-rest OAuth store. Built once `userData` is known to exist. */
let vault: TokenVault | null = null;

/** Live poll scheduler; the sole writer of source health. */
let poller: Poller | null = null;

/**
 * LanceDB handle, held for the process lifetime for the same reason as `db`:
 * `RetrievalService` keeps a reference and a local would be collected.
 */
let vectors: VectorStore | null = null;

/**
 * Layer 3. Built once — every repo it holds prepares its statement set in its
 * constructor, and rebuilding it per briefing would redo all of that plus
 * re-open the vector store.
 *
 * The SAME instance serves both entry points (manual `briefing:request` and the
 * FR-3 schedule runner), which is what makes "a scheduled briefing runs the
 * identical generation path" structural rather than a claim.
 */
let briefingGenerator: BriefingGenerator | null = null;

/**
 * Step 2 of the X-3 fallback chain (Task 4.3), held for the same reason as
 * `briefingGenerator` and built from the same repo instances.
 *
 * Never called directly from either entry point: both go through
 * `generateWithFallback`, which owns the decision about *when* the deterministic
 * template runs. Wiring it in anywhere else would create a second, divergent
 * notion of "the model is unavailable".
 */
let templateBriefingRenderer: TemplateBriefingRenderer | null = null;

/** OI-1 backlog counter; read directly only on the failed-generation path. */
let watermarks: WatermarkRepo | null = null;

/** FR-3 recurring briefings. Ticks on its own chained timer; stopped on quit. */
let scheduleRunner: BriefingScheduleRunner | null = null;

/**
 * Layer 2's D-7 debounce trigger (`DebounceScheduler.tick()`), unlike
 * `scheduleRunner`, owns no timer of its own — its own doc comment says it is
 * "called once at startup and every 30s thereafter" by whoever constructs it.
 * This is that caller-owned interval; cleared on quit like every other one here.
 */
let debounceTimer: NodeJS.Timeout | null = null;

/** Disposer for the `health:sources` push loop, returned by `startHealthPush`. */
let stopHealthPush: (() => void) | null = null;

/** Disposer for the `pipeline:status` push loop, returned by `registerPipelineStatusPush`. */
let stopPipelineStatusPush: (() => void) | null = null;

// Set before any `app.getPath()` call. Electron derives `userData` from the app name,
// which otherwise comes from package.json — i.e. the scoped `@cr/desktop`. Pinning it
// keeps the store at the documented `%APPDATA%/context-restorer/` (design doc §4.1).
app.setName('context-restorer');

// Must run before `whenReady`; Electron ignores scheme privileges registered later.
registerAppSchemePrivileges();

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    webPreferences: {
      // `.cjs`, not `.js`: the preload source is `preload.cts`, which `tsc` emits as
      // CommonJS. Sandboxed renderers cannot load an ESM preload.
      preload: join(here, 'preload.cjs'),
      // SECURITY: all three are required. This window renders untrusted ingested
      // content (email/Slack text); with `nodeIntegration: true` a stored-XSS-shaped
      // bug becomes full local code execution. Do not weaken.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Task 4.6: this window renders untrusted ingested content, so it is not
  // allowed to leave `app://` — `will-navigate` is cancelled for anything else
  // and `window.open` is denied outright. The app's own FR-6 deep links go out
  // through the `shell:openExternal` IPC channel instead. Installed before
  // `loadURL` so no navigation can slip in ahead of the listener.
  installNavigationLockdown(win.webContents);

  // Close hides the window; the app stays resident in the tray.
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  win.once('ready-to-show', () => win?.show());

  registerAppProtocol(UI_ROOT);
  await win.loadURL('app://local/index.html');
}

/**
 * Abort startup with a native modal naming the problem and its remedy.
 *
 * The single failure path for every blocking startup gate — the app must never
 * silently continue in a degraded state, nor die as an unexplained native crash.
 *
 * @returns Always `false`, so callers can `return failStartup(...)`.
 */
function failStartup(message: string): false {
  dialog.showErrorBox('Context Restorer — setup required', message);
  app.quit();
  return false;
}

/**
 * Blocking startup gate: opens (creating on first run) and migrates the relational
 * store at `%APPDATA%/context-restorer/context-restorer.db`.
 *
 * Runs after the preflight gate — no point writing a database file for a process that
 * is already quitting over a missing model.
 *
 * @returns `true` if startup may continue, `false` if the app is quitting.
 */
function runDatabaseGate(): boolean {
  const dir = app.getPath('userData');

  try {
    // Electron creates `userData` itself on most paths, but not guaranteed before
    // first use; `recursive` makes this a no-op when it already exists.
    mkdirSync(dir, { recursive: true });
    db = openDb(join(dir, DB_FILENAME));
    migrate(db);
  } catch (err) {
    return failStartup(
      `Could not open the local database in:\n\n  ${dir}\n\n${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return true;
}

/**
 * An error shaped so `Poller`'s duck-typed `isAuthError()` classifies it as a bad
 * credential (it matches on `code`), which surfaces in the UI as `disconnected`
 * and in the tray as "Reconnect required".
 *
 * This is the correct report for a source the user has simply never connected:
 * the alternative — returning `{ events: [] }` — would show a green "ok" for a
 * source that is not ingesting anything at all.
 */
function notConnectedError(source: PollSourceKind): Error {
  const error = new Error(`${source} is not connected: no OAuth tokens in the vault`);
  return Object.assign(error, { code: 'not_authed' });
}

/**
 * Slack connector bound to the vault rather than to a token captured at startup.
 *
 * `SlackClient` takes a fixed `token` string in its constructor (unlike
 * `GmailClient`, which accepts a token *supplier*), so a client built at boot
 * would hold whatever credential existed then — `undefined` on first run, and a
 * stale one after a reconnect. This thin adapter re-reads the vault each cycle.
 *
 * Polls every channel in {@link SlackChannelsRepo}, re-read fresh each cycle so
 * a channel added mid-session takes effect on the very next poll with no
 * restart. `Poller`'s contract is one opaque string cursor per source, but
 * there is one Slack watermark PER CHANNEL — so the cursor this class hands
 * back and forth is a JSON-encoded `{ [channelId]: perChannelCursor }` map,
 * opaque to the poller and meaningful only here. A channel that is
 * de-selected simply stops appearing as a key; its old watermark is dropped
 * along with it, which is correct — re-selecting it later should not resume
 * from a cursor the user never saw polled.
 *
 * No channels selected is a normal, healthy idle state (closes Task 1.7's
 * gap) — `{ events: [] }`, not a thrown error. A connected-but-unconfigured
 * Slack account is not the same failure as a revoked token, and conflating
 * the two would show "Reconnect required" for a user who simply has not
 * opened the channel picker yet. The vault check runs BEFORE the idle check
 * for exactly the opposite reason: a revoked/never-connected token must still
 * report `disconnected`, even with zero channels selected — otherwise a fresh
 * install with no OAuth done yet would read as a healthy, quiet source.
 *
 * One channel's failure does not fail the others. A single bad or
 * no-longer-joined channel would otherwise throw out of the loop below,
 * which — per `Poller.#runCycle` — discards every event already fetched from
 * OTHER, healthy channels in the same cycle and backs the whole source off.
 * Each channel's fetch is therefore isolated in its own try/catch; the cycle
 * only fails (and the source only backs off) when EVERY selected channel
 * failed, which is the one case where "Slack is unhealthy" is actually true.
 */
class VaultBackedSlackClient implements SourceClient<string> {
  readonly source = 'slack' as const;

  constructor(
    private readonly tokens: TokenVault,
    private readonly channels: SlackChannelsRepo,
  ) {}

  async fetchSince(cursor?: string): Promise<SourceFetchResult<string>> {
    const stored = await this.tokens.load('slack');
    if (stored === undefined) throw notConnectedError('slack');

    const selected = this.channels.list();
    if (selected.length === 0) return { events: [] };

    const cursors = parseChannelCursors(cursor);
    const client = new SlackClient({ token: stored.accessToken });

    const events: RawSourceEvent[] = [];
    const nextCursors: Record<string, string> = {};
    let failures = 0;
    let lastError: unknown;

    for (const channel of selected) {
      try {
        client.setChannel(channel.channelId);
        const result = await client.fetchSince(cursors[channel.channelId]);
        events.push(...result.events);
        if (result.cursor !== undefined) {
          nextCursors[channel.channelId] = result.cursor;
        } else if (cursors[channel.channelId] !== undefined) {
          nextCursors[channel.channelId] = cursors[channel.channelId] as string;
        }
      } catch (error) {
        failures += 1;
        lastError = error;
        console.error(`[poll] slack channel ${channel.channelId} failed`, error);
        // Keep whatever watermark this channel already had rather than losing
        // it — a transient failure should not force a re-fetch from scratch
        // once the channel recovers.
        if (cursors[channel.channelId] !== undefined) {
          nextCursors[channel.channelId] = cursors[channel.channelId] as string;
        }
      }
    }

    if (failures > 0 && failures === selected.length) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    return { events, cursor: JSON.stringify(nextCursors) };
  }
}

/**
 * Decode the per-channel cursor map {@link VaultBackedSlackClient} encodes.
 *
 * Absent or unparseable input decodes to `{}` (every channel starts fresh)
 * rather than throwing: a first-ever poll has no cursor by definition, and a
 * corrupt watermark is exactly the kind of thing that must not permanently
 * wedge a source (the same principle Task 2.5's `MAX_EPOCH_MS` guard exists
 * for on the Layer-2 side).
 */
function parseChannelCursors(cursor: string | undefined): Record<string, string> {
  if (cursor === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Build the live connectors handed to the `Poller`.
 *
 * Constructed unconditionally, even with no credentials: the poller is the only
 * writer of source health, so a source with no client would have no health at
 * all and would simply vanish from the status strip instead of reporting
 * "disconnected".
 */
function createSourceClients(
  tokens: TokenVault,
  channels: SlackChannelsRepo,
  appConfig: AppConfig,
): Record<PollSourceKind, SourceClient<unknown>> {
  const gmail = new GmailClient({
    // A supplier, not a captured string: the token is read at call time, so a
    // connect or revoke takes effect on the very next cycle without a restart.
    //
    // Goes through `ensureFreshTokens` rather than a bare `tokens.load`: a
    // Google access token lives about an hour, and without this every Gmail
    // connection quietly expired and showed up as "disconnected" regardless
    // of how healthy the underlying grant still was.
    accessToken: async () => {
      const stored = await ensureFreshTokens('gmail', { vault: tokens, config: appConfig });
      if (stored === undefined) throw notConnectedError('gmail');
      return stored.accessToken;
    },
  });

  return {
    slack: new VaultBackedSlackClient(tokens, channels) as SourceClient<unknown>,
    gmail: gmail as SourceClient<unknown>,
  };
}

/**
 * Build the ingestion pipeline over the given repos.
 *
 * Takes already-constructed repos rather than a bare handle: `graph`/`events`/
 * `watermarks` are shared with the rest of startup (Layer 1/2/3 and the IPC
 * handlers all read or write through the SAME instances), and each repo
 * prepares its whole statement set in its constructor — a second instance
 * over the same table would just redo that work for no benefit.
 *
 * `enqueueExtraction` used to be a PLACEHOLDER that only logged (Phase 2 was
 * not built yet). It is now real — see `createExtractionSweep` — but the
 * pipeline's contract is unchanged: called exactly once per genuinely new
 * event, hand-off only, no return value the pipeline waits on beyond the promise.
 */
function createPipeline(
  events: EventsRepo,
  graph: GraphRepo,
  watermarks: WatermarkRepo,
  enqueueExtraction: EnqueueExtraction,
): IngestionPipeline {
  return new IngestionPipeline(events, graph, watermarks, enqueueExtraction, systemClock);
}

/**
 * Start the poll scheduler.
 *
 * Non-blocking, unlike the preflight and database gates: an unconnected or
 * failing source is a normal state that the health strip is built to display,
 * not a reason to refuse to start.
 */
function startPolling(
  appConfig: AppConfig,
  tokens: TokenVault,
  channels: SlackChannelsRepo,
  pipeline: IngestionPipeline,
): Poller {
  const scheduler = new Poller({
    clock: systemClock,
    sources: createSourceClients(tokens, channels, appConfig),
    config: appConfig,
    // The real sink: normalize → redact → persist → enqueue (Task 1.6).
    //
    // Deliberately NOT wrapped in a try/catch. `Poller.#runCycle` awaits this
    // callback inside its own try/catch and, per Task 1.5's design, treats a
    // rejection as a FAILED cycle — it does not advance `lastSyncAt` and it
    // backs the source off. Swallowing a persistence failure here would instead
    // report a healthy sync for events that never reached the database, and the
    // cursor would move past them.
    onEvents: async (source: PollSourceKind, events: RawSourceEvent[]) => {
      if (events.length === 0) return;
      const outcomes = await pipeline.ingestBatch(events);
      const ingested = outcomes.filter((o) => o.status === 'ingested').length;
      console.info(
        `[poll] ${source}: ${events.length} event(s) fetched, ` +
          `${ingested} persisted, ${outcomes.length - ingested} duplicate`,
      );
    },
  });
  scheduler.start();
  return scheduler;
}

/* -------------------------------------------------------------------------- */
/* Layer 3 — briefing generation (Phase 3 integration)                        */
/* -------------------------------------------------------------------------- */

/**
 * Blocking startup gate: opens (creating on first run) the LanceDB table
 * directory at `%APPDATA%/context-restorer/vectors/` (design doc §4.1).
 *
 * Blocking, like the database gate and for the same reason. The vector store is
 * not an optional accelerator: it IS retrieval, and retrieval's output is the
 * citation allowlist. A briefing generated with no vector store does not fail —
 * it succeeds with an empty allowlist and reports "nothing to say", which is
 * indistinguishable, on screen, from a genuinely quiet week. Being told nothing
 * happened when in fact the store was broken is precisely the kind of quiet
 * wrongness this app must not have.
 *
 * @returns `true` if startup may continue, `false` if the app is quitting.
 */
async function runVectorGate(): Promise<boolean> {
  const dir = join(app.getPath('userData'), VECTORS_DIRNAME);

  try {
    vectors = await openVectors(dir);
  } catch (err) {
    return failStartup(
      `Could not open the local vector store in:\n\n  ${dir}\n\n${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return true;
}

/** Repos `main.ts` already holds; passed in so nothing is constructed twice. */
interface SharedRepos {
  graph: GraphRepo;
  briefings: BriefingsRepo;
  pending: PendingItemsRepo;
  watermarks: WatermarkRepo;
}

/**
 * Collaborators Layer 1, Layer 2 and Layer 3 all need, built once so there is
 * exactly one Ollama client, one embedding closure, one `RetrievalService` and
 * one `ai_calls` sink for the whole process. Splitting this out of
 * {@link createLayer3} (which used to build all of it privately) is what lets
 * {@link createLayer12} share the SAME instances rather than opening a second
 * Ollama connection and a second `ai_calls` table view that the Diagnostics
 * panel would then have to reconcile.
 */
interface SharedAiDeps {
  ollama: OllamaClient;
  embed: EmbedFn;
  retrieval: RetrievalService;
  deltas: DeltasRepo;
  aiCalls: AiCallsRepo;
}

/**
 * Build {@link SharedAiDeps} over the live stores.
 *
 * @param handle Open database handle, for the two repos built here.
 * @param appConfig Supplies the Ollama endpoint/model names.
 * @param store The LanceDB vector store `RetrievalService` searches.
 * @param graph Read by `RetrievalService` for graph-neighbour expansion.
 */
function createSharedAiDeps(
  handle: Db,
  appConfig: AppConfig,
  store: VectorStore,
  graph: GraphRepo,
): SharedAiDeps {
  const ollama = createOllamaClient(
    appConfig.model.ollamaBaseUrl,
    appConfig.model.chat,
    appConfig.model.embed,
  );

  // `OllamaClient.embed` is batch (`string[] → number[][]`); retrieval wants one
  // vector for one string. A missing row is thrown on rather than defaulted to
  // `[]`: an empty query vector would silently return arbitrary neighbours.
  const embed: EmbedFn = async (text: string): Promise<number[]> => {
    const [vector] = await ollama.embed([text]);
    if (vector === undefined) {
      throw new Error(`embedding model ${appConfig.model.embed} returned no vector`);
    }
    return vector;
  };

  const retrieval = new RetrievalService(store, graph, appConfig, embed);

  // Shared by every layer: one prepared statement set each, and one `ai_calls`
  // sink, so the audit trail reads as a single stream regardless of which
  // layer answered.
  const deltas = new DeltasRepo(handle);
  const aiCalls = new AiCallsRepo(handle);

  return { ollama, embed, retrieval, deltas, aiCalls };
}

/** Both steps of the X-3 fallback chain, over one shared set of repos. */
interface Layer3 {
  /** Chain step 1: the local model. */
  generator: BriefingGenerator;
  /** Chain step 2: deterministic, model-free rendering of stored rows. */
  templateRenderer: TemplateBriefingRenderer;
  /** The one `ai_calls` sink both chain steps share — exposed for the read-only metrics panel (Task 4.4). */
  aiCalls: AiCallsRepo;
  /** Where both chain steps write `trace-YYYY-MM-DD.jsonl` — exposed for the same reason. */
  logsDir: string;
}

/**
 * Assemble Layer 3 over the live stores — both chain steps (X-3).
 *
 * Everything here is real: the local Ollama client, `RetrievalService` over the
 * LanceDB store, and `CitationGate` over the same `GraphRepo` the IPC handlers
 * read — the gate must resolve artifacts against the graph the drill-down panel
 * will later show, or "cited" and "verifiable" stop meaning the same thing.
 *
 * The template renderer is built here, beside the generator, from the SAME repo
 * instances (`shared.deltas`, `shared.aiCalls`, and everything in
 * {@link SharedRepos}). Two things follow from that, and both matter. The
 * renderer reads exactly the rows the generator ranked, so the fallback cannot
 * disagree with the LLM path about what happened in the window; and no
 * statement set is prepared twice.
 *
 * Note what the renderer is NOT handed: `ollama`, `retrieval`, `store`. Step 2
 * of the chain has no way to reach a model — that is the structural guarantee
 * `packages/ai/src/layer3/template.ts` documents, and it only holds if this call
 * site respects it. Do not pass a model client in.
 *
 * `narrativeDir` is `userData` itself, not `userData/briefings`: both the
 * generator and the renderer append `briefings/<id>.md` internally (§4.1).
 */
function createLayer3(shared: SharedAiDeps, appConfig: AppConfig, repos: SharedRepos): Layer3 {
  const userData = app.getPath('userData');
  const traceSink = { logsDir: join(userData, LOGS_DIRNAME) };

  const generator = new BriefingGenerator(
    shared.ollama,
    shared.retrieval,
    shared.deltas,
    repos.briefings,
    new CitationGate(repos.graph),
    repos.watermarks,
    repos.graph,
    repos.pending,
    shared.aiCalls,
    appConfig,
    userData,
    appConfig.model.chat,
    // `promptVersions.layer3` is the bare version (`"v1"`); the audit row wants
    // the full prompt name, which is what `config/prompts/layer3-brief.v1.md`
    // is called.
    `layer3-brief.${appConfig.promptVersions.layer3}`,
    systemClock,
    traceSink,
  );

  const templateRenderer = new TemplateBriefingRenderer(
    shared.deltas,
    repos.pending,
    repos.briefings,
    repos.graph,
    repos.watermarks,
    shared.aiCalls,
    appConfig,
    userData,
    systemClock,
    traceSink,
  );

  return { generator, templateRenderer, aiCalls: shared.aiCalls, logsDir: traceSink.logsDir };
}

/** Layer 1 extraction plus the Layer 2 debounce trigger that fires synthesis. */
interface Layer12 {
  /** Drains `EventsRepo.listUnextracted()` through Layer 1. Never rejects. */
  runExtractionSweep: () => Promise<void>;
  /** D-7 debounce trigger; caller owns the timer (see its own doc comment). */
  scheduler: DebounceScheduler;
}

/**
 * Assemble Layer 1 (event extraction) and Layer 2 (state synthesis + its D-7
 * debounce trigger) over the live stores.
 *
 * This is the wiring `apps/desktop/src/main.ts` never had: ingestion persisted
 * events and armed the D-7 watermark correctly (`IngestionPipeline`, `@cr/ingest`),
 * but the hand-off to Layer 1 was a placeholder that only logged, and nothing
 * ever constructed a `DebounceScheduler` to drive Layer 2. Both layers were
 * already implemented and unit-tested in `@cr/ai` — this just connects them,
 * the same way `packages/eval/src/harness.ts` already does for the eval
 * pipeline (that file is the reference this mirrors).
 *
 * `events.listUnextracted()` — not the ingestion hand-off's `eventId` — is what
 * actually drives Layer 1, for the same reason the eval harness does it that
 * way: it is the system's own definition of outstanding work, so a worker that
 * crashed mid-extraction or a response that failed the schema check (no
 * `extractions` row written) is indistinguishable from "never attempted" and
 * both are correctly retried on the very next sweep, ingestion-triggered or not.
 *
 * @param shared The Ollama client, embedder, retrieval service, and `deltas`/
 *   `aiCalls` repos, shared with Layer 3 (see {@link createSharedAiDeps}).
 * @param appConfig Supplies the chat model name, prompt versions, and
 *   `config.debounce` (D-7 quiet-window/hard-cap thresholds).
 * @param handle Open database handle, for `ExtractionsRepo`.
 * @param vectors Chunk store Layer 1 writes non-noise extractions into.
 * @param events Read for the extraction work-list; also gives the scheduler's
 *   trace an events-per-thread count.
 * @param pending Obligation store Layer 2 derives `pending_item` rows into.
 * @param watermarks D-7 state. The SAME instance `IngestionPipeline` arms —
 *   Layer 2 never touches it directly (see `layer2/synthesize.ts`'s own note);
 *   only the scheduler does, on a resolved `onSynthesize`.
 * @param logsDir Where the scheduler's per-trigger trace JSONL lands, so
 *   `debug:metrics`'s "Synthesis triggers" panel sees real data.
 */
function createLayer12(
  shared: SharedAiDeps,
  appConfig: AppConfig,
  handle: Db,
  vectors: VectorStore,
  events: EventsRepo,
  pending: PendingItemsRepo,
  watermarks: WatermarkRepo,
  logsDir: string,
): Layer12 {
  const extractions = new ExtractionsRepo(handle);

  const extractor = new Layer1Extractor(
    shared.ollama,
    extractions,
    vectors,
    shared.aiCalls,
    shared.embed,
    appConfig.model.chat,
    // Layer 1's own doc contract (`layer1/extract.ts`) is the bare version
    // string, unlike Layer 2/3's `<template-name>.<version>` — the two layers
    // disagree on this and each is followed on its own terms here.
    appConfig.promptVersions.layer1,
    systemClock,
  );

  const runExtractionSweep = async (): Promise<void> => {
    for (const event of events.listUnextracted()) {
      try {
        await extractor.extractEvent(event, newId());
      } catch (error) {
        // Never let one bad event stop the sweep: `listUnextracted()` will
        // offer this same event again on the next sweep, which is the
        // self-healing property the whole design relies on.
        console.error('[layer1] extraction failed', event.eventId, error);
      }
    }
  };

  const synthesizer = new Layer2Synthesizer(
    shared.ollama,
    shared.retrieval,
    shared.deltas,
    pending,
    watermarks,
    shared.aiCalls,
    appConfig.model.chat,
    `layer2-synthesize.${appConfig.promptVersions.layer2}`,
    systemClock,
  );

  const scheduler = new DebounceScheduler({
    clock: systemClock,
    config: appConfig.debounce,
    watermarks,
    onSynthesize: (threadKey, traceId) => synthesizer.synthesize(threadKey, traceId),
    countThreadEvents: (threadKey) => events.listByThread(threadKey).length,
    logsDir,
  });

  return { runExtractionSweep, scheduler };
}

/**
 * Push one payload to the live renderer, if there is one.
 *
 * Reads the module-level `win` at send time rather than capturing it, the same
 * way `ipc/health.ts`'s push does: the window survives `close` (it only hides),
 * but it can be destroyed and re-created (`activate` on macOS), and a send to a
 * destroyed `webContents` throws from a context with no caller to catch it.
 *
 * A dropped chunk is not an error worth failing generation over — the claim is
 * already persisted, and the narrative file and `briefing_claims` remain the
 * durable record.
 */
function sendToRenderer(channel: string, payload: BriefingChunk | BriefingDone): void {
  if (win === null || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

/**
 * Build the renderer-facing {@link Citation} for one accepted claim.
 *
 * The gate guarantees every cited id resolves in the graph, so the artifact
 * lookup is expected to succeed; the event lookup is best-effort. `Citation`
 * requires an `eventId`, and the honest one for an artifact is the most recent
 * event on its thread — which is exactly what `resolveEvents(..., maxEvents: 1)`
 * returns, reusing the same resolution FR-6's drill-down performs rather than
 * inventing a second, divergent notion of "where this came from".
 *
 * The first cited id is used, matching `briefing_claims.citation_artifact_id`
 * (single-valued in the schema), so the chip the user clicks and the row the
 * database stores point at the same artifact.
 *
 * @returns `undefined` when the artifact cannot be resolved at all — better to
 * omit the chunk than to guess a `source` and render a citation that leads
 * nowhere.
 */
function citationFor(
  artifactIds: readonly string[],
  graph: GraphRepo,
  events: EventsRepo,
): Citation | undefined {
  const artifactId = artifactIds[0];
  if (artifactId === undefined) return undefined;

  const artifact = graph.getArtifact(artifactId);
  if (artifact === undefined) {
    console.error('[briefing] accepted claim cites an unresolvable artifact', artifactId);
    return undefined;
  }

  const [latest] = resolveEvents(artifactId, { artifacts: graph, events, maxEvents: 1 });
  const externalUrl =
    latest === undefined ? undefined : deepLinkFor(latest.source, latest.sourceEventId);

  return {
    eventId: latest?.eventId ?? '',
    artifactId,
    source: latest?.source ?? artifact.source,
    // `exactOptionalPropertyTypes`: an absent link is an absent KEY.
    ...(externalUrl !== undefined ? { externalUrl } : {}),
  };
}

/**
 * The `IpcDeps.startGeneration` adapter: run the Layer 3 fallback chain for an
 * id the renderer has ALREADY been handed, streaming each accepted claim to it
 * as it lands.
 *
 * Fire-and-forget by contract (`briefing:request` returns before this is
 * called), so this function returns `void` and owns every failure itself:
 * an escaping rejection here is an unhandled rejection in the main process.
 *
 * Routed through `generateWithFallback` rather than calling `generate` directly
 * (X-3, Task 4.3): local model, then local code. When Ollama is not running, or
 * dies mid-sentence, the user still gets a cited briefing assembled from the
 * deltas already on disk — and `result.mode` tells the renderer which they got,
 * so the "Simplified briefing" banner is driven by what actually happened.
 *
 * The `briefingId` is passed straight through, which is the whole point of that
 * option — without it the chain would mint its own and every chunk, every
 * persisted claim and the `briefings` row would carry an id the renderer has
 * never heard of. Both chain steps honour `onClaimAccepted`, so the stream
 * paints the same way on either branch.
 */
function startBriefingGeneration(
  generator: BriefingGenerator,
  templateRenderer: TemplateBriefingRenderer,
  appConfig: AppConfig,
  graph: GraphRepo,
  events: EventsRepo,
  briefingId: string,
  window: { windowStart: number; windowEnd: number },
): void {
  const startedAt = systemClock.now();

  const onClaimAccepted = (chunk: AcceptedClaimChunk): void => {
    const citation = citationFor(chunk.citationArtifactIds, graph, events);
    if (citation === undefined) return;
    sendToRenderer(CHUNK_CHANNEL, {
      briefingId,
      section: chunk.section,
      claim: chunk.text,
      citation,
    });
  };

  generateWithFallback(
    generator,
    templateRenderer,
    appConfig.model.ollamaBaseUrl,
    appConfig.model.chat,
    appConfig.model.embed,
    window,
    { briefingId, onClaimAccepted },
  ).then(
    (result) => {
      sendToRenderer(DONE_CHANNEL, {
        briefingId,
        mode: result.mode,
        threadsStillProcessing: result.threadsStillProcessing,
        timings: {
          firstTokenMs: result.timings.firstTokenMs ?? 0,
          // `BriefingGenerationResult` carries the five stage timings but not a
          // total (the generator persists its own `total_ms` and does not return
          // it). Measured here instead, which is in any case the number the
          // renderer's own `timings` field means: how long the user waited from
          // the request being dispatched to the stream ending.
          totalMs: systemClock.now() - startedAt,
        },
      });
    },
    (error: unknown) => {
      // `generateWithFallback` is documented as never rejecting: a failed
      // preflight, a failed `generate()` and a dead stream all end in a template
      // render. So this branch means the FALLBACK itself threw — the renderer's
      // own database writes failed, or something equally structural — and there
      // is nothing left to publish for this window.
      //
      // Kept anyway, because the renderer is sitting on `aria-busy` showing
      // "Still writing…" and will do so forever unless it is told the stream
      // ended. `BriefingDone` has no error variant, and adding one would mean
      // changing the preload contract from an integration task; `mode:
      // 'template'` is the closest the existing type offers, and the briefing
      // ends up visibly finished and visibly empty rather than eternally in
      // progress. The main-process log below is where the actual cause lives.
      console.error('[briefing] fallback chain failed', briefingId, error);
      sendToRenderer(DONE_CHANNEL, {
        briefingId,
        mode: 'template',
        // Re-read rather than reported as 0: a failure is exactly when the
        // backlog disclosure matters most, and claiming "0 threads still
        // processing" for a run that never got far enough to measure would be a
        // fabricated reassurance.
        threadsStillProcessing: pendingSynthesisCount(),
        timings: { firstTokenMs: 0, totalMs: systemClock.now() - startedAt },
      });
    },
  );
}

/** OI-1 backlog size, or 0 when it cannot be read. Never throws. */
function pendingSynthesisCount(): number {
  try {
    return watermarks?.countPendingSynthesis() ?? 0;
  } catch (error) {
    console.error('[briefing] could not count pending synthesis', error);
    return 0;
  }
}

/**
 * Blocking startup gate: verifies the local Ollama instance is reachable and both
 * required models are pulled.
 *
 * The app must never silently start in a degraded state on first run. On failure this
 * shows a native modal naming the problem and the exact remedy command, then quits.
 * (Phase 3 replaces this with a real in-app onboarding panel.)
 *
 * Runs AFTER {@link runDatabaseGate}, not before, specifically so it can read a
 * persisted `model:setChat` override (Settings page) and apply it to `config`
 * before probing Ollama — and before anything downstream (`BriefingGenerator`,
 * the schedule runner, …) captures `config.model.chat` for the rest of the
 * process's life. A user who picked a smaller model must have THAT model
 * preflighted and used everywhere, not the config file's original default.
 *
 * @returns `true` if startup may continue, `false` if the app is quitting.
 */
async function runPreflightGate(): Promise<boolean> {
  let message: string | null = null;

  try {
    // Retained module-level: the poller and the OAuth handlers both read it.
    config = loadConfig(CONFIG_PATH);
    defaultChatModel = config.model.chat;

    // `db!` is safe here: `runDatabaseGate()` now runs before this gate (see
    // `app.whenReady()` below) and returns `false` — aborting startup before
    // this function is even called — if it did not succeed.
    appSettings = new AppSettingsRepo(db!);
    const chatOverride = appSettings.get(CHAT_MODEL_SETTING_KEY);
    if (chatOverride !== null && chatOverride !== '') {
      config = { ...config, model: { ...config.model, chat: chatOverride } };
    }

    const result = await preflight(
      config.model.ollamaBaseUrl,
      config.model.chat,
      config.model.embed,
    );
    if (!result.ok) {
      message =
        result.reason === 'unreachable'
          ? (result.message ?? `Ollama is unreachable at ${config.model.ollamaBaseUrl}.`)
          : `Missing model. Run:\n\n  ${result.remedy}`;
    }
  } catch (err) {
    // A missing or invalid config file must also fail loudly, not as a native crash.
    message = `Could not load configuration from:\n\n  ${CONFIG_PATH}\n\n${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  if (message === null) return true;
  return failStartup(message);
}

/** Set once the user has genuinely asked to quit, so `close` stops being intercepted. */
let isQuitting = false;

// Single instance: a second launch focuses the resident window instead of starting a
// duplicate poller against the same SQLite database.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(
    async () => {
      // Gates: all three must block before any window exists. The database gate
      // now runs FIRST: the preflight gate reads a persisted `model:setChat`
      // override out of it before probing Ollama (see `runPreflightGate`'s own
      // comment), so `db` must already exist by the time preflight runs. The
      // preflight gate is also what loads `config`, which every dependency below
      // needs, so nothing else can be constructed ahead of it. The vector gate
      // runs last of the three because it is the most expensive and the least
      // likely to fail — no point building a LanceDB table for a process that
      // is quitting over a missing model.
      if (!runDatabaseGate()) return;
      if (!(await runPreflightGate())) return;
      if (!(await runVectorGate())) return;

      // Electron's real `safeStorage` satisfies `SafeStorageLike` structurally
      // (`isEncryptionAvailable`/`encryptString`/`decryptString`, identical
      // signatures), so it is passed straight through — no adapter, and the vault
      // stays unit-testable under plain Node with a fake.
      vault = new TokenVault(safeStorage, join(app.getPath('userData'), VAULT_FILENAME));

      // `db!` is safe by construction: this is the same sequential `whenReady`
      // continuation, and `runDatabaseGate()` returned `true` two lines above —
      // which it only does after assigning `db`. Nothing runs in between.
      //
      // Built here, ahead of the pipeline and the poller, because the pipeline
      // now needs `graph`/`events`/`watermarks` themselves (Layer 1/2 wiring,
      // below) rather than constructing its own private copies.
      // `pending`/`graph` power the first-paint path (Task 3.5): `briefing:pending`
      // reads them directly, with no model in the dependency set — which is what
      // makes "first content on screen without waiting for Ollama" structural.
      // One `GraphRepo` for both consumers: each prepares its whole statement set
      // in its constructor, and the briefing path's `StakesReader` is a narrow
      // view of exactly this object.
      const graph = new GraphRepo(db!);
      const events = new EventsRepo(db!);
      const pending = new PendingItemsRepo(db!);
      const briefings = new BriefingsRepo(db!);
      const schedules = new BriefingSchedulesRepo(db!);
      watermarks = new WatermarkRepo(db!);

      // Layer 3, assembled before the handler table so `startGeneration` is the
      // real chain from the very first `briefing:request` — a window in which
      // the placeholder was still installed would hand the renderer an id it
      // would never see a chunk for.
      const sharedAiDeps = createSharedAiDeps(db!, config!, vectors!, graph);
      const layer3 = createLayer3(sharedAiDeps, config!, {
        graph,
        briefings,
        pending,
        watermarks,
      });
      briefingGenerator = layer3.generator;
      templateBriefingRenderer = layer3.templateRenderer;
      const { generator, templateRenderer, aiCalls, logsDir } = layer3;

      // Layer 1 (event extraction) + Layer 2 (state synthesis, D-7 debounce
      // trigger) — the wiring that used to be the "Phase 2" placeholder. Built
      // from the SAME `sharedAiDeps`/`graph`/`pending`/`watermarks` as Layer 3
      // above, so every layer's `ai_calls` rows land in one sink and the
      // Diagnostics panel's per-layer table means what it says.
      const layer12 = createLayer12(
        sharedAiDeps,
        config!,
        db!,
        vectors!,
        events,
        pending,
        watermarks,
        logsDir,
      );

      // Catch up on anything ingested before this wiring existed (or before
      // this launch). Fire-and-forget, not awaited: real model inference per
      // backlogged event can take well over a minute on this hardware, and
      // startup (window, IPC, tray) must not hang on it.
      //
      // The debounce scheduler is armed only once the sweep resolves, not
      // alongside it — a `tick()` racing ahead of extraction could see a
      // thread as "due" (quiet window already passed, which is exactly the
      // backlog case) and synthesize it with no context yet written, which
      // `markSynthesized` would then mark caught-up until the NEXT new event
      // arrives on that thread. After this first catch-up, steady-state
      // ingestion extracts synchronously per event (see `createPipeline`
      // below), well inside any thread's quiet window, so no such race
      // recurs on later ticks.
      void layer12.runExtractionSweep().then(() => {
        void layer12.scheduler.tick();
        debounceTimer = setInterval(() => void layer12.scheduler.tick(), 30_000);
        // Never keep the process alive solely to fire this — same reasoning
        // as the scheduler's own timeout timers.
        debounceTimer.unref();
      });

      const pipeline = createPipeline(events, graph, watermarks, () =>
        layer12.runExtractionSweep(),
      );
      // Read by the poller every Slack cycle and by `slack:*` IPC — one
      // instance, since each repo prepares its whole statement set in its
      // constructor.
      const slackChannels = new SlackChannelsRepo(db!);
      poller = startPolling(config!, vault, slackChannels, pipeline);

      registerIpcHandlers({
        vault,
        poller,
        config: config!,
        pending,
        graph,
        // Task 4.4 step 4: the local metrics view (per-layer call stats, briefing
        // latency percentiles, gate drop reasons from the trace). Read-only, and
        // `metricsBriefings` is deliberately the SAME `briefings` instance passed
        // above — see the field's own doc comment for why that's still a
        // separate, narrower-typed field rather than reuse.
        metricsAiCalls: aiCalls,
        metricsBriefings: briefings,
        logsDir,
        // OI-3 onboarding (Task 3.1): `projects:suggest` mines the event log for
        // candidates, `projects:declare` writes them, `onboarding:status` reports
        // the gate the briefing action is disabled behind.
        //
        // These same two repos also back FR-6 `claim:drilldown`: it resolves the
        // artifact out of `projectStore` (the full `GraphRepo`) and the thread's
        // raw events out of `events`. No extra dependency, and deliberately the
        // SAME instances — a second `EventsRepo`/`GraphRepo` over the same handle
        // would re-prepare every statement for no benefit.
        events,
        projectStore: graph,
        // Layer 3, live. The adapter exists for one reason: `briefing:request`
        // mints the id and hands it to the renderer BEFORE generation starts,
        // whereas `generate()` would otherwise mint its own — so the id is
        // threaded through, and every claim, chunk and row carries the id the
        // renderer is already listening on.
        startGeneration: (briefingId, window) =>
          startBriefingGeneration(
            generator,
            templateRenderer,
            config!,
            graph,
            events,
            briefingId,
            window,
          ),
        // FR-3 recurring briefings (Task 3.8): the settings editor. The
        // `BriefingScheduleRunner` that acts on these rows is started below,
        // over this same repo instance.
        schedules,
        // FR-11 completion signal + FR-12 verdicts (Task 3.7).
        //
        // `BriefingsRepo` also backs the NFR-10 `briefing:metrics` view and is
        // the SAME instance Layer 3 persists through and the schedule runner
        // reads `getMostRecent()` from — one prepared statement set, and no way
        // for two views of "the briefings table" to disagree.
        feedback: new FeedbackRepo(db!),
        briefings,
        clock: systemClock,
        // Slack channel selector settings surface (closes Task 1.7's gap). Same
        // instance the poller reads every cycle — see the comment above.
        slackChannels,
        // Chat-model picker (Settings page). `appSettings`/`defaultChatModel`
        // are set by `runPreflightGate`, which always runs before this point.
        modelSettings: appSettings!,
        defaultChatModel: defaultChatModel!,
      });

      // FR-3, the acting half: saved schedules now actually fire. Called WITHOUT
      // a pre-minted id or a chunk callback — a scheduled run has no renderer
      // waiting on a handle, so the chain mints its own id and its completion is
      // announced by the OS notification instead of by `briefing:done`.
      //
      // Same two objects and the same `generateWithFallback` call as the IPC
      // path above, which is what makes "a scheduled briefing runs the identical
      // generation path, fallback included" structural rather than a claim. A
      // schedule that fires overnight is in fact the case most likely to find
      // Ollama down, so it is the last place that should be missing step 2.
      scheduleRunner = new BriefingScheduleRunner({
        clock: systemClock,
        schedules,
        briefings,
        generate: (window) =>
          generateWithFallback(
            generator,
            templateRenderer,
            config!.model.ollamaBaseUrl,
            config!.model.chat,
            config!.model.embed,
            window,
          ),
        notify,
      });
      // `start()` owns its own cadence: chained one-shot timers at
      // `TICK_INTERVAL_MS` (60s), armed only once the previous tick has settled.
      // Deliberately NOT a bare `setInterval` — generation can take tens of
      // seconds, and an interval would queue ticks behind it and then fire them
      // back-to-back.
      scheduleRunner.start();

      // Task 4.6, and strictly before any window exists: the CSP is injected on
      // response headers, and a response already delivered cannot be
      // retro-fitted with a policy. `session.defaultSession` is also only
      // available after `whenReady`, which is why this cannot sit next to
      // `registerAppSchemePrivileges()` at module scope.
      registerContentSecurityPolicy();

      await createWindow();
      // The health push needs a live window to send to, so it can only be wired
      // here. `updateTrayStatus` rides the same payload, which is what keeps the
      // tray and the status strip from ever disagreeing.
      stopHealthPush = startHealthPush(win!, poller, { onHealth: updateTrayStatus });

      // Same reasoning, same live-window requirement: the pipeline-activity
      // strip needs somewhere to push to. `layer12.scheduler` is the SAME
      // `DebounceScheduler` instance driving real synthesis (see above), so
      // this can never disagree with what is actually running.
      stopPipelineStatusPush = registerPipelineStatusPush(win!, {
        events,
        watermarks: watermarks!,
        scheduler: layer12.scheduler,
        debounce: config!.debounce,
        clock: systemClock,
      });

      createTray(win!, poller);
      registerAutostart();
    },
    (err: unknown) => {
      console.error('[main] startup failed', err);
      app.exit(1);
    },
  );

  // macOS: clicking the dock icon with no windows open re-creates one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    } else {
      win?.show();
    }
  });

  app.on('window-all-closed', () => {
    // Tray app: stay resident, do not quit when the window closes.
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopHealthPush?.();
    stopHealthPush = null;
    stopPipelineStatusPush?.();
    stopPipelineStatusPush = null;
    // Cancels pending timers; an in-flight cycle is allowed to finish.
    poller?.pause();
    poller = null;
    // Same contract as the poller: the next tick is cancelled, an in-flight
    // generation is left to finish (its schedule is already stamped, so it
    // cannot replay on the next launch).
    scheduleRunner?.stop();
    scheduleRunner = null;
    // The debounce scheduler has no `stop()` of its own (see its doc comment);
    // clearing the caller-owned interval is the entire contract. An in-flight
    // `tick()` is left to finish — its own `inFlight` guard prevents overlap.
    if (debounceTimer !== null) clearInterval(debounceTimer);
    debounceTimer = null;
    briefingGenerator = null;
    templateBriefingRenderer = null;
    watermarks = null;
    // LanceDB holds no explicit handle to close; dropping the reference is all
    // there is to do, and its writes are committed per call rather than buffered.
    vectors = null;
    destroyTray();
    // Checkpoints the WAL; skipping it leaves `-wal`/`-shm` files beside the db.
    db?.close();
    db = null;
  });
}
