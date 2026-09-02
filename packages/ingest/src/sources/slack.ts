import { redact } from '@cr/redact';
import {
  realSleep,
  type FetchLike,
  type RawSourceEvent,
  type SleepFn,
  type SourceClient,
  type SourceFetchResult,
} from './types.js';

/**
 * Slack Web API connector + normalizer (Task 1.3).
 *
 * Two responsibilities, deliberately separable:
 *
 *  - `SlackClient` talks HTTP: cursor pagination over `conversations.history`
 *    and `conversations.replies`, and `Retry-After` compliance on 429s.
 *  - `normalizeSlack` is a pure function turning one raw Slack message into a
 *    `RawSourceEvent`, including the SEC-4 redaction pass.
 *
 * The normalizer is pure and exported on its own precisely so the unit-slip
 * risk in `ts` → epoch-ms can be tested without any HTTP in the picture.
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** The subset of a Slack message we depend on. Extra fields are preserved but unused. */
export interface SlackMessage {
  /** Decimal string of float SECONDS since epoch, e.g. `"1699999999.000100"`. */
  ts: string;
  text?: string;
  /** Author id for human messages. */
  user?: string;
  /** Present on anything posted by an app/bot. */
  bot_id?: string;
  /** `bot_message`, `channel_join`, `channel_leave`, … Absent for plain messages. */
  subtype?: string;
  /** Present on replies; points at the parent message's `ts`. */
  thread_ts?: string;
  /** Present on a thread parent. `> 0` means there are replies to fetch. */
  reply_count?: number;
}

/** One row of a `conversations.list` page — the subset the channel selector needs. */
export interface SlackChannelSummary {
  id: string;
  name: string;
  isMember: boolean;
}

/** The wire shape of one `conversations.list` channel entry. */
interface SlackChannelEntry {
  id: string;
  name?: string;
  is_archived?: boolean;
  is_member?: boolean;
}

/** Slack's uniform response envelope. `ok: false` carries a machine-readable `error`. */
export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  /** Present on `conversations.list` responses only. */
  channels?: SlackChannelEntry[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Subtypes that are structurally noise: channel membership churn and
 * topic/purpose/name bookkeeping. These are NOT dropped — dropping them would
 * lose ingestion-plane data that Layer 1 is the right place to judge — they are
 * only flagged.
 */
const NOISE_SUBTYPES: ReadonlySet<string> = new Set([
  'bot_message',
  'channel_join',
  'channel_leave',
  'group_join',
  'group_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_topic',
  'group_purpose',
  'group_name',
  'group_archive',
  'group_unarchive',
  'pinned_item',
  'unpinned_item',
]);

/** Slack `ts` carries microsecond precision: `<seconds>.<6 digits>`. */
const TS_RE = /^(\d+)(?:\.(\d{1,6}))?$/;

/**
 * Convert a Slack `ts` to epoch **milliseconds**.
 *
 * Slack's `ts` is a decimal string of float SECONDS with microsecond precision
 * (`"1699999999.000100"` = 1699999999.0001s). Downstream every window query is
 * in epoch ms, so a missing `* 1000` here is silent and total data loss for
 * time-bounded reads — hence the dedicated test.
 *
 * Parsed off the STRING rather than via `parseFloat(ts) * 1000` on purpose:
 * `1699999999.0001 * 1000` is `1699999999000.0999…` in IEEE-754, and relying on
 * `Math.round` to clean that up is a correctness argument we would rather not
 * have to make. The integer path is exact; sub-millisecond precision is rounded
 * half-up, which is all `Date`/SQLite can represent anyway.
 */
export function slackTsToMs(ts: string): number {
  const match = TS_RE.exec(ts.trim());
  if (match === null) {
    // Tolerate anything unexpected rather than crashing a poll cycle.
    const parsed = Number.parseFloat(ts);
    if (!Number.isFinite(parsed)) throw new Error(`Slack ts is not a number: ${ts}`);
    return Math.round(parsed * 1000);
  }

  const [, secondsPart, fractionPart] = match;
  const seconds = Number.parseInt(secondsPart ?? '0', 10);
  // Right-pad to microseconds so `.5` reads as 500000µs, not 5µs.
  const micros = Number.parseInt((fractionPart ?? '').padEnd(6, '0'), 10) || 0;

  return seconds * 1000 + Math.round(micros / 1000);
}

/**
 * `${channelId}:${thread_ts ?? ts}`.
 *
 * A top-level message anchors its own thread (it has no `thread_ts`, so its own
 * `ts` is the anchor); its replies carry `thread_ts` pointing back at it. Both
 * therefore produce the identical key, which is what makes a thread a single
 * unit downstream.
 */
export function slackThreadKey(msg: Pick<SlackMessage, 'ts' | 'thread_ts'>, channelId: string): string {
  return `${channelId}:${msg.thread_ts ?? msg.ts}`;
}

/** `${channelId}:${ts}` — unique per message, and the input to `eventId()`. */
export function slackSourceEventId(ts: string, channelId: string): string {
  return `${channelId}:${ts}`;
}

/** Bot chatter and membership/system notices. See `NOISE_SUBTYPES`. */
export function isSlackNoiseCandidate(msg: SlackMessage): boolean {
  if (msg.bot_id !== undefined && msg.bot_id !== '') return true;
  if (msg.subtype === undefined) return false;
  return NOISE_SUBTYPES.has(msg.subtype);
}

/**
 * Normalize one Slack message into a `RawSourceEvent`.
 *
 * SEC-4 ordering is load-bearing: `redact()` runs HERE, inside the normalizer,
 * so raw secret-bearing text never leaves this function — not to the pipeline,
 * not to storage, not to a model. The redaction *metadata* (`count`, `kinds`)
 * is intentionally not part of `RawSourceEvent`; Task 1.6 recomputes/persists
 * `redactionCount` at the DB layer. Callers that want it can use
 * `normalizeSlackWithRedaction`.
 */
export function normalizeSlack(msg: SlackMessage, channelId: string): RawSourceEvent {
  return normalizeSlackWithRedaction(msg, channelId).event;
}

/** `normalizeSlack` plus the redaction tally, for callers that record it. */
export function normalizeSlackWithRedaction(
  msg: SlackMessage,
  channelId: string,
): { event: RawSourceEvent; redactionCount: number; redactionKinds: string[] } {
  const redacted = redact(msg.text ?? '');

  const event: RawSourceEvent = {
    source: 'slack',
    sourceEventId: slackSourceEventId(msg.ts, channelId),
    threadKey: slackThreadKey(msg, channelId),
    occurredAt: slackTsToMs(msg.ts),
    text: redacted.text,
    isNoiseCandidate: isSlackNoiseCandidate(msg),
  };

  // `exactOptionalPropertyTypes` — an absent author is an absent key, not `undefined`.
  const actorId = msg.user ?? msg.bot_id;
  if (actorId !== undefined && actorId !== '') event.actorId = actorId;

  return { event, redactionCount: redacted.count, redactionKinds: redacted.kinds };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const SLACK_API_BASE = 'https://slack.com/api';

/** Slack's own docs cap a Tier-3 page at 200; 200 keeps round-trips down. */
const DEFAULT_PAGE_SIZE = 200;

/** Attempts beyond the first, for 429s and transient 5xx. */
const DEFAULT_MAX_RETRIES = 5;

/** Used when a 429 arrives without a parseable `Retry-After`. */
const FALLBACK_RETRY_MS = 1_000;

/** Ceiling on a single backoff, so a hostile header cannot wedge a poll forever. */
const MAX_RETRY_MS = 60_000;

export interface SlackClientOptions {
  /** Bot/user token. Sent as `Authorization: Bearer …`, never in the query string. */
  token: string;
  /** Injectable transport. Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable delay. Defaults to `setTimeout`; tests inject an instant recorder. */
  sleep?: SleepFn;
  /** Retries after the first attempt. Default 5. */
  maxRetries?: number;
  /** Override for tests/proxies. Default `https://slack.com/api`. */
  baseUrl?: string;
  /** `limit` sent to paginated endpoints. Default 200. */
  pageSize?: number;
}

/** A Slack API call that came back `ok: false`, carrying Slack's error code. */
export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly slackError: string,
    readonly status?: number,
  ) {
    super(`Slack ${method} failed: ${slackError}`);
    this.name = 'SlackApiError';
  }
}

/**
 * Cursor-paginating Slack Web API client.
 *
 * Rate limiting (R-5): a `429` is honoured by waiting AT LEAST the advertised
 * `Retry-After` seconds and then retrying the *same* request. The wait goes
 * through the injected `sleep`, so the behaviour is observable in tests without
 * anyone actually waiting three seconds.
 */
export class SlackClient implements SourceClient<string> {
  readonly source = 'slack' as const;

  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #sleep: SleepFn;
  readonly #maxRetries: number;
  readonly #baseUrl: string;
  readonly #pageSize: number;
  #channelId: string | undefined;

  constructor(options: SlackClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? realSleep;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#baseUrl = (options.baseUrl ?? SLACK_API_BASE).replace(/\/+$/, '');
    this.#pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  /**
   * One Slack API GET, with 429/5xx retry.
   *
   * Slack signals rate limiting two ways — an HTTP `429`, and (rarely, behind
   * some proxies) a `200` with `ok: false, error: "ratelimited"`. Both are
   * treated identically, because treating the second as a hard failure would
   * turn a throttle into a dropped poll cycle.
   */
  async request(method: string, params: Record<string, string | number>): Promise<SlackApiResponse> {
    const url = new URL(`${this.#baseUrl}/${method}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const response = await this.#fetch(url.toString(), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: 'application/json',
        },
      });

      if (response.status === 429) {
        // Drain the body so the socket can be reused before we go to sleep.
        await response.text().catch(() => '');
        lastError = new SlackApiError(method, 'ratelimited', 429);
        if (attempt === this.#maxRetries) break;
        await this.#sleep(retryDelayMs(response.headers.get('retry-after'), attempt));
        continue;
      }

      if (response.status >= 500) {
        await response.text().catch(() => '');
        lastError = new SlackApiError(method, `http_${response.status}`, response.status);
        if (attempt === this.#maxRetries) break;
        await this.#sleep(retryDelayMs(response.headers.get('retry-after'), attempt));
        continue;
      }

      const body = (await response.json()) as SlackApiResponse;

      if (body.ok === false && body.error === 'ratelimited') {
        lastError = new SlackApiError(method, 'ratelimited', response.status);
        if (attempt === this.#maxRetries) break;
        await this.#sleep(retryDelayMs(response.headers.get('retry-after'), attempt));
        continue;
      }

      if (body.ok === false) {
        // A non-throttle Slack error (bad token, missing scope) will not fix
        // itself on retry — fail fast so source health surfaces it.
        throw new SlackApiError(method, body.error ?? 'unknown_error', response.status);
      }

      return body;
    }

    throw lastError ?? new SlackApiError(method, 'exhausted_retries');
  }

  /**
   * Walk `response_metadata.next_cursor` until it is absent or empty,
   * accumulating every message across pages exactly once.
   *
   * Slack's contract is "an empty `next_cursor` means you are done"; a repeated
   * cursor would mean the server is looping, which we stop rather than follow.
   */
  async #paginate(method: string, params: Record<string, string | number>): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (;;) {
      const page = await this.request(method, {
        ...params,
        limit: this.#pageSize,
        ...(cursor !== undefined ? { cursor } : {}),
      });

      messages.push(...(page.messages ?? []));

      const next = page.response_metadata?.next_cursor;
      if (next === undefined || next === '') return messages;
      if (seenCursors.has(next)) return messages;

      seenCursors.add(next);
      cursor = next;
    }
  }

  /**
   * All messages in `channelId`, following pagination to the end.
   *
   * `oldest` is exclusive-ish in Slack's model (it is a watermark, not an id),
   * which is exactly the semantics a poll cursor wants.
   */
  async fetchHistory(
    channelId: string,
    options: { oldest?: string; latest?: string } = {},
  ): Promise<RawSourceEvent[]> {
    const params: Record<string, string | number> = { channel: channelId };
    if (options.oldest !== undefined) params['oldest'] = options.oldest;
    if (options.latest !== undefined) params['latest'] = options.latest;

    const messages = await this.#paginate('conversations.history', params);
    return messages.map((msg) => normalizeSlack(msg, channelId));
  }

  /**
   * The replies of one thread.
   *
   * `conversations.replies` echoes the PARENT back as the first message; by
   * default it is dropped here because `fetchHistory` already returned it and
   * emitting it twice would be a duplicate on the ingestion plane. Every
   * returned event shares the parent's `threadKey` — the replies carry
   * `thread_ts`, and the parent's own `ts` IS that `thread_ts`.
   */
  async fetchReplies(
    channelId: string,
    threadTs: string,
    options: { includeParent?: boolean } = {},
  ): Promise<RawSourceEvent[]> {
    const messages = await this.#paginate('conversations.replies', {
      channel: channelId,
      ts: threadTs,
    });

    const includeParent = options.includeParent ?? true;
    return messages
      .filter((msg) => includeParent || msg.ts !== threadTs)
      .map((msg) => normalizeSlack(msg, channelId));
  }

  /**
   * Channel history plus every thread's replies, deduplicated by
   * `sourceEventId` — a message must appear exactly once regardless of whether
   * it arrived via `history`, via `replies`, or via both.
   */
  async fetchChannel(
    channelId: string,
    options: { oldest?: string; latest?: string } = {},
  ): Promise<RawSourceEvent[]> {
    const params: Record<string, string | number> = { channel: channelId };
    if (options.oldest !== undefined) params['oldest'] = options.oldest;
    if (options.latest !== undefined) params['latest'] = options.latest;

    const parents = await this.#paginate('conversations.history', params);

    const byId = new Map<string, RawSourceEvent>();
    const collect = (event: RawSourceEvent): void => {
      if (!byId.has(event.sourceEventId)) byId.set(event.sourceEventId, event);
    };

    for (const msg of parents) collect(normalizeSlack(msg, channelId));

    for (const msg of parents) {
      if ((msg.reply_count ?? 0) <= 0) continue;
      const replies = await this.fetchReplies(channelId, msg.thread_ts ?? msg.ts);
      for (const event of replies) collect(event);
    }

    return [...byId.values()].sort((a, b) => a.occurredAt - b.occurredAt);
  }

  /** Channel targeted by `fetchSince`. Set by the poller before the first call. */
  setChannel(channelId: string): void {
    this.#channelId = channelId;
  }

  /**
   * Public channels the token's user can see, for the channel-selector UI.
   *
   * Requires `channels:read` (added to `SLACK_SCOPES` specifically for this).
   * Archived channels are excluded — polling a channel nobody can post to again
   * is never a useful selection. Paginates the same way `#paginate` does, just
   * over `channels` instead of `messages`, since `conversations.list`'s page
   * shape does not fit `SlackMessage[]`.
   */
  async listChannels(): Promise<SlackChannelSummary[]> {
    const channels: SlackChannelEntry[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (;;) {
      const page = await this.request('conversations.list', {
        types: 'public_channel',
        exclude_archived: 'true',
        limit: this.#pageSize,
        ...(cursor !== undefined ? { cursor } : {}),
      });

      channels.push(...(page.channels ?? []));

      const next = page.response_metadata?.next_cursor;
      if (next === undefined || next === '') break;
      if (seenCursors.has(next)) break;

      seenCursors.add(next);
      cursor = next;
    }

    return channels.map((c) => ({
      id: c.id,
      name: c.name ?? c.id,
      isMember: c.is_member ?? false,
    }));
  }

  /**
   * `SourceClient` entry point. The Slack cursor is a `ts` watermark: the
   * newest `occurredAt` we have seen, re-encoded as Slack seconds.
   */
  async fetchSince(cursor?: string): Promise<SourceFetchResult<string>> {
    const channelId = this.#channelId;
    if (channelId === undefined) {
      throw new Error('SlackClient.fetchSince called before setChannel()');
    }

    const events = await this.fetchChannel(
      channelId,
      cursor !== undefined ? { oldest: cursor } : {},
    );

    const newest = events.reduce((max, e) => (e.occurredAt > max ? e.occurredAt : max), 0);
    return newest > 0
      ? { events, cursor: (newest / 1000).toFixed(6) }
      : { events, ...(cursor !== undefined ? { cursor } : {}) };
  }
}

/**
 * How long to wait before retrying.
 *
 * `Retry-After` wins when present and parseable — Slack's value is a whole
 * number of seconds, and the contract we owe it is "wait AT LEAST this long",
 * so it is used verbatim rather than shortened by any local backoff logic.
 * Without a usable header we fall back to exponential backoff with jitter so a
 * fleet of clients does not resynchronise on the same retry instant.
 */
export function retryDelayMs(retryAfterHeader: string | null, attempt: number): number {
  if (retryAfterHeader !== null) {
    const seconds = Number.parseInt(retryAfterHeader.trim(), 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_MS);
    }
  }

  const backoff = FALLBACK_RETRY_MS * 2 ** attempt;
  const jitter = Math.random() * FALLBACK_RETRY_MS;
  return Math.min(backoff + jitter, MAX_RETRY_MS);
}
