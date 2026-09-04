import type { SourceId } from './ids.js';

export type { SourceId };

/** Layer-1 classification of a single source event. */
export type ExtractionClass = 'decision' | 'question' | 'status_update' | 'noise';

/** Layer-2 synthesis output category. */
export type DeltaKind = 'decision' | 'progress' | 'reversal' | 'resolution';

export type PendingStatus = 'open' | 'resolved' | 'dismissed';

/** How a briefing narrative was produced — `template` is the deterministic fallback. */
export type BriefingMode = 'llm' | 'template';

export type FeedbackVerdict = 'relevant' | 'irrelevant' | 'missed' | 'wrong';

/**
 * A single raw item pulled from a connector, post-redaction.
 * `eventId` is the deterministic hash of (source, sourceEventId) — see ids.ts.
 */
export interface Event {
  eventId: string;
  source: SourceId;
  /** The connector-native id (Slack `channel:ts`, Gmail message id). */
  sourceEventId: string;
  /** Conversation grouping key: Slack thread root or Gmail RFC-822 thread id. */
  threadKey: string;
  actorId: string;
  /** Epoch ms at which the event happened at the source. */
  occurredAt: number;
  /** Epoch ms at which we persisted it locally. */
  ingestedAt: number;
  /** Parsed `payload_json` — connector-shaped, opaque to the domain. */
  payload: Record<string, unknown>;
  /** Number of spans the redactor replaced before persistence. */
  redactionCount: number;
}

/** A durable external object (doc, ticket, PR, message permalink) used for citations. */
export interface Artifact {
  artifactId: string;
  source: SourceId;
  /** e.g. 'message', 'thread', 'document', 'issue'. */
  kind: string;
  /** Stable external identifier or permalink used to re-resolve the artifact. */
  externalRef: string;
  title: string | null;
  /** Lifecycle state as reported by the source, when it exposes one. */
  state: string | null;
  ownerId: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface Person {
  personId: string;
  displayName: string;
  /** Salted hash — raw addresses are never persisted (SEC-3). */
  emailHash: string | null;
  /** Stored as INTEGER 0/1; repositories convert at the boundary. */
  isSelf: boolean;
}

export interface Project {
  projectId: string;
  name: string;
  /** 'declared' during onboarding, or 'inferred' from activity clustering. */
  origin: string;
  /** Relative importance multiplier applied during ranking. */
  stakesWeight: number;
  declaredAt: number;
}

/** Layer-1 output: what a single event asserts. */
export interface Extraction {
  extractionId: string;
  eventId: string;
  class: ExtractionClass;
  confidence: number;
  /** Parsed `participants_json` — person ids mentioned or acting. */
  participants: string[];
  /** Parsed `artifacts_json` — artifact ids referenced by the event. */
  artifacts: string[];
  model: string;
  promptVersion: string;
  createdAt: number;
}

/** Layer-2 output: an append-only, versioned statement of how a thread changed. */
export interface StateDelta {
  deltaId: string;
  threadKey: string;
  /** The primary artifact this delta is about, when one exists. */
  artifactId: string | null;
  /** Monotonic per `threadKey`, starting at 1. */
  version: number;
  /** deltaId of the version this one replaces; null for the first version. */
  supersedes: string | null;
  summary: string;
  kind: DeltaKind;
  confidence: number;
  /** Parsed `source_event_ids_json` — the events synthesized into this delta. */
  sourceEventIds: string[];
  /** Parsed `citation_artifact_ids_json` — every artifact backing the summary. */
  citationArtifactIds: string[];
  model: string;
  promptVersion: string;
  createdAt: number;
}

/** An outstanding obligation extracted from a delta. */
export interface PendingItem {
  pendingId: string;
  deltaId: string;
  description: string;
  confidence: number;
  citationArtifactId: string | null;
  status: PendingStatus;
  createdAt: number;
  /** Epoch ms when the item left `open`; null while still open. */
  resolvedAt: number | null;
}

/** Layer-3 output: one generated briefing over a time window. */
export interface Briefing {
  briefingId: string;
  windowStart: number;
  windowEnd: number;
  generatedAt: number;
  mode: BriefingMode;
  /**
   * True when generation was cut short before the model finished — currently
   * only by the `budgets.generationMs` deadline (§7.8).
   *
   * Orthogonal to {@link mode}: every claim in a partial briefing is still a
   * real, gated, cited LLM claim, so it is NOT the template fallback. It is also
   * orthogonal to {@link threadsStillProcessing}, which describes the *input*
   * backlog rather than this generation attempt.
   */
  partial: boolean;
  /** Filesystem path to the stored narrative markdown. */
  narrativePath: string;
  /** Parsed `delta_ids_json` — the deltas included in this briefing. */
  deltaIds: string[];
  /** Count of threads still awaiting synthesis when the briefing was generated. */
  threadsStillProcessing: number;
  /** Epoch ms at which the backlog drained to zero; null while still processing. */
  caughtUpAt: number | null;
  /** Streaming latency metrics; null until generation completes. */
  firstTokenMs: number | null;
  totalMs: number | null;
}

/** One atomic, individually citable sentence of a briefing narrative. */
/**
 * Who wrote a claim (P0, deterministic-first).
 *
 * `'template'` — rendered from a stored `StateDelta` with no inference. Under
 * deterministic-first this is the NORMAL case, not a degraded one.
 * `'llm'` — written by the background pre-computer through Layer 3.
 *
 * Per CLAIM rather than per briefing because a briefing is legitimately mixed:
 * the pre-computer may have covered some deltas in a window and not others.
 */
export type ClaimProvenance = 'template' | 'llm';

export interface BriefingClaim {
  claimId: string;
  briefingId: string;
  /** Position within the briefing, used to re-assemble the narrative in order. */
  ordinal: number;
  section: string;
  text: string;
  /** Every claim must cite an artifact; null only for template-mode connective text. */
  citationArtifactId: string | null;
  deltaId: string | null;
  /** Who wrote it. See {@link ClaimProvenance}. */
  producedBy: ClaimProvenance;
}

export interface Feedback {
  feedbackId: string;
  briefingId: string;
  /** Null for briefing-level feedback such as `missed`. */
  claimId: string | null;
  verdict: FeedbackVerdict;
  note?: string;
  createdAt: number;
}

/** Telemetry for a single model invocation (NFR observability). */
export interface AiCall {
  callId: string;
  traceId: string;
  /** 1 = extraction, 2 = synthesis, 3 = briefing generation. */
  layer: number;
  model: string;
  promptVersion: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  /** e.g. 'ok', 'timeout', 'parse_error', 'fallback'. */
  outcome: string;
  createdAt: number;
}

/** Per-thread synthesis progress marker driving the debounce scheduler. */
export interface SynthesisWatermark {
  threadKey: string;
  source: SourceId;
  /** Occurred-at of the oldest event not yet synthesized; null when fully caught up. */
  oldestUnsynthAt: number | null;
  lastEventAt: number;
  /** Epoch ms of the last successful synthesis; null if never synthesized. */
  lastSynthesizedAt: number | null;
  /** Consecutive failed synthesis attempts, for backoff and poison-thread detection. */
  attempts: number;
}
