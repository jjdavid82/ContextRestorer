import { describe, expect, it } from 'vitest';

import { formatEta, formatLag } from '../lib/pipelineFormat';

describe('formatEta', () => {
  it('rounds to the roughest honest unit', () => {
    // Deliberately coarse past the first hour: the ETA answers "minutes or
    // hours", and quoting it to the minute would dress an estimate as a schedule.
    expect(formatEta(20_000)).toBe('under a minute');
    expect(formatEta(9 * 60_000)).toBe('~9 min');
    expect(formatEta(59 * 60_000)).toBe('~59 min');
    expect(formatEta(90 * 60_000)).toBe('~1.5 h');
    expect(formatEta(3 * 3_600_000)).toBe('~3 h');
    expect(formatEta(14 * 3_600_000)).toBe('~14 h');
  });

  it('returns a self-contained phrase — callers must not prefix "about"', () => {
    // The `~` is the hedge. "about ~12 min to go" is what this guards against.
    expect(formatEta(12 * 60_000).startsWith('about')).toBe(false);
    expect(formatEta(12 * 60_000)).toMatch(/^~/);
  });
});

describe('formatLag', () => {
  it('collapses to the roughest honest unit', () => {
    expect(formatLag(null)).toBe('lag unknown');
    expect(formatLag(30_000)).toBe('up to date');
    expect(formatLag(5 * 60_000)).toBe('5m behind');
    expect(formatLag(3 * 3_600_000)).toBe('3h behind');
  });
});
