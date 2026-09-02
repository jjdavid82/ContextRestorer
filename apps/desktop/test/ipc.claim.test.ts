/**
 * Provenance path tests (FR-6) — `apps/desktop/src/ipc/claim.ts`.
 *
 * These run against a REAL `GraphRepo`/`EventsRepo` over `openDb(':memory:')` +
 * `migrate`, not stubbed readers. The load-bearing claim of this module is that
 * an artifact id resolves, via `artifacts.external_ref` = `events.thread_key`, to
 * that thread's rows in the order the repo returns them — a hand-rolled fake
 * would prove nothing about either join or about `listByThread`'s ordering.
 *
 * `claim.ts` imports `ipcMain` at module scope, which does not exist outside a
 * running Electron process — same `vi.mock('electron', …)` + dynamic-import
 * pattern as `ipc.briefing.test.ts`/`oauth.test.ts`/`health.test.ts`.
 *
 * THE KEY UNDER TEST IS AN ARTIFACT ID. `briefing:chunk` carries no claim row id,
 * so the renderer's `claimIdOf()` sends `citation.artifactId` instead (Task 3.6).
 * These tests are written against that reality on purpose; if the chunk payload
 * ever grows a real `claimId`, this file is one of the two places that changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { EventsRepo, GraphRepo, migrate, openDb } from '@cr/store';
import type { Artifact, Event, SourceId } from '@cr/core';

const handle = vi.fn();
vi.mock('electron', () => ({ ipcMain: { handle } }));

const {
  DRILLDOWN_CHANNEL,
  MAX_DRILLDOWN_EVENTS,
  MAX_EVENT_TEXT_CHARS,
  authorFor,
  deepLinkFor,
  drilldown,
  eventText,
  gmailDeepLink,
  parseDrilldownArg,
  registerClaimHandlers,
  resolveEvents,
  slackDeepLink,
} = await import('../src/ipc/claim.js');

type ClaimModule = typeof import('../src/ipc/claim.js');
type Deps = Parameters<ClaimModule['drilldown']>[1];

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let db: Database;
let graph: GraphRepo;
let events: EventsRepo;

/**
 * A thread artifact exactly as `@cr/ingest`'s `artifactFor()` builds one:
 * `externalRef` IS the thread key. That equality is the join this module walks,
 * so the fixture must not "helpfully" set `externalRef` to a URL.
 */
function seedArtifact(opts: {
  artifactId: string;
  threadKey: string;
  source?: SourceId;
}): Artifact {
  const artifact: Artifact = {
    artifactId: opts.artifactId,
    source: opts.source ?? 'slack',
    kind: 'thread',
    externalRef: opts.threadKey,
    title: null,
    state: null,
    ownerId: null,
    firstSeenAt: 1_000,
    lastSeenAt: 1_000,
  };
  graph.upsertArtifact(artifact);
  return artifact;
}

/** One already-redacted event on `threadKey`, as the pipeline would have stored it. */
function seedEvent(opts: {
  eventId: string;
  threadKey: string;
  occurredAt: number;
  source?: SourceId;
  sourceEventId?: string;
  actorId?: string;
  text?: string;
}): Event {
  const event: Event = {
    eventId: opts.eventId,
    source: opts.source ?? 'slack',
    sourceEventId: opts.sourceEventId ?? `C123:${opts.occurredAt / 1000}`,
    threadKey: opts.threadKey,
    actorId: opts.actorId ?? 'U-alice',
    occurredAt: opts.occurredAt,
    ingestedAt: opts.occurredAt + 10,
    payload: { text: opts.text ?? `body of ${opts.eventId}`, isNoiseCandidate: false },
    redactionCount: 0,
  };
  events.insertIfAbsent(event);
  return event;
}

function makeDeps(over: Partial<Deps> = {}): Deps {
  return { artifacts: graph, events, ...over };
}

beforeEach(() => {
  handle.mockReset();
  db = openDb(':memory:');
  migrate(db);
  graph = new GraphRepo(db);
  events = new EventsRepo(db);
});

afterEach(() => {
  db.close();
});

/* -------------------------------------------------------------------------- */
/* Requirement 1 — a known artifact returns its thread's events, with links    */
/* -------------------------------------------------------------------------- */

describe('claim:drilldown resolves an artifact id to its thread events', () => {
  it('returns the events behind the artifact, each with a deep link', () => {
    seedArtifact({ artifactId: 'art-1', threadKey: 'C123:1712345678.000100' });
    seedEvent({
      eventId: 'ev-1',
      threadKey: 'C123:1712345678.000100',
      occurredAt: 1_712_345_678_000,
      sourceEventId: 'C123:1712345678.000100',
      actorId: 'U-alice',
      text: 'we are going with postgres',
    });

    const result = drilldown({ claimId: 'art-1' }, makeDeps());

    // The claim id is echoed verbatim so a late resolve can be correlated with
    // the panel that asked — even though it is really an artifact id.
    expect(result.claimId).toBe('art-1');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({
      eventId: 'ev-1',
      source: 'slack',
      occurredAt: 1_712_345_678_000,
      author: 'U-alice',
      text: 'we are going with postgres',
      externalUrl:
        'https://slack.com/app_redirect?channel=C123&message_ts=1712345678.000100',
    });
  });

  it('joins on external_ref = thread_key, not on the artifact id', () => {
    // Two artifacts, two threads. Picking the wrong side of the join, or ignoring
    // `externalRef` and matching on the id, both fail this.
    seedArtifact({ artifactId: 'art-a', threadKey: 'thread-a' });
    seedArtifact({ artifactId: 'art-b', threadKey: 'thread-b' });
    seedEvent({ eventId: 'ev-a1', threadKey: 'thread-a', occurredAt: 1_000 });
    seedEvent({ eventId: 'ev-b1', threadKey: 'thread-b', occurredAt: 2_000 });
    seedEvent({ eventId: 'ev-b2', threadKey: 'thread-b', occurredAt: 3_000 });

    expect(drilldown({ claimId: 'art-a' }, makeDeps()).events.map((e) => e.eventId)).toEqual([
      'ev-a1',
    ]);
    expect(drilldown({ claimId: 'art-b' }, makeDeps()).events.map((e) => e.eventId)).toEqual([
      'ev-b1',
      'ev-b2',
    ]);
  });

  it('prefers a resolved display name and falls back to the raw actor id', () => {
    seedArtifact({ artifactId: 'art-1', threadKey: 't1' });
    seedEvent({ eventId: 'ev-known', threadKey: 't1', occurredAt: 1_000, actorId: 'U-alice' });
    seedEvent({ eventId: 'ev-unknown', threadKey: 't1', occurredAt: 2_000, actorId: 'U-ghost' });
    seedEvent({ eventId: 'ev-none', threadKey: 't1', occurredAt: 3_000, actorId: '' });
    graph.upsertPerson({
      personId: 'U-alice',
      displayName: 'Alice Ng',
      emailHash: null,
      isSelf: false,
    });

    expect(drilldown({ claimId: 'art-1' }, makeDeps()).events.map((e) => e.author)).toEqual([
      'Alice Ng',
      'U-ghost',
      'unknown',
    ]);
    expect(authorFor(graph, '')).toBe('unknown');
  });

  it('projects only the five bridge fields — no payload passthrough', () => {
    seedArtifact({ artifactId: 'art-1', threadKey: 't1' });
    seedEvent({ eventId: 'ev-1', threadKey: 't1', occurredAt: 1_000 });

    const [projected] = drilldown({ claimId: 'art-1' }, makeDeps()).events;
    // `sourceEventId`, `ingestedAt`, `redactionCount`, `threadKey` and every
    // connector-specific payload key must NOT cross the bridge.
    expect(Object.keys(projected!).sort()).toEqual([
      'author',
      'eventId',
      'externalUrl',
      'occurredAt',
      'source',
      'text',
    ]);
    expect(JSON.stringify(projected)).not.toContain('isNoiseCandidate');
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 2 — an unknown id resolves, it does not explode                 */
/* -------------------------------------------------------------------------- */

describe('claim:drilldown handles an unknown identifier without throwing', () => {
  it('returns the documented empty transcript for an id with no artifact', () => {
    // `Drilldown` has no "not found" variant on the wire (no `ok`, no `reason`),
    // so an unknown id is `{ claimId, events: [] }` — which `DrillDownPanel`
    // already renders as "No source events are recorded for this claim".
    expect(() => drilldown({ claimId: 'art-nope' }, makeDeps())).not.toThrow();
    expect(drilldown({ claimId: 'art-nope' }, makeDeps())).toEqual({
      claimId: 'art-nope',
      events: [],
    });
  });

  it('does not leak another thread’s events for an unknown id', () => {
    seedArtifact({ artifactId: 'art-real', threadKey: 't1' });
    seedEvent({ eventId: 'ev-1', threadKey: 't1', occurredAt: 1_000 });

    expect(drilldown({ claimId: 't1' }, makeDeps()).events).toEqual([]);
  });

  it('rejects a malformed argument with an empty-shaped result', () => {
    for (const bad of [null, undefined, {}, { claimId: '' }, { claimId: 42 }, 'art-1']) {
      expect(drilldown(bad, makeDeps())).toEqual({ claimId: '', events: [] });
    }
    expect(parseDrilldownArg({ claimId: 'art-1' })).toBe('art-1');
    expect(parseDrilldownArg({ claimId: '' })).toBeNull();
    expect(parseDrilldownArg(null)).toBeNull();
  });

  it('degrades a repo failure to an empty transcript rather than a rejection', () => {
    const exploding: Deps = {
      artifacts: {
        getArtifact: () => {
          throw new Error('database is locked');
        },
        getPerson: () => undefined,
      },
      events,
    };

    expect(drilldown({ claimId: 'art-1' }, exploding)).toEqual({ claimId: 'art-1', events: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 3 — a known artifact with no events is empty, not an error      */
/* -------------------------------------------------------------------------- */

describe('claim:drilldown returns an empty list for an artifact with no events', () => {
  it('handles a thread emptied by retention', () => {
    // The artifact survives the 90-day raw-event sweep; its events do not. That
    // is a normal end state, not a failure.
    seedArtifact({ artifactId: 'art-purged', threadKey: 'thread-purged' });

    const result = drilldown({ claimId: 'art-purged' }, makeDeps());
    expect(result).toEqual({ claimId: 'art-purged', events: [] });
  });

  it('distinguishes nothing from nothing only in the log, never in the shape', () => {
    seedArtifact({ artifactId: 'art-empty', threadKey: 'thread-empty' });

    // Known-but-empty and entirely-unknown are the same wire shape by design.
    expect(drilldown({ claimId: 'art-empty' }, makeDeps()).events).toEqual([]);
    expect(drilldown({ claimId: 'art-missing' }, makeDeps()).events).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4 — chronological order, as `listByThread` guarantees           */
/* -------------------------------------------------------------------------- */

describe('claim:drilldown returns events in chronological order', () => {
  it('orders oldest first regardless of insertion order', () => {
    seedArtifact({ artifactId: 'art-1', threadKey: 't1' });
    seedEvent({ eventId: 'ev-third', threadKey: 't1', occurredAt: 3_000 });
    seedEvent({ eventId: 'ev-first', threadKey: 't1', occurredAt: 1_000 });
    seedEvent({ eventId: 'ev-second', threadKey: 't1', occurredAt: 2_000 });

    const result = drilldown({ claimId: 'art-1' }, makeDeps());
    expect(result.events.map((e) => e.eventId)).toEqual(['ev-first', 'ev-second', 'ev-third']);
    expect(result.events.map((e) => e.occurredAt)).toEqual([1_000, 2_000, 3_000]);
  });

  it('breaks an exact timestamp tie by event id, so two reads never disagree', () => {
    seedArtifact({ artifactId: 'art-1', threadKey: 't1' });
    seedEvent({ eventId: 'ev-b', threadKey: 't1', occurredAt: 5_000, sourceEventId: 'C1:5.b' });
    seedEvent({ eventId: 'ev-a', threadKey: 't1', occurredAt: 5_000, sourceEventId: 'C1:5.a' });

    const first = drilldown({ claimId: 'art-1' }, makeDeps()).events.map((e) => e.eventId);
    const second = drilldown({ claimId: 'art-1' }, makeDeps()).events.map((e) => e.eventId);
    expect(first).toEqual(['ev-a', 'ev-b']);
    expect(second).toEqual(first);
  });

  it('caps a very long thread to its most recent window, still in order', () => {
    seedArtifact({ artifactId: 'art-1', threadKey: 't1' });
    for (let i = 0; i < 10; i += 1) {
      seedEvent({
        eventId: `ev-${String(i).padStart(2, '0')}`,
        threadKey: 't1',
        occurredAt: 1_000 + i,
        sourceEventId: `C1:${i}`,
      });
    }

    const capped = resolveEvents('art-1', makeDeps({ maxEvents: 3 }));
    expect(capped.map((e) => e.eventId)).toEqual(['ev-07', 'ev-08', 'ev-09']);
    expect(MAX_DRILLDOWN_EVENTS).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* Deep links — best effort, and honest about it                              */
/* -------------------------------------------------------------------------- */

describe('external deep links are best effort and never fabricated', () => {
  it('builds Slack’s workspace-agnostic redirect from channel + ts', () => {
    // NOT `https://<workspace>.slack.com/archives/...`: no workspace domain is
    // stored anywhere in the app, and guessing one produces a confident 404.
    expect(slackDeepLink('C024BE7LH:1712345678.000100')).toBe(
      'https://slack.com/app_redirect?channel=C024BE7LH&message_ts=1712345678.000100',
    );
  });

  it('builds a Gmail All-Mail link from the message id', () => {
    // `#all/`, not `#inbox/`: an archived thread is invisible under `#inbox`.
    expect(gmailDeepLink('18f0a1b2c3d4e5f6')).toBe(
      'https://mail.google.com/mail/u/0/#all/18f0a1b2c3d4e5f6',
    );
  });

  it('omits the link entirely for an id it does not recognise', () => {
    // No link beats a wrong link: the panel renders "no deep link available".
    expect(slackDeepLink('not-a-slack-id')).toBeUndefined();
    expect(slackDeepLink('C123:not-a-timestamp')).toBeUndefined();
    expect(slackDeepLink(':1712345678.000100')).toBeUndefined();
    expect(gmailDeepLink('has spaces')).toBeUndefined();
    expect(gmailDeepLink('../../evil')).toBeUndefined();
    expect(deepLinkFor('slack', '')).toBeUndefined();
    expect(deepLinkFor('gmail', '')).toBeUndefined();
  });

  it('omits externalUrl as an absent key, not an undefined value', () => {
    seedArtifact({ artifactId: 'art-1', threadKey: 't1' });
    seedEvent({
      eventId: 'ev-1',
      threadKey: 't1',
      occurredAt: 1_000,
      sourceEventId: 'garbage without a ts',
    });

    const [projected] = drilldown({ claimId: 'art-1' }, makeDeps()).events;
    expect('externalUrl' in projected!).toBe(false);
  });

  it('dispatches per event source', () => {
    expect(deepLinkFor('gmail', '18f0a1b2')).toContain('mail.google.com');
    expect(deepLinkFor('slack', 'C1:1.0')).toContain('slack.com/app_redirect');
  });
});

/* -------------------------------------------------------------------------- */
/* Body text projection                                                       */
/* -------------------------------------------------------------------------- */

describe('event text is read from the redacted payload and bounded', () => {
  it('reads payload.text and nothing else', () => {
    expect(eventText({ text: 'hello' })).toBe('hello');
    // A payload with no string body yields '' rather than a JSON dump of every
    // connector field the normalizer happened to stash.
    expect(eventText({ isNoiseCandidate: true })).toBe('');
    expect(eventText({ text: 42 })).toBe('');
  });

  it('truncates a very long body with a visible marker', () => {
    const long = 'x'.repeat(MAX_EVENT_TEXT_CHARS + 500);
    const clipped = eventText({ text: long });

    expect(clipped).toHaveLength(MAX_EVENT_TEXT_CHARS + 1);
    expect(clipped.endsWith('…')).toBe(true);
    expect(eventText({ text: 'x'.repeat(MAX_EVENT_TEXT_CHARS) })).toHaveLength(
      MAX_EVENT_TEXT_CHARS,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

describe('registration', () => {
  it('registers the drilldown channel with a synchronous handler', () => {
    seedArtifact({ artifactId: 'art-1', threadKey: 't1' });
    seedEvent({ eventId: 'ev-1', threadKey: 't1', occurredAt: 1_000 });
    registerClaimHandlers(makeDeps());

    const callback = handle.mock.calls.find(([c]) => c === DRILLDOWN_CHANNEL)?.[1] as (
      e: unknown,
      arg: unknown,
    ) => unknown;
    expect(callback).toBeDefined();

    const returned = callback({}, { claimId: 'art-1' });
    expect(returned).not.toBeInstanceOf(Promise);
    expect(returned).toMatchObject({ claimId: 'art-1' });
  });

  it('registers exactly one channel', () => {
    registerClaimHandlers(makeDeps());
    expect(handle.mock.calls.map(([c]) => c)).toEqual([DRILLDOWN_CHANNEL]);
  });
});
