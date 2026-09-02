export { openDb } from './db.js';
export { migrate, currentSchemaVersion } from './migrate.js';
export { openVectors } from './vectors.js';
export type { Chunk, VectorStore, SearchFilter, SearchResult, OpenVectorsOptions } from './vectors.js';
export { EventsRepo } from './repos/events.js';
export { GraphRepo } from './repos/graph.js';
export { BriefingsRepo } from './repos/briefings.js';
export type { CreateBriefingInput, AddClaimInput, DurationStats } from './repos/briefings.js';
export { FeedbackRepo } from './repos/feedback.js';
export type { SubmitFeedbackInput } from './repos/feedback.js';
export { AiCallsRepo } from './repos/aiCalls.js';
export type {
  AiLayer,
  LogAiCallInput,
  AiLayerStat,
  AiOutcomeStat,
} from './repos/aiCalls.js';
export { ExtractionsRepo } from './repos/extractions.js';
export type { NewExtraction } from './repos/extractions.js';
export { DeltasRepo } from './repos/deltas.js';
export type { NewStateDelta } from './repos/deltas.js';
export { PendingItemsRepo } from './repos/pending.js';
export type { NewPendingItem } from './repos/pending.js';
export { WatermarkRepo } from './repos/watermark.js';
export type { DueThread } from './repos/watermark.js';
// Privileged writers (retention NFR + SEC-8 right-to-delete). These are the only
// functions allowed to drop the append-only triggers; do not import them to
// delete rows from anywhere else.
export { purgeRawEventsOlderThan, deleteEverything } from './retention.js';
export type { DeleteEverythingResult } from './retention.js';
// Recurring briefing schedules (FR-3 time-based half, OI-4). Additive: the
// `briefing_schedules` table ships with migration 001.
export { BriefingSchedulesRepo, BRIEFING_CADENCES } from './repos/briefingSchedules.js';
export type {
  BriefingSchedule,
  BriefingCadence,
  CreateBriefingScheduleInput,
} from './repos/briefingSchedules.js';
// Slack channel selector (Task 1.7's gap, closed). Migration 004.
export { SlackChannelsRepo } from './repos/slackChannels.js';
export type { SelectedSlackChannel } from './repos/slackChannels.js';
// Generic app-level settings (currently: the selected chat model). Migration 005.
export { AppSettingsRepo } from './repos/appSettings.js';
