/**
 * Ingestion pipeline (Task 1.6) — normalize → redact → persist → enqueue.
 *
 * This is the single funnel every connector item passes through on its way into
 * SQLite, and the ORDER of the steps in {@link IngestionPipeline.ingest} is the
 * contract:
 *
 *  1. **normalize** — `RawSourceEvent` → the `@cr/core` `Event` shape, with the
 *     deterministic `eventId(source, sourceEventId)` as the idempotency key.
 *  2. **redact (SEC-4)** — unconditionally, *before* any write. The Slack and
 *     Gmail normalizers already redact (Tasks 1.3 / 1.4), but this pass is an
 *     independent guarantee at the persistence boundary: a third connector, or a
 *     bug in a normalizer, must not be able to put a secret in the database.
 *     Re-redacting already-redacted text is a no-op — `@cr/redact` leaves its own
 *     `[REDACTED:*]` placeholders alone and does not count them.
 *  3. **persist idempotently (AC-10)** — `UNIQUE (source, source_event_id)` is
 *     the real replay defence; `insertIfAbsent` turns the violation into
 *     `{ inserted: false }` instead of a throw.
 *  4-6. **graph, watermark, hand-off** — reached ONLY for genuinely new events.
 *
 * The short-circuit on `inserted === false` is the load-bearing part. A poll of
 * an unchanged thread re-delivers the same items every tick; if a duplicate
 * still touched the D-7 watermark, `oldest_unsynth_at` would be re-armed forever
 * and Layer 2 would re-synthesize threads that never actually changed, spending
 * the whole background compute budget on nothing.
 */

import {
  artifactId as artifactIdFor,
  eventId as computeEventId,
  systemClock,
  type Artifact,
  type Clock,
  type Event,
  type SourceId,
} from '@cr/core';
import { redact } from '@cr/redact';
import type { EventsRepo, GraphRepo, WatermarkRepo } from '@cr/store';
import type { RawSourceEvent } from './sources/types.js';

/**
 * Hand-off into Layer 1. Phase 2 supplies the real durable queue; until then any
 * callback shape works — the pipeline's only obligation is to CALL it, exactly
 * once, for each genuinely new event.
 */
export type EnqueueExtraction = (eventId: string) => void | Promise<void>;

/** What one `ingest()` call did. `redactionKinds` is only meaningful when ingested. */
export interface IngestOutcome {
  status: 'ingested' | 'duplicate';
  /** Distinct redaction kinds applied to this event's body, in detector order. */
  redactionKinds?: string[];
}

/** The artifact `kind` every conversation-level artifact is filed under. */
const THREAD_ARTIFACT_KIND = 'thread';

/**
 * An `Event` mid-flight: identity and timing are settled, but the body is still
 * carried separately as `text` because it has not been through step 2 yet. It
 * becomes an `Event` only once the redacted text is folded into `payload`.
 */
interface NormalizedEvent {
  eventId: string;
  source: SourceId;
  sourceEventId: string;
  threadKey: string;
  actorId: string;
  occurredAt: number;
  ingestedAt: number;
  /** NOT yet guaranteed redacted at this point — that is step 2's job. */
  text: string;
  /** Everything except the body; the body is merged in post-redaction. */
  payload: Record<string, unknown>;
}

/**
 * `RawSourceEvent` → the DB's `Event` shape, minus the body.
 *
 * `eventId` comes from `@cr/core`'s `eventId(source, sourceEventId)` and nowhere
 * else: it is the same hash the `events` primary key uses, so two deliveries of
 * one source item always collide rather than producing two rows.
 */
export function toEvent(raw: RawSourceEvent, ingestedAt: number): NormalizedEvent {
  const payload: Record<string, unknown> = {};
  if (raw.isNoiseCandidate !== undefined) payload['isNoiseCandidate'] = raw.isNoiseCandidate;

  return {
    eventId: computeEventId(raw.source, raw.sourceEventId),
    source: raw.source,
    sourceEventId: raw.sourceEventId,
    threadKey: raw.threadKey,
    // `Event.actorId` is a plain string; an unattributed item is '' , not null.
    actorId: raw.actorId ?? '',
    occurredAt: raw.occurredAt,
    ingestedAt,
    text: raw.text,
    payload,
  };
}

/**
 * The conversation-level artifact an event belongs to.
 *
 * At this layer there is no richer external link than the thread key itself
 * (Slack `channel:thread_ts`, Gmail `threadId`), so it doubles as `externalRef`;
 * Layer 1 is what attaches real permalinks. `firstSeenAt` and `lastSeenAt` are
 * both the event's `occurredAt` — `GraphRepo.upsertArtifact` keeps the original
 * `first_seen_at` on a repeat sighting and advances `last_seen_at` via MAX, so
 * passing the same value for both is correct on first and subsequent calls.
 */
export function artifactFor(event: Event): Artifact {
  return {
    artifactId: artifactIdFor(event.source, THREAD_ARTIFACT_KIND, event.threadKey),
    source: event.source,
    kind: THREAD_ARTIFACT_KIND,
    externalRef: event.threadKey,
    title: null,
    state: null,
    ownerId: null,
    firstSeenAt: event.occurredAt,
    lastSeenAt: event.occurredAt,
  };
}

export class IngestionPipeline {
  constructor(
    private readonly events: EventsRepo,
    private readonly graph: GraphRepo,
    private readonly watermarks: WatermarkRepo,
    private readonly enqueueExtraction: EnqueueExtraction,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Ingest one raw connector item.
   *
   * Returns `{ status: 'duplicate' }` — never throws — when the item has already
   * been persisted, and in that case performs no further writes at all.
   */
  async ingest(raw: RawSourceEvent): Promise<IngestOutcome> {
    // 1. normalize
    const normalized = toEvent(raw, this.clock.now());

    // 2. redact — SEC-4, before anything is written, always.
    const { text, count, kinds } = redact(normalized.text);

    const event: Event = {
      eventId: normalized.eventId,
      source: normalized.source,
      sourceEventId: normalized.sourceEventId,
      threadKey: normalized.threadKey,
      actorId: normalized.actorId,
      occurredAt: normalized.occurredAt,
      ingestedAt: normalized.ingestedAt,
      payload: { ...normalized.payload, text },
      redactionCount: count,
    };

    // 3. persist idempotently — AC-10.
    const { inserted } = this.events.insertIfAbsent(event);
    if (!inserted) {
      // Replay: the row already exists and is append-only. Touching the graph or
      // the watermark here would re-arm D-7 for a thread that did not change.
      return { status: 'duplicate' };
    }

    // 4. graph — refresh the thread artifact's recency.
    this.graph.upsertArtifact(artifactFor(event));

    // 5. arm D-7 — new events only. The "don't reset oldest_unsynth_at" rule
    //    lives in WatermarkRepo.touch (COALESCE); do not reimplement it here.
    this.watermarks.touch(event.threadKey, event.source, event.occurredAt);

    // 6. hand off to Layer 1 (Phase 2 owns the real queue).
    await this.enqueueExtraction(event.eventId);

    return { status: 'ingested', redactionKinds: kinds };
  }

  /**
   * Ingest a batch in order, one item at a time.
   *
   * Sequential on purpose: items within a poll window can share a thread, and
   * the watermark's first-touch semantics only make sense against a deterministic
   * ordering. The result array is positionally aligned with `raws`.
   */
  async ingestBatch(raws: RawSourceEvent[]): Promise<IngestOutcome[]> {
    const outcomes: IngestOutcome[] = [];
    for (const raw of raws) {
      outcomes.push(await this.ingest(raw));
    }
    return outcomes;
  }
}
