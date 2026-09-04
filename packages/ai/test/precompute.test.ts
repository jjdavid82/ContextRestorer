/**
 * Background prose pre-computation (P0).
 *
 * The properties these pin are mostly about restraint: what the pre-computer
 * must NOT do. It runs when nobody is waiting, so every failure mode is a
 * cycle that quietly does nothing — and the one thing it must never do is
 * disturb the tick it shares with ingestion and Layer 2 synthesis.
 */
import { describe, it, expect, vi } from 'vitest';
import { FakeClock } from '@cr/core';
import { BriefingPrecomputer, type PrecomputeBriefings } from '../src/layer3/precompute.js';

const NOW = 1_800_000_000_000;

function makeBriefings(pending: string[]): PrecomputeBriefings & {
  calls: Array<{ start: number; end: number; limit: number }>;
} {
  const calls: Array<{ start: number; end: number; limit: number }> = [];
  return {
    calls,
    deltasNeedingProse: (start: number, end: number, limit: number) => {
      calls.push({ start, end, limit });
      return pending;
    },
  };
}

const generatorReturning = (claimsAccepted: number) => ({
  generate: vi.fn(async () => ({ claimsAccepted }) as never),
});

describe('BriefingPrecomputer', () => {
  it('generates for deltas that have no prose', async () => {
    const generator = generatorReturning(3);
    const briefings = makeBriefings(['d1', 'd2']);

    const result = await new BriefingPrecomputer(generator, briefings, {
      clock: new FakeClock(NOW),
    }).runCycle();

    expect(result).toEqual({ candidates: 2, claimsWritten: 3, ran: true });
    expect(generator.generate).toHaveBeenCalledTimes(1);
  });

  it('marks its briefing as precompute, never as delivered', async () => {
    const generator = generatorReturning(1);

    await new BriefingPrecomputer(generator, makeBriefings(['d1']), {
      clock: new FakeClock(NOW),
    }).runCycle();

    // AC-1 is a claim about how long a USER waited. A background run nobody
    // was watching must not enter that distribution — `latencyStats()` filters
    // on exactly this field.
    expect(generator.generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: 'precompute' }),
    );
  });

  it('does not call the model when every delta already has prose', async () => {
    const generator = generatorReturning(1);

    const result = await new BriefingPrecomputer(generator, makeBriefings([]), {
      clock: new FakeClock(NOW),
    }).runCycle();

    // The common steady state. Waking a 14B model to discover there is nothing
    // to do is the cost this queue exists to avoid.
    expect(result).toEqual({ candidates: 0, claimsWritten: 0, ran: false });
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('queries a bounded lookback window and a bounded batch', async () => {
    const briefings = makeBriefings([]);

    await new BriefingPrecomputer(generatorReturning(0), briefings, {
      clock: new FakeClock(NOW),
      lookbackMs: 60_000,
      maxDeltasPerCycle: 5,
    }).runCycle();

    // Unbounded either way would move the prompt-evaluation cost this design
    // exists to keep off the request path, rather than removing it.
    expect(briefings.calls[0]).toEqual({ start: NOW - 60_000, end: NOW, limit: 5 });
  });

  it('never throws when generation fails, and leaves the deltas queued', async () => {
    const generator = {
      generate: vi.fn(async () => {
        throw new Error('ollama went away');
      }),
    };

    const result = await new BriefingPrecomputer(generator as never, makeBriefings(['d1']), {
      clock: new FakeClock(NOW),
    }).runCycle();

    // Nothing downstream waits on prose, so a failed cycle is a cycle that did
    // nothing — and it must not disturb the tick it shares with ingestion.
    expect(result.ran).toBe(false);
    expect(result.error).toContain('ollama went away');
  });

  it('drops a re-entrant cycle rather than running two against the same deltas', async () => {
    let release: (() => void) | undefined;
    const generator = {
      generate: vi.fn(
        async () =>
          new Promise((resolve) => {
            release = () => resolve({ claimsAccepted: 1 } as never);
          }),
      ),
    };
    const precomputer = new BriefingPrecomputer(generator as never, makeBriefings(['d1']), {
      clock: new FakeClock(NOW),
    });

    const first = precomputer.runCycle();
    // Generation takes minutes; the 30s tick will fire underneath it.
    const second = await precomputer.runCycle();

    expect(second).toEqual({ candidates: 0, claimsWritten: 0, ran: false });
    expect(generator.generate).toHaveBeenCalledTimes(1);

    release?.();
    await first;
  });

  it('accepts work again once the previous cycle finishes', async () => {
    const generator = generatorReturning(1);
    const precomputer = new BriefingPrecomputer(generator, makeBriefings(['d1']), {
      clock: new FakeClock(NOW),
    });

    await precomputer.runCycle();
    const second = await precomputer.runCycle();

    expect(second.ran).toBe(true);
    expect(generator.generate).toHaveBeenCalledTimes(2);
  });
});

describe('BriefingPrecomputer power policy (§9 Q4)', () => {
  it('declines to run when mayRun says no, without querying for work', async () => {
    const generator = generatorReturning(1);
    const briefings = makeBriefings(['d1']);

    const result = await new BriefingPrecomputer(generator, briefings, {
      clock: new FakeClock(NOW),
      mayRun: () => false,
    }).runCycle();

    // Reported as `skipped: 'paused'` rather than as a bare `ran: false`:
    // "we chose not to" and "there was no work" are different facts about the
    // same idle tick, and only one of them is worth investigating.
    expect(result).toEqual({ candidates: 0, claimsWritten: 0, ran: false, skipped: 'paused' });
    expect(generator.generate).not.toHaveBeenCalled();
    // Not even the queue query — a paused cycle should cost nothing at all.
    expect(briefings.calls).toHaveLength(0);
  });

  it('runs again as soon as mayRun allows it', async () => {
    const generator = generatorReturning(2);
    let onBattery = true;
    const precomputer = new BriefingPrecomputer(generator, makeBriefings(['d1']), {
      clock: new FakeClock(NOW),
      mayRun: () => !onBattery,
    });

    expect((await precomputer.runCycle()).skipped).toBe('paused');

    onBattery = false;
    const resumed = await precomputer.runCycle();

    // Pausing must not be sticky: the deltas stayed queued and are picked up on
    // the first cycle after the machine is plugged in.
    expect(resumed.ran).toBe(true);
    expect(resumed.claimsWritten).toBe(2);
  });

  it('runs by default on a host with no notion of battery', async () => {
    const generator = generatorReturning(1);

    const result = await new BriefingPrecomputer(generator, makeBriefings(['d1']), {
      clock: new FakeClock(NOW),
    }).runCycle();

    // The eval harness and every test construct it without a predicate; a
    // default of "paused" would silently disable pre-computation there.
    expect(result.ran).toBe(true);
  });
});
