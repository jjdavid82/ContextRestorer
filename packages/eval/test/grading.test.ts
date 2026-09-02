/**
 * Task 5.1 — the harness's claim-grading rule, tested WITHOUT a model.
 *
 * `classifyClaim` is the pure heart of the AC-5 / AC-6 numbers: it decides
 * whether a generated claim has a supporting artifact and whether each of its
 * citations goes where it says it does. It is separated from `metrics.test.ts`
 * because importing `harness.ts` loads `@cr/store` and therefore the
 * better-sqlite3 and LanceDB native modules — `metrics.test.ts` documents itself
 * as having zero such dependencies, and that promise is worth keeping.
 *
 * The cases below are the ones that caught a real bug. The first version of this
 * rule compared a claim to a hand-labeled negative with the same SYMMETRIC
 * similarity used for pending-item descriptions, which scored the perfectly
 * correct claim "Ben raised May 4 as an option for the Atlas launch but did not
 * decide" as a fabrication of "The Atlas launch slipped to May 4." — inflating
 * the AC-5 release-gate number with a false positive. `Direction of the
 * containment check` is the whole fix, so it is pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  GROUNDING_CONTAINMENT_THRESHOLD,
  LABELED_NEGATIVE_CONTAINMENT_THRESHOLD,
  buildCoverage,
  citationResolver,
  classifyClaim,
  selectFixtures,
} from '../src/harness.js';
import { contentTokens } from '../src/metrics.js';
import type { EvalFixture } from '../src/types.js';

/** The real source text of `pm-vacation-01`'s launch thread, close enough. */
const LAUNCH_THREAD_TEXT = [
  'Heads up: localization QA found 31 untranslated strings in the onboarding flow.',
  "If we can't clear those by Thursday, I'd want to talk about pushing to May 4.",
  "I'm not calling that yet — just flagging the option so nobody is surprised.",
  'Update: 22 of the 31 strings are done. The remaining 9 are in the payment step',
  'and need a native reviewer we don\'t have until next week.',
].join(' ');

const context = {
  tokensByArtifact: new Map([['thread-launch', contentTokens(LAUNCH_THREAD_TEXT)]]),
  unsupported: [
    'The Atlas launch slipped to May 4.',
    'All localization issues were resolved.',
  ],
};

describe('classifyClaim — hand-labeled negatives', () => {
  it('marks a claim that ASSERTS a labeled negative as unsupported', () => {
    const { claim, labeledUnsupported } = classifyClaim(
      'The Atlas launch slipped to May 4.',
      ['thread-launch'],
      context,
    );
    expect(labeledUnsupported).toBe(true);
    expect(claim.citations).toEqual([{ artifactId: 'thread-launch', supportsClaim: false }]);
  });

  it('does NOT mark a correct, hedged claim that merely shares words with a negative', () => {
    // The regression this file exists for. Symmetric Dice scores this 0.545 —
    // well past the 0.30 description threshold — but the falsehood lives entirely
    // in the word "slipped", which this claim does not contain (3 of 4 = 0.75,
    // below the 0.80 bar).
    const { labeledUnsupported } = classifyClaim(
      'Ben raised May 4 as an option for the Atlas launch but did not decide.',
      ['thread-launch'],
      context,
    );
    expect(labeledUnsupported).toBe(false);
  });

  it('uses containment of the LABEL in the CLAIM, not the other way round', () => {
    // A verbose claim that fully restates the falsehood is still a fabrication,
    // even though the label is a small fraction of the claim's tokens.
    const { labeledUnsupported } = classifyClaim(
      'Following the localization review, leadership confirmed that the Atlas launch ' +
        'slipped to May 4 and the team has been notified accordingly.',
      ['thread-launch'],
      context,
    );
    expect(labeledUnsupported).toBe(true);
  });

  it('overrides grounding: every citation on a labeled-negative claim is wrong', () => {
    // "pushing to May 4" appears verbatim in the thread, so the lexical check
    // alone would call this grounded. The label wins.
    const { claim } = classifyClaim(
      'The Atlas launch slipped to May 4.',
      ['thread-launch', 'thread-launch'],
      context,
    );
    expect(claim.citations.every((citation) => citation.supportsClaim)).toBe(false);
  });
});

describe('classifyClaim — lexical grounding', () => {
  it('accepts a claim whose content tokens are present in the cited thread', () => {
    const { claim } = classifyClaim(
      'Localization QA found 31 untranslated strings in the onboarding flow.',
      ['thread-launch'],
      context,
    );
    expect(claim.citations).toEqual([{ artifactId: 'thread-launch', supportsClaim: true }]);
  });

  it('rejects a claim built mostly from words that are not in the cited thread', () => {
    const { claim } = classifyClaim(
      'The payments vendor renewed its annual contract and issued a refund.',
      ['thread-launch'],
      context,
    );
    expect(claim.citations[0]?.supportsClaim).toBe(false);
  });

  it('rejects a citation naming an artifact the harness has no text for', () => {
    const { claim } = classifyClaim(
      'Localization QA found 31 untranslated strings in the onboarding flow.',
      ['thread-unknown'],
      context,
    );
    expect(claim.citations[0]?.supportsClaim).toBe(false);
  });

  it('produces an empty citation list for an uncited claim', () => {
    const { claim } = classifyClaim('Something happened.', [], context);
    expect(claim.citations).toEqual([]);
  });

  it('exposes both thresholds so the report can state what produced its numbers', () => {
    expect(GROUNDING_CONTAINMENT_THRESHOLD).toBe(0.6);
    expect(LABELED_NEGATIVE_CONTAINMENT_THRESHOLD).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// Citation resolution
// ---------------------------------------------------------------------------

/** A minimal fixture: two messages in one thread, one in another. */
const fixture = {
  id: 'coverage-01',
  description: 'x',
  persona: 'pm',
  window: { start: '2026-05-11T00:00:00Z', end: '2026-05-15T00:00:00Z' },
  events: [
    {
      event_id: 'e1',
      source: 'slack' as const,
      thread_key: 'C0A:1.0',
      artifact_id: 'slack:C0A:1.0',
      actor: 'Omar Feld',
      occurred_at: '2026-05-11T09:00:00Z',
      text: 'first',
    },
    {
      event_id: 'e2',
      source: 'slack' as const,
      thread_key: 'C0A:1.0',
      artifact_id: 'slack:C0A:2.0',
      actor: 'Lena Marsh',
      occurred_at: '2026-05-11T10:00:00Z',
      text: 'second',
    },
    {
      event_id: 'e3',
      source: 'slack' as const,
      thread_key: 'C0B:1.0',
      artifact_id: 'slack:C0B:1.0',
      actor: 'Omar Feld',
      occurred_at: '2026-05-12T09:00:00Z',
      text: 'third',
    },
  ],
  ground_truth: { pending_items: [{ description: 'd', citation: 'slack:C0A:2.0' }] },
  failure_mode_tags: ['wrong_citation' as const],
} satisfies EvalFixture;

describe('buildCoverage / citationResolver', () => {
  it('groups a thread’s message artifacts under one pipeline artifact id', () => {
    const coverage = buildCoverage(fixture);
    // Two threads → two pipeline artifacts, one covering two messages.
    expect(coverage.size).toBe(2);
    expect([...coverage.values()].map((set) => set.size).sort()).toEqual([1, 2]);
  });

  it('credits a thread-granular citation that covers the labeled message', () => {
    const coverage = buildCoverage(fixture);
    const resolve = citationResolver(coverage);
    const [threadA] = [...coverage.entries()].filter(([, ids]) => ids.has('slack:C0A:2.0'));
    expect(threadA).toBeDefined();
    expect(resolve(threadA?.[0] ?? '', 'slack:C0A:2.0')).toBe(true);
    // …and, crucially, does NOT credit the other thread. This is the property
    // that keeps `pm-wrong-citation-01` a failing case rather than a pass.
    const [threadB] = [...coverage.entries()].filter(([, ids]) => ids.has('slack:C0B:1.0'));
    expect(resolve(threadB?.[0] ?? '', 'slack:C0A:2.0')).toBe(false);
  });

  it('never credits a null citation', () => {
    expect(citationResolver(buildCoverage(fixture))(null, 'slack:C0A:2.0')).toBe(false);
  });

  it('still accepts an exact message-id match, if the pipeline ever emits one', () => {
    expect(citationResolver(new Map())('slack:C0A:2.0', 'slack:C0A:2.0')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subset selection
// ---------------------------------------------------------------------------

describe('selectFixtures', () => {
  const other: EvalFixture = { ...fixture, id: 'coverage-02' };

  it('returns everything when no ids are given', () => {
    expect(selectFixtures([fixture, other], undefined)).toHaveLength(2);
    expect(selectFixtures([fixture, other], [])).toHaveLength(2);
  });

  it('narrows to the requested ids, preserving directory order', () => {
    expect(selectFixtures([fixture, other], ['coverage-02']).map((f) => f.id)).toEqual([
      'coverage-02',
    ]);
  });

  it('THROWS on an unknown id rather than silently shrinking the run (RO-2)', () => {
    expect(() => selectFixtures([fixture, other], ['coverage-99'])).toThrowError(
      /no such fixture id\(s\): coverage-99/,
    );
  });
});
