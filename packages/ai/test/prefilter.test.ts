/**
 * Layer 1 deterministic pre-filter (P3, F-1).
 *
 * Two things are under test and they are different claims:
 *
 *  1. `prefilterReason` is conservative — it skips ONLY what the connector
 *     already flagged structurally, or a genuinely empty body. A short human
 *     message is not noise.
 *  2. `Layer1Extractor` honours it by writing a real `noise` extraction with
 *     **zero model calls and zero `ai_calls` rows**, because no call happened
 *     and a synthetic row would corrupt NFR-8's latency stats.
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
import { Layer1Extractor, PREFILTER_MODEL } from '../src/layer1/extract.js';
import { prefilterReason, connectorFlaggedNoise } from '../src/layer1/prefilter.js';

const NOW = 1_800_000_000_000;

function event(payload: Record<string, unknown>): Event {
  return {
    eventId: 'evt-1',
    source: 'slack',
    sourceEventId: 'C1:1.1',
    threadKey: 'C1:1',
    actorId: 'U1',
    occurredAt: NOW,
    ingestedAt: NOW,
    payload,
    redactionCount: 0,
  };
}

describe('prefilterReason', () => {
  it('skips an event the connector flagged as noise', () => {
    expect(prefilterReason(event({ text: 'has joined the channel', isNoiseCandidate: true }))).toBe(
      'connector_noise',
    );
  });

  it('skips an event with no usable body', () => {
    expect(prefilterReason(event({ text: '   ' }))).toBe('empty_body');
    expect(prefilterReason(event({}))).toBe('empty_body');
    expect(prefilterReason(event({ text: 42 }))).toBe('empty_body');
  });

  it('does NOT skip an ordinary message, however short', () => {
    // The filter must not become a length heuristic. "ship it" is three
    // characters of content and can be the decision the whole thread turned on.
    expect(prefilterReason(event({ text: 'ship it' }))).toBeUndefined();
    expect(prefilterReason(event({ text: 'yes' }))).toBeUndefined();
  });

  it('does NOT skip an unflagged event that merely looks automated', () => {
    // Only the connector's structural flag counts. Guessing from prose is
    // exactly the new judgement this filter refuses to invent.
    expect(
      prefilterReason(event({ text: 'Automated build 4821 passed. Do not reply.' })),
    ).toBeUndefined();
  });

  it('reports the more specific reason for an empty flagged event', () => {
    expect(prefilterReason(event({ text: '', isNoiseCandidate: true }))).toBe('connector_noise');
  });

  it('treats a non-true flag value as unflagged', () => {
    for (const value of [false, 'true', 1, null, undefined]) {
      expect(connectorFlaggedNoise(event({ text: 'real message', isNoiseCandidate: value }))).toBe(
        false,
      );
    }
  });
});

describe('Layer1Extractor pre-filtering', () => {
  let db: Database;
  let events: EventsRepo;
  let extractions: ExtractionsRepo;
  let aiCalls: AiCallsRepo;
  let generateJson: ReturnType<typeof vi.fn>;
  let embed: ReturnType<typeof vi.fn>;
  let upsert: ReturnType<typeof vi.fn>;

  /** Persist the event first — `extractions.event_id` is a live foreign key. */
  const seed = (payload: Record<string, unknown>): Event => {
    const e = event(payload);
    events.insertIfAbsent(e);
    return e;
  };

  const make = (skipNoise = true): Layer1Extractor => {
    const ollama = { generateJson, generateStream: vi.fn(), embed: vi.fn() };
    const vectors = { upsert } as unknown as VectorStore;
    return new Layer1Extractor(
      ollama as never,
      extractions,
      vectors,
      aiCalls,
      embed as never,
      'qwen2.5:7b',
      'v1',
      new FakeClock(NOW),
      skipNoise,
    );
  };

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    events = new EventsRepo(db);
    extractions = new ExtractionsRepo(db);
    aiCalls = new AiCallsRepo(db);
    generateJson = vi.fn(() => Promise.reject(new Error('the model must not be called')));
    embed = vi.fn(() => Promise.reject(new Error('embedding must not happen for noise')));
    upsert = vi.fn(() => Promise.resolve());
  });

  afterEach(() => {
    db.close();
  });

  it('classifies a flagged event as noise without calling the model', async () => {
    const result = await make().extractEvent(
      seed({ text: 'has joined the channel', isNoiseCandidate: true }),
      'trace-1',
    );

    expect(result.status).toBe('prefiltered');
    expect(result.prefilterReason).toBe('connector_noise');
    expect(result.extraction?.class).toBe('noise');
    // The whole point: ~29s of local inference not spent.
    expect(generateJson).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('writes a real extractions row, so the sweep does not re-queue it forever', async () => {
    const result = await make().extractEvent(
      seed({ text: 'x', isNoiseCandidate: true }),
      'trace-1',
    );

    const stored = extractions.listByEvent('evt-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.class).toBe('noise');
    expect(stored[0]?.extractionId).toBe(result.extraction?.extractionId);
  });

  it('records the FILTER as the model, never the chat model', async () => {
    await make().extractEvent(seed({ text: 'x', isNoiseCandidate: true }), 'trace-1');

    // The audit trail must never imply a model produced a classification it
    // never saw.
    expect(extractions.listByEvent('evt-1')[0]?.model).toBe(PREFILTER_MODEL);
  });

  it('writes NO ai_calls row, because no model call happened', async () => {
    await make().extractEvent(seed({ text: 'x', isNoiseCandidate: true }), 'trace-1');

    // A synthetic row would corrupt the per-layer latency stats NFR-8 exists to
    // make trustworthy — a 0ms "call" dragging the P50 down is a lie about speed.
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM ai_calls`).get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('falls through to the model when the filter is disabled', async () => {
    generateJson = vi.fn(() =>
      Promise.resolve({
        value: { class: 'noise', confidence: 0.9, participants: [], artifacts: [] },
        latencyMs: 10,
      }),
    );

    const result = await make(false).extractEvent(
      seed({ text: 'has joined the channel', isNoiseCandidate: true }),
      'trace-1',
    );

    // This is the comparison arm the eval needs: same corpus, model asked about
    // every event.
    expect(result.status).toBe('extracted');
    expect(generateJson).toHaveBeenCalledTimes(1);
  });
});
