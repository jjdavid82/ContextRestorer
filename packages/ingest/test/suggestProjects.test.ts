/**
 * Tests for the onboarding project suggester (Task 3.1, OI-3).
 *
 * Backed by a REAL in-memory SQLite database and a REAL `EventsRepo`, for the
 * same reason the pipeline tests are: the suggester reads through the repo's
 * window query, and a hand-rolled fake would encode this file's opinion of that
 * query rather than the query itself.
 *
 * Events are inserted directly (not through `IngestionPipeline`), because the
 * whole point of the extraction rules under test is which *payload* fields a
 * candidate name can be recovered from — a fixture that could only ever contain
 * what today's normalizers happen to write would be unable to express them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventsRepo, migrate, openDb } from '@cr/store';
import { eventId as computeEventId, type Event, type SourceId } from '@cr/core';
import { suggestProjects } from '../src/suggestProjects.js';

type Db = ReturnType<typeof openDb>;

/** The `actorId` standing in for the signed-in user across every fixture. */
const SELF = 'U-SELF';
/** Anyone else, used to prove ranking counts the user's OWN messages only. */
const OTHER = 'U-COLLEAGUE';

let db: Db;
let events: EventsRepo;
/** Monotonic counter making each fixture's `(source, sourceEventId)` unique. */
let seq = 0;

interface EventOptions {
  source?: SourceId;
  threadKey?: string;
  actorId?: string;
  payload?: Record<string, unknown>;
}

/** Persist one synthetic event. Returns the id, for debugging failures. */
function insert(options: EventOptions = {}): string {
  seq += 1;
  const source = options.source ?? 'slack';
  const sourceEventId = `evt-${seq}`;
  const event: Event = {
    eventId: computeEventId(source, sourceEventId),
    source,
    sourceEventId,
    threadKey: options.threadKey ?? 'general:1',
    actorId: options.actorId ?? SELF,
    occurredAt: 1_700_000_000_000 + seq,
    ingestedAt: 1_700_000_000_000 + seq,
    payload: { text: 'hello', ...options.payload },
    redactionCount: 0,
  };
  events.insertIfAbsent(event);
  return event.eventId;
}

/** Insert `n` Slack messages from `actorId` in `channelName`. */
function postToChannel(channelName: string, n: number, actorId = SELF): void {
  for (let i = 0; i < n; i += 1) {
    insert({
      source: 'slack',
      // Realistic shape: an opaque channel id in the thread key, with the human
      // name carried on the payload.
      threadKey: `C${seq.toString().padStart(8, '0')}:170000000${i}.0001`,
      actorId,
      payload: { channelName },
    });
  }
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  events = new EventsRepo(db);
  seq = 0;
});

afterEach(() => {
  db.close();
});

describe('suggestProjects — empty store', () => {
  it('returns [] when nothing has been ingested, without throwing', () => {
    expect(() => suggestProjects(events, SELF)).not.toThrow();
    expect(suggestProjects(events, SELF)).toEqual([]);
  });

  it('returns [] when the self id is unknown, rather than matching unattributed events', () => {
    // `actorId: ''` is exactly how the pipeline stores an unattributed event, so
    // an empty self id must not be allowed to match it.
    insert({ source: 'slack', actorId: '', payload: { channelName: 'api-redesign' } });
    expect(suggestProjects(events, '')).toEqual([]);
  });
});

describe('suggestProjects — ranking', () => {
  it('ranks candidates by the user’s own participation, descending', () => {
    postToChannel('api-redesign', 5);
    postToChannel('billing-v2', 3);
    postToChannel('docs-refresh', 1);

    const result = suggestProjects(events, SELF);

    expect(result.map((c) => c.name)).toEqual(['#api-redesign', '#billing-v2', '#docs-refresh']);
    expect(result.map((c) => c.evidenceCount)).toEqual([5, 3, 1]);
    expect(result.every((c) => c.source === 'slack')).toBe(true);
  });

  it('counts only the self actor, not everyone else in the channel', () => {
    postToChannel('api-redesign', 2, SELF);
    postToChannel('api-redesign', 40, OTHER);
    postToChannel('billing-v2', 3, SELF);

    const result = suggestProjects(events, SELF);

    // #api-redesign is by far the loudest channel and still ranks second: volume
    // of other people's traffic is noise, not stakes.
    expect(result.map((c) => [c.name, c.evidenceCount])).toEqual([
      ['#billing-v2', 3],
      ['#api-redesign', 2],
    ]);
  });

  it('drops groups the user has never posted in', () => {
    postToChannel('lurking-only', 9, OTHER);
    expect(suggestProjects(events, SELF)).toEqual([]);
  });

  it('derives Gmail candidates from user labels and thread subjects', () => {
    insert({ source: 'gmail', threadKey: 't1', payload: { labelIds: ['INBOX', 'Q3 Migration'] } });
    insert({ source: 'gmail', threadKey: 't2', payload: { labelIds: ['Q3 Migration'] } });
    insert({ source: 'gmail', threadKey: 't3', payload: { subject: 'Re: Vendor contract' } });

    const result = suggestProjects(events, SELF);

    expect(result).toEqual([
      {
        name: 'Q3 Migration',
        source: 'gmail',
        evidenceCount: 2,
        reason: 'you posted 2 times in Q3 Migration',
      },
      {
        // `Re:` is stripped so a reply and its parent are one candidate.
        name: 'Vendor contract',
        source: 'gmail',
        evidenceCount: 1,
        reason: 'you posted 1 time in Vendor contract',
      },
    ]);
  });

  it('groups a channel regardless of thread, casing or a leading #', () => {
    insert({ payload: { channelName: 'API-Redesign' } });
    insert({ payload: { channelName: '#api-redesign' } });
    insert({ payload: { channelName: 'api-redesign' } });

    const result = suggestProjects(events, SELF);

    expect(result).toHaveLength(1);
    expect(result[0]?.evidenceCount).toBe(3);
  });

  it('falls back to the channel segment of a Slack thread key', () => {
    // `slackThreadKey()` builds `${channelId}:${thread_ts}`; a readable channel
    // handle in that position is usable as-is.
    insert({ threadKey: 'team-platform:1700000000.0001' });
    insert({ threadKey: 'team-platform:1700000000.0002' });

    expect(suggestProjects(events, SELF)).toEqual([
      {
        name: '#team-platform',
        source: 'slack',
        evidenceCount: 2,
        reason: 'you posted 2 times in #team-platform',
      },
    ]);
  });

  it('drops candidates whose only name is an opaque provider id', () => {
    // No channel metadata on the payload, so the only available name is the raw
    // Slack id — not something a user can recognise in a checkbox list.
    insert({ threadKey: 'C08ABCDEF:1700000000.0001' });
    insert({ threadKey: 'C08ABCDEF:1700000000.0002' });
    // Gmail thread ids are never used as names at all.
    insert({ source: 'gmail', threadKey: '18f2ab99c0de1234' });

    expect(suggestProjects(events, SELF)).toEqual([]);
  });
});

describe('suggestProjects — exclusions', () => {
  it('excludes generic Slack channels and Gmail system labels', () => {
    postToChannel('general', 20);
    postToChannel('#General', 5);
    postToChannel('random', 15);
    postToChannel('api-redesign', 2);
    insert({ source: 'gmail', payload: { label: 'INBOX' } });
    insert({ source: 'gmail', payload: { label: 'SPAM' } });
    insert({ source: 'gmail', payload: { label: 'CATEGORY_PROMOTIONS' } });
    insert({ source: 'gmail', payload: { labelIds: ['INBOX', 'CATEGORY_UPDATES'] } });

    const result = suggestProjects(events, SELF);

    // Every excluded group outranks the survivor on raw volume, so a leak would
    // be impossible to miss here.
    expect(result.map((c) => c.name)).toEqual(['#api-redesign']);
  });

  it('does not let an all-system label set fall through to the subject', () => {
    insert({
      source: 'gmail',
      payload: { labelIds: ['INBOX', 'CATEGORY_SOCIAL'], subject: 'Your weekly digest' },
    });

    expect(suggestProjects(events, SELF)).toEqual([]);
  });
});

describe('suggestProjects — output contract', () => {
  it('returns at most 12 candidates even when more exist', () => {
    // 20 distinct channels, each with a distinct participation count so the
    // ranking is total and the slice is deterministic.
    for (let i = 0; i < 20; i += 1) {
      postToChannel(`project-${String(i).padStart(2, '0')}`, 20 - i);
    }

    const result = suggestProjects(events, SELF);

    expect(result).toHaveLength(12);
    // The 12 highest-participation channels, in order — not an arbitrary 12.
    expect(result[0]?.name).toBe('#project-00');
    expect(result[0]?.evidenceCount).toBe(20);
    expect(result[11]?.name).toBe('#project-11');
    expect(result[11]?.evidenceCount).toBe(9);
  });

  it('gives every candidate a non-empty reason quoting its actual count', () => {
    postToChannel('api-redesign', 23);
    postToChannel('billing-v2', 1);

    const result = suggestProjects(events, SELF);

    for (const candidate of result) {
      expect(candidate.reason.length).toBeGreaterThan(0);
      expect(candidate.reason).toContain(String(candidate.evidenceCount));
      expect(candidate.reason).toContain(candidate.name);
    }
    expect(result[0]?.reason).toBe('you posted 23 times in #api-redesign');
    // Singular, not "1 times".
    expect(result[1]?.reason).toBe('you posted 1 time in #billing-v2');
  });
});
