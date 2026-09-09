import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { Event } from '@cr/core';
import { openDb, migrate } from '../src/index.js';
import { EventsRepo } from '../src/repos/events.js';

let db: Database;
let repo: EventsRepo;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new EventsRepo(db);
});

/** Minimal valid event; every field is overridable per-test. */
const makeEvent = (over: Partial<Event> = {}): Event => ({
  eventId: 'e1',
  source: 'slack',
  sourceEventId: 's1',
  threadKey: 'C1:1',
  actorId: 'U1',
  occurredAt: 1_000,
  ingestedAt: 1_050,
  payload: { text: 'hello' },
  redactionCount: 0,
  ...over,
});

/** Minimal `extractions` row satisfying the FK and every NOT NULL column. */
const insertExtraction = (extractionId: string, eventId: string) =>
  db
    .prepare(
      `INSERT INTO extractions
         (extraction_id, event_id, class, confidence,
          participants_json, artifacts_json, model, prompt_version, created_at)
       VALUES (?, ?, 'status_update', 0.9, '[]', '[]', 'm', 'v1', 1000)`,
    )
    .run(extractionId, eventId);

describe('EventsRepo.insertIfAbsent', () => {
  it('inserts once and reports a replay without throwing (AC-10)', () => {
    const e = makeEvent();

    expect(repo.insertIfAbsent(e)).toEqual({ inserted: true });

    // Same (source, sourceEventId) → same deterministic event_id on a real
    // connector, but assert the *unique key* is what stops the second write.
    expect(() => repo.insertIfAbsent(e)).not.toThrow();
    expect(repo.insertIfAbsent(e)).toEqual({ inserted: false });

    const n = db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('reports a replay even when only (source, sourceEventId) matches', () => {
    repo.insertIfAbsent(makeEvent());

    // A different primary key but a colliding natural key — the UNIQUE index,
    // not the PK, is what must catch this.
    const result = repo.insertIfAbsent(makeEvent({ eventId: 'e1-different' }));
    expect(result).toEqual({ inserted: false });
  });

  it('never mutates the existing row on replay', () => {
    repo.insertIfAbsent(makeEvent());

    const replay = makeEvent({
      actorId: 'U-IMPOSTOR',
      payload: { text: 'overwritten' },
      occurredAt: 9_999,
      redactionCount: 42,
    });
    expect(repo.insertIfAbsent(replay)).toEqual({ inserted: false });

    const stored = repo.listByThread('C1:1');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      actorId: 'U1',
      payload: { text: 'hello' },
      occurredAt: 1_000,
      redactionCount: 0,
    });
  });
});

describe('EventsRepo.listByThread', () => {
  it('returns events ordered by occurredAt ascending', () => {
    repo.insertIfAbsent(makeEvent({ eventId: 'e-c', sourceEventId: 's-c', occurredAt: 3_000 }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e-a', sourceEventId: 's-a', occurredAt: 1_000 }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e-b', sourceEventId: 's-b', occurredAt: 2_000 }));

    expect(repo.listByThread('C1:1').map((e) => e.occurredAt)).toEqual([1_000, 2_000, 3_000]);
  });

  it('does not leak events from other threads', () => {
    repo.insertIfAbsent(makeEvent({ eventId: 'e-1', sourceEventId: 's-1', threadKey: 'C1:1' }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e-2', sourceEventId: 's-2', threadKey: 'C2:2' }));

    expect(repo.listByThread('C1:1').map((e) => e.eventId)).toEqual(['e-1']);
    expect(repo.listByThread('nope')).toEqual([]);
  });
});

describe('EventsRepo.listWindow', () => {
  it('treats [start, end) as half-open', () => {
    for (const t of [999, 1_000, 1_500, 2_000, 2_001]) {
      repo.insertIfAbsent(makeEvent({ eventId: `e${t}`, sourceEventId: `s${t}`, occurredAt: t }));
    }

    const inWindow = repo.listWindow(1_000, 2_000).map((e) => e.occurredAt);

    expect(inWindow).toEqual([1_000, 1_500]); // start included, end excluded
    expect(inWindow).not.toContain(2_000);
    expect(inWindow).not.toContain(999);
  });

  it('returns an empty array for an empty window', () => {
    repo.insertIfAbsent(makeEvent({ occurredAt: 1_000 }));
    expect(repo.listWindow(5_000, 6_000)).toEqual([]);
  });
});

describe('EventsRepo.newestOccurredAtByThreadPrefix', () => {
  it('returns the newest occurred_at across every thread under the prefix', () => {
    repo.insertIfAbsent(makeEvent({ eventId: 'a', sourceEventId: 'a', threadKey: 'C1:100', occurredAt: 100 }));
    repo.insertIfAbsent(makeEvent({ eventId: 'b', sourceEventId: 'b', threadKey: 'C1:250', occurredAt: 250 }));
    repo.insertIfAbsent(makeEvent({ eventId: 'c', sourceEventId: 'c', threadKey: 'C1:250', occurredAt: 180 }));

    expect(repo.newestOccurredAtByThreadPrefix('C1:')).toBe(250);
  });

  it('is null when nothing matches the prefix', () => {
    repo.insertIfAbsent(makeEvent({ threadKey: 'C1:1', occurredAt: 100 }));
    expect(repo.newestOccurredAtByThreadPrefix('C2:')).toBeNull();
    expect(repo.newestOccurredAtByThreadPrefix('C1:')).toBe(100);
  });

  it('does not bleed across a channel id that is a prefix of another', () => {
    // The `:` delimiter must isolate `C1` from `C12` — a plain `LIKE 'C1%'`
    // would fold `C12:...` into `C1`'s result.
    repo.insertIfAbsent(makeEvent({ eventId: 'x', sourceEventId: 'x', threadKey: 'C1:1', occurredAt: 100 }));
    repo.insertIfAbsent(makeEvent({ eventId: 'y', sourceEventId: 'y', threadKey: 'C12:1', occurredAt: 9_999 }));

    expect(repo.newestOccurredAtByThreadPrefix('C1:')).toBe(100);
    expect(repo.newestOccurredAtByThreadPrefix('C12:')).toBe(9_999);
  });

  it('ignores Gmail threads, whose keys carry no colon', () => {
    repo.insertIfAbsent(
      makeEvent({ eventId: 'g', sourceEventId: 'g', source: 'gmail', threadKey: '18f0abc', occurredAt: 5_000 }),
    );
    expect(repo.newestOccurredAtByThreadPrefix('18f0abc:')).toBeNull();
  });
});

describe('EventsRepo.newestOccurredAtBySource', () => {
  it('returns the newest occurred_at for one source, or null when it has none', () => {
    repo.insertIfAbsent(
      makeEvent({ eventId: 's1', sourceEventId: 's1', source: 'slack', occurredAt: 100 }),
    );
    repo.insertIfAbsent(
      makeEvent({ eventId: 'g1', sourceEventId: 'g1', source: 'gmail', threadKey: 't1', occurredAt: 900 }),
    );
    repo.insertIfAbsent(
      makeEvent({ eventId: 'g2', sourceEventId: 'g2', source: 'gmail', threadKey: 't2', occurredAt: 400 }),
    );

    expect(repo.newestOccurredAtBySource('gmail')).toBe(900);
    expect(repo.newestOccurredAtBySource('slack')).toBe(100);
    expect(repo.newestOccurredAtBySource('nonesuch')).toBeNull();
  });
});

describe('EventsRepo.countUnextracted', () => {
  it('counts events with no row in extractions', () => {
    repo.insertIfAbsent(makeEvent({ eventId: 'e-1', sourceEventId: 's-1' }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e-2', sourceEventId: 's-2' }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e-3', sourceEventId: 's-3' }));

    expect(repo.countUnextracted()).toBe(3);

    insertExtraction('x-1', 'e-2');

    expect(repo.countUnextracted()).toBe(2);
  });

  it('returns 0 for an empty database', () => {
    expect(repo.countUnextracted()).toBe(0);
  });
});

describe('EventsRepo.listUnextracted', () => {
  const seedThree = () => {
    repo.insertIfAbsent(makeEvent({ eventId: 'e-1', sourceEventId: 's-1', occurredAt: 1_000 }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e-2', sourceEventId: 's-2', occurredAt: 2_000 }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e-3', sourceEventId: 's-3', occurredAt: 3_000 }));
  };

  it('returns only events with no extraction row, newest first', () => {
    seedThree();
    insertExtraction('x-2', 'e-2');

    // Newest first (F2): the window a returning user asks about is what has to
    // be extractable in minutes, not the oldest mail in the mailbox.
    expect(repo.listUnextracted().map((e) => e.eventId)).toEqual(['e-3', 'e-1']);
  });

  it('agrees with countUnextracted', () => {
    seedThree();
    insertExtraction('x-1', 'e-1');

    expect(repo.listUnextracted()).toHaveLength(repo.countUnextracted());
  });

  it('honours a limit, and distinguishes a limit of 0 from an absent one', () => {
    seedThree();

    // The limit takes the NEWEST n, which is what makes a bounded sweep on a
    // huge backlog still cover the window the user is asking about.
    expect(repo.listUnextracted(2).map((e) => e.eventId)).toEqual(['e-3', 'e-2']);
    expect(repo.listUnextracted(0)).toEqual([]);
    expect(repo.listUnextracted()).toHaveLength(3);
  });

  it('returns fully hydrated events', () => {
    repo.insertIfAbsent(makeEvent());

    expect(repo.listUnextracted()[0]).toMatchObject({
      eventId: 'e1',
      source: 'slack',
      threadKey: 'C1:1',
      actorId: 'U1',
      payload: { text: 'hello' },
    });
  });

  it('returns an empty array for an empty database', () => {
    expect(repo.listUnextracted()).toEqual([]);
  });
});

describe('EventsRepo.threadExtractionState', () => {
  /**
   * The query that lets Layer 2 tell its two kinds of empty apart: "retrieval
   * has nothing YET" (extraction still running — retry) from "retrieval will
   * never have anything" (every event extracted, all of it noise — settle).
   * Collapsing the two is what parked 79 all-noise threads on a real install
   * and reported them to the user as summarization failures.
   */
  const insertClassified = (
    extractionId: string,
    eventId: string,
    cls: 'noise' | 'question' | 'status_update',
  ) =>
    db
      .prepare(
        `INSERT INTO extractions
           (extraction_id, event_id, class, confidence,
            participants_json, artifacts_json, model, prompt_version, created_at)
         VALUES (?, ?, ?, 0.9, '[]', '[]', 'm', 'v1', 1000)`,
      )
      .run(extractionId, eventId, cls);

  it('reports an unextracted backlog, which is the retryable case', () => {
    repo.insertIfAbsent(makeEvent({ eventId: 'e1', sourceEventId: 's1' }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e2', sourceEventId: 's2' }));
    insertClassified('x1', 'e1', 'noise');

    expect(repo.threadExtractionState('C1:1')).toEqual({
      events: 2,
      unextracted: 1,
      signal: 0,
    });
  });

  it('reports zero signal for a fully-extracted all-noise thread — the terminal case', () => {
    repo.insertIfAbsent(makeEvent({ eventId: 'e1', sourceEventId: 's1' }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e2', sourceEventId: 's2' }));
    insertClassified('x1', 'e1', 'noise');
    insertClassified('x2', 'e2', 'noise');

    expect(repo.threadExtractionState('C1:1')).toEqual({
      events: 2,
      unextracted: 0,
      signal: 0,
    });
  });

  it('counts every non-noise class as signal', () => {
    repo.insertIfAbsent(makeEvent({ eventId: 'e1', sourceEventId: 's1' }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e2', sourceEventId: 's2' }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e3', sourceEventId: 's3' }));
    insertClassified('x1', 'e1', 'question');
    insertClassified('x2', 'e2', 'status_update');
    insertClassified('x3', 'e3', 'noise');

    expect(repo.threadExtractionState('C1:1')).toEqual({
      events: 3,
      unextracted: 0,
      signal: 2,
    });
  });

  it('is scoped to the thread asked about', () => {
    repo.insertIfAbsent(makeEvent({ eventId: 'e1', sourceEventId: 's1', threadKey: 'C1:1' }));
    repo.insertIfAbsent(makeEvent({ eventId: 'e2', sourceEventId: 's2', threadKey: 'C2:2' }));
    insertClassified('x2', 'e2', 'status_update');

    expect(repo.threadExtractionState('C1:1')).toEqual({
      events: 1,
      unextracted: 1,
      signal: 0,
    });
  });

  it('returns zeroes for a thread with no events, never null', () => {
    // `events: 0` must not read as "fully extracted, nothing to say": Layer 2
    // requires `events > 0` before concluding a thread is terminally empty.
    expect(repo.threadExtractionState('nope')).toEqual({
      events: 0,
      unextracted: 0,
      signal: 0,
    });
  });
});
