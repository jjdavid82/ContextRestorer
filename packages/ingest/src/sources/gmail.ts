/**
 * Task 1.4 — Gmail source client and normalizer.
 *
 * Two concerns live here, deliberately separated:
 *
 *  - `GmailClient` — transport. Cursor-based sync over `users.history.list`,
 *    with a bounded backfill for the first run and for the case where Gmail has
 *    aged our cursor out. It never downloads attachment bytes (T-2 scope is
 *    metadata + body text only).
 *  - `normalizeGmail` — pure function. Turns one `users.messages.get` payload
 *    into a `RawSourceEvent`, decoding the base64url body, preferring
 *    `text/plain`, trimming quoted reply chains, and running the result through
 *    `@cr/redact` before it leaves this module (SEC-4).
 *
 * The split matters for testing: the normalizer is exercised directly against
 * fixtures with no fetch in sight, and the client is exercised against a mocked
 * `fetch` with no assertions about body parsing.
 */

import { redact } from '@cr/redact';
import type { FetchLike, RawSourceEvent, SourceClient, SourceFetchResult } from './types.js';

// ---------------------------------------------------------------------------
// Gmail API v1 response shapes (only the fields we actually consume)
// ---------------------------------------------------------------------------

/** A single RFC-822 header as Gmail returns it. */
export interface GmailHeader {
  name: string;
  value: string;
}

/** One MIME part. Multipart messages nest further parts under `parts`. */
export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  /** Non-empty for attachments; empty string for inline body parts. */
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    size?: number;
    /** base64url-encoded content. Absent on container and attachment parts. */
    data?: string;
    /** Present INSTEAD of `data` on attachment parts. We never resolve it. */
    attachmentId?: string;
  };
  parts?: GmailMessagePart[];
}

/** `users.messages.get?format=full`. */
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** Epoch MILLISECONDS, as a decimal string. Unlike Slack's `ts`, not seconds. */
  internalDate: string;
  payload?: GmailMessagePart;
}

/** `users.getProfile`. The cheapest way to read the mailbox's current cursor. */
interface GmailProfile {
  emailAddress?: string;
  historyId?: string;
}

/** `users.messages.list`. */
interface GmailMessageList {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

/** `users.history.list`. */
interface GmailHistoryList {
  history?: Array<{
    id?: string;
    messagesAdded?: Array<{ message?: { id?: string; threadId?: string } }>;
    messages?: Array<{ id?: string; threadId?: string }>;
  }>;
  nextPageToken?: string;
  /** The cursor to persist for the next incremental sync. */
  historyId?: string;
}

// ---------------------------------------------------------------------------
// Client configuration and results
// ---------------------------------------------------------------------------

/** Resolved per request, so a refreshed token is picked up without reconstruction. */
export type AccessTokenSource = string | (() => string | Promise<string>);

export interface GmailClientOptions {
  accessToken: AccessTokenSource;
  fetchImpl?: FetchLike;
  /**
   * Hard ceiling on how many messages a backfill will pull. A backfill happens
   * on first connect AND whenever Gmail expires our cursor, so it must stay
   * bounded — "sync the user's entire mailbox" is never an acceptable outcome.
   */
  backfillMaxMessages?: number;
  /** Gmail search bound applied to the backfill listing. */
  backfillQuery?: string;
  /** Safety valve on `nextPageToken` following, for both list and history. */
  maxPages?: number;
}

/** How the events in a `GmailSyncResult` were obtained. */
export type GmailSyncMode = 'incremental' | 'backfill';

/**
 * Outcome of one `sync()`.
 *
 * `mode` and `historyExpired` together are what Task 1.5 (source health)
 * observes: a `backfill` with `historyExpired: true` means Gmail aged our
 * cursor out and we silently re-based, which is a degraded — not failed —
 * state and should be visible to the user rather than swallowed.
 */
export interface GmailSyncResult {
  mode: GmailSyncMode;
  /** Normalized, redacted events. Deduplicated by message id, oldest first. */
  events: RawSourceEvent[];
  /** The cursor to persist and pass to the next `sync()` call. */
  historyId: string;
  /** True only when a stored cursor was rejected as too old by the API. */
  historyExpired: boolean;
}

/** Non-2xx from the Gmail API. `status` is kept for backoff decisions in 1.5. */
export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const DEFAULT_BACKFILL_MAX_MESSAGES = 100;
/** Gmail search syntax. Bounded in time as well as in count. */
const DEFAULT_BACKFILL_QUERY = 'newer_than:7d';
const DEFAULT_MAX_PAGES = 10;
/** Gmail's own per-request ceiling for `users.messages.list`. */
const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Read-only Gmail connector.
 *
 * Stateless with respect to the cursor: `sync()` takes the stored `historyId`
 * and returns the next one. Persisting it is the caller's job (Task 1.6), which
 * keeps this class free of any storage dependency.
 */
export class GmailClient implements SourceClient<string> {
  readonly source = 'gmail' as const;

  private readonly accessToken: AccessTokenSource;
  private readonly fetchImpl: FetchLike;
  private readonly backfillMaxMessages: number;
  private readonly backfillQuery: string;
  private readonly maxPages: number;

  constructor(options: GmailClientOptions) {
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.backfillMaxMessages = options.backfillMaxMessages ?? DEFAULT_BACKFILL_MAX_MESSAGES;
    this.backfillQuery = options.backfillQuery ?? DEFAULT_BACKFILL_QUERY;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /**
   * One poll cycle.
   *
   * - No `storedHistoryId` (first ever sync) → bounded backfill.
   * - Stored cursor accepted → incremental `users.history.list`.
   * - Stored cursor rejected as expired → bounded backfill, flagged via
   *   `historyExpired`, never thrown.
   */
  async sync(storedHistoryId?: string): Promise<GmailSyncResult> {
    if (storedHistoryId === undefined || storedHistoryId === '') {
      return this.backfill(false);
    }

    try {
      return await this.incremental(storedHistoryId);
    } catch (err) {
      if (!isExpiredHistoryError(err)) throw err;
      // Gmail keeps roughly a week of history and drops it aggressively on
      // large mailboxes. An expired cursor is expected operational behaviour,
      // not a fault: re-base on a fresh backfill and let the caller report it.
      return this.backfill(true);
    }
  }

  /**
   * `SourceClient` adapter over `sync()`, so the poller (Task 1.5) can drive
   * Slack and Gmail through one interface. The richer `GmailSyncResult` — in
   * particular `historyExpired` — is only visible through `sync()`.
   */
  async fetchSince(cursor?: string): Promise<SourceFetchResult<string>> {
    const result = await this.sync(cursor);
    return {
      events: result.events,
      ...(result.historyId !== '' ? { cursor: result.historyId } : {}),
    };
  }

  /**
   * Bounded first-run / recovery sync.
   *
   * Reads the mailbox cursor BEFORE listing messages. Doing it in that order
   * means anything that arrives mid-backfill is re-reported by the next
   * incremental sync (a duplicate, which `eventId` dedupes at the DB level per
   * AC-10) rather than skipped, which would be a permanent hole.
   */
  async backfill(historyExpired = false): Promise<GmailSyncResult> {
    const profile = await this.request<GmailProfile>('/profile');
    const profileCursor = profile.historyId ?? '';

    const ids = await this.listRecentMessageIds();
    const { events, maxHistoryId } = await this.fetchAndNormalize(ids);

    return {
      mode: 'backfill',
      events,
      // `users.getProfile` is the authoritative "current" cursor. If it somehow
      // came back without one, fall back to the highest per-message historyId
      // we saw — an empty cursor would force another backfill on every poll.
      historyId: profileCursor !== '' ? profileCursor : maxHistoryId,
      historyExpired,
    };
  }

  /** Cursor-based delta sync. Throws `GmailApiError` on an expired cursor. */
  private async incremental(storedHistoryId: string): Promise<GmailSyncResult> {
    const ids: string[] = [];
    const seen = new Set<string>();
    let cursor = storedHistoryId;
    let pageToken: string | undefined;

    for (let page = 0; page < this.maxPages; page += 1) {
      const query = new URLSearchParams({
        startHistoryId: storedHistoryId,
        // Deletions, label changes and drafts are not events we ingest.
        historyTypes: 'messageAdded',
        maxResults: String(MAX_PAGE_SIZE),
      });
      if (pageToken !== undefined) query.set('pageToken', pageToken);

      const body = await this.request<GmailHistoryList>(`/history?${query.toString()}`);

      for (const record of body.history ?? []) {
        for (const added of record.messagesAdded ?? []) {
          const id = added.message?.id;
          if (id !== undefined && !seen.has(id)) {
            seen.add(id);
            ids.push(id);
          }
        }
      }

      // Present on every page; the last page carries the cursor to persist.
      if (body.historyId !== undefined && body.historyId !== '') cursor = body.historyId;

      if (body.nextPageToken === undefined || body.nextPageToken === '') break;
      pageToken = body.nextPageToken;
    }

    const { events } = await this.fetchAndNormalize(ids);
    return { mode: 'incremental', events, historyId: cursor, historyExpired: false };
  }

  /** One or more `users.messages.list` pages, capped by `backfillMaxMessages`. */
  private async listRecentMessageIds(): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < this.maxPages; page += 1) {
      const remaining = this.backfillMaxMessages - ids.length;
      if (remaining <= 0) break;

      const query = new URLSearchParams({
        q: this.backfillQuery,
        maxResults: String(Math.min(remaining, MAX_PAGE_SIZE)),
      });
      if (pageToken !== undefined) query.set('pageToken', pageToken);

      const body = await this.request<GmailMessageList>(`/messages?${query.toString()}`);
      for (const message of body.messages ?? []) {
        if (ids.length >= this.backfillMaxMessages) break;
        ids.push(message.id);
      }

      if (body.nextPageToken === undefined || body.nextPageToken === '') break;
      pageToken = body.nextPageToken;
    }

    return ids;
  }

  /**
   * `users.messages.get?format=full` for each id, normalized.
   *
   * `format=full` returns the parsed MIME tree with inline body parts inlined,
   * and attachment parts carrying only an `attachmentId`. That is exactly the
   * scope we want: no `users.messages.attachments.get` call is ever issued.
   */
  private async fetchAndNormalize(
    ids: readonly string[],
  ): Promise<{ events: RawSourceEvent[]; maxHistoryId: string }> {
    const events: RawSourceEvent[] = [];
    let maxHistoryId = '';

    for (const id of ids) {
      const message = await this.request<GmailMessage>(
        `/messages/${encodeURIComponent(id)}?format=full`,
      );
      events.push(normalizeGmail(message));

      // historyIds are unsigned 64-bit, so compare numerically, not as strings.
      const candidate = message.historyId ?? '';
      if (candidate !== '' && (maxHistoryId === '' || Number(candidate) > Number(maxHistoryId))) {
        maxHistoryId = candidate;
      }
    }

    // Oldest first: downstream watermarking (Task 2.4) assumes ascending time.
    events.sort((a, b) => a.occurredAt - b.occurredAt);
    return { events, maxHistoryId };
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${GMAIL_API_BASE}${path}`;
    const token =
      typeof this.accessToken === 'string' ? this.accessToken : await this.accessToken();

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new GmailApiError(
        `Gmail API ${response.status} for ${path}`,
        response.status,
        url,
        body,
      );
    }
    return body as T;
  }
}

/**
 * True when `err` is Gmail telling us the `startHistoryId` is no longer
 * available. The API reports this as a plain `404`; the error body's
 * `reason`/`status` are checked too because the same condition is occasionally
 * surfaced as `failedPrecondition` on large mailboxes.
 */
function isExpiredHistoryError(err: unknown): boolean {
  if (!(err instanceof GmailApiError)) return false;
  if (err.status === 404) return true;

  const body = err.body;
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;

  const { code, status, errors } = error as {
    code?: unknown;
    status?: unknown;
    errors?: unknown;
  };
  if (code === 404) return true;
  if (status === 'NOT_FOUND' || status === 'FAILED_PRECONDITION') return true;

  if (Array.isArray(errors)) {
    return errors.some((entry) => {
      const reason = (entry as { reason?: unknown } | null)?.reason;
      return reason === 'notFound' || reason === 'failedPrecondition';
    });
  }
  return false;
}

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Gmail system labels that mark bulk/machine mail. Present on the message, so
 * this costs nothing — it is a hint for Layer 1, not a filter (the event is
 * still ingested either way).
 */
const NOISE_LABELS = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
  'SPAM',
]);

/** Case-insensitive RFC-822 header lookup. */
export function headerValue(part: GmailMessagePart | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return part?.headers?.find((header) => header.name.toLowerCase() === wanted)?.value;
}

/** `"Dana Reeves <dana@example.com>"` → `"dana@example.com"`. */
function parseAddress(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const angled = /<([^>]+)>/.exec(raw);
  const address = (angled?.[1] ?? raw).trim().toLowerCase();
  return address === '' ? undefined : address;
}

/** Decode Gmail's base64url body payload. Invalid input yields an empty string. */
export function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * True for a part whose bytes live behind `users.messages.attachments.get`, or
 * that is a named file rather than an inline body. We never walk into these and
 * never resolve their `attachmentId` — that is the whole of requirement 7.
 */
function isAttachmentPart(part: GmailMessagePart): boolean {
  if (part.body?.attachmentId !== undefined) return true;
  return part.filename !== undefined && part.filename !== '';
}

/** Count of attachment parts, for observability. Their content is never fetched. */
export function countAttachments(part: GmailMessagePart | undefined): number {
  if (part === undefined) return 0;
  if (isAttachmentPart(part)) return 1;
  return (part.parts ?? []).reduce((total, child) => total + countAttachments(child), 0);
}

/** Depth-first search for the first non-attachment part of `mimeType` with data. */
function findPart(part: GmailMessagePart | undefined, mimeType: string): GmailMessagePart | undefined {
  if (part === undefined || isAttachmentPart(part)) return undefined;

  if ((part.mimeType ?? '').toLowerCase().startsWith(mimeType) && part.body?.data !== undefined) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * A very small HTML-to-text pass. Deliberately regex-based: pulling an HTML
 * parser onto the ingestion hot path to render text we are about to summarize
 * is not a trade worth making, and the output only ever feeds an LLM.
 *
 * Drops `<style>`/`<script>` wholesale, turns block boundaries into newlines,
 * strips remaining tags, and decodes the handful of entities that actually show
 * up in mail bodies.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Remove Gmail/Outlook quote containers from HTML BEFORE tag stripping, while
 * the structural markers still exist. Once tags are gone, an HTML quote block
 * is indistinguishable from ordinary prose.
 */
function stripHtmlQuotes(html: string): string {
  return (
    html
      // Gmail wraps the quoted history in <div class="gmail_quote">, Apple Mail
      // and Outlook in <blockquote type="cite"> / a signature+quote wrapper.
      .replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/i, '')
      .replace(/<blockquote[^>]*type="cite"[\s\S]*$/i, '')
      .replace(/<div[^>]*id="(?:divRplyFwdMsg|appendonsend)"[\s\S]*$/i, '')
  );
}

/**
 * Line-level quote markers. Anchored at line start; the surrounding function
 * cuts the body at the FIRST line that matches any of them.
 */
const QUOTE_MARKERS: readonly RegExp[] = [
  // Gmail/Apple Mail attribution, one-line form:
  //   "On Tue, Aug 25, 2026 at 9:12 AM Dana Reeves <dana@example.com> wrote:"
  /^\s*On\b[\s\S]{0,200}?\bwrote:\s*$/,
  // Outlook / Thunderbird separators.
  /^\s*-{2,}\s*(Original Message|Forwarded message)\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,
  /^\s*-{5,}\s*$/,
  // Outlook's quoted header block always opens with a From: line.
  /^\s*From:\s*.+<[^>]+>\s*$/,
  /^\s*From:\s*\S+@\S+\s*$/,
  // Quoted text itself.
  /^\s*>/,
];

/**
 * Trim the quoted history off a reply body.
 *
 * Without this, every reply in a thread re-ingests the entire conversation
 * above it: a 10-message thread ingests the first message 10 times, which
 * inflates the vector index, wastes Layer 1 calls, and makes Layer 2 see a
 * burst of "activity" that never happened.
 *
 * The heuristic: cut at the first line that looks like a quote marker (an
 * attribution line, a client separator, or the start of a `>`-prefixed run),
 * plus the split form of Gmail's attribution where "wrote:" lands on its own
 * line after a wrapped "On …" line.
 *
 * KNOWN LIMITATIONS — this is a heuristic, not a MIME/quote parser:
 *  - Non-English clients ("Am … schrieb:", "Le … a écrit :") are not matched,
 *    so their quoted history survives.
 *  - Interleaved / inline replies (new text written BETWEEN quoted blocks) lose
 *    everything after the first quoted line.
 *  - A deliberately forwarded message is treated as quoted history and dropped,
 *    even though its content may be the entire point of the mail.
 *  - Signatures ("-- \nDana") are only removed when they happen to sit below a
 *    marker; a signature above the quote is kept.
 *  - A body that legitimately begins with a quote marker normalizes to empty
 *    text, which is the safe direction (an empty event, not a duplicated one).
 */
export function trimQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);

  let cut = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (QUOTE_MARKERS.some((marker) => marker.test(line))) {
      cut = i;
      break;
    }

    // Wrapped attribution: "On <date> <person>" on one line, "wrote:" on the
    // next. Gmail produces this whenever the attribution exceeds the wrap width.
    if (/^\s*On\b/.test(line)) {
      const lookahead = lines.slice(i + 1, i + 4);
      const joinedEnd = lookahead.findIndex((next) => /\bwrote:\s*$/.test(next));
      if (joinedEnd !== -1) {
        cut = i;
        break;
      }
    }
  }

  return lines
    .slice(0, cut)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract readable body text from a message payload.
 *
 * `multipart/alternative` carries the same content twice; `text/plain` is the
 * authoritative version and is preferred. `text/html` is used only when it is
 * the sole representation, with its quote containers removed before its tags
 * are stripped.
 */
export function extractBodyText(payload: GmailMessagePart | undefined): string {
  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data !== undefined) {
    return decodeBase64Url(plain.body.data);
  }

  const html = findPart(payload, 'text/html');
  if (html?.body?.data !== undefined) {
    return stripHtml(stripHtmlQuotes(decodeBase64Url(html.body.data)));
  }

  return '';
}

/**
 * Normalize one Gmail message into a redacted `RawSourceEvent`.
 *
 * Pure and synchronous — no network, in particular no attachment fetch.
 *
 * Notes on the field mapping:
 *  - `threadKey` is `threadId` verbatim. Gmail threads conversations at the API
 *    level, so unlike Slack there is nothing to derive.
 *  - `occurredAt` is `internalDate` parsed as an integer. Gmail already reports
 *    epoch MILLISECONDS here; multiplying by 1000 (the correct move for Slack's
 *    `ts`) would put every event in the year 57000.
 *  - `text` is post-redaction, always (SEC-4).
 */
export function normalizeGmail(message: GmailMessage): RawSourceEvent {
  const rawBody = extractBodyText(message.payload);
  const trimmed = trimQuotedReply(rawBody);
  const { text } = redact(trimmed);

  const actorId = parseAddress(headerValue(message.payload, 'from'));
  const labels = message.labelIds ?? [];
  const isNoiseCandidate =
    labels.some((label) => NOISE_LABELS.has(label)) ||
    headerValue(message.payload, 'list-unsubscribe') !== undefined ||
    /(?:no-?reply|do-?not-?reply)@/i.test(actorId ?? '');

  const occurredAt = Number.parseInt(message.internalDate, 10);

  return {
    source: 'gmail',
    sourceEventId: message.id,
    threadKey: message.threadId,
    ...(actorId !== undefined ? { actorId } : {}),
    occurredAt: Number.isFinite(occurredAt) ? occurredAt : 0,
    text,
    ...(isNoiseCandidate ? { isNoiseCandidate: true } : {}),
  };
}
