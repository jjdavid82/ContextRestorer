import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';

import {
  SlackClient,
  isSlackNoiseCandidate,
  normalizeSlack,
  slackThreadKey,
  slackTsToMs,
  type SlackApiResponse,
  type SlackMessage,
} from '../src/sources/slack.js';
import type { RawSourceEvent, SleepFn } from '../src/sources/types.js';

const CHANNEL = 'C0PLATFORM';

const fixture = (name: string): SlackApiResponse =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/slack/${name}.json`, import.meta.url)), 'utf8'),
  ) as SlackApiResponse;

const messagesOf = (name: string): SlackMessage[] => fixture(name).messages ?? [];

/** Build a real `Response` so header access mirrors production exactly. */
const json = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

/** Instant `sleep` that records every requested delay in order. */
const recordingSleep = (): { sleep: SleepFn; delays: number[] } => {
  const delays: number[] = [];
  const sleep: SleepFn = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
};

/**
 * Transport that answers from fixtures based on the Slack method in the URL.
 * `queue` entries are consumed in order per method, so a 429-then-200 sequence
 * can be expressed directly.
 */
type FetchInit = { method?: string; headers?: Record<string, string> };

const scriptedFetch = (script: Record<string, Array<() => Response>>) => {
  const urls: string[] = [];
  const remaining = new Map<string, Array<() => Response>>(
    Object.entries(script).map(([method, responses]) => [method, [...responses]]),
  );

  const fetchImpl = vi.fn((input: string, _init?: FetchInit): Promise<Response> => {
    urls.push(input);
    const method = new URL(input).pathname.split('/').pop() ?? '';
    const queue = remaining.get(method);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`unexpected Slack call: ${method} (${input})`);
    }
    // Keep the last scripted response as the steady state for extra calls.
    const next = queue.length === 1 ? queue[0] : queue.shift();
    return Promise.resolve(next!());
  });

  return { fetchImpl, urls };
};

const makeClient = (
  script: Record<string, Array<() => Response>>,
  overrides: { sleep?: SleepFn; maxRetries?: number } = {},
) => {
  const { fetchImpl, urls } = scriptedFetch(script);
  const client = new SlackClient({
    token: 'xoxb-test-token',
    fetchImpl,
    ...(overrides.sleep !== undefined ? { sleep: overrides.sleep } : {}),
    ...(overrides.maxRetries !== undefined ? { maxRetries: overrides.maxRetries } : {}),
  });
  return { client, fetchImpl, urls };
};

describe('slackTsToMs — Slack float seconds to epoch milliseconds', () => {
  it('converts the exact fixture ts "1699999999.000100" to 1699999999000 ms', () => {
    // 1699999999.0001 SECONDS -> 1699999999000.1 ms -> 1699999999000.
    // If this ever reads 1699999999 the `* 1000` was lost and every window
    // query downstream silently returns nothing.
    expect(slackTsToMs('1699999999.000100')).toBe(1699999999000);
  });

  it('is in milliseconds, not seconds — three orders of magnitude apart', () => {
    const ms = slackTsToMs('1700000050.000200');
    expect(ms).toBe(1700000050000);
    expect(ms).toBeGreaterThan(1_000_000_000_000);
    expect(Math.floor(ms / 1000)).toBe(1700000050);
  });

  it('rounds sub-millisecond precision rather than truncating the seconds', () => {
    expect(slackTsToMs('1700000000.123456')).toBe(1700000000123);
    expect(slackTsToMs('1700000000.999999')).toBe(1700000001000);
    expect(slackTsToMs('1700000000.500000')).toBe(1700000000500);
    // Short fractions are microseconds left-aligned: `.5` is 500000us = 500ms.
    expect(slackTsToMs('1700000000.5')).toBe(1700000000500);
    expect(slackTsToMs('1700000000')).toBe(1700000000000);
  });

  it('yields a Date that round-trips to the same instant', () => {
    expect(new Date(slackTsToMs('1699999999.000100')).toISOString()).toBe(
      '2023-11-14T22:13:19.000Z',
    );
  });
});

describe('normalizeSlack', () => {
  it('produces the sourceEventId `${channelId}:${ts}` and a millisecond occurredAt', () => {
    const [parent] = messagesOf('history-page1');
    const event = normalizeSlack(parent!, CHANNEL);

    expect(event.source).toBe('slack');
    expect(event.sourceEventId).toBe(`${CHANNEL}:1699999999.000100`);
    expect(event.occurredAt).toBe(1699999999000);
    expect(event.actorId).toBe('U01ALICE');
    expect(event.text).toContain('indexer rewrite');
  });

  it('derives threadKey from the message`s own ts when there is no thread_ts', () => {
    const [parent] = messagesOf('history-page1');
    expect(parent!.thread_ts).toBeUndefined();
    expect(normalizeSlack(parent!, CHANNEL).threadKey).toBe(`${CHANNEL}:1699999999.000100`);
    expect(slackThreadKey(parent!, CHANNEL)).toBe(`${CHANNEL}:1699999999.000100`);
  });

  it('derives threadKey from thread_ts when the message IS a reply', () => {
    const reply = messagesOf('replies').find((m) => m.ts === '1700000200.000500');
    expect(reply?.thread_ts).toBe('1699999999.000100');

    const event = normalizeSlack(reply!, CHANNEL);
    // The key is the PARENT's anchor, not the reply's own ts.
    expect(event.threadKey).toBe(`${CHANNEL}:1699999999.000100`);
    expect(event.sourceEventId).toBe(`${CHANNEL}:1700000200.000500`);
    expect(event.threadKey).not.toBe(event.sourceEventId);
  });

  it('gives a parent and every one of its replies the identical threadKey', () => {
    const keys = messagesOf('replies').map((m) => normalizeSlack(m, CHANNEL).threadKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(`${CHANNEL}:1699999999.000100`);
  });

  it('scopes threadKey by channel, so the same ts in two channels does not collide', () => {
    const [parent] = messagesOf('history-page1');
    expect(normalizeSlack(parent!, 'C0OTHER').threadKey).not.toBe(
      normalizeSlack(parent!, CHANNEL).threadKey,
    );
  });

  it('tolerates a message with no text', () => {
    const event = normalizeSlack({ ts: '1700000000.000000', user: 'U01ALICE' }, CHANNEL);
    expect(event.text).toBe('');
  });
});

describe('noise flagging', () => {
  const byTs = (ts: string): RawSourceEvent =>
    normalizeSlack(messagesOf('noise').find((m) => m.ts === ts)!, CHANNEL);

  it('normalizes a bot message rather than dropping it, and flags it as noise', () => {
    const event = byTs('1700000300.000700');

    // Still a fully-formed event: nothing is lost from the ingestion plane.
    expect(event.sourceEventId).toBe(`${CHANNEL}:1700000300.000700`);
    // 700us rounds up to 1ms — sub-ms precision is rounded, seconds are exact.
    expect(event.occurredAt).toBe(1700000300001);
    expect(event.text).toContain('Build #4271');
    expect(event.actorId).toBe('B07BUILDBOT');
    expect(event.isNoiseCandidate).toBe(true);
  });

  it('normalizes a channel_join system message and flags it as noise', () => {
    const event = byTs('1700000360.000800');

    expect(event.sourceEventId).toBe(`${CHANNEL}:1700000360.000800`);
    expect(event.occurredAt).toBe(1700000360001);
    expect(event.text).toContain('has joined the channel');
    expect(event.isNoiseCandidate).toBe(true);
  });

  it('flags channel_leave too', () => {
    expect(byTs('1700000390.000850').isNoiseCandidate).toBe(true);
  });

  it('does NOT flag an ordinary human message', () => {
    const event = byTs('1700000420.000900');
    expect(event.text).toBe('Welcome Dave!');
    expect(event.isNoiseCandidate).toBe(false);
  });

  it('flags on bot_id even without a bot_message subtype', () => {
    expect(isSlackNoiseCandidate({ ts: '1700000000.000000', bot_id: 'B123' })).toBe(true);
    expect(isSlackNoiseCandidate({ ts: '1700000000.000000', user: 'U1' })).toBe(false);
  });

  it('emits every noise message — none are silently discarded', async () => {
    const { client } = makeClient({
      'conversations.history': [() => json(fixture('noise'))],
    });

    const events = await client.fetchHistory(CHANNEL);
    expect(events).toHaveLength(messagesOf('noise').length);
    expect(events.filter((e) => e.isNoiseCandidate === true)).toHaveLength(3);
  });
});

describe('redaction before the event leaves the normalizer (SEC-4)', () => {
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';

  it('redacts an AWS-shaped key in the returned event`s text', () => {
    const [msg] = messagesOf('secret');
    expect(msg!.text).toContain(SECRET); // the fixture really does carry it

    const event = normalizeSlack(msg!, CHANNEL);

    expect(event.text).not.toContain(SECRET);
    expect(event.text).toContain('[REDACTED:aws_access_key]');
    // Surrounding prose survives — redaction is surgical, not a body wipe.
    expect(event.text).toContain('rotate after the migration');
  });

  it('does not expose redaction metadata as a required field of RawSourceEvent', () => {
    const event = normalizeSlack(messagesOf('secret')[0]!, CHANNEL);
    expect(event).not.toHaveProperty('redactionCount');
    expect(event).not.toHaveProperty('kinds');
  });

  it('redacts on the client path too, so no raw secret reaches a caller', async () => {
    const { client } = makeClient({
      'conversations.history': [() => json(fixture('secret'))],
    });

    const [event] = await client.fetchHistory(CHANNEL);
    expect(event!.text).not.toContain(SECRET);
    expect(event!.text).toContain('[REDACTED:aws_access_key]');
  });
});

describe('conversations.history pagination', () => {
  it('follows response_metadata.next_cursor across pages and yields every message once', async () => {
    const { client, fetchImpl, urls } = makeClient({
      'conversations.history': [
        () => json(fixture('history-page1')),
        () => json(fixture('history-page2')),
      ],
    });

    const events = await client.fetchHistory(CHANNEL);

    // Two pages requested, in order.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(urls[0]!).searchParams.get('cursor')).toBeNull();
    expect(new URL(urls[1]!).searchParams.get('cursor')).toBe('dXNlcjpVMDYxTkZUVDI=');

    // Every message across both pages, exactly once.
    const expected = messagesOf('history-page1').length + messagesOf('history-page2').length;
    expect(events).toHaveLength(expected);

    const ids = events.map((e) => e.sourceEventId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toEqual([
      `${CHANNEL}:1699999999.000100`,
      `${CHANNEL}:1700000050.000200`,
      `${CHANNEL}:1700000100.000300`, // page 2 — not dropped
      `${CHANNEL}:1700000150.000400`,
    ]);
  });

  it('stops at an empty next_cursor rather than looping forever', async () => {
    const { client, fetchImpl } = makeClient({
      'conversations.history': [() => json(fixture('history-page2'))],
    });

    await client.fetchHistory(CHANNEL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends the channel and the bearer token, never the token in the query string', async () => {
    const { client, fetchImpl, urls } = makeClient({
      'conversations.history': [() => json(fixture('history-page2'))],
    });

    await client.fetchHistory(CHANNEL);

    const url = new URL(urls[0]!);
    expect(url.pathname.endsWith('/conversations.history')).toBe(true);
    expect(url.searchParams.get('channel')).toBe(CHANNEL);
    expect(url.search).not.toContain('xoxb-');

    const init = fetchImpl.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers['authorization']).toBe('Bearer xoxb-test-token');
  });
});

describe('listChannels (conversations.list)', () => {
  it('maps id/name/is_member and follows pagination across pages', async () => {
    const { client, fetchImpl, urls } = makeClient({
      'conversations.list': [
        () =>
          json({
            ok: true,
            channels: [
              { id: 'C1', name: 'general', is_member: true },
              { id: 'C2', name: 'random', is_member: false },
            ],
            response_metadata: { next_cursor: 'page2cursor' },
          }),
        () =>
          json({
            ok: true,
            channels: [{ id: 'C3', name: 'eng-team', is_member: true }],
            response_metadata: { next_cursor: '' },
          }),
      ],
    });

    const channels = await client.listChannels();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(urls[0]!).searchParams.get('cursor')).toBeNull();
    expect(new URL(urls[1]!).searchParams.get('cursor')).toBe('page2cursor');
    expect(new URL(urls[0]!).searchParams.get('types')).toBe('public_channel');
    expect(new URL(urls[0]!).searchParams.get('exclude_archived')).toBe('true');

    expect(channels).toEqual([
      { id: 'C1', name: 'general', isMember: true },
      { id: 'C2', name: 'random', isMember: false },
      { id: 'C3', name: 'eng-team', isMember: true },
    ]);
  });

  it('stops at an empty next_cursor rather than looping forever', async () => {
    const { client, fetchImpl } = makeClient({
      'conversations.list': [
        () => json({ ok: true, channels: [{ id: 'C1', name: 'general' }] }),
      ],
    });

    await client.listChannels();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops rather than looping forever if the server repeats a cursor', async () => {
    const { client, fetchImpl } = makeClient({
      'conversations.list': [
        () =>
          json({
            ok: true,
            channels: [{ id: 'C1', name: 'general' }],
            response_metadata: { next_cursor: 'same' },
          }),
        () =>
          json({
            ok: true,
            channels: [{ id: 'C2', name: 'random' }],
            response_metadata: { next_cursor: 'same' },
          }),
      ],
    });

    const channels = await client.listChannels();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(channels.map((c) => c.id)).toEqual(['C1', 'C2']);
  });

  it('falls back to the channel id for a missing name and to isMember: false when absent', async () => {
    const { client } = makeClient({
      'conversations.list': [() => json({ ok: true, channels: [{ id: 'C9' }] })],
    });

    expect(await client.listChannels()).toEqual([{ id: 'C9', name: 'C9', isMember: false }]);
  });
});

describe('conversations.replies', () => {
  it('fetches replies via conversations.replies and shares the parent`s threadKey', async () => {
    const { client, urls } = makeClient({
      'conversations.replies': [() => json(fixture('replies'))],
    });

    const events = await client.fetchReplies(CHANNEL, '1699999999.000100');

    const url = new URL(urls[0]!);
    expect(url.pathname.endsWith('/conversations.replies')).toBe(true);
    expect(url.searchParams.get('channel')).toBe(CHANNEL);
    expect(url.searchParams.get('ts')).toBe('1699999999.000100');

    const keys = new Set(events.map((e) => e.threadKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(`${CHANNEL}:1699999999.000100`);
  });

  it('gives replies the SAME threadKey the parent got from conversations.history', async () => {
    const { client } = makeClient({
      'conversations.history': [
        () => json(fixture('history-page1')),
        () => json(fixture('history-page2')),
      ],
      'conversations.replies': [() => json(fixture('replies'))],
    });

    const history = await client.fetchHistory(CHANNEL);
    const parent = history.find((e) => e.sourceEventId === `${CHANNEL}:1699999999.000100`);

    const replies = await client.fetchReplies(CHANNEL, '1699999999.000100', {
      includeParent: false,
    });

    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      expect(reply.threadKey).toBe(parent!.threadKey);
      expect(reply.sourceEventId).not.toBe(parent!.sourceEventId);
    }
  });

  it('fetchChannel merges history and replies with no duplicate sourceEventIds', async () => {
    const { client } = makeClient({
      'conversations.history': [
        () => json(fixture('history-page1')),
        () => json(fixture('history-page2')),
      ],
      'conversations.replies': [() => json(fixture('replies'))],
    });

    const events = await client.fetchChannel(CHANNEL);
    const ids = events.map((e) => e.sourceEventId);

    // 4 top-level (2 pages) + 2 replies; the parent echoed by `replies` is not duplicated.
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(ids).toContain(`${CHANNEL}:1700000200.000500`);
    expect(events.map((e) => e.occurredAt)).toEqual(
      [...events.map((e) => e.occurredAt)].sort((a, b) => a - b),
    );
  });
});

describe('rate limiting (429 / Retry-After)', () => {
  it('waits at least the advertised 3 seconds and then retries the same request', async () => {
    const { sleep, delays } = recordingSleep();
    const { client, fetchImpl, urls } = makeClient(
      {
        'conversations.history': [
          () => json(fixture('ratelimited'), { status: 429, headers: { 'retry-after': '3' } }),
          () => json(fixture('history-page2')),
        ],
      },
      { sleep },
    );

    const events = await client.fetchHistory(CHANNEL);

    // Slept before retrying, for at least the advertised 3s.
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(3000);

    // The retry actually happened, against the identical URL, and succeeded.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(urls[1]).toBe(urls[0]);
    expect(events).toHaveLength(2);
    expect(events[0]!.sourceEventId).toBe(`${CHANNEL}:1700000100.000300`);
  });

  it('sleeps before the retry, not after it', async () => {
    const order: string[] = [];
    const sleep: SleepFn = (ms) => {
      order.push(`sleep:${ms}`);
      return Promise.resolve();
    };

    let call = 0;
    const fetchImpl = vi.fn((_input: string, _init?: FetchInit): Promise<Response> => {
      call += 1;
      order.push(`fetch:${call}`);
      return Promise.resolve(
        call === 1
          ? json(fixture('ratelimited'), { status: 429, headers: { 'retry-after': '3' } })
          : json(fixture('history-page2')),
      );
    });

    const client = new SlackClient({ token: 'xoxb-t', fetchImpl, sleep });
    await client.fetchHistory(CHANNEL);

    expect(order).toEqual(['fetch:1', 'sleep:3000', 'fetch:2']);
  });

  it('honours a 200-with-ok:false ratelimited body the same way', async () => {
    const { sleep, delays } = recordingSleep();
    const { client, fetchImpl } = makeClient(
      {
        'conversations.history': [
          () => json(fixture('ratelimited'), { status: 200, headers: { 'retry-after': '3' } }),
          () => json(fixture('history-page2')),
        ],
      },
      { sleep },
    );

    const events = await client.fetchHistory(CHANNEL);

    expect(delays[0]).toBeGreaterThanOrEqual(3000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(2);
  });

  it('gives up after maxRetries rather than retrying forever', async () => {
    const { sleep, delays } = recordingSleep();
    const { client, fetchImpl } = makeClient(
      {
        'conversations.history': [
          () => json(fixture('ratelimited'), { status: 429, headers: { 'retry-after': '3' } }),
        ],
      },
      { sleep, maxRetries: 2 },
    );

    await expect(client.fetchHistory(CHANNEL)).rejects.toThrow(/ratelimited/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(delays).toEqual([3000, 3000]);
  });

  it('fails fast on a non-throttle Slack error instead of burning retries', async () => {
    const { sleep, delays } = recordingSleep();
    const { client, fetchImpl } = makeClient(
      { 'conversations.history': [() => json({ ok: false, error: 'invalid_auth' })] },
      { sleep },
    );

    await expect(client.fetchHistory(CHANNEL)).rejects.toThrow(/invalid_auth/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});

describe('fetchSince (SourceClient contract)', () => {
  it('returns events plus a ts watermark cursor', async () => {
    const { client } = makeClient({
      'conversations.history': [() => json(fixture('history-page2'))],
    });

    client.setChannel(CHANNEL);
    const result = await client.fetchSince();

    expect(result.events).toHaveLength(2);
    expect(client.source).toBe('slack');
    // Newest event, re-encoded as Slack float seconds.
    expect(result.cursor).toBe('1700000150.000000');
  });

  it('passes a stored cursor through as `oldest`', async () => {
    const { client, urls } = makeClient({
      'conversations.history': [() => json(fixture('history-page2'))],
    });

    client.setChannel(CHANNEL);
    await client.fetchSince('1700000000.000000');

    expect(new URL(urls[0]!).searchParams.get('oldest')).toBe('1700000000.000000');
  });
});
