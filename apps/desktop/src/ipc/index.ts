/**
 * Main-process IPC registration table.
 *
 * Every channel listed in the preload allowlist (`src/preload.cts`) gets exactly one
 * `ipcMain.handle` / emitter registration here, and each handler re-validates its
 * arguments — the preload's checks are a convenience gate, not a trust boundary, since
 * a compromised renderer controls what it sends.
 *
 * Registration happens in TWO phases, because the channels do not all have the same
 * prerequisites:
 *
 *   - `registerIpcHandlers(deps)` — everything that only needs process-level singletons.
 *     Called before the first window is created, so no renderer request can race an
 *     unregistered channel.
 *   - `startHealthPush(win, poller)` — the `health:sources` *push*, which needs a live
 *     `BrowserWindow` to send to and therefore cannot exist until `createWindow()` has
 *     resolved. Kept as a separate export rather than deferred inside
 *     `registerIpcHandlers` with a nullable window, because a push with nowhere to go is
 *     not a handler that can be "registered early" in any meaningful sense.
 *
 * Handlers are added in the Phase 1-3 tasks:
 *   - Phase 1: `onboarding:status` ✅, `oauth:connect` ✅, `oauth:revoke` ✅,
 *              `projects:suggest` ✅, `projects:declare` ✅, `health:sources` ✅
 *   - Phase 2: `briefing:request` ✅, `briefing:pending` ✅, `briefing:caughtUp` ✅.
 *              `briefing:chunk` / `briefing:done` are *sends*, emitted by
 *              `main.ts`'s Layer 3 adapter (which needs the live window), so —
 *              like `health:sources` — they are deliberately not registered here.
 *   - Phase 3: `claim:drilldown` ✅, `feedback:submit` ✅, `briefing:metrics` ✅,
 *              `schedule:list` ✅, `schedule:create` ✅, `schedule:setEnabled` ✅
 */
import type { BrowserWindow } from 'electron';
import { systemClock, type AppConfig } from '@cr/core';
import type { Poller, TokenVault } from '@cr/ingest';
import type { EventsRepo, GraphRepo } from '@cr/store';
import { registerOauthHandlers } from './oauth.js';
import { registerProjectsHandlers } from './projects.js';
import { registerHealthHandlers, type HealthPushOptions } from './health.js';
import {
  registerBriefingHandlers,
  type PendingReader,
  type StakesReader,
} from './briefing.js';
import { registerScheduleHandlers, type ScheduleStore } from './schedule.js';
import {
  registerSlackChannelsHandlers,
  type SlackChannelStore,
} from './slackChannels.js';
import { registerClaimHandlers } from './claim.js';
import { registerExternalHandlers } from './external.js';
import {
  registerFeedbackHandlers,
  type BriefingCompletionStore,
  type FeedbackStore,
} from './feedback.js';
import {
  registerMetricsHandlers,
  type AiCallStatsReader,
  type BriefingStatsReader,
} from './metrics.js';
import {
  registerModelSettingsHandlers,
  type ModelSettingsStore,
} from './modelSettings.js';

export { toHealthPayload, HEALTH_CHANNEL, type SourceHealth } from './health.js';
export {
  registerProjectsHandlers,
  parseDeclareNames,
  distinctNames,
  type ProjectsHandlerDeps,
} from './projects.js';
export {
  registerBriefingHandlers,
  rankPendingItems,
  listPending,
  beginBriefing,
  resolvePendingItem,
  parseBriefingWindow,
  parsePendingIdArg,
  PENDING_CHANNEL,
  REQUEST_CHANNEL,
  RESOLVE_CHANNEL,
  type BriefingHandlerDeps,
  type PendingReader,
  type StakesReader,
  type PendingItemView,
} from './briefing.js';
export {
  registerClaimHandlers,
  drilldown,
  resolveEvents,
  parseDrilldownArg,
  toDrilldownEvent,
  deepLinkFor,
  slackDeepLink,
  gmailDeepLink,
  eventText,
  authorFor,
  DRILLDOWN_CHANNEL,
  MAX_DRILLDOWN_EVENTS,
  MAX_EVENT_TEXT_CHARS,
  type ClaimHandlerDeps,
  type ArtifactReader,
  type ThreadEventReader,
} from './claim.js';
export {
  registerExternalHandlers,
  openExternalLink,
  parseOpenExternalArg,
  isAllowedExternalUrl,
  OPEN_EXTERNAL_CHANNEL,
  ALLOWED_LINK_HOSTS,
  type ExternalLinkDeps,
  type OpenExternalResult,
} from './external.js';
export {
  registerFeedbackHandlers,
  submitFeedback,
  markBriefingCaughtUp,
  briefingMetrics,
  claimVerdicts,
  parseFeedbackArg,
  parseBriefingIdArg,
  parseMetricsArg,
  parseClaimIdsArg,
  SUBMIT_CHANNEL as FEEDBACK_SUBMIT_CHANNEL,
  CAUGHT_UP_CHANNEL,
  METRICS_CHANNEL,
  CLAIM_VERDICTS_CHANNEL,
  MAX_NOTE_CHARS,
  MAX_METRICS_IDS,
  MAX_CLAIM_IDS,
  type FeedbackHandlerDeps,
  type FeedbackStore,
  type BriefingCompletionStore,
  type ParsedFeedback,
  type BriefingMetric,
  type CaughtUpResult,
} from './feedback.js';
export {
  registerMetricsHandlers,
  collectLocalMetrics,
  DEBUG_METRICS_CHANNEL,
  METRICS_TRACE_DAYS,
  type MetricsHandlerDeps,
  type AiCallStatsReader,
  type BriefingStatsReader,
} from './metrics.js';
export {
  registerScheduleHandlers,
  parseScheduleInput,
  toScheduleView,
  listSchedules,
  createSchedule,
  setScheduleEnabled,
  LIST_CHANNEL as SCHEDULE_LIST_CHANNEL,
  CREATE_CHANNEL as SCHEDULE_CREATE_CHANNEL,
  SET_ENABLED_CHANNEL as SCHEDULE_SET_ENABLED_CHANNEL,
  type ScheduleHandlerDeps,
  type ScheduleStore,
} from './schedule.js';
export {
  registerSlackChannelsHandlers,
  parseSelection as parseSlackChannelSelection,
  listAvailableChannels,
  getSelectedChannels,
  setSelectedChannels,
  LIST_AVAILABLE_CHANNEL as SLACK_LIST_AVAILABLE_CHANNEL,
  GET_SELECTED_CHANNEL as SLACK_GET_SELECTED_CHANNEL,
  SET_SELECTED_CHANNEL as SLACK_SET_SELECTED_CHANNEL,
  type SlackChannelsHandlerDeps,
  type SlackChannelStore,
  type AvailableChannelsResult,
} from './slackChannels.js';
export {
  registerModelSettingsHandlers,
  getModelInfo,
  setChatModel,
  parseSetChatArg,
  MODEL_GET_CHANNEL,
  MODEL_SET_CHAT_CHANNEL,
  CHAT_MODEL_SETTING_KEY,
  type ModelSettingsDeps,
  type ModelSettingsStore,
  type ModelInfo,
} from './modelSettings.js';

/** Process-level singletons the handler table needs. Built once, in `main.ts`. */
export interface IpcDeps {
  /** Encrypted-at-rest OAuth token store (SEC-2). */
  vault: TokenVault;
  /** Live poll scheduler; the sole writer of source health. */
  poller: Poller;
  /** Supplies `oauth.<source>.clientId` for the connect flow. */
  config: AppConfig;
  /**
   * Open-obligation reader for the first-paint path (`PendingItemsRepo`).
   *
   * Optional so `main.ts` can be wired incrementally; when absent the briefing
   * channels are simply not registered, and the renderer's `briefing.pending()`
   * rejects as an unhandled channel rather than silently resolving to `[]` —
   * "not wired yet" and "nothing pending" must not look the same.
   */
  pending?: PendingReader;
  /** Stakes source for ranking (`GraphRepo`). Ranking degrades gracefully without it. */
  graph?: StakesReader;
  /**
   * Event-log reader behind `projects:suggest` (`EventsRepo`).
   *
   * Optional, and paired with {@link IpcDeps.projectStore}: the project channels
   * are registered only when BOTH are supplied, so a partially-wired `main.ts`
   * leaves `projects:declare` an unhandled channel rather than a handler that
   * accepts declarations and drops them.
   */
  events?: EventsRepo;
  /**
   * Full `GraphRepo`: project reader/writer behind `projects:declare` and
   * `onboarding:status`, and artifact/person reader behind `claim:drilldown`.
   *
   * In production this is the SAME `GraphRepo` instance as {@link IpcDeps.graph};
   * the two fields exist separately because the briefing path only needs the
   * narrow `StakesReader` slice, and widening it there would force every future
   * caller to hand over the whole repo. `claim.ts` likewise declares only the
   * narrow `ArtifactReader` slice it reads — this field is the one dep that
   * actually holds the whole repo, so it is what gets passed in.
   */
  projectStore?: GraphRepo;
  /**
   * Layer-3 hand-off invoked after `briefing:request` has already returned its
   * handle. `main.ts` supplies an adapter over `BriefingGenerator` that threads
   * this `briefingId` into `generate()` and streams accepted claims out on
   * `briefing:chunk` / `briefing:done`.
   *
   * Still optional, so a partially-wired host (and every existing test) gets the
   * logging fallback below rather than a hard dependency on Ollama.
   */
  startGeneration?: (briefingId: string, window: { windowStart: number; windowEnd: number }) => void;
  /**
   * Recurring-briefing schedule store behind `schedule:list` / `schedule:create`
   * / `schedule:setEnabled` (`BriefingSchedulesRepo`).
   *
   * Optional for the same reason as {@link IpcDeps.pending}: absent it, the
   * settings page's calls reject as unhandled channels rather than silently
   * resolving to "you have no schedules", which is what a user with schedules
   * would see if a wiring mistake made the store unreachable.
   */
  schedules?: ScheduleStore;
  /**
   * Selected-Slack-channels store behind `slack:listAvailable` /
   * `slack:getSelected` / `slack:setSelected` (`SlackChannelsRepo`).
   *
   * Optional so `main.ts` can be wired incrementally, matching every other
   * feature-scoped store in this interface; when absent the settings page's
   * calls reject as unhandled channels. `slack:listAvailable` itself uses
   * {@link IpcDeps.vault} (always present), not a separate dependency — it is
   * one more Slack Web API call over the same token, not a new store.
   */
  slackChannels?: SlackChannelStore;
  /**
   * Verdict sink behind `feedback:submit` (`FeedbackRepo`).
   *
   * Optional, and paired with {@link IpcDeps.briefings}: the completion channels
   * are registered only when BOTH are supplied. FR-11's "I'm caught up" and
   * FR-12's verdicts are two halves of one gesture, and a build where the button
   * stamps the briefing but the verdicts vanish is worse than one where neither
   * is wired — the user would be told their feedback was recorded when it was
   * not.
   */
  feedback?: FeedbackStore;
  /**
   * Briefing reader/stamper behind `briefing:caughtUp` and `briefing:metrics`
   * (`BriefingsRepo`). See {@link IpcDeps.feedback} for why the two are paired.
   */
  briefings?: BriefingCompletionStore;
  /**
   * Read-only aggregate readers behind `debug:metrics` (Task 4.4, step 4):
   * `AiCallsRepo`, `BriefingsRepo`, and the `<userData>/logs` directory the
   * trace JSONL is written to.
   *
   * All three are required together, and the channel is registered only when all
   * three are present — a panel that showed per-layer latency but silently
   * reported zero gate drops (because the log directory was never passed) would
   * be worse than an unregistered channel, which the renderer reports as
   * "metrics are not wired".
   *
   * `metricsBriefings` is a SEPARATE field from {@link IpcDeps.briefings} even
   * though production passes the same `BriefingsRepo` instance to both: that
   * field is typed as the narrow `BriefingCompletionStore` (get/stamp one
   * briefing), and widening it would force every existing caller — and every
   * test that hand-rolls a completion store — to grow two aggregate methods
   * they have no use for.
   */
  metricsAiCalls?: AiCallStatsReader;
  metricsBriefings?: BriefingStatsReader;
  /** Directory holding `trace-YYYY-MM-DD.jsonl`. */
  logsDir?: string;
  /**
   * Time source for schedule `created_at` and `briefings.caught_up_at`.
   * Defaults to `systemClock`.
   */
  clock?: { now(): number };
  /**
   * Chat-model picker behind `model:get` / `model:setChat` (`AppSettingsRepo`).
   *
   * Optional, and paired with {@link IpcDeps.defaultChatModel}: both must be
   * present for the channels to register, since a picker with no config
   * default to fall back to cannot report an effective model.
   */
  modelSettings?: ModelSettingsStore;
  /** `config.model.chat`, BEFORE any persisted override is applied — see `IpcDeps.modelSettings`. */
  defaultChatModel?: string;
}

/**
 * Register every window-independent IPC handler. Call once, after `app.whenReady()`
 * and before the first window loads.
 */
export function registerIpcHandlers(deps: IpcDeps): void {
  registerOauthHandlers({ vault: deps.vault, config: deps.config });

  // Task 4.6: the single sanctioned egress for FR-6 source deep links. Takes no
  // deps and is registered unconditionally — the renderer's "open in Slack/Gmail"
  // links are locked out of navigating on their own (`security/csp.ts`), so a
  // conditional registration here would mean a dead link rather than a degraded
  // one.
  registerExternalHandlers();

  // OI-3 onboarding: `projects:suggest`, `projects:declare`, `onboarding:status`.
  if (deps.events !== undefined && deps.projectStore !== undefined) {
    registerProjectsHandlers({
      events: deps.events,
      graph: deps.projectStore,
      config: deps.config,
      vault: deps.vault,
    });
  }

  if (deps.pending !== undefined) {
    registerBriefingHandlers({
      pending: deps.pending,
      // Spread rather than assigned: under `exactOptionalPropertyTypes` an
      // explicit `graph: undefined` is not the same as an absent `graph`.
      ...(deps.graph !== undefined ? { graph: deps.graph } : {}),
      clock: deps.clock ?? systemClock,
      startGeneration:
        deps.startGeneration ??
        ((briefingId) => {
          // FALLBACK, not the production path: `main.ts` passes the real Layer 3
          // adapter. Reaching this line means the caller wired the briefing
          // channels without a generator, so logging keeps the hand-off
          // observable instead of making it a silent no-op that looks like
          // working code — the renderer still gets its id and still paints
          // pending items, it just never sees a chunk.
          console.info('[briefing] generation requested with no generator wired', briefingId);
        }),
    });
  }

  // FR-6 provenance: `claim:drilldown`. Registered only when BOTH repos are
  // present, for the same reason as `projects:*` above — a drill-down that
  // resolved every id to "no source events" because a repo was missing would be
  // indistinguishable, in the panel, from a claim whose thread was genuinely
  // purged, and the trust surface is exactly the wrong place to be ambiguous.
  // Reuses `projectStore` (the full `GraphRepo`, same instance as `graph`) and
  // the same `EventsRepo` the project suggester reads; no new instances, since
  // each repo prepares its whole statement set in its constructor.
  if (deps.events !== undefined && deps.projectStore !== undefined) {
    registerClaimHandlers({ artifacts: deps.projectStore, events: deps.events });
  }

  // FR-11 completion signal + FR-12 verdict capture: `briefing:caughtUp`,
  // `briefing:metrics`, `feedback:submit`. `briefing:caughtUp` is made
  // idempotent inside the handler (`ipc/feedback.ts`), not by the repo, which
  // overwrites unconditionally — see that module's header.
  if (deps.feedback !== undefined && deps.briefings !== undefined) {
    registerFeedbackHandlers({
      feedback: deps.feedback,
      briefings: deps.briefings,
      clock: deps.clock ?? systemClock,
    });
  }

  // Task 4.4 step 4: the local metrics view. Read-only, and registered only when
  // all three readers are present — see `IpcDeps.metricsAiCalls`.
  if (
    deps.metricsAiCalls !== undefined &&
    deps.metricsBriefings !== undefined &&
    deps.logsDir !== undefined
  ) {
    registerMetricsHandlers({
      aiCalls: deps.metricsAiCalls,
      briefings: deps.metricsBriefings,
      logsDir: deps.logsDir,
    });
  }

  // FR-3 recurring briefings: the settings surface. The scheduler that acts on
  // these rows (`scheduler/briefingSchedule.ts`) is started separately in
  // `main.ts` — registering the editor does not by itself run anything.
  if (deps.schedules !== undefined) {
    registerScheduleHandlers({
      schedules: deps.schedules,
      clock: deps.clock ?? systemClock,
    });
  }

  // Slack channel selector: closes Task 1.7's gap. `vault` is always present,
  // so this is gated on `slackChannels` alone.
  if (deps.slackChannels !== undefined) {
    registerSlackChannelsHandlers({
      vault: deps.vault,
      channels: deps.slackChannels,
      clock: deps.clock ?? systemClock,
    });
  }

  // Chat-model picker (Settings page): registered only when both a store AND
  // a config default are present, matching every other feature-scoped pair in
  // this function — see `IpcDeps.modelSettings`.
  if (deps.modelSettings !== undefined && deps.defaultChatModel !== undefined) {
    registerModelSettingsHandlers({
      settings: deps.modelSettings,
      defaultChatModel: deps.defaultChatModel,
      ollamaBaseUrl: deps.config.model.ollamaBaseUrl,
    });
  }
}

/**
 * Start the `health:sources` push loop against a live window.
 *
 * @returns Disposer; call it on quit.
 */
export function startHealthPush(
  win: BrowserWindow,
  poller: Poller,
  options?: HealthPushOptions,
): () => void {
  return registerHealthHandlers(win, poller, options);
}
