/**
 * Connector-agnostic shapes shared by the Slack and Gmail clients (Tasks 1.3 / 1.4).
 *
 * A `RawSourceEvent` is the hand-off point between a source client and the
 * ingestion pipeline (Task 1.6): the connector has already normalized the
 * provider's payload and already run the body through `@cr/redact`, but nothing
 * has been hashed, enriched or persisted yet. The pipeline is what turns one of
 * these into a `@cr/core` `Event` (assigning `eventId`, `ingestedAt`, etc.).
 */

/**
 * One normalized, post-redaction item pulled from a connector.
 *
 * Invariant: `text` is ALWAYS the redacted text. A source client must never
 * return a `RawSourceEvent` whose `text` still contains a secret (SEC-4).
 */
export interface RawSourceEvent {
  source: 'slack' | 'gmail';
  /**
   * The connector-native identifier, unique within `source`. Slack uses
   * `${channelId}:${ts}`; Gmail uses the message id.
   */
  sourceEventId: string;
  /**
   * Conversation grouping key. Slack derives it (`${channelId}:${thread_ts ?? ts}`);
   * Gmail uses the API-level `threadId` as-is.
   */
  threadKey: string;
  /**
   * Who produced the event, in connector-native terms (Slack user id, Gmail
   * `From` address). Mapping this onto a `Person` — and hashing addresses per
   * SEC-3 — is the persistence layer's job, not the connector's.
   */
  actorId?: string;
  /** Epoch MILLISECONDS at the source. Connectors own any unit conversion. */
  occurredAt: number;
  /** Body text, already passed through `redact()`. */
  text: string;
  /**
   * Set when the connector already has cheap structural evidence that this is
   * not human conversation (bot posts, channel-join notices, bulk mail). It is
   * a hint for Layer 1's `noise` class, never a filter — the event is still
   * ingested.
   */
  isNoiseCandidate?: boolean;
}

/** Connector identity, mirroring `@cr/core`'s `SourceId`. */
export type SourceKind = RawSourceEvent['source'];

/**
 * Result of fetching one window of raw events.
 *
 * `cursor` is the source-specific point to resume from on the next poll (Slack:
 * a `ts` watermark; Gmail: a `historyId`). The poller stores it opaquely and
 * hands it back verbatim. `undefined` means there is no new resume point.
 */
export interface SourceFetchResult<TCursor> {
  events: RawSourceEvent[];
  cursor?: TCursor;
}

/**
 * A polling connector. The cursor shape is source-specific, hence the type
 * parameter.
 */
export interface SourceClient<TCursor = string> {
  readonly source: SourceKind;
  /** Everything after `cursor`, or a bounded backfill when it is absent. */
  fetchSince(cursor?: TCursor): Promise<SourceFetchResult<TCursor>>;
}

/**
 * Injectable delay. Production uses a `setTimeout` implementation; tests
 * substitute an instant version that RECORDS the requested delay, so honouring
 * a `Retry-After: 3` costs the suite microseconds instead of three seconds.
 */
export type SleepFn = (ms: number) => Promise<void>;

/** Injectable HTTP transport, so tests can serve recorded-shape fixtures. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<Response>;

/** Production `sleep`: a plain unref'd timer. */
export const realSleep: SleepFn = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending backoff must never be the reason the process stays alive.
    if (typeof timer.unref === 'function') timer.unref();
  });
