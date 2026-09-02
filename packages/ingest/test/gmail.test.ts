import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GmailClient,
  normalizeGmail,
  trimQuotedReply,
  extractBodyText,
  type GmailMessage,
} from '../src/sources/gmail.js';

// ---------------------------------------------------------------------------
// Fixtures — recorded-shape Gmail API v1 responses
// ---------------------------------------------------------------------------

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/gmail/${name}.json`, import.meta.url), 'utf8')) as T;

const profile = fixture<{ historyId: string }>('profile');
const messagesList = fixture<{ messages: Array<{ id: string }> }>('messages-list');
const historyList = fixture<{ historyId: string }>('history-list');
const historyExpired = fixture<unknown>('history-expired');

const MESSAGES: Record<string, GmailMessage> = {
  'msg-plain-001': fixture<GmailMessage>('message-plain-multipart'),
  'msg-html-002': fixture<GmailMessage>('message-html-only'),
  'msg-quoted-003': fixture<GmailMessage>('message-quoted-reply'),
  'msg-attach-004': fixture<GmailMessage>('message-with-attachment'),
  'msg-htmlquote-005': fixture<GmailMessage>('message-html-quoted'),
  'msg-secret-006': fixture<GmailMessage>('message-with-secret'),
  'msg-bulk-007': fixture<GmailMessage>('message-bulk'),
};

/** The exact `internalDate` recorded in `message-plain-multipart.json`. */
const PLAIN_INTERNAL_DATE_MS = 1787097600000;

// ---------------------------------------------------------------------------
// Mocked transport
// ---------------------------------------------------------------------------

interface MockOptions {
  /** Serve this instead of `history-list.json` on `users.history.list`. */
  historyResponse?: { status: number; body: unknown };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Routes Gmail API URLs onto the fixtures. Every call is recorded on `.mock`. */
function createFetch(options: MockOptions = {}) {
  return vi.fn(async (url: string): Promise<Response> => {
    if (url.includes('/users/me/profile')) return json(profile);

    if (url.includes('/users/me/history')) {
      const configured = options.historyResponse;
      if (configured !== undefined) return json(configured.body, configured.status);
      return json(historyList);
    }

    const single = /\/users\/me\/messages\/([^?]+)/.exec(url);
    if (single !== null) {
      const id = decodeURIComponent(single[1] ?? '');
      const message = MESSAGES[id];
      if (message === undefined) return json({ error: { code: 404 } }, 404);
      return json(message);
    }

    if (url.includes('/users/me/messages')) return json(messagesList);

    throw new Error(`unexpected URL in test: ${url}`);
  });
}

const urlsOf = (fetchMock: ReturnType<typeof createFetch>): string[] =>
  fetchMock.mock.calls.map((call) => call[0]);

const client = (fetchMock: ReturnType<typeof createFetch>): GmailClient =>
  new GmailClient({ accessToken: 'ya29.test-access-token', fetchImpl: fetchMock });

// ---------------------------------------------------------------------------
// Cursor-based sync
// ---------------------------------------------------------------------------

describe('GmailClient.sync — cursor handling', () => {
  it('performs a BOUNDED backfill on the first sync and records the current historyId', async () => {
    const fetchMock = createFetch();

    const result = await client(fetchMock).sync();

    expect(result.mode).toBe('backfill');
    expect(result.historyExpired).toBe(false);
    // The cursor to persist comes from the API response, not from us.
    expect(result.historyId).toBe(profile.historyId);
    expect(result.events).toHaveLength(messagesList.messages.length);

    const urls = urlsOf(fetchMock);
    // No stored cursor ⇒ history.list is never consulted.
    expect(urls.some((url) => url.includes('/users/me/history'))).toBe(false);

    const listUrl = urls.find((url) => /\/users\/me\/messages\?/.test(url));
    expect(listUrl).toBeDefined();
    // Bounded in BOTH directions: a time-bounded query and a capped page size.
    expect(listUrl).toContain('newer_than');
    const maxResults = Number(new URL(listUrl ?? '').searchParams.get('maxResults'));
    expect(maxResults).toBeGreaterThan(0);
    expect(maxResults).toBeLessThanOrEqual(100);
  });

  it('sends the stored historyId to users.history.list and returns the new one to persist', async () => {
    const fetchMock = createFetch();

    const result = await client(fetchMock).sync(profile.historyId);

    expect(result.mode).toBe('incremental');
    expect(result.historyExpired).toBe(false);
    expect(result.historyId).toBe(historyList.historyId);
    expect(result.historyId).not.toBe(profile.historyId);

    const historyUrl = urlsOf(fetchMock).find((url) => url.includes('/users/me/history'));
    expect(historyUrl).toBeDefined();
    expect(new URL(historyUrl ?? '').searchParams.get('startHistoryId')).toBe(profile.historyId);

    // Only the messages history reported as added are fetched.
    expect(result.events.map((event) => event.sourceEventId)).toEqual([
      'msg-quoted-003',
      'msg-attach-004',
    ]);
  });

  it('feeds the persisted cursor back into the following sync', async () => {
    const fetchMock = createFetch();
    const gmail = client(fetchMock);

    const first = await gmail.sync(profile.historyId);
    await gmail.sync(first.historyId);

    const startIds = urlsOf(fetchMock)
      .filter((url) => url.includes('/users/me/history'))
      .map((url) => new URL(url).searchParams.get('startHistoryId'));

    expect(startIds).toEqual([profile.historyId, historyList.historyId]);
  });

  it('sends the bearer token on every request', async () => {
    const fetchMock = createFetch();
    await client(fetchMock).sync();

    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as { headers?: Record<string, string> } | undefined)?.headers;
      expect(headers?.['authorization']).toBe('Bearer ya29.test-access-token');
    }
  });
});

describe('GmailClient.sync — expired history cursor', () => {
  it('falls back to a full re-sync on a 404 instead of throwing, and says so', async () => {
    const fetchMock = createFetch({ historyResponse: { status: 404, body: historyExpired } });

    const result = await client(fetchMock).sync('411001');

    // Recovered, not crashed.
    expect(result.mode).toBe('backfill');
    expect(result.events).toHaveLength(messagesList.messages.length);
    expect(result.historyId).toBe(profile.historyId);

    // …and distinguishable from a normal incremental sync, so Task 1.5 (source
    // health) has something to observe.
    expect(result.historyExpired).toBe(true);

    const urls = urlsOf(fetchMock);
    expect(urls.some((url) => url.includes('startHistoryId=411001'))).toBe(true);
    expect(urls.some((url) => /\/users\/me\/messages\?/.test(url))).toBe(true);
  });

  it('a normal incremental sync is NOT flagged as expired', async () => {
    const fetchMock = createFetch();
    const incremental = await client(fetchMock).sync(profile.historyId);

    expect(incremental.historyExpired).toBe(false);
    expect(incremental.mode).toBe('incremental');
  });

  it('still throws on errors that are not an expired cursor', async () => {
    const fetchMock = createFetch({
      historyResponse: { status: 500, body: { error: { code: 500, status: 'INTERNAL' } } },
    });

    await expect(client(fetchMock).sync(profile.historyId)).rejects.toThrow(/500/);
  });
});

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

describe('normalizeGmail — field mapping', () => {
  const message = MESSAGES['msg-plain-001'] as GmailMessage;

  it('uses the Gmail threadId verbatim as threadKey', () => {
    const event = normalizeGmail(message);

    expect(event.threadKey).toBe(message.threadId);
    expect(event.threadKey).toBe('thread-aaa-111');
    expect(event.sourceEventId).toBe('msg-plain-001');
    expect(event.source).toBe('gmail');
  });

  it('parses internalDate as epoch ms with NO unit conversion', () => {
    // Gmail already reports milliseconds here — unlike Slack's seconds-based
    // `ts`, so any multiply/divide is a bug.
    expect(message.internalDate).toBe('1787097600000');

    const event = normalizeGmail(message);

    expect(event.occurredAt).toBe(PLAIN_INTERNAL_DATE_MS);
    expect(event.occurredAt).toBe(Number.parseInt(message.internalDate, 10));
  });

  it('extracts the sender address as actorId and flags bulk mail as noise', () => {
    expect(normalizeGmail(message).actorId).toBe('sam.okafor@example.com');
    expect(normalizeGmail(message).isNoiseCandidate).toBeUndefined();

    const bulk = normalizeGmail(MESSAGES['msg-bulk-007'] as GmailMessage);
    expect(bulk.isNoiseCandidate).toBe(true);
  });
});

describe('normalizeGmail — body decoding', () => {
  it('prefers the text/plain part of a multipart/alternative message', () => {
    const event = normalizeGmail(MESSAGES['msg-plain-001'] as GmailMessage);

    expect(event.text).toContain('Decision: we are going with Postgres for the datastore.');
    expect(event.text).toContain('Migration starts Monday');
    // The HTML twin of the same content must not leak in.
    expect(event.text).not.toContain('HTML_ALTERNATIVE_SENTINEL');
    expect(event.text).not.toContain('<');
  });

  it('falls back to text/html with tags stripped when that is the only part', () => {
    const event = normalizeGmail(MESSAGES['msg-html-002'] as GmailMessage);

    expect(event.text).toContain('Sprint review moved to Thursday at 10:00.');
    // Entities decoded, markup and stylesheet gone.
    expect(event.text).toContain('shared doc & the deck');
    expect(event.text).not.toContain('<');
    expect(event.text).not.toContain('color:red');
  });
});

describe('normalizeGmail — quoted-reply trimming', () => {
  it('drops the quoted history so a thread is not re-ingested on every reply', () => {
    const message = MESSAGES['msg-quoted-003'] as GmailMessage;
    const raw = extractBodyText(message.payload);
    const event = normalizeGmail(message);

    expect(event.text).toBe('Confirmed, Thursday works for me.');
    expect(raw).toContain('QUOTED_SENTINEL_DO_NOT_INGEST');
    expect(event.text).not.toContain('QUOTED_SENTINEL_DO_NOT_INGEST');
    expect(event.text).not.toContain('wrote:');
    expect(event.text.length).toBeLessThan(raw.length / 2);
  });

  it('drops an HTML gmail_quote container too', () => {
    const event = normalizeGmail(MESSAGES['msg-htmlquote-005'] as GmailMessage);

    expect(event.text).toBe('Shipping it today.');
    expect(event.text).not.toContain('HTML_QUOTED_SENTINEL_DO_NOT_INGEST');
  });

  it('cuts at a bare run of >-prefixed lines and at Outlook separators', () => {
    expect(trimQuotedReply('Ship it.\n\n> old text\n> more old text')).toBe('Ship it.');
    expect(
      trimQuotedReply('Ship it.\n\n-----Original Message-----\nFrom: a@b.com\nold text'),
    ).toBe('Ship it.');
    // Wrapped Gmail attribution, with "wrote:" on its own line.
    expect(
      trimQuotedReply(
        'Ship it.\n\nOn Tue, Aug 25, 2026 at 9:12 AM Priya Raman\n<priya.raman@example.com>\nwrote:\nold text',
      ),
    ).toBe('Ship it.');
  });
});

describe('attachments', () => {
  it('never fetches attachment content', async () => {
    const fetchMock = createFetch();

    const result = await client(fetchMock).sync(profile.historyId);

    const event = result.events.find((candidate) => candidate.sourceEventId === 'msg-attach-004');
    expect(event?.text).toContain('Roadmap deck attached');

    const attachmentId =
      MESSAGES['msg-attach-004']?.payload?.parts?.[1]?.body?.attachmentId ?? 'missing';
    for (const url of urlsOf(fetchMock)) {
      expect(url).not.toContain('/attachments');
      expect(url).not.toContain(attachmentId);
    }
  });
});

describe('redaction (SEC-4)', () => {
  it('redacts secrets before the event leaves the normalizer', () => {
    const message = MESSAGES['msg-secret-006'] as GmailMessage;
    const raw = extractBodyText(message.payload);
    const event = normalizeGmail(message);

    expect(raw).toContain('AKIAIOSFODNN7EXAMPLE');

    expect(event.text).toContain('[REDACTED:');
    expect(event.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(event.text).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(event.text).not.toContain('hunter2trombone');
    // Surrounding prose survives — only the secret spans are replaced.
    expect(event.text).toContain('Rotating the staging keys');
  });

  it('redacts on the client path too, not just via direct normalizer calls', async () => {
    const fetchMock = createFetch({
      historyResponse: {
        status: 200,
        body: {
          history: [{ id: '1', messagesAdded: [{ message: { id: 'msg-secret-006' } }] }],
          historyId: '998099',
        },
      },
    });

    const result = await client(fetchMock).sync(profile.historyId);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.events[0]?.text).toContain('[REDACTED:');
  });
});
