export { createChallenge, createState, type PkceChallenge } from './oauth/pkce.js';
export {
  startLoopbackServer,
  type LoopbackResult,
  type LoopbackServer,
} from './oauth/loopback.js';
export {
  TokenVault,
  type OAuthTokens,
  type SafeStorageLike,
  type SourceId,
} from './oauth/vault.js';
export { GMAIL_SCOPES, SLACK_SCOPES } from './oauth/scopes.js';
export {
  SlackApiError,
  SlackClient,
  isSlackNoiseCandidate,
  normalizeSlack,
  normalizeSlackWithRedaction,
  retryDelayMs,
  slackSourceEventId,
  slackThreadKey,
  slackTsToMs,
  type SlackApiResponse,
  type SlackChannelSummary,
  type SlackClientOptions,
  type SlackMessage,
} from './sources/slack.js';
export {
  GmailApiError,
  GmailClient,
  countAttachments,
  decodeBase64Url,
  extractBodyText,
  headerValue,
  normalizeGmail,
  stripHtml,
  trimQuotedReply,
  type AccessTokenSource,
  type GmailClientOptions,
  type GmailHeader,
  type GmailMessage,
  type GmailMessagePart,
  type GmailSyncMode,
  type GmailSyncResult,
} from './sources/gmail.js';
export type {
  RawSourceEvent,
  SourceClient,
  SourceFetchResult,
  SourceKind,
} from './sources/types.js';
export {
  IngestionPipeline,
  artifactFor,
  toEvent,
  type EnqueueExtraction,
  type IngestOutcome,
} from './pipeline.js';
export {
  suggestProjects,
  isGenericSlackChannel,
  isGmailSystemLabel,
  normalizeSubject,
  type ProjectCandidate,
} from './suggestProjects.js';
export type { SourceHealth, SourceStatus } from './health.js';
export {
  Poller,
  isAuthError,
  isRateLimitError,
  rateLimitRetryAfterMs,
  type OnEventsFn,
  type PollSourceKind,
  type PollerDeps,
} from './poller.js';
