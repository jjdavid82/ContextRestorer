/**
 * Batched Layer 1 extraction (P3 part 2, F-1).
 *
 * The claim under test is narrow and load-bearing: batching changes HOW MANY
 * TIMES the model is asked, and nothing else. One `extractions` row and one
 * chunk per event, same shape, same recovery semantics — so retrieval,
 * citations, the eval's per-event counting and `listUnextracted()` are all
 * unaffected.
 *
 * The other half is failure isolation. A response that classifies some events
 * and not others must write rows for the ones it classified and leave the rest
 * queued, never guess.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from 'better-sqlite3';
import { FakeClock, type Event } from '@cr/core';
import {
  AiCallsRepo,
  EventsRepo,
  ExtractionsRepo,
  migrate,
  openDb,
  type VectorStore,
} from '@cr/store';
import { Layer1Extractor, MAX_BATCH_EVENTS, parseLayer1Batch } from '../src/layer1/extract.js';

const NOW = 1_800_000_000_000;

let db: Database;
let events: EventsRepo;
let extractions: ExtractionsRepo;
let aiCalls: AiCallsRepo;
let generateJson: ReturnType<typeof vi.fn>;
let upsert: ReturnType<typeof vi.fn>;

/** Persist and return an event; `extractions.event_id` is a live FK. */
function seed(n: number, over: Record<string, unknown> = {}): Event {
  const event: Event = {
    eventId: `evt-${n}`,
    source: 'slack',
    sourceEventId: `C1:${n}.0`,
    threadKey: 'C1:1',
    actorId: 'U1',
    occurredAt: NOW + n,
    ingestedAt: NOW + n,
    payload: { text: `message number ${n}`, ...over },
    redactionCount: 0,
  };
  events.insertIfAbsent(event);
  return event;
}

/** A batched response classifying the given indices. */
const batchOf = (indices: number[]) => ({
  value: {
    extractions: indices.map((index) => ({
      index,
      class: 'status_update',
      confidence: 0.8,
      participants: [],
      artifacts: [],
    })),
  },
  latencyMs: 10,
});

function makeExtractor(): Layer1Extractor {
  const ollama = { generateJson, generateStream: vi.fn(), embed: vi.fn() };
  const vectors = { upsert } as unknown as VectorStore;
  return new Layer1Extractor(
    ollama as never,
    extractions,
    vectors,
    aiCalls,
    (async () => [0.1, 0.2]) as never,
    'qwen2.5:14b',
    'v1',
    new FakeClock(NOW),
  );
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  events = new EventsRepo(db);
  extractions = new ExtractionsRepo(db);
  aiCalls = new AiCallsRepo(db);
  upsert = vi.fn(() => Promise.resolve());
  generateJson = vi.fn();
});

afterEach(() => {
  db.close();
});

describe('parseLayer1Batch', () => {
  it('maps entries onto the events they name', () => {
    const slots = parseLayer1Batch(batchOf([0, 1]).value, 2);
    expect(slots.map((slot) => slot?.class)).toEqual(['status_update', 'status_update']);
  });

  it('leaves a slot null when the model skipped that event', () => {
    const slots = parseLayer1Batch(batchOf([0]).value, 3);
    expect(slots[0]).not.toBeNull();
    expect(slots[1]).toBeNull();
    expect(slots[2]).toBeNull();
  });

  it('DISCARDS an out-of-range index rather than repositioning it', () => {
    // Guessing would attach one event's classification to another's row. A
    // missing extraction gets retried; a wrong one becomes a fact the rest of
    // the pipeline trusts.
    const slots = parseLayer1Batch(batchOf([7]).value, 2);
    expect(slots.every((slot) => slot === null)).toBe(true);
  });

  it('keeps the first of a duplicated index', () => {
    const value = {
      extractions: [
        { index: 0, class: 'decision', confidence: 0.9, participants: [], artifacts: [] },
        { index: 0, class: 'noise', confidence: 0.1, participants: [], artifacts: [] },
      ],
    };
    expect(parseLayer1Batch(value, 1)[0]?.class).toBe('decision');
  });

  it('returns all-null for a response that is not the batch shape', () => {
    for (const value of [null, [], 'text', { extractions: 'not an array' }]) {
      expect(parseLayer1Batch(value, 2)).toEqual([null, null]);
    }
  });
});

describe('Layer1Extractor.extractThread', () => {
  it('classifies a whole thread in ONE model call', async () => {
    const batch = [seed(1), seed(2), seed(3)];
    generateJson.mockResolvedValue(batchOf([0, 1, 2]));

    const result = await makeExtractor().extractThread(batch, 'trace-1');

    // The entire point: 3 events, 1 call. At ~85s per call on 14b this is the
    // difference between minutes and hours over a real corpus.
    expect(result.modelCalls).toBe(1);
    expect(result.extracted).toBe(3);
    expect(generateJson).toHaveBeenCalledTimes(1);
  });

  it('writes one extractions row per event, exactly as the single-event path does', async () => {
    const batch = [seed(1), seed(2)];
    generateJson.mockResolvedValue(batchOf([0, 1]));

    await makeExtractor().extractThread(batch, 'trace-1');

    // The row/chunk contract is unchanged, which is what keeps retrieval,
    // citations and the recovery sweep working untouched.
    expect(extractions.listByEvent('evt-1')).toHaveLength(1);
    expect(extractions.listByEvent('evt-2')).toHaveLength(1);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('leaves unclassified events queued rather than guessing', async () => {
    const batch = [seed(1), seed(2), seed(3)];
    generateJson.mockResolvedValue(batchOf([0])); // the model skipped 2 and 3

    const result = await makeExtractor().extractThread(batch, 'trace-1');

    expect(result.extracted).toBe(1);
    expect(result.unclassified).toBe(2);
    // Still visible to the recovery sweep — the same behaviour a single-event
    // schema failure has always had.
    expect(events.listUnextracted().map((e) => e.eventId)).toEqual(['evt-2', 'evt-3']);
  });

  it('splits a long thread into bounded batches', async () => {
    const batch = Array.from({ length: MAX_BATCH_EVENTS + 2 }, (_unused, i) => seed(i + 1));
    generateJson.mockResolvedValue(batchOf([0]));

    const result = await makeExtractor().extractThread(batch, 'trace-1');

    // An unbounded batch would trade N slow calls for one nearly-as-slow call,
    // and make a single malformed response cost the whole thread.
    expect(result.modelCalls).toBe(2);
  });

  it('pre-filters structural noise BEFORE the model sees it', async () => {
    const batch = [seed(1, { isNoiseCandidate: true }), seed(2)];
    generateJson.mockResolvedValue(batchOf([0]));

    const result = await makeExtractor().extractThread(batch, 'trace-1');

    // Batching must not smuggle back the cost P3 part 1 removed.
    expect(result.prefiltered).toBe(1);
    expect(extractions.listByEvent('evt-1')[0]?.class).toBe('noise');
    const prompt = generateJson.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).not.toContain('message number 1');
    expect(prompt).toContain('message number 2');
  });

  it('makes no model call at all when every event is pre-filtered', async () => {
    const batch = [seed(1, { isNoiseCandidate: true }), seed(2, { isNoiseCandidate: true })];

    const result = await makeExtractor().extractThread(batch, 'trace-1');

    expect(result).toMatchObject({ prefiltered: 2, extracted: 0, modelCalls: 0 });
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('wraps every body in ONE untrusted block (T-1)', async () => {
    generateJson.mockResolvedValue(batchOf([0, 1]));

    await makeExtractor().extractThread([seed(1), seed(2)], 'trace-1');

    const prompt = generateJson.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toMatch(/<<<UNTRUSTED_CONTENT_[0-9a-f]{6}/);
    // The per-event numbering sits INSIDE the fence with the content, so a body
    // imitating a numbering line cannot escape into the trusted half.
    const open = prompt.indexOf('<<<UNTRUSTED_CONTENT_');
    const close = prompt.indexOf('<<<END_UNTRUSTED_CONTENT_');
    expect(prompt.indexOf('[event 0]')).toBeGreaterThan(open);
    expect(prompt.indexOf('[event 1]')).toBeLessThan(close);
  });

  it('writes exactly one ai_calls row per batch, not per event', async () => {
    generateJson.mockResolvedValue(batchOf([0, 1, 2]));

    await makeExtractor().extractThread([seed(1), seed(2), seed(3)], 'trace-1');

    // The honest accounting: it was one call. Three rows would inflate the
    // per-layer call counts NFR-8 exists to make trustworthy.
    const rows = db.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE layer = 1').get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it('returns an empty result for an empty thread', async () => {
    const result = await makeExtractor().extractThread([], 'trace-1');
    expect(result).toEqual({ extracted: 0, prefiltered: 0, unclassified: 0, modelCalls: 0 });
  });
});
