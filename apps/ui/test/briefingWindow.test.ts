/**
 * Window resolution for "Brief me on what I missed" (F-2).
 *
 * `resolveBriefingWindow` is deliberately pure — `now` is passed in rather than
 * read from a clock, and both inputs are plain values rather than storage reads
 * — so the precedence rule it implements can be pinned exactly, without a DOM,
 * a bridge, or a fake timer.
 *
 * The rule under test: an explicit Settings override outranks the resume point,
 * the resume point outranks the first-run default, and anything unusable falls
 * through rather than producing an inverted or empty window.
 */
import { describe, expect, it } from 'vitest';

import {
  FIRST_RUN_BRIEFING_WINDOW_MS,
  resolveBriefingWindow,
} from '../lib/briefingWindow';

const NOW = 1_700_000_000_000;

describe('resolveBriefingWindow', () => {
  it('starts at the resume point when one exists', () => {
    const resumeFrom = NOW - 3 * 60 * 60 * 1000;

    expect(resolveBriefingWindow({ now: NOW, resumeFrom })).toEqual({
      windowStart: resumeFrom,
      windowEnd: NOW,
    });
  });

  it('falls back to a 24h lookback on first run', () => {
    // The user has never tapped "I'm caught up". Deliberately NOT the 30-day
    // default the old Settings control used: that value existed because the
    // question was answered once and never revisited, and a month-wide first
    // briefing is one nobody reads.
    expect(resolveBriefingWindow({ now: NOW, resumeFrom: null })).toEqual({
      windowStart: NOW - FIRST_RUN_BRIEFING_WINDOW_MS,
      windowEnd: NOW,
    });
  });

  it('lets an explicit override outrank the resume point', () => {
    const resumeFrom = NOW - 60 * 60 * 1000;
    const override = NOW - 14 * 24 * 60 * 60 * 1000;

    // "Show me further back than where I left off" is a real request and must
    // win — otherwise the override control does nothing once the user has ever
    // caught up.
    expect(resolveBriefingWindow({ now: NOW, resumeFrom, override })).toEqual({
      windowStart: override,
      windowEnd: NOW,
    });
  });

  it('uses the override on first run too', () => {
    const override = NOW - 5 * 24 * 60 * 60 * 1000;

    expect(resolveBriefingWindow({ now: NOW, resumeFrom: null, override })).toEqual({
      windowStart: override,
      windowEnd: NOW,
    });
  });

  it('ignores a resume point at or after now', () => {
    // Clock skew, or a briefing whose window ended in the future. Honouring it
    // would produce a zero-width or inverted window, which `parseBriefingWindow`
    // rejects in the main process — leaving the button silently broken.
    for (const resumeFrom of [NOW, NOW + 60_000]) {
      expect(resolveBriefingWindow({ now: NOW, resumeFrom })).toEqual({
        windowStart: NOW - FIRST_RUN_BRIEFING_WINDOW_MS,
        windowEnd: NOW,
      });
    }
  });

  it('ignores a non-finite resume point', () => {
    expect(resolveBriefingWindow({ now: NOW, resumeFrom: Number.NaN })).toEqual({
      windowStart: NOW - FIRST_RUN_BRIEFING_WINDOW_MS,
      windowEnd: NOW,
    });
  });

  it('falls through to the resume point when the override is unusable', () => {
    const resumeFrom = NOW - 2 * 60 * 60 * 1000;

    // An override in the future is not a reason to discard a perfectly good
    // resume point.
    expect(
      resolveBriefingWindow({ now: NOW, resumeFrom, override: NOW + 1000 }),
    ).toEqual({ windowStart: resumeFrom, windowEnd: NOW });

    expect(
      resolveBriefingWindow({ now: NOW, resumeFrom, override: Number.NaN }),
    ).toEqual({ windowStart: resumeFrom, windowEnd: NOW });
  });

  it('always produces a strictly positive-width window', () => {
    const cases = [
      { now: NOW, resumeFrom: null },
      { now: NOW, resumeFrom: NOW + 1 },
      { now: NOW, resumeFrom: NOW - 1 },
      { now: NOW, resumeFrom: null, override: NOW + 1 },
      { now: NOW, resumeFrom: NOW - 1000, override: NOW - 2000 },
    ];

    // The main process re-validates and returns an empty id for a bad window,
    // so this is the property that keeps the primary button working.
    for (const input of cases) {
      const { windowStart, windowEnd } = resolveBriefingWindow(input);
      expect(windowEnd).toBeGreaterThan(windowStart);
    }
  });
});
