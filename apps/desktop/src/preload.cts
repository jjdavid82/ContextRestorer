/**
 * Preload bridge — the *entire* renderer-visible IPC surface.
 *
 * This file is deliberately a `.cts` module: `webPreferences.sandbox` is `true`, and
 * Electron only supports **CommonJS** preload scripts in sandboxed renderers. The `.cts`
 * extension makes `tsc` emit `dist/preload.cjs` (CommonJS) regardless of the package's
 * `"type": "module"` and the shared `"module": "NodeNext"` setting. Keep the extension.
 *
 * Design rules (do not relax without a security review):
 *  1. No generic `invoke(channel, args)` passthrough. A passthrough would make the
 *     channel allowlist meaningless: any XSS in the renderer (which displays untrusted
 *     ingested email/Slack text) could reach every main-process handler. Each channel
 *     gets its own named method.
 *  2. Arguments are shape-checked here before crossing the bridge. This is a cheap first
 *     gate, *not* the authoritative one — main-process handlers must re-validate, since
 *     a compromised renderer controls what it sends.
 *  3. Only structured-cloneable plain data crosses `contextBridge`; no functions, no
 *     `ipcRenderer` itself, no Node primitives.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/* -------------------------------------------------------------------------- */
/* Payload types                                                              */
/* -------------------------------------------------------------------------- */

/** The two ingestion sources supported in v1. */
export type Source = 'slack' | 'gmail';

/** Feedback verdicts; mirrors the `feedback.verdict` CHECK constraint in the store. */
export type FeedbackVerdict = 'relevant' | 'irrelevant' | 'missed' | 'wrong';

export interface OnboardingStatus {
  /** Sources with a live, non-revoked credential. */
  sourcesConnected: Source[];
  /** Project names the user has declared (onboarding requires >= 3). */
  projectsDeclared: string[];
  /** Whether the local Ollama endpoint answered a health probe. */
  ollamaReady: boolean;
}

/** `model:get` — the chat-model picker (Settings page). */
export interface ModelInfo {
  /** Currently effective chat model: a persisted override if set, else `defaultChat`. */
  chat: string;
  /** `config/default.json`'s own choice, so the UI can label it as the default. */
  defaultChat: string;
  /** Every model Ollama currently reports as installed. Empty if Ollama is unreachable. */
  available: string[];
}

export interface OkResult {
  ok: boolean;
  /**
   * Machine-readable failure cause, present only when `ok` is false.
   *
   * Deliberately a plain string rather than a closed union: it is rendered, not
   * branched on, and every handler that fails must be able to say *why* without
   * first widening a shared type. Values emitted today by `oauth:connect`:
   * `not_configured` (no OAuth client id for that source), `state_mismatch`,
   * `timeout`, `exchange_failed`, `vault_error`, `internal_error`.
   */
  reason?: string;
}

export interface ProjectCandidate {
  name: string;
  /** Where the candidate was inferred from, e.g. a Slack channel or Gmail label. */
  source: Source;
  /** Number of observed artifacts backing this candidate. */
  evidenceCount: number;
  /**
   * Human-readable justification, e.g. `you posted 23 times in #api-redesign`.
   *
   * Optional so the contract survives a suggester that has no explanation to
   * offer; `@cr/ingest`'s `suggestProjects` always populates it.
   */
  reason?: string;
}

export interface ProjectSuggestions {
  candidates: ProjectCandidate[];
}

/**
 * A declared project with its id (A-2).
 *
 * `OnboardingStatus.projectsDeclared` carries names only, which is enough for a
 * status line. Tagging a Slack channel writes a foreign key, and a name is not
 * a key — hence this.
 */
export interface DeclaredProject {
  projectId: string;
  name: string;
}

/** Half-open briefing window `[windowStart, windowEnd)`, epoch milliseconds. */
export interface BriefingWindow {
  windowStart: number;
  windowEnd: number;
}

export interface BriefingHandle {
  briefingId: string;
}

/**
 * A pending item rendered on first paint, before any LLM output exists.
 *
 * A projection of the `pending_items` row (`@cr/core`'s `PendingItem`) down to the
 * fields the renderer actually paints. `citationArtifactId` is nullable for the same
 * reason it is in the store: a template-mode item can exist without a resolved artifact.
 */
export interface PendingItem {
  pendingId: string;
  description: string;
  /** Model confidence in [0, 1]; drives the low-confidence flag in the UI. */
  confidence: number;
  /** Artifact backing this item; feeds `claim.drilldown` and the external deep link. */
  citationArtifactId: string | null;
  /**
   * A short verbatim quote from the message behind this obligation (P4).
   *
   * The artifact's own text, never model output — it is the evidence for the
   * claim above it, which is why obligations show it inline while the changed
   * list does not. `null` when it could not be resolved.
   */
  sourceQuote: string | null;
}

/** A citation anchoring a claim to a concrete ingested event. */
export interface Citation {
  eventId: string;
  artifactId: string;
  source: Source;
  /** Deep link back into Slack/Gmail. */
  externalUrl?: string;
}

/** One validated claim, streamed as it is produced. */
export interface BriefingChunk {
  briefingId: string;
  section: string;
  claim: string;
  citation: Citation;
}

/**
 * How the briefing narrative was produced. Mirrors the `briefings.mode` column
 * (`'llm' | 'template'`) and `@cr/core`'s `BriefingMode`; `'template'` is the
 * deterministic fallback taken when the LLM path fails.
 */
export type BriefingMode = 'llm' | 'template';

export interface BriefingDone {
  briefingId: string;
  /** `'template'` means the LLM path failed and the fallback renderer ran. */
  mode: BriefingMode;
  threadsStillProcessing: number;
  /**
   * Streaming latency telemetry, in milliseconds. These are exactly the two values
   * persisted as `briefings.first_token_ms` / `briefings.total_ms`, not an open-ended
   * bag of stage timings.
   */
  timings: {
    firstTokenMs: number;
    totalMs: number;
  };
}

/**
 * `briefing:snapshot` result — what could be rehydrated for an already-
 * requested briefing, from what is actually persisted rather than from a live
 * stream.
 *
 * Exists because navigating to Settings and back is a real page load (see
 * `layout.tsx`'s nav), which drops every `briefing:chunk`/`briefing:done`
 * subscription. `found: false` covers an unknown id, a not-yet-created row,
 * and a read failure alike; the renderer's response — fall back to the live
 * stream — is the same in all three.
 */
export interface BriefingSnapshot {
  found: boolean;
  claims: BriefingChunk[];
  /** `null` while the briefing is still generating. */
  done: BriefingDone | null;
}

export interface DrilldownEvent {
  eventId: string;
  source: Source;
  occurredAt: number;
  author: string;
  text: string;
  externalUrl?: string;
}

export interface Drilldown {
  claimId: string;
  events: DrilldownEvent[];
}

export interface FeedbackSubmission {
  briefingId: string;
  claimId?: string;
  verdict: FeedbackVerdict;
  note?: string;
}

/**
 * `briefing:caughtUp` result (FR-11).
 *
 * Widens {@link OkResult} rather than replacing it, so every existing caller
 * that only reads `ok`/`reason` keeps compiling untouched.
 *
 * Both extra fields are present only when `ok` is true. `caughtUpAt` is the
 * **authoritative** stamp: the channel is idempotent, so a second (or third)
 * tap of the button returns the timestamp written by the FIRST one, not the
 * current clock. `timeToReEntryMs` is NFR-10's metric — `caughtUpAt` minus the
 * briefing's `generatedAt` — returned here so the renderer never has to make a
 * second round trip to learn how long re-entry took.
 */
export interface CaughtUpResult extends OkResult {
  /** Epoch ms the user FIRST declared themselves caught up. */
  caughtUpAt?: number;
  /** NFR-10: `caughtUpAt - generatedAt`, in milliseconds. */
  timeToReEntryMs?: number;
}

/**
 * `briefing:resumePoint` result — where "Brief me on what I missed" starts (F-2).
 *
 * `windowStart` is the `window_end` of the furthest-forward briefing the user
 * acknowledged, NOT the moment they tapped the button: the tap is later than the
 * window they read, and starting there would silently skip the gap between the
 * two. `null` means they have never acknowledged one, which is the first-run
 * state and not an error — the renderer answers it with a default lookback.
 */
export interface ResumePoint {
  windowStart: number | null;
  /**
   * A-4: how many "things changed" items to show before collapsing the rest.
   * Config-driven (`briefing.maxChangedItems`). Obligations are never capped.
   */
  maxChangedItems: number;
}

/**
 * `briefing:metrics` — one briefing's time-to-re-entry (NFR-10).
 *
 * `caughtUpAt`/`timeToReEntryMs` are `null` (not absent) while the briefing is
 * still open: "the user has not finished catching up yet" is a real, reportable
 * state, and a metrics view that silently omitted those rows would flatter the
 * average by counting only the briefings that were completed.
 */
export interface BriefingMetric {
  briefingId: string;
  /** Epoch ms the briefing was generated. */
  generatedAt: number;
  /** Epoch ms the user declared themselves caught up; null while still open. */
  caughtUpAt: number | null;
  /** `caughtUpAt - generatedAt`; null while still open. */
  timeToReEntryMs: number | null;
}

/** One `{ key, count }` pair, for the metrics view's histogram-shaped fields. */
export interface MetricCount {
  key: string;
  count: number;
}

/** A latency distribution. `null` percentiles mean "no observation", not "0 ms". */
export interface MetricDuration {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/**
 * `debug:metrics` — the whole local metrics view (Task 4.4, step 4).
 *
 * A debugging surface, deliberately raw: every field is a count or a
 * millisecond value, with no formatting and no opinion about which numbers are
 * bad. The renderer prints a table.
 *
 * `available: false` with a `reason` is a real state, not an error: it is what
 * a failed read degrades to, and it must be distinguishable from a genuinely
 * idle install whose every counter is legitimately 0.
 */
export interface LocalMetrics {
  available: boolean;
  /** Why the view is unavailable. Present only when `available` is false. */
  reason?: string;
  /** Per-layer call volume and mean latency, from `ai_calls`. */
  layers: { layer: number; calls: number; meanLatencyMs: number }[];
  /** Calls per `(layer, outcome)`. Includes Layer 3's `all_claims_dropped`. */
  outcomes: { layer: number; outcome: string; calls: number }[];
  /** OI-1: end-to-end briefing latency. */
  briefingLatency: MetricDuration;
  /** NFR-10: time from generating a briefing to the user declaring caught-up. */
  reEntry: MetricDuration;
  /** Citation-gate drops by reason, from the trace log. `injection_pattern` is T-1. */
  gateDrops: MetricCount[];
  /** SEC-5: accepted claims that had something redacted. */
  redactedClaims: number;
  /** SEC-5: total values redacted. */
  redactionCount: number;
  /** SEC-5: detector kinds that fired. Kinds only — never a redacted value. */
  redactionKinds: string[];
  /** D-7: Layer-2 trigger decisions, by fired condition and by outcome. */
  triggers: { total: number; byReason: MetricCount[]; byOutcome: MetricCount[] };
  /** Trace lines successfully parsed, and lines that could not be. */
  tracesRead: number;
  unparseableTraceLines: number;
}

/** Recurrence vocabulary for a recurring briefing (FR-3). No cron, ever. */
export type BriefingCadence = 'daily' | 'weekdays' | 'weekly';

/** One saved recurring-briefing schedule, as the settings UI renders it. */
export interface BriefingScheduleView {
  scheduleId: string;
  cadence: BriefingCadence;
  /** Local wall-clock hour, 0–23. */
  hourLocal: number;
  /** Local wall-clock minute, 0–59. */
  minuteLocal: number;
  /** 0 = Sunday … 6 = Saturday; non-null only for `weekly`. */
  weekday: number | null;
  enabled: boolean;
  /** Local hour quiet time opens (inclusive); null when unset. */
  quietFrom: number | null;
  /** Local hour quiet time closes (exclusive); null when unset. */
  quietTo: number | null;
  /** Epoch ms of the last run this schedule triggered; null until it first fires. */
  lastFiredAt: number | null;
}

/** `schedule:create` payload. `weekday` is required for `weekly`. */
export interface BriefingScheduleInput {
  cadence: BriefingCadence;
  hourLocal: number;
  minuteLocal: number;
  weekday?: number | null;
  quietFrom?: number | null;
  quietTo?: number | null;
}

/** `schedule:create` result. Carries the saved row so the UI need not re-list. */
export interface BriefingScheduleResult {
  ok: boolean;
  /** Present only when `ok` is false, e.g. `invalid_schedule`, `internal_error`. */
  reason?: string;
  /** Present only when `ok` is true. */
  schedule?: BriefingScheduleView;
}

/** One Slack channel the connected token can see, as `conversations.list` reports it. */
export interface SlackChannel {
  id: string;
  name: string;
  /** Whether the connected user has already joined this channel. */
  isMember: boolean;
}

/** A channel the user has selected for polling. Mirrors `slack_selected_channels`. */
export interface SelectedSlackChannel {
  channelId: string;
  name: string;
  addedAt: number;
}

/**
 * `slack:listAvailable` result.
 *
 * `ok: false, reason: 'not_connected'` is the expected shape before Slack has
 * ever been connected — distinct from an empty `channels` array, which means
 * "connected, but the token can see no public channels".
 */
export interface SlackChannelsResult {
  ok: boolean;
  channels?: SlackChannel[];
  reason?: string;
}

export interface SourceHealth {
  source: Source;
  status: 'ok' | 'degraded' | 'rate-limited' | 'disconnected';
  /** Ingestion lag in milliseconds, or `null` when unknown. */
  lagMs: number | null;
  /** Epoch ms until which the source is backing off, when rate limited. */
  retryAfter?: number;
}

/** `pipeline:status` — a live "what is the pipeline doing right now" snapshot. */
export interface PipelineStatus {
  /** Ingested events with no `extractions` row yet. */
  extractionBacklog: number;
  /** Threads due for synthesis on the debounce scheduler's next tick. */
  synthesisDue: number;
  /** Threads Layer 2 is synthesizing at this exact moment. */
  synthesisInFlight: number;
}

/** Detaches a `send`-style listener. Always call this on component teardown. */
export type Unsubscribe = () => void;

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

const VERDICTS: readonly FeedbackVerdict[] = ['relevant', 'irrelevant', 'missed', 'wrong'];

function assertSource(source: unknown): asserts source is Source {
  if (source !== 'slack' && source !== 'gmail') {
    throw new Error('invalid source');
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid ${label}`);
  }
}

function assertBriefingWindow(w: unknown): asserts w is BriefingWindow {
  const candidate = w as Partial<BriefingWindow> | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !Number.isFinite(candidate.windowStart) ||
    !Number.isFinite(candidate.windowEnd) ||
    (candidate.windowStart as number) >= (candidate.windowEnd as number)
  ) {
    throw new Error('invalid briefing window');
  }
}

/**
 * Shape-check the id list `briefing:metrics` takes.
 *
 * An EMPTY array is accepted deliberately — "report on nothing" is a coherent
 * request with a coherent answer (`[]`), and rejecting it would force every
 * caller to branch before asking.
 */
function assertBriefingIds(ids: unknown): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('invalid briefingIds');
  }
}

function assertClaimIds(ids: unknown): asserts ids is string[] {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('invalid claimIds');
  }
}

function assertProjectNames(names: unknown): asserts names is string[] {
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || n.trim() === '')) {
    throw new Error('invalid project names');
  }
}

function assertFeedback(f: unknown): asserts f is FeedbackSubmission {
  const candidate = f as Partial<FeedbackSubmission> | null;
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('invalid feedback');
  }
  assertNonEmptyString(candidate.briefingId, 'briefingId');
  if (!VERDICTS.includes(candidate.verdict as FeedbackVerdict)) {
    throw new Error('invalid verdict');
  }
  if (candidate.claimId !== undefined) assertNonEmptyString(candidate.claimId, 'claimId');
  if (candidate.note !== undefined && typeof candidate.note !== 'string') {
    throw new Error('invalid note');
  }
}

const CADENCES: readonly BriefingCadence[] = ['daily', 'weekdays', 'weekly'];

function isHour(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

/**
 * Shape-check a schedule before it crosses the bridge.
 *
 * As everywhere in this file, a convenience gate rather than the trust
 * boundary — `ipc/schedule.ts` re-validates, and `BriefingSchedulesRepo`
 * validates again before writing.
 */
function assertScheduleInput(input: unknown): asserts input is BriefingScheduleInput {
  const candidate = input as Partial<BriefingScheduleInput> | null;
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('invalid schedule');
  }
  if (!CADENCES.includes(candidate.cadence as BriefingCadence)) {
    throw new Error('invalid cadence');
  }
  if (!isHour(candidate.hourLocal, 23)) throw new Error('invalid hourLocal');
  if (!isHour(candidate.minuteLocal, 59)) throw new Error('invalid minuteLocal');
  if (candidate.cadence === 'weekly' && !isHour(candidate.weekday, 6)) {
    throw new Error('invalid weekday');
  }
  for (const bound of [candidate.quietFrom, candidate.quietTo]) {
    if (bound !== undefined && bound !== null && !isHour(bound, 23)) {
      throw new Error('invalid quiet hours');
    }
  }
}

/** Shape-check the selection `slack:setSelected` takes. */
function assertChannelSelection(
  channels: unknown,
): asserts channels is Array<{ channelId: string; name: string }> {
  if (
    !Array.isArray(channels) ||
    channels.some((c: unknown) => {
      const row = c as { channelId?: unknown; name?: unknown } | null;
      return (
        row === null ||
        typeof row !== 'object' ||
        typeof row.channelId !== 'string' ||
        row.channelId.length === 0 ||
        typeof row.name !== 'string' ||
        row.name.length === 0
      );
    })
  ) {
    throw new Error('invalid channel selection');
  }
}

function assertCallback(cb: unknown): asserts cb is (payload: never) => void {
  if (typeof cb !== 'function') throw new Error('invalid callback');
}

/**
 * Subscribe to a `send`-style channel, returning an unsubscribe function.
 * The Electron event object is deliberately withheld from the renderer callback —
 * it exposes `sender`, which is a bridge back out of the sandbox.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  assertCallback(cb);
  const handler = (_event: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/* -------------------------------------------------------------------------- */
/* Bridge                                                                     */
/* -------------------------------------------------------------------------- */

/** The object exposed to the renderer as `window.contextRestorer`. */
export interface ContextRestorerBridge {
  onboarding: {
    status(): Promise<OnboardingStatus>;
  };
  oauth: {
    connect(source: Source): Promise<OkResult>;
    revoke(source: Source): Promise<OkResult>;
  };
  projects: {
    suggest(): Promise<ProjectSuggestions>;
    declare(names: string[]): Promise<OkResult>;
    /** Declared projects with their ids, for the channel-tagging control (A-2). */
    list(): Promise<DeclaredProject[]>;
  };
  briefing: {
    request(window: BriefingWindow): Promise<BriefingHandle>;
    pending(briefingId: string): Promise<PendingItem[]>;
    /** The user manually declaring a "Waiting on you" item dealt with. */
    resolvePending(pendingId: string): Promise<OkResult>;
    caughtUp(briefingId: string): Promise<CaughtUpResult>;
    /**
     * Where the next briefing should start: `window_end` of the furthest-forward
     * briefing the user acknowledged, or `null` if they never have (F-2).
     */
    resumePoint(): Promise<ResumePoint>;
    /**
     * NFR-10 time-to-re-entry for the given briefings (FR-11's metrics view).
     * Unknown ids are omitted from the result, so the array may be shorter than
     * the request.
     */
    metrics(briefingIds: string[]): Promise<BriefingMetric[]>;
    /**
     * Rehydrate an already-requested briefing from what is persisted, for a
     * renderer that lost its live stream (e.g. a Settings round-trip). See
     * {@link BriefingSnapshot}.
     */
    snapshot(briefingId: string): Promise<BriefingSnapshot>;
    onChunk(cb: (chunk: BriefingChunk) => void): Unsubscribe;
    onDone(cb: (done: BriefingDone) => void): Unsubscribe;
  };
  claim: {
    drilldown(claimId: string): Promise<Drilldown>;
  };
  /**
   * The one sanctioned way out of the app (Task 4.6).
   *
   * FR-6's source deep links cannot navigate on their own: `will-navigate` and
   * `setWindowOpenHandler` refuse everything that is not an `app://` page, so
   * that untrusted ingested content cannot navigate or pop the window off to a
   * host of its choosing. Explicit user clicks on the app's own deep links come
   * through here instead, where the main process re-validates the URL against a
   * host allowlist (`ipc/external.ts`) before handing it to `shell.openExternal`.
   */
  shell: {
    openExternal(url: string): Promise<OkResult>;
  };
  feedback: {
    submit(feedback: FeedbackSubmission): Promise<OkResult>;
    /**
     * The verdict already on file for each of `claimIds`, keyed by claim id —
     * across every briefing, not just the current one. Seeds "✓ recorded" so a
     * restarted app (or a still-open pending item resurfacing under a new
     * `briefingId`) does not ask the user to re-judge something already
     * answered. A claim with no key in the result has no verdict yet.
     */
    claimVerdicts(claimIds: string[]): Promise<Record<string, FeedbackVerdict>>;
  };
  health: {
    onSources(cb: (health: SourceHealth[]) => void): Unsubscribe;
  };
  pipeline: {
    onStatus(cb: (status: PipelineStatus) => void): Unsubscribe;
  };
  /**
   * The local metrics view (Task 4.4, step 4).
   *
   * Takes no argument on purpose: it is a whole-install aggregate, so there is
   * nothing for a compromised renderer to steer. Rejects as an unhandled channel
   * when the main process was wired without the metrics readers, which the panel
   * renders as "not wired" rather than as a page of zeroes.
   */
  debug: {
    metrics(): Promise<LocalMetrics>;
  };
  /** Recurring briefings (FR-3, time-based half). */
  schedule: {
    list(): Promise<BriefingScheduleView[]>;
    create(input: BriefingScheduleInput): Promise<BriefingScheduleResult>;
    setEnabled(scheduleId: string, enabled: boolean): Promise<OkResult>;
  };
  /** Slack channel selector: which channels the poller is authorized to fetch. */
  slack: {
    /** Live `conversations.list` call over the connected token. */
    listAvailable(): Promise<SlackChannelsResult>;
    getSelected(): Promise<SelectedSlackChannel[]>;
    setSelected(channels: Array<{ channelId: string; name: string }>): Promise<OkResult>;
  };
  /**
   * The chat-model picker (Settings page). `setChat` only PERSISTS the
   * choice — it takes effect on the NEXT launch, not live (see `main.ts`'s
   * `runPreflightGate`), so the settings UI must say so.
   */
  model: {
    get(): Promise<ModelInfo>;
    setChat(model: string): Promise<OkResult>;
  };
}

const bridge: ContextRestorerBridge = {
  onboarding: {
    status: () => ipcRenderer.invoke('onboarding:status') as Promise<OnboardingStatus>,
  },
  oauth: {
    connect: (source) => {
      assertSource(source);
      return ipcRenderer.invoke('oauth:connect', { source }) as Promise<OkResult>;
    },
    revoke: (source) => {
      assertSource(source);
      return ipcRenderer.invoke('oauth:revoke', { source }) as Promise<OkResult>;
    },
  },
  projects: {
    suggest: () => ipcRenderer.invoke('projects:suggest') as Promise<ProjectSuggestions>,
    // No argument to validate.
    list: () => ipcRenderer.invoke('projects:list') as Promise<DeclaredProject[]>,
    declare: (names) => {
      assertProjectNames(names);
      return ipcRenderer.invoke('projects:declare', { names }) as Promise<OkResult>;
    },
  },
  briefing: {
    request: (window) => {
      assertBriefingWindow(window);
      const { windowStart, windowEnd } = window;
      return ipcRenderer.invoke('briefing:request', {
        windowStart,
        windowEnd,
      }) as Promise<BriefingHandle>;
    },
    pending: (briefingId) => {
      assertNonEmptyString(briefingId, 'briefingId');
      return ipcRenderer.invoke('briefing:pending', { briefingId }) as Promise<PendingItem[]>;
    },
    resolvePending: (pendingId) => {
      assertNonEmptyString(pendingId, 'pendingId');
      return ipcRenderer.invoke('briefing:resolvePending', { pendingId }) as Promise<OkResult>;
    },
    caughtUp: (briefingId) => {
      assertNonEmptyString(briefingId, 'briefingId');
      return ipcRenderer.invoke('briefing:caughtUp', { briefingId }) as Promise<CaughtUpResult>;
    },
    // No argument to validate: the resume point is a property of the user's
    // history, not of any one briefing.
    resumePoint: () => ipcRenderer.invoke('briefing:resumePoint') as Promise<ResumePoint>,
    metrics: (briefingIds) => {
      assertBriefingIds(briefingIds);
      // Rebuilt with `map(String)` rather than forwarded: the renderer's array
      // may carry extra own properties, and only structured-cloneable plain data
      // crosses the bridge.
      return ipcRenderer.invoke('briefing:metrics', {
        briefingIds: briefingIds.map(String),
      }) as Promise<BriefingMetric[]>;
    },
    snapshot: (briefingId) => {
      assertNonEmptyString(briefingId, 'briefingId');
      return ipcRenderer.invoke('briefing:snapshot', { briefingId }) as Promise<BriefingSnapshot>;
    },
    onChunk: (cb) => subscribe<BriefingChunk>('briefing:chunk', cb),
    onDone: (cb) => subscribe<BriefingDone>('briefing:done', cb),
  },
  claim: {
    drilldown: (claimId) => {
      assertNonEmptyString(claimId, 'claimId');
      return ipcRenderer.invoke('claim:drilldown', { claimId }) as Promise<Drilldown>;
    },
  },
  shell: {
    openExternal: (url) => {
      assertNonEmptyString(url, 'url');
      // Shape only — the authoritative scheme/host allowlist lives in
      // `ipc/external.ts`, since a compromised renderer controls this side.
      return ipcRenderer.invoke('shell:openExternal', { url }) as Promise<OkResult>;
    },
  },
  feedback: {
    submit: (feedback) => {
      assertFeedback(feedback);
      const { briefingId, claimId, verdict, note } = feedback;
      return ipcRenderer.invoke('feedback:submit', {
        briefingId,
        verdict,
        ...(claimId !== undefined ? { claimId } : {}),
        ...(note !== undefined ? { note } : {}),
      }) as Promise<OkResult>;
    },
    claimVerdicts: (claimIds) => {
      assertClaimIds(claimIds);
      // Rebuilt with `map(String)`, same reasoning as `briefing.metrics`
      // above: only structured-cloneable plain data crosses the bridge.
      return ipcRenderer.invoke('feedback:claimVerdicts', {
        claimIds: claimIds.map(String),
      }) as Promise<Record<string, FeedbackVerdict>>;
    },
  },
  health: {
    onSources: (cb) => subscribe<SourceHealth[]>('health:sources', cb),
  },
  pipeline: {
    onStatus: (cb) => subscribe<PipelineStatus>('pipeline:status', cb),
  },
  debug: {
    metrics: () => ipcRenderer.invoke('debug:metrics') as Promise<LocalMetrics>,
  },
  schedule: {
    list: () => ipcRenderer.invoke('schedule:list') as Promise<BriefingScheduleView[]>,
    create: (input) => {
      assertScheduleInput(input);
      const { cadence, hourLocal, minuteLocal, weekday, quietFrom, quietTo } = input;
      // Rebuilt field by field rather than forwarded: only structured-cloneable
      // plain data crosses the bridge, and a renderer-supplied object may carry
      // anything else besides.
      return ipcRenderer.invoke('schedule:create', {
        cadence,
        hourLocal,
        minuteLocal,
        weekday: weekday ?? null,
        quietFrom: quietFrom ?? null,
        quietTo: quietTo ?? null,
      }) as Promise<BriefingScheduleResult>;
    },
    setEnabled: (scheduleId, enabled) => {
      assertNonEmptyString(scheduleId, 'scheduleId');
      if (typeof enabled !== 'boolean') throw new Error('invalid enabled');
      return ipcRenderer.invoke('schedule:setEnabled', { scheduleId, enabled }) as Promise<OkResult>;
    },
  },
  slack: {
    listAvailable: () =>
      ipcRenderer.invoke('slack:listAvailable') as Promise<SlackChannelsResult>,
    getSelected: () =>
      ipcRenderer.invoke('slack:getSelected') as Promise<SelectedSlackChannel[]>,
    setSelected: (channels) => {
      assertChannelSelection(channels);
      // Rebuilt field by field, not forwarded: only structured-cloneable plain
      // data crosses the bridge.
      return ipcRenderer.invoke('slack:setSelected', {
        channels: channels.map((c) => ({ channelId: c.channelId, name: c.name })),
      }) as Promise<OkResult>;
    },
  },
  model: {
    get: () => ipcRenderer.invoke('model:get') as Promise<ModelInfo>,
    setChat: (model) => {
      assertNonEmptyString(model, 'model');
      return ipcRenderer.invoke('model:setChat', { model }) as Promise<OkResult>;
    },
  },
};

contextBridge.exposeInMainWorld('contextRestorer', bridge);
