import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  FAILURE_MODE_TAGS,
  REQUIRED_FAILURE_MODE_TAGS,
  validateFixture,
  type EvalFixture,
} from '../src/types.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

/**
 * Globbed at test time on purpose: a fixture added later must be covered without anyone
 * remembering to update a list here. Task 5.2 grows this directory to ~70 files.
 */
const fixtureFiles = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.json')).sort();

function loadFixture(fileName: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, fileName), 'utf8'));
}

describe('fixture files', () => {
  it('the fixtures directory is not empty', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles)('%s parses as JSON and passes validateFixture()', (fileName) => {
    const parsed = loadFixture(fileName);
    const result = validateFixture(parsed);
    // Surfacing the error list in the assertion makes a failure self-diagnosing.
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.each(fixtureFiles)('%s has an id matching its filename stem', (fileName) => {
    const parsed = loadFixture(fileName) as EvalFixture;
    expect(parsed.id).toBe(fileName.replace(/\.json$/, ''));
  });
});

describe('failure-mode taxonomy coverage', () => {
  const coveredTags = new Set<string>();
  for (const fileName of fixtureFiles) {
    const parsed = loadFixture(fileName) as EvalFixture;
    for (const tag of parsed.failure_mode_tags ?? []) coveredTags.add(tag);
  }

  // Named per tag rather than a single set comparison, so a removed category fails loudly
  // by name instead of as an opaque set diff.
  it.each(REQUIRED_FAILURE_MODE_TAGS)(
    'at least one fixture is tagged %s',
    (requiredTag) => {
      const owners = fixtureFiles.filter((fileName) =>
        ((loadFixture(fileName) as EvalFixture).failure_mode_tags ?? []).includes(requiredTag),
      );
      expect(
        owners,
        `no fixture carries the required failure-mode tag '${requiredTag}' — do not delete the last example for a category`,
      ).not.toHaveLength(0);
    },
  );

  it('every tag used is part of the documented taxonomy', () => {
    for (const tag of coveredTags) {
      expect(FAILURE_MODE_TAGS as readonly string[]).toContain(tag);
    }
  });
});

describe('validateFixture rejects bad input', () => {
  /** A minimal fixture that is valid, used as the base for targeted mutations. */
  function baseFixture(): Record<string, unknown> {
    return {
      id: 'synthetic-valid-01',
      description: 'A minimal valid fixture used as a mutation base in tests.',
      persona: 'eng_manager',
      window: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
      events: [
        {
          event_id: 'ev-1',
          source: 'slack',
          thread_key: 'C0TEST:1.000100',
          artifact_id: 'slack:C0TEST:1.000100',
          actor: 'Test Person',
          occurred_at: '2026-01-01T09:00:00Z',
          text: 'Can you approve the thing by Friday?',
        },
      ],
      ground_truth: {
        pending_items: [{ description: 'Approve the thing.', citation: 'slack:C0TEST:1.000100' }],
      },
      failure_mode_tags: ['missed_pending_item'],
    };
  }

  function expectRejected(mutate: (fixture: Record<string, unknown>) => void, match: RegExp): void {
    const fixture = baseFixture();
    mutate(fixture);
    const result = validateFixture(fixture);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(match);
  }

  it('accepts the base fixture (guards against a validator that rejects everything)', () => {
    expect(validateFixture(baseFixture())).toEqual({ valid: true, errors: [] });
  });

  it('rejects a missing failure_mode_tags', () => {
    expectRejected((f) => delete f['failure_mode_tags'], /failure_mode_tags: must be an array/);
  });

  it('rejects an empty failure_mode_tags array', () => {
    expectRejected(
      (f) => (f['failure_mode_tags'] = []),
      /failure_mode_tags: must contain at least one tag/,
    );
  });

  it('rejects an unknown failure_mode_tag', () => {
    expectRejected((f) => (f['failure_mode_tags'] = ['vibes_were_off']), /unknown tag 'vibes_were_off'/);
  });

  it('rejects a fixture with neither pending_items nor expect_no_pending', () => {
    expectRejected(
      (f) => (f['ground_truth'] = { acceptable_briefings: ['something happened'] }),
      /must declare either at least one pending_items entry or expect_no_pending: true/,
    );
  });

  it('rejects an empty pending_items array with no explicit negative label', () => {
    expectRejected(
      (f) => (f['ground_truth'] = { pending_items: [] }),
      /must declare either at least one pending_items entry or expect_no_pending: true/,
    );
  });

  it('rejects a fixture asserting both pending_items and expect_no_pending', () => {
    expectRejected(
      (f) =>
        (f['ground_truth'] = {
          pending_items: [{ description: 'Approve the thing.', citation: 'slack:C0TEST:1.000100' }],
          expect_no_pending: true,
        }),
      /contradicts a non-empty pending_items/,
    );
  });

  it('accepts expect_no_pending: true on its own', () => {
    const fixture = baseFixture();
    fixture['ground_truth'] = { expect_no_pending: true, notes: 'nothing is waiting on the user' };
    fixture['failure_mode_tags'] = ['false_pending_item'];
    expect(validateFixture(fixture)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a missing id and a missing description', () => {
    expectRejected((f) => delete f['id'], /id: must be a non-empty string/);
    expectRejected((f) => (f['description'] = '   '), /description: must be a non-empty string/);
  });

  it('rejects a pending-item citation that matches no event artifact_id', () => {
    expectRejected(
      (f) =>
        (f['ground_truth'] = {
          pending_items: [{ description: 'Approve the thing.', citation: 'slack:C0OTHER:9.000900' }],
        }),
      /does not match any events\[\]\.artifact_id/,
    );
  });

  it('rejects an empty events array and a bad source value', () => {
    expectRejected((f) => (f['events'] = []), /events: must contain at least one event/);
    expectRejected((f) => {
      const events = f['events'] as Array<Record<string, unknown>>;
      events[0]!['source'] = 'teams';
    }, /events\[0\]\.source: must be 'slack' or 'gmail'/);
  });

  it('rejects non-object input', () => {
    for (const input of [null, undefined, 42, 'fixture', ['fixture']]) {
      expect(validateFixture(input)).toEqual({
        valid: false,
        errors: ['fixture must be a JSON object'],
      });
    }
  });

  it('collects every error in one pass rather than stopping at the first', () => {
    const result = validateFixture({ failure_mode_tags: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(3);
  });
});
