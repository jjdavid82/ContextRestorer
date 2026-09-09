import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDb, migrate } from '../src/index.js';
import { AiCallsRepo } from '../src/repos/aiCalls.js';

let db: Database;
let repo: AiCallsRepo;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  repo = new AiCallsRepo(db);
});

afterEach(() => {
  db.close();
});

/**
 * Insert a row with an EXPLICIT `created_at`.
 *
 * `AiCallsRepo.log()` stamps `Date.now()` itself, so two calls in a test can
 * land in the same millisecond and leave `ORDER BY created_at DESC` free to
 * return either first. Every ordering-sensitive assertion below therefore seeds
 * through SQL rather than through the repo; the repo's own write path is
 * exercised by the tests that do not care about order.
 */
function seedCall(opts: {
  layer: number;
  latencyMs: number;
  outcome?: string;
  createdAt: number;
}): void {
  db.prepare(
    `INSERT INTO ai_calls
       (call_id, trace_id, layer, model, prompt_version, latency_ms,
        tokens_in, tokens_out, outcome, created_at)
     VALUES (?, 't', ?, 'm', 'v1', ?, 1, 1, ?, ?)`,
  ).run(
    `c-${opts.layer}-${opts.createdAt}-${opts.latencyMs}`,
    opts.layer,
    opts.latencyMs,
    opts.outcome ?? 'ok',
    opts.createdAt,
  );
}

describe('AiCallsRepo.recentMeanLatencyMs — the extraction ETA input (F2)', () => {
  it('averages recent successful calls on the requested layer', () => {
    seedCall({ layer: 1, latencyMs: 1_000, createdAt: 1 });
    seedCall({ layer: 1, latencyMs: 3_000, createdAt: 2 });

    expect(repo.recentMeanLatencyMs(1, 10)).toBe(2_000);
  });

  it('is scoped to one layer', () => {
    seedCall({ layer: 1, latencyMs: 1_000, createdAt: 1 });
    seedCall({ layer: 3, latencyMs: 300_000, createdAt: 2 });

    // Layer 3 generation is minutes; quoting it as the extraction pace would
    // overstate an extraction backlog by an order of magnitude.
    expect(repo.recentMeanLatencyMs(1, 10)).toBe(1_000);
  });

  it('ignores failures, which are fast and would make the estimate optimistic', () => {
    // A parse error returns in milliseconds. Averaging those in would quote a
    // backlog as minutes when it is hours, and an ETA that is confidently wrong
    // is worse than none.
    seedCall({ layer: 1, latencyMs: 80_000, createdAt: 1 });
    seedCall({ layer: 1, latencyMs: 5, outcome: 'parse_error', createdAt: 2 });
    seedCall({ layer: 1, latencyMs: 5, outcome: 'error', createdAt: 3 });

    expect(repo.recentMeanLatencyMs(1, 10)).toBe(80_000);
  });

  it('honours the sample size, taking the NEWEST calls', () => {
    // The point of a trailing sample: this machine's pace right now, not the
    // pace of a model the user has since changed.
    seedCall({ layer: 1, latencyMs: 1_000, createdAt: 1 });
    seedCall({ layer: 1, latencyMs: 100_000, createdAt: 2 });

    expect(repo.recentMeanLatencyMs(1, 1)).toBe(100_000);
  });

  it('rounds to a whole millisecond', () => {
    seedCall({ layer: 1, latencyMs: 1_000, createdAt: 1 });
    seedCall({ layer: 1, latencyMs: 1_001, createdAt: 2 });

    expect(repo.recentMeanLatencyMs(1, 10)).toBe(1_001);
  });

  it('returns null — never 0 — when there is nothing to average', () => {
    // `null` is what the renderer reads as "cannot say yet". `0` would read as
    // "instant" and produce an ETA of zero for a backlog of thousands, which is
    // the false promise this whole field exists to avoid.
    expect(repo.recentMeanLatencyMs(1, 10)).toBeNull();

    seedCall({ layer: 1, latencyMs: 5, outcome: 'parse_error', createdAt: 1 });
    expect(repo.recentMeanLatencyMs(1, 10)).toBeNull();
  });

  it('returns null for a non-positive sample rather than querying', () => {
    seedCall({ layer: 1, latencyMs: 1_000, createdAt: 1 });

    expect(repo.recentMeanLatencyMs(1, 0)).toBeNull();
    expect(repo.recentMeanLatencyMs(1, -5)).toBeNull();
  });

  it('reads rows written through the repo, not only hand-seeded ones', () => {
    repo.log({
      traceId: 't',
      layer: 1,
      model: 'm',
      promptVersion: 'v1',
      latencyMs: 42_000,
      outcome: 'ok',
    });

    expect(repo.recentMeanLatencyMs(1, 10)).toBe(42_000);
  });
});
