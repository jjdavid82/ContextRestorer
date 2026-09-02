/**
 * Type definitions for the `window.contextRestorer` preload bridge.
 *
 * The Electron preload script exposes this object via `contextBridge` with
 * `contextIsolation: true`. Every member maps 1:1 onto an IPC channel from the
 * technical design doc §5; renderer code must never reach for `ipcRenderer`
 * directly. Prefer `getBridge()` from `lib/bridge.ts` over touching
 * `window.contextRestorer` so the "not running inside Electron" case fails with
 * a clear error instead of `undefined is not an object`.
 *
 * SHAPE CONTRACT: these declarations must stay structurally identical to the
 * payload types in `apps/desktop/src/preload.cts`, which is the implementation
 * that actually puts data on the wire. The renderer cannot import from
 * `@cr/desktop` (importing the preload module would run
 * `contextBridge.exposeInMainWorld` outside a preload context, and the UI is a
 * separately-compiled static export), so the two files are kept in sync by hand.
 * Local names differ where the renderer already had a house style
 * (`SourceId`/`PendingItemView`/`ClaimChunk`/`DrillDown`/`FeedbackInput`);
 * the *shapes* must not.
 */

/** Sources the app can ingest from. Mirrors `Source` in the preload. */
export type SourceId = 'slack' | 'gmail';

/** Callback disposer returned by every event subscription on the bridge. */
export type Unsubscribe = () => void;

/** Generic acknowledgement returned by the mutating `invoke` channels. */
export interface OkResult {
  ok: boolean;
  /**
   * Machine-readable failure cause, present only when `ok` is false. Rendered,
   * not branched on. `oauth:connect` emits `not_configured` when the app has no
   * OAuth client id for that source, plus `state_mismatch` / `timeout` /
   * `exchange_failed` / `vault_error` / `internal_error`.
   */
  reason?: string;
}

/** `onboarding:status` — what the first-run wizard still needs from the user. */
export interface OnboardingStatus {
  /** Sources that currently hold valid, non-revoked OAuth credentials. */
  sourcesConnected: SourceId[];
  /** Names of the projects the user has declared; onboarding requires >= 3 (OI-3). */
  projectsDeclared: string[];
  /** True when the local Ollama runtime answered a health probe. */
  ollamaReady: boolean;
}

/** `model:get` — the chat-model picker (Settings page). Mirrors `ModelInfo` in the preload. */
export interface ModelInfo {
  /** Currently effective chat model: a persisted override if set, else `defaultChat`. */
  chat: string;
  /** `config/default.json`'s own choice, so the UI can label it as the default. */
  defaultChat: string;
  /** Every model Ollama currently reports as installed. Empty if Ollama is unreachable. */
  available: string[];
}

/** `projects:suggest` — a project the clusterer inferred from recent activity. */
export interface ProjectCandidate {
  name: string;
  /** Where the candidate was inferred from, e.g. a Slack channel or Gmail label. */
  source: SourceId;
  /** Number of observed artifacts backing this candidate. */
  evidenceCount: number;
  /**
   * Human-readable justification, e.g. `you posted 23 times in #api-redesign`.
   * Optional: a suggester with no explanation to offer simply omits it.
   */
  reason?: string;
}

/** `projects:suggest` result envelope. */
export interface ProjectSuggestions {
  candidates: ProjectCandidate[];
}

/**
 * `briefing:pending` — an item the user still owes someone a response on.
 *
 * A projection of the store's `pending_items` row; `citationArtifactId` is
 * nullable there and therefore nullable here.
 */
export interface PendingItemView {
  pendingId: string;
  description: string;
  /** Model confidence in [0, 1]. */
  confidence: number;
  /** Artifact backing this item; feeds `claim.drilldown` / deep links. */
  citationArtifactId: string | null;
}

/** A citation anchoring a claim to a concrete ingested event. */
export interface Citation {
  eventId: string;
  artifactId: string;
  source: SourceId;
  /** Deep link back into Slack/Gmail; absent when the source exposes no permalink. */
  externalUrl?: string;
}

/** `briefing:chunk` — one streamed, already-validated claim of the briefing. */
export interface ClaimChunk {
  briefingId: string;
  /** Briefing section this claim belongs to, e.g. `"decisions"`. */
  section: string;
  /** Rendered claim text. */
  claim: string;
  /** Structured citation — not a display string; the UI renders it and links from it. */
  citation: Citation;
}

/** How a briefing narrative was produced; mirrors the `briefings.mode` column. */
export type BriefingMode = 'llm' | 'template';

/** `briefing:done` — terminal event for a briefing stream. */
export interface BriefingDone {
  briefingId: string;
  /** `'template'` means the LLM path failed and the fallback renderer ran. */
  mode: BriefingMode;
  /** Threads still ingesting; the briefing may be incomplete while > 0 (OI-1). */
  threadsStillProcessing: number;
  /** Persisted as `briefings.first_token_ms` / `total_ms`. */
  timings: {
    firstTokenMs: number;
    totalMs: number;
  };
}

/** One raw source event behind a claim, as returned by `claim:drilldown`. */
export interface DrilldownEvent {
  eventId: string;
  source: SourceId;
  occurredAt: number;
  author: string;
  text: string;
  /** URL that opens this message in Slack/Gmail (FR-6 external deep link). */
  externalUrl?: string;
}

/** `claim:drilldown` — provenance for a single claim. */
export interface DrillDown {
  claimId: string;
  /** Source events behind the claim; each carries its own external deep link. */
  events: DrilldownEvent[];
}

/** `feedback:submit` — user judgement used to tune relevance. */
export interface FeedbackInput {
  briefingId: string;
  claimId?: string;
  verdict: 'relevant' | 'irrelevant' | 'missed' | 'wrong';
  note?: string;
}

/**
 * `briefing:caughtUp` result (FR-11). Mirrors `CaughtUpResult` in the preload.
 *
 * Widens `OkResult` rather than replacing it, so callers that only read
 * `ok`/`reason` are unaffected. Both extra fields appear only when `ok` is true.
 * The channel is idempotent: a second tap returns the timestamp written by the
 * FIRST one, not the current clock.
 */
export interface CaughtUpResult extends OkResult {
  /** Epoch ms the user FIRST declared themselves caught up. */
  caughtUpAt?: number;
  /** NFR-10: `caughtUpAt - generatedAt`, in milliseconds. */
  timeToReEntryMs?: number;
}

/**
 * `briefing:metrics` — one briefing's time-to-re-entry (NFR-10). Mirrors
 * `BriefingMetric` in the preload.
 *
 * `caughtUpAt`/`timeToReEntryMs` are `null` (not absent) while the briefing is
 * still open, so an unfinished briefing is visible as unfinished rather than
 * missing.
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

/** One `{ key, count }` pair. Mirrors `MetricCount` in the preload. */
export interface MetricCount {
  key: string;
  count: number;
}

/**
 * A latency distribution. Mirrors `MetricDuration` in the preload.
 *
 * `null` percentiles mean "no observation qualified", never "0 ms" — 0 is a
 * reachable latency and must not double as missing data.
 */
export interface MetricDuration {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/**
 * `debug:metrics` — the local metrics view (Task 4.4, step 4). Mirrors
 * `LocalMetrics` in the preload.
 *
 * Raw counts and raw milliseconds, with no formatting and no opinion about which
 * numbers are bad: it is a debugging surface, and the panel prints a table.
 */
export interface LocalMetrics {
  available: boolean;
  /** Why the view is unavailable. Present only when `available` is false. */
  reason?: string;
  layers: { layer: number; calls: number; meanLatencyMs: number }[];
  outcomes: { layer: number; outcome: string; calls: number }[];
  briefingLatency: MetricDuration;
  reEntry: MetricDuration;
  /** Citation-gate drops by reason. `injection_pattern` is the T-1 detector. */
  gateDrops: MetricCount[];
  redactedClaims: number;
  redactionCount: number;
  /** Detector kinds only — never any part of a redacted value. */
  redactionKinds: string[];
  triggers: { total: number; byReason: MetricCount[]; byOutcome: MetricCount[] };
  tracesRead: number;
  unparseableTraceLines: number;
}

/** One Slack channel the connected token can see. Mirrors `SlackChannel` in the preload. */
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
 * `slack:listAvailable` result. Mirrors `SlackChannelsResult` in the preload.
 *
 * `ok: false, reason: 'not_connected'` means Slack has never been connected —
 * distinct from an empty `channels` array ("connected, but no visible
 * channels").
 */
export interface SlackChannelsResult {
  ok: boolean;
  channels?: SlackChannel[];
  reason?: string;
}

/** `health:sources` — per-source connector health for the status strip. */
export interface SourceHealth {
  source: SourceId;
  status: 'ok' | 'degraded' | 'rate-limited' | 'disconnected';
  /** How far behind live the connector is, in milliseconds; `null` when unknown. */
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

/** Time window a briefing should cover (epoch milliseconds), half-open. */
export interface BriefingWindow {
  windowStart: number;
  windowEnd: number;
}

/** `briefing:request` result envelope. */
export interface BriefingHandle {
  briefingId: string;
}

/**
 * Recurrence vocabulary for a recurring briefing (FR-3, time-based half).
 * Mirrors `BriefingCadence` in the preload and the `briefing_schedules.cadence`
 * column. No cron syntax is exposed to the user, or to this layer.
 */
export type BriefingCadence = 'daily' | 'weekdays' | 'weekly';

/** `schedule:list` — one saved recurring briefing. */
export interface BriefingScheduleView {
  scheduleId: string;
  /** Local wall-clock hour, 0–23. Resolved against the user's zone in main. */
  hourLocal: number;
  /** Local wall-clock minute, 0–59. */
  minuteLocal: number;
  cadence: BriefingCadence;
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

/** `schedule:create` payload. `weekday` is required when `cadence` is `weekly`. */
export interface BriefingScheduleInput {
  cadence: BriefingCadence;
  hourLocal: number;
  minuteLocal: number;
  weekday?: number | null;
  quietFrom?: number | null;
  quietTo?: number | null;
}

/** `schedule:create` result; carries the saved row so the UI need not re-list. */
export interface BriefingScheduleResult {
  ok: boolean;
  /** Present only when `ok` is false, e.g. `invalid_schedule`. */
  reason?: string;
  /** Present only when `ok` is true. */
  schedule?: BriefingScheduleView;
}

/** The full surface exposed on `window.contextRestorer`. */
export interface ContextRestorerBridge {
  onboarding: {
    status(): Promise<OnboardingStatus>;
  };
  oauth: {
    connect(source: SourceId): Promise<OkResult>;
    revoke(source: SourceId): Promise<OkResult>;
  };
  projects: {
    suggest(): Promise<ProjectSuggestions>;
    declare(names: string[]): Promise<OkResult>;
  };
  briefing: {
    request(w: BriefingWindow): Promise<BriefingHandle>;
    pending(id: string): Promise<PendingItemView[]>;
    /** The user manually declaring a "Waiting on you" item dealt with. */
    resolvePending(pendingId: string): Promise<OkResult>;
    /** Idempotent (FR-11): re-tapping returns the FIRST `caughtUpAt`, not now. */
    caughtUp(id: string): Promise<CaughtUpResult>;
    /**
     * NFR-10 time-to-re-entry for the given briefings (FR-11's metrics view).
     * Unknown ids are omitted, so the array may be shorter than the request.
     */
    metrics(briefingIds: string[]): Promise<BriefingMetric[]>;
    /** Returns an unsubscribe fn: without it, a React effect re-subscribing on
     * every re-render stacks listeners and replays claims into the DOM twice. */
    onChunk(cb: (c: ClaimChunk) => void): Unsubscribe;
    /** Returns an unsubscribe fn — same effect-cleanup contract as `onChunk`. */
    onDone(cb: (d: BriefingDone) => void): Unsubscribe;
  };
  claim: {
    drilldown(claimId: string): Promise<DrillDown>;
  };
  /**
   * The one sanctioned way out of the app (Task 4.6).
   *
   * The window refuses to navigate anywhere but `app://` and denies every
   * `window.open`, because it renders untrusted ingested content. FR-6 source
   * deep links therefore cannot be plain navigations: `ExternalLink` calls this
   * channel, and the main process re-validates the URL against a host allowlist
   * before handing it to the system browser.
   */
  shell: {
    /** Resolves `{ ok: false, reason: 'invalid_url' }` for a refused URL. */
    openExternal(url: string): Promise<OkResult>;
  };
  feedback: {
    /** Resolves with `{ ok }` once the verdict is persisted (design §5, <=1s). */
    submit(f: FeedbackInput): Promise<OkResult>;
    /**
     * The verdict already on file for each claim id — across every briefing,
     * not just the current one — keyed by claim id. A claim absent from the
     * result has no verdict yet. Lets the UI seed "✓ recorded" after a
     * restart instead of asking the user to re-judge an unchanged claim.
     */
    claimVerdicts(claimIds: string[]): Promise<Record<string, FeedbackInput['verdict']>>;
  };
  health: {
    /** Returns an unsubscribe fn — same effect-cleanup contract as `onChunk`. */
    onSources(cb: (h: SourceHealth[]) => void): Unsubscribe;
  };
  pipeline: {
    /** Returns an unsubscribe fn — same effect-cleanup contract as `onChunk`. */
    onStatus(cb: (s: PipelineStatus) => void): Unsubscribe;
  };
  /**
   * The local metrics view (Task 4.4, step 4).
   *
   * Rejects as an unhandled channel when the main process was wired without the
   * metrics readers; the panel renders that as "not wired" rather than as a page
   * of zeroes, because an idle install legitimately reports zeroes.
   */
  debug: {
    metrics(): Promise<LocalMetrics>;
  };
  /** Recurring briefings (FR-3, time-based half) — the settings editor's channels. */
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
   * choice — it takes effect on the NEXT app launch, not live.
   */
  model: {
    get(): Promise<ModelInfo>;
    setChat(model: string): Promise<OkResult>;
  };
}

declare global {
  interface Window {
    /** Injected by the Electron preload script; absent in a plain browser. */
    contextRestorer: ContextRestorerBridge;
  }
}
