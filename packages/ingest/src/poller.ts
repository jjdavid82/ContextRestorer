/**
 * Poll scheduler for the Slack and Gmail connectors (Task 1.5).
 *
 * Responsibilities, and just as importantly the non-responsibilities:
 *
 * - It OWNS *when* each source is fetched: one independent timer per source, so
 *   a Slack call that hangs for 30s cannot delay, skip or coalesce a Gmail poll.
 * - It OWNS failure policy: `Retry-After` is honoured verbatim, everything else
 *   gets exponential backoff with additive jitter, capped by config.
 * - It OWNS source health, including the NFR-2 lag measurement.
 * - It does NOT persist anything. Fetched events are handed to `onEvents`, which
 *   is the ingestion pipeline (Task 1.6).
 * - It does NOT interpret cursors. `SourceFetchResult.cursor` is stored opaquely
 *   and handed back verbatim on the next call; `pause()`/`resume()` never clear
 *   it and never rebuild the `SourceClient`, so a Gmail `historyId` survives a
 *   pause and we do not fall back to a bounded backfill on resume.
 *
 * Everything time-related is injected (`clock`, `scheduleTimer`, `clearTimer`,
 * `random`), so the tests assert real scheduling behaviour without real waiting.
 */

import type { AppConfig, Clock } from '@cr/core';

import type { SourceHealth, SourceStatus } from './health.js';
import type { RawSourceEvent, SourceClient } from './sources/types.js';

/** The connectors this poller drives. Mirrors `AppConfig.polling`'s keys. */
export type PollSourceKind = 'slack' | 'gmail';

const POLL_SOURCES: readonly PollSourceKind[] = ['slack', 'gmail'];

/**
 * Fraction of the computed backoff added as jitter, i.e. the realised delay is
 * uniform over `[d, d * 1.2)`.
 *
 * Jitter is strictly ADDITIVE on purpose. The tempting "d * (0.8 + 0.4*rand)"
 * form can return less than the base interval, which turns a backoff into an
 * accidental *speed-up* against a service that is already unhappy.
 */
const JITTER_RATIO = 0.2;

/** Slack `error` codes (and Google reasons) that mean "the credential is bad". */
const AUTH_ERROR_CODES = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'invalid_token',
  'account_inactive',
  'missing_scope',
  'no_permission',
  'authError',
  'unauthorized',
]);

/** Hand-off to the ingestion pipeline. Awaited: a slow sink slows the poller. */
export type OnEventsFn = (
  source: PollSourceKind,
  events: RawSourceEvent[],
) => Promise<void> | void;

export interface PollerDeps {
  /** Injectable time source — nothing here calls `Date.now()` directly. */
  clock: Clock;
  /**
   * The live connector instances. Held by reference for the poller's whole
   * lifetime; `pause()`/`resume()` must not replace them, because their cursor
   * state (Slack `ts` watermark, Gmail `historyId`) lives inside them.
   */
  sources: Record<PollSourceKind, SourceClient<unknown>>;
  /** Supplies `polling.<source>.{intervalMs, maxBackoffMs}`. */
  config: AppConfig;
  /** Where fetched events go. The poller itself never persists. */
  onEvents: OnEventsFn;
  /** Defaults to `setTimeout`. Injected so tests can drive the clock. */
  scheduleTimer?: (fn: () => void, ms: number) => unknown;
  /** Defaults to `clearTimeout`. Must accept whatever `scheduleTimer` returned. */
  clearTimer?: (handle: unknown) => void;
  /** Jitter source, defaults to `Math.random`. Injected for deterministic tests. */
  random?: () => number;
}

/** Mutable per-source bookkeeping. Never handed out; `health()` copies it. */
interface SourceState {
  status: SourceStatus;
  lastSyncAt: number | null;
  /** Max `occurredAt` ever observed for this source — the basis of `lagMs`. */
  newestEventAt: number | null;
  newEventCount: number;
  /** Consecutive failed cycles; the exponent in the backoff. */
  failures: number;
  /** Delay used for the NEXT schedule; base interval after any success. */
  nextDelayMs: number;
  /** Opaque resume point from the last successful fetch. */
  cursor: unknown;
  timer: unknown;
  inFlight: boolean;
}

export class Poller {
  readonly #clock: Clock;
  readonly #sources: Record<PollSourceKind, SourceClient<unknown>>;
  readonly #config: AppConfig;
  readonly #onEvents: OnEventsFn;
  readonly #schedule: (fn: () => void, ms: number) => unknown;
  readonly #clear: (handle: unknown) => void;
  readonly #random: () => number;
  readonly #state: Record<PollSourceKind, SourceState>;

  /** False while paused or before `start()`; gates ALL rescheduling. */
  #running = false;

  constructor(deps: PollerDeps) {
    this.#clock = deps.clock;
    this.#sources = deps.sources;
    this.#config = deps.config;
    this.#onEvents = deps.onEvents;
    this.#schedule = deps.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clear = deps.clearTimer ?? ((handle) => clearTimeout(handle as never));
    this.#random = deps.random ?? Math.random;

    this.#state = {
      slack: this.#initialState('slack'),
      gmail: this.#initialState('gmail'),
    };
  }

  /**
   * Begin polling. The first cycle for each source is scheduled at delay 0 —
   * separately, so even the very first Gmail poll is independent of Slack's.
   * Idempotent: calling `start()` twice does not double up the timers.
   */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    for (const source of POLL_SOURCES) this.#scheduleNext(source, 0);
  }

  /**
   * Stop scheduling for ALL sources and cancel pending timers.
   *
   * A cycle already in flight is allowed to finish (its result is still recorded
   * and still handed to `onEvents` — dropping already-fetched events would risk
   * losing them, since the cursor has moved on), it simply does not reschedule.
   */
  pause(): void {
    if (!this.#running) return;
    this.#running = false;
    for (const source of POLL_SOURCES) this.#cancel(source);
  }

  /**
   * Resume polling with all prior state intact: cursors, backoff level and
   * health are untouched, and the `SourceClient` instances are the same objects.
   * Each source is re-armed at its own current delay (base interval when
   * healthy, the current backoff when it was failing).
   */
  resume(): void {
    if (this.#running) return;
    this.#running = true;
    for (const source of POLL_SOURCES) {
      // A cycle that outlived the pause will reschedule itself on completion;
      // arming a second timer here would double the poll rate.
      if (this.#state[source].inFlight) continue;
      this.#scheduleNext(source, this.#state[source].nextDelayMs);
    }
  }

  /** Immutable snapshot of both sources' health, `lagMs` computed against now. */
  health(): Record<PollSourceKind, SourceHealth> {
    return {
      slack: this.#healthOf('slack'),
      gmail: this.#healthOf('gmail'),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #initialState(source: PollSourceKind): SourceState {
    return {
      status: 'never_synced',
      lastSyncAt: null,
      newestEventAt: null,
      newEventCount: 0,
      failures: 0,
      nextDelayMs: this.#intervalMs(source),
      cursor: undefined,
      timer: undefined,
      inFlight: false,
    };
  }

  #intervalMs(source: PollSourceKind): number {
    return this.#config.polling[source].intervalMs;
  }

  #maxBackoffMs(source: PollSourceKind): number {
    return this.#config.polling[source].maxBackoffMs;
  }

  #healthOf(source: PollSourceKind): SourceHealth {
    const state = this.#state[source];
    return {
      status: state.status,
      lastSyncAt: state.lastSyncAt,
      // NFR-2/AC-8: staleness of the DATA, not recency of the POLL. Clamped at 0
      // because a source clock running slightly ahead must not report a
      // negative lag.
      lagMs:
        state.newestEventAt === null ? null : Math.max(0, this.#clock.now() - state.newestEventAt),
      newEventCount: state.newEventCount,
    };
  }

  #cancel(source: PollSourceKind): void {
    const state = this.#state[source];
    if (state.timer !== undefined) {
      this.#clear(state.timer);
      state.timer = undefined;
    }
  }

  #scheduleNext(source: PollSourceKind, delayMs: number): void {
    if (!this.#running) return;
    this.#cancel(source);
    this.#state[source].timer = this.#schedule(() => {
      this.#state[source].timer = undefined;
      void this.#runCycle(source);
    }, delayMs);
  }

  /**
   * One poll cycle: fetch → hand off → record → reschedule.
   *
   * The whole body is inside try/catch and each source has its own timer, so a
   * throw (or rejected promise) here can only ever affect this source's loop.
   * A failing `onEvents` counts as a failed cycle: the events did not reach the
   * pipeline, so claiming a successful sync would be a lie and would also
   * advance `lastSyncAt` past data we dropped.
   */
  async #runCycle(source: PollSourceKind): Promise<void> {
    const state = this.#state[source];
    if (state.inFlight) return;
    state.inFlight = true;

    try {
      const result = await this.#sources[source].fetchSince(state.cursor);
      const events = result.events ?? [];
      await this.#onEvents(source, events);
      this.#recordSuccess(source, events, result.cursor);
    } catch (error) {
      this.#recordFailure(source, error);
    } finally {
      state.inFlight = false;
      // `#scheduleNext` is a no-op while paused, so a cycle that finishes after
      // `pause()` quietly stops the loop instead of resurrecting it.
      this.#scheduleNext(source, state.nextDelayMs);
    }
  }

  #recordSuccess(source: PollSourceKind, events: RawSourceEvent[], cursor: unknown): void {
    const state = this.#state[source];

    // Only advance on a real resume point: `undefined` means "no new cursor",
    // and overwriting a good watermark with it would re-fetch from scratch.
    if (cursor !== undefined) state.cursor = cursor;

    for (const event of events) {
      if (state.newestEventAt === null || event.occurredAt > state.newestEventAt) {
        state.newestEventAt = event.occurredAt;
      }
    }

    state.status = 'ok';
    state.lastSyncAt = this.#clock.now();
    state.newEventCount = events.length;
    // One success wipes the whole failure run — back to the base interval.
    state.failures = 0;
    state.nextDelayMs = this.#intervalMs(source);
  }

  #recordFailure(source: PollSourceKind, error: unknown): void {
    const state = this.#state[source];
    const retryAfterMs = rateLimitRetryAfterMs(error);

    if (retryAfterMs !== null) {
      // The provider told us exactly how long to wait. Honour it verbatim
      // (bounded by the cap) and do NOT grow the backoff exponent: throttling is
      // a normal, self-correcting condition, not an outage.
      state.status = 'rate_limited';
      state.nextDelayMs = Math.min(retryAfterMs, this.#maxBackoffMs(source));
      return;
    }

    state.failures += 1;
    state.nextDelayMs = this.#backoffMs(source, state.failures);
    state.status = isAuthError(error)
      ? 'auth_error'
      : isRateLimitError(error)
        ? 'rate_limited'
        : 'backoff';
  }

  /**
   * `interval * 2^failures`, plus up to 20% jitter, capped at `maxBackoffMs`
   * and floored at the base interval.
   *
   * The floor is the important part: jitter and the cap are both applied in a
   * direction that can never produce a delay shorter than the healthy interval,
   * so a source that is failing is always polled LESS often, never more.
   */
  #backoffMs(source: PollSourceKind, failures: number): number {
    const interval = this.#intervalMs(source);
    const cap = this.#maxBackoffMs(source);
    const exponential = Math.min(interval * 2 ** failures, cap);
    const jittered = exponential + this.#random() * exponential * JITTER_RATIO;
    return Math.max(interval, Math.min(jittered, cap));
  }
}

// ---------------------------------------------------------------------------
// Error classification
//
// Duck-typed rather than `instanceof SlackApiError | GmailApiError`: the poller
// stays connector-agnostic, and a hand-rolled or future `SourceClient` gets the
// same treatment for free as long as it exposes the conventional fields.
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

/** Parse a `Retry-After`-ish value into ms. Accepts numbers and numeric strings. */
const secondsToMs = (value: unknown): number | null => {
  const seconds = typeof value === 'string' ? Number.parseFloat(value.trim()) : value;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
};

/**
 * True when the error is the provider throttling us: HTTP 429, or Slack's
 * `ratelimited` code (which it also emits on a 200 behind some proxies).
 */
export function isRateLimitError(error: unknown): boolean {
  const err = asRecord(error);
  if (err === null) return false;
  if (err['status'] === 429 || err['statusCode'] === 429) return true;
  return err['slackError'] === 'ratelimited' || err['code'] === 'ratelimited';
}

/** True when the error means the credential must be re-authorised (401/403). */
export function isAuthError(error: unknown): boolean {
  const err = asRecord(error);
  if (err === null) return false;

  const status = err['status'] ?? err['statusCode'];
  if (status === 401 || status === 403) return true;

  for (const key of ['slackError', 'code', 'reason'] as const) {
    const value = err[key];
    if (typeof value === 'string' && AUTH_ERROR_CODES.has(value)) return true;
  }

  // Gmail's shape: `{ body: { error: { code, status, errors: [{ reason }] } } }`.
  const body = asRecord(err['body']);
  const inner = body === null ? null : asRecord(body['error']);
  if (inner !== null) {
    if (inner['code'] === 401 || inner['code'] === 403) return true;
    if (inner['status'] === 'UNAUTHENTICATED' || inner['status'] === 'PERMISSION_DENIED') {
      return true;
    }
    const errors = inner['errors'];
    if (Array.isArray(errors)) {
      return errors.some((entry) => {
        const reason = asRecord(entry)?.['reason'];
        return typeof reason === 'string' && AUTH_ERROR_CODES.has(reason);
      });
    }
  }
  return false;
}

/**
 * The delay a rate-limited error explicitly asks for, in ms, or `null` when the
 * error is not a throttle or carries no usable value.
 *
 * `null` for a bare 429 is deliberate: without a number we fall through to
 * exponential backoff (and still report `rate_limited`), rather than inventing
 * a delay the provider never asked for.
 */
export function rateLimitRetryAfterMs(error: unknown): number | null {
  if (!isRateLimitError(error)) return null;
  const err = asRecord(error);
  if (err === null) return null;

  const directMs = err['retryAfterMs'];
  if (typeof directMs === 'number' && Number.isFinite(directMs) && directMs >= 0) return directMs;

  for (const key of ['retryAfterSeconds', 'retryAfter'] as const) {
    const ms = secondsToMs(err[key]);
    if (ms !== null) return ms;
  }

  // A `Headers`-like or plain-object header bag hung off the error.
  const headers = err['headers'];
  const headerGet = asRecord(headers)?.['get'];
  if (typeof headerGet === 'function') {
    const raw: unknown = (headers as Headers).get('retry-after');
    const ms = secondsToMs(raw);
    if (ms !== null) return ms;
  } else {
    const bag = asRecord(headers);
    if (bag !== null) {
      const ms = secondsToMs(bag['retry-after'] ?? bag['Retry-After']);
      if (ms !== null) return ms;
    }
  }
  return null;
}
