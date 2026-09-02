/**
 * Task 5.1 Step 1 — the metrics graded against HAND-COMPUTED values.
 *
 * Every number asserted here was worked out on paper from a constructed input,
 * then written down. That is the point: these are pure functions, so a metric
 * bug and a model regression are the only two things that can move the eval
 * numbers, and this file exists to rule out the first one. There is **no Ollama,
 * no database and no fixture I/O in this suite** — it runs in milliseconds and
 * must never acquire a dependency that changes that.
 *
 * `toBe`, not `toBeCloseTo`, wherever the value is exactly representable: 9/10
 * and 8/10 are exact in IEEE-754 doubles, and a tolerance would let a genuinely
 * wrong denominator slip through. `toBeCloseTo` appears only where the quotient
 * is a repeating binary fraction (thirds, sevenths, elevenths).
 *
 * The single most important test in this file is
 * "a right-sounding item with the WRONG citation is a miss AND a citation error".
 * That is the rule design §10 states and the rule `pm-wrong-citation-01.json`
 * exists to catch, and it is the one a well-meaning refactor is most likely to
 * soften into "close enough".
 */

import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MATCH_THRESHOLD,
  TOP_N,
  citationAccuracy,
  citationAccuracyDetail,
  containment,
  contentTokens,
  descriptionSimilarity,
  descriptionsMatch,
  dice,
  hallucinationRate,
  hallucinationRateDetail,
  isHallucinated,
  isSurfaced,
  isWrongCitation,
  matchPendingItems,
  precision,
  precisionDetail,
  recall,
  recallDetail,
  strictCitationMatch,
  top3Relevance,
  top3RelevanceDetail,
  type EvalCase,
  type GroundTruthPendingItem,
  type MatchedItem,
  type PredictedClaim,
  type PredictedPendingItem,
} from '../src/metrics.js';
import { buildReport, renderHeadline, renderMarkdown, type EvalReport } from '../src/report.js';

// ---------------------------------------------------------------------------
// Builders — deliberately explicit, so the hand computation is checkable by eye
// ---------------------------------------------------------------------------

/** A ground-truth item whose description is `n` distinct nonsense tokens. */
function gt(n: number, citation: string): GroundTruthPendingItem {
  return { description: words(n), citation };
}

/** A prediction with an identical description to `gt(n, …)` — similarity 1.0. */
function pred(n: number, citation: string | null): PredictedPendingItem {
  return { description: words(n), citation };
}

/**
 * `n` distinct, stopword-free, ≥2-char tokens.
 *
 * Prefixed so no token is an English stopword and none collides across `n`
 * values in a way that would make two "different" descriptions accidentally
 * similar. `words(3)` ⊂ `words(4)`, which is what lets the tests dial similarity.
 */
function words(n: number): string {
  return Array.from({ length: n }, (_unused, index) => `tok${index}a`).join(' ');
}

/** A surfaced (description-matched, citation-correct) match. */
function hit(citation: string): MatchedItem {
  const item = gt(6, citation);
  return { groundTruth: item, predicted: { description: item.description, citation }, citationCorrect: true };
}

/** A never-surfaced match. */
function miss(citation: string): MatchedItem {
  return { groundTruth: gt(6, citation), predicted: null, citationCorrect: false };
}

/** A claim with `supporting` supporting citations and `wrong` non-supporting ones. */
function claim(text: string, supporting: number, wrong: number): PredictedClaim {
  return {
    text,
    citations: [
      ...Array.from({ length: supporting }, (_u, i) => ({
        artifactId: `ok-${text}-${i}`,
        supportsClaim: true,
      })),
      ...Array.from({ length: wrong }, (_u, i) => ({
        artifactId: `bad-${text}-${i}`,
        supportsClaim: false,
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Tokenizer and similarity — the substrate the fuzzy rule rests on
// ---------------------------------------------------------------------------

describe('contentTokens', () => {
  it('lowercases, splits on non-alphanumerics and drops stopwords', () => {
    expect([...contentTokens('The cutover WAS approved by Rhea.')]).toEqual([
      'cutover',
      'approved',
      'rhea',
    ]);
  });

  it('drops single characters but KEEPS two-character tokens', () => {
    // `v2`/`v3` are the entire distinction in `injection-01.json`. A three-char
    // floor would erase it, so this is a regression guard, not a style choice.
    expect([...contentTokens('a v2 to v3 migration')]).toEqual(['v2', 'v3', 'migration']);
  });

  it('is a set, not a bag', () => {
    expect(contentTokens('freeze freeze freeze').size).toBe(1);
  });
});

describe('dice', () => {
  it('is 1 for identical non-empty sets', () => {
    expect(dice(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('is 0 when either set is empty — an empty description matches nothing', () => {
    expect(dice(new Set(), new Set(['a']))).toBe(0);
    expect(dice(new Set(), new Set())).toBe(0);
  });

  it('computes 2|A∩B| / (|A|+|B|)', () => {
    // |A|=4, |B|=2, shared = 2  →  4/6
    expect(dice(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b']))).toBeCloseTo(4 / 6, 12);
  });

  it('is symmetric', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd', 'e']);
    expect(dice(a, b)).toBe(dice(b, a));
  });
});

describe('containment', () => {
  it('is the fraction of the needle present in the haystack', () => {
    expect(containment(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b', 'z']))).toBe(0.5);
  });

  it('is 0 for an empty needle', () => {
    expect(containment(new Set(), new Set(['a']))).toBe(0);
  });
});

describe('descriptionSimilarity / descriptionsMatch', () => {
  it('clears the threshold for a terse but faithful rewording of a real label', () => {
    // The calibration case from `DESCRIPTION_MATCH_THRESHOLD`'s doc comment,
    // taken verbatim from `eng-mgr-vacation-01.json`.
    const label =
      'Decide whether the billing queue-migration cutover holds for the audit freeze or ' +
      'proceeds on the 21st — Rhea is blocked on this sign-off and cannot schedule the ' +
      'on-call rotation without it.';
    const model =
      'Provide a yes/no decision on whether to hold the queue-migration cutover for the ' +
      'audit freeze.';
    expect(descriptionSimilarity(label, model)).toBeGreaterThanOrEqual(
      DESCRIPTION_MATCH_THRESHOLD,
    );
    expect(descriptionsMatch(label, model)).toBe(true);
  });

  it('rejects a short generic near-miss against a specific label', () => {
    const label =
      'Approve the self-serve tier seat-band change by Friday, or the old bands ship at ' +
      'sales kickoff.';
    expect(descriptionsMatch('Approve the pricing sheet', label)).toBe(false);
  });

  it('rejects a two-token prediction that is a strict subset of the label', () => {
    // The failure mode containment-based matching has and Dice does not.
    expect(descriptionsMatch(words(2), words(20))).toBe(false);
  });
});

describe('strictCitationMatch', () => {
  it('requires exact equality and never matches null', () => {
    expect(strictCitationMatch('art-1', 'art-1')).toBe(true);
    expect(strictCitationMatch('art-2', 'art-1')).toBe(false);
    expect(strictCitationMatch(null, 'art-1')).toBe(false);
    // No trimming, no case folding: "close enough" citations point at the wrong
    // message.
    expect(strictCitationMatch(' art-1', 'art-1')).toBe(false);
    expect(strictCitationMatch('ART-1', 'art-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE matching rule
// ---------------------------------------------------------------------------

describe('matchPendingItems — fuzzy on description, STRICT on citation', () => {
  it('matches a reworded description with the correct citation', () => {
    const groundTruth = [gt(10, 'art-right')];
    const predictions: PredictedPendingItem[] = [
      { description: `${words(6)} extra padding tokens here`, citation: 'art-right' },
    ];

    const [match] = matchPendingItems(groundTruth, predictions);
    expect(match).toBeDefined();
    expect(match?.predicted).toBe(predictions[0]);
    expect(match?.citationCorrect).toBe(true);
    expect(isSurfaced(match as MatchedItem)).toBe(true);
  });

  /**
   * THE test. `pm-wrong-citation-01.json` in one assertion block.
   *
   * The prediction's description is a perfect match for the label — same words,
   * so similarity is 1.0 and no fuzziness argument can rescue it — but it cites
   * the distractor artifact. Design §10: that is a MISS for recall AND a
   * citation error. Not a pass. Not a partial credit. Not a warning.
   */
  it('a right-sounding item with the WRONG citation is a MISS and a CITATION ERROR, not a match', () => {
    const groundTruth = [gt(12, 'slack:C0SELFSERVE:1778544000.000100')];
    const predictions: PredictedPendingItem[] = [
      // Word-for-word the labeled obligation …
      { description: words(12), citation: 'slack:C0PRICING:1778457600.000100' }, // … wrong thread.
    ];

    const matches = matchPendingItems(groundTruth, predictions);
    const [match] = matches;
    expect(match).toBeDefined();

    // The description DID match — that is why `predicted` is retained.
    expect(descriptionSimilarity(groundTruth[0]?.description ?? '', words(12))).toBe(1);
    expect(match?.predicted).toBe(predictions[0]);

    // But the citation is wrong, so it is not surfaced …
    expect(match?.citationCorrect).toBe(false);
    expect(isSurfaced(match as MatchedItem)).toBe(false);
    // … it is a recall MISS …
    expect(recall(matches)).toBe(0);
    // … it is a citation ERROR, attributable as such …
    expect(isWrongCitation(match as MatchedItem)).toBe(true);
    // … and it is a precision FAILURE too: the item the system surfaced was not
    // a real one, because it pointed the user at the wrong message.
    expect(precision(predictions, matches)).toBe(0);
  });

  it('does not let a wrong-citation duplicate steal the slot from the correct item', () => {
    // A chatty model emits the same obligation twice, once cited correctly. The
    // greedy pairing prefers the citation-correct candidate, so recall is 1 and
    // the duplicate is left over as the false positive it is.
    const groundTruth = [gt(10, 'art-right')];
    const predictions: PredictedPendingItem[] = [
      { description: words(10), citation: 'art-wrong' },
      { description: words(10), citation: 'art-right' },
    ];

    const matches = matchPendingItems(groundTruth, predictions);
    expect(matches[0]?.predicted).toBe(predictions[1]);
    expect(recall(matches)).toBe(1);
    expect(precision(predictions, matches)).toBe(0.5);
  });

  it('never pairs one prediction with two ground-truth items', () => {
    const groundTruth = [gt(10, 'art-a'), gt(10, 'art-b')];
    const predictions: PredictedPendingItem[] = [{ description: words(10), citation: 'art-a' }];

    const matches = matchPendingItems(groundTruth, predictions);
    expect(matches.filter((match) => match.predicted !== null)).toHaveLength(1);
    expect(recall(matches)).toBe(0.5);
  });

  it('treats a null citation as never correct', () => {
    const matches = matchPendingItems([gt(10, 'art-a')], [pred(10, null)]);
    expect(matches[0]?.citationCorrect).toBe(false);
    expect(recall(matches)).toBe(0);
  });

  it('honours an injected citation equivalence (thread-granularity resolution)', () => {
    // How the harness bridges message-granular labels to thread-granular output.
    const coverage = new Map([['thread-artifact', new Set(['msg-1', 'msg-2'])]]);
    const matches = matchPendingItems([gt(10, 'msg-2')], [pred(10, 'thread-artifact')], {
      citationMatches: (predicted, groundTruth) =>
        predicted !== null &&
        (predicted === groundTruth || coverage.get(predicted)?.has(groundTruth) === true),
    });
    expect(matches[0]?.citationCorrect).toBe(true);
  });

  it('returns one entry per ground-truth item, in label order', () => {
    const groundTruth = [gt(4, 'a'), gt(8, 'b'), gt(12, 'c')];
    const matches = matchPendingItems(groundTruth, []);
    expect(matches.map((match) => match.groundTruth.citation)).toEqual(['a', 'b', 'c']);
    expect(matches.every((match) => match.predicted === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recall — hand-computed 9/10
// ---------------------------------------------------------------------------

describe('recall', () => {
  it('is exactly 0.9 when 9 of 10 ground-truth items were surfaced', () => {
    const matches: MatchedItem[] = [
      ...Array.from({ length: 9 }, (_u, i) => hit(`art-${i}`)),
      miss('art-9'),
    ];
    expect(matches).toHaveLength(10);
    expect(recall(matches)).toBe(0.9);
    expect(recallDetail(matches)).toEqual({ value: 0.9, numerator: 9, denominator: 10 });
  });

  it('counts a wrong-citation pair in the denominator but not the numerator', () => {
    // 10 labeled items: 8 clean hits, 1 wrong citation, 1 never surfaced → 8/10.
    const wrongCitation: MatchedItem = {
      groundTruth: gt(6, 'art-8'),
      predicted: { description: words(6), citation: 'art-other' },
      citationCorrect: false,
    };
    const matches: MatchedItem[] = [
      ...Array.from({ length: 8 }, (_u, i) => hit(`art-${i}`)),
      wrongCitation,
      miss('art-9'),
    ];
    expect(recall(matches)).toBe(0.8);
    expect(matches.filter(isWrongCitation)).toHaveLength(1);
  });

  it('is 1 on an empty denominator (nothing was labeled, so nothing was missed)', () => {
    expect(recall([])).toBe(1);
    expect(recallDetail([])).toEqual({ value: 1, numerator: 0, denominator: 0 });
  });
});

// ---------------------------------------------------------------------------
// precision — hand-computed 8/10
// ---------------------------------------------------------------------------

describe('precision', () => {
  it('is exactly 0.8 when 8 of 10 surfaced items are real', () => {
    // 8 labeled items, each surfaced correctly, plus 2 invented obligations.
    const groundTruth = Array.from({ length: 8 }, (_u, i) => gt(10 + i, `art-${i}`));
    const real: PredictedPendingItem[] = groundTruth.map((item) => ({
      description: item.description,
      citation: item.citation,
    }));
    const invented: PredictedPendingItem[] = [
      { description: 'entirely unrelated fabricated obligation alpha', citation: 'art-x' },
      { description: 'entirely unrelated fabricated obligation beta', citation: 'art-y' },
    ];
    const predictions = [...real, ...invented];
    expect(predictions).toHaveLength(10);

    const matches = matchPendingItems(groundTruth, predictions);
    expect(matches.filter(isSurfaced)).toHaveLength(8);
    expect(precision(predictions, matches)).toBe(0.8);
    expect(precisionDetail(predictions, matches)).toEqual({
      value: 0.8,
      numerator: 8,
      denominator: 10,
    });
  });

  it('counts a duplicate of an already-credited item as a false positive', () => {
    const groundTruth = [gt(10, 'art-a')];
    const predictions: PredictedPendingItem[] = [pred(10, 'art-a'), pred(10, 'art-a')];
    const matches = matchPendingItems(groundTruth, predictions);
    // One label, so only one prediction can be credited; the other is surplus.
    expect(precision(predictions, matches)).toBe(0.5);
  });

  it('is 0 when everything surfaced was invented', () => {
    const predictions: PredictedPendingItem[] = [
      { description: 'invented obligation about quarterly widgets', citation: 'art-x' },
      { description: 'invented obligation about monthly gizmos', citation: 'art-y' },
    ];
    const matches = matchPendingItems([gt(20, 'art-real')], predictions);
    expect(precision(predictions, matches)).toBe(0);
  });

  it('is 1 on an empty denominator (nothing was surfaced, so nothing was false)', () => {
    expect(precision([], [])).toBe(1);
    expect(precisionDetail([], [])).toEqual({ value: 1, numerator: 0, denominator: 0 });
  });

  it('uses identity, so two textually identical predictions are counted separately', () => {
    const groundTruth = [gt(10, 'art-a'), gt(10, 'art-a')];
    const predictions: PredictedPendingItem[] = [pred(10, 'art-a'), pred(10, 'art-a')];
    const matches = matchPendingItems(groundTruth, predictions);
    expect(matches.filter(isSurfaced)).toHaveLength(2);
    expect(precision(predictions, matches)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// hallucinationRate — AC-5, the release gate
// ---------------------------------------------------------------------------

describe('hallucinationRate', () => {
  it('is exactly 0.2 when 2 of 10 claims have no supporting artifact', () => {
    const claims: PredictedClaim[] = [
      ...Array.from({ length: 8 }, (_u, i) => claim(`supported-${i}`, 1, 0)),
      claim('fabricated-a', 0, 1), // cited, but the citation does not support it
      claim('fabricated-b', 0, 0), // cited nothing at all
    ];
    expect(claims).toHaveLength(10);
    expect(hallucinationRate(claims)).toBe(0.2);
    expect(hallucinationRateDetail(claims)).toEqual({ value: 0.2, numerator: 2, denominator: 10 });
  });

  it('treats an uncited claim as hallucinated', () => {
    expect(isHallucinated({ text: 'no citations at all', citations: [] })).toBe(true);
  });

  it('treats a claim with one supporting citation among several as NOT hallucinated', () => {
    // Something did back it up. Whether the OTHER links go where they say is
    // citationAccuracy's question, not this one.
    const mixed = claim('partly-cited', 1, 2);
    expect(isHallucinated(mixed)).toBe(false);
    expect(hallucinationRate([mixed])).toBe(0);
  });

  it('is exactly 0 for 0 of 47 claims — the shape a passing AC-5 run has', () => {
    const claims = Array.from({ length: 47 }, (_u, i) => claim(`grounded-${i}`, 1, 0));
    expect(hallucinationRate(claims)).toBe(0);
    expect(hallucinationRateDetail(claims).denominator).toBe(47);
  });

  it('is 1 when every claim is unsupported', () => {
    expect(hallucinationRate([claim('a', 0, 1), claim('b', 0, 0)])).toBe(1);
  });

  it('is 0 on an empty denominator (the one metric where low is good)', () => {
    expect(hallucinationRate([])).toBe(0);
    expect(hallucinationRateDetail([])).toEqual({ value: 0, numerator: 0, denominator: 0 });
  });
});

// ---------------------------------------------------------------------------
// citationAccuracy — AC-6
// ---------------------------------------------------------------------------

describe('citationAccuracy', () => {
  it('is exactly 0.9 when 18 of 20 citations support their claim', () => {
    // 6 claims × 3 citations = 18 supporting, plus 1 claim × 2 wrong = 20 total.
    const claims: PredictedClaim[] = [
      ...Array.from({ length: 6 }, (_u, i) => claim(`ok-${i}`, 3, 0)),
      claim('two-bad-links', 0, 2),
    ];
    const detail = citationAccuracyDetail(claims);
    expect(detail).toEqual({ value: 0.9, numerator: 18, denominator: 20 });
    expect(citationAccuracy(claims)).toBe(0.9);
  });

  it('is per-citation, not per-claim', () => {
    // One claim, 1 good and 2 bad citations → 1/3, not 0 and not 1.
    const claims = [claim('mixed', 1, 2)];
    expect(citationAccuracy(claims)).toBeCloseTo(1 / 3, 12);
    expect(citationAccuracyDetail(claims).denominator).toBe(3);
  });

  it('ignores uncited claims entirely — they have no citations to be wrong', () => {
    const claims: PredictedClaim[] = [claim('cited', 1, 0), { text: 'uncited', citations: [] }];
    expect(citationAccuracyDetail(claims)).toEqual({ value: 1, numerator: 1, denominator: 1 });
    // …but the uncited claim IS a hallucination, and that is where it is counted.
    expect(hallucinationRate(claims)).toBe(0.5);
  });

  it('is 1 on an empty denominator (no citations were made, so none were wrong)', () => {
    expect(citationAccuracy([])).toBe(1);
    expect(citationAccuracyDetail([])).toEqual({ value: 1, numerator: 0, denominator: 0 });
  });
});

// ---------------------------------------------------------------------------
// top3Relevance — AC-7
// ---------------------------------------------------------------------------

describe('top3Relevance', () => {
  /** A case whose relevant item sits at rank `position` (0-based). */
  function caseWithRelevantAt(id: string, position: number, ranked: number): EvalCase {
    const label = gt(12, 'art-relevant');
    const rankedItems: PredictedPendingItem[] = Array.from({ length: ranked }, (_u, index) =>
      index === position
        ? { description: label.description, citation: 'art-relevant' }
        : { description: `irrelevant filler bullet number ${index} about unrelated matters`, citation: `art-noise-${index}` },
    );
    return { id, rankedItems, groundTruth: [label] };
  }

  it('is exactly 0.75 when 3 of 4 scoreable cases have a relevant item in the top 3', () => {
    const cases: EvalCase[] = [
      caseWithRelevantAt('rank-1', 0, 6),
      caseWithRelevantAt('rank-2', 1, 6),
      caseWithRelevantAt('rank-3', 2, 6),
      // Rank 4 — present, but buried below the fold. This is `poor_ranking`.
      caseWithRelevantAt('rank-4', 3, 6),
    ];
    expect(top3Relevance(cases)).toBe(0.75);
    expect(top3RelevanceDetail(cases)).toEqual({
      value: 0.75,
      numerator: 3,
      denominator: 4,
      skipped: 0,
    });
  });

  it('looks at exactly the first three ranked items', () => {
    expect(TOP_N).toBe(3);
    expect(top3Relevance([caseWithRelevantAt('at-3', 2, 4)])).toBe(1);
    expect(top3Relevance([caseWithRelevantAt('at-4', 3, 4)])).toBe(0);
  });

  it('counts a top-3 bullet with the WRONG citation as NOT relevant', () => {
    // The strict-citation rule reaches AC-7 too: a plausible bullet in slot one
    // that points at the wrong message has not put relevant content on screen.
    const label = gt(12, 'art-right');
    const evalCase: EvalCase = {
      id: 'wrong-citation-at-top',
      rankedItems: [{ description: label.description, citation: 'art-wrong' }],
      groundTruth: [label],
    };
    expect(top3Relevance([evalCase])).toBe(0);
  });

  it('excludes (and counts) cases with no ground-truth items rather than scoring them', () => {
    const cases: EvalCase[] = [
      caseWithRelevantAt('scoreable', 0, 3),
      { id: 'expect-no-pending', rankedItems: [], groundTruth: [] },
      { id: 'expect-no-pending-2', rankedItems: [], groundTruth: [] },
    ];
    const detail = top3RelevanceDetail(cases);
    // 1 of 1 SCOREABLE case, with 2 excluded — not 1 of 3, and not 3 of 3.
    expect(detail).toEqual({ value: 1, numerator: 1, denominator: 1, skipped: 2 });
  });

  it('is 1 on an empty denominator', () => {
    expect(top3Relevance([])).toBe(1);
  });

  it('honours a per-case citation equivalence', () => {
    const label = gt(12, 'msg-2');
    const coverage = new Map([['thread-artifact', new Set(['msg-1', 'msg-2'])]]);
    const evalCase: EvalCase = {
      id: 'thread-granular',
      rankedItems: [{ description: label.description, citation: 'thread-artifact' }],
      groundTruth: [label],
      citationMatches: (predicted, groundTruth) =>
        predicted !== null && coverage.get(predicted)?.has(groundTruth) === true,
    };
    expect(top3Relevance([evalCase])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RO-2 — n is mandatory
// ---------------------------------------------------------------------------

describe('buildReport — RO-2', () => {
  /** A complete report body, minus `n`. */
  const body: Omit<EvalReport, 'n'> = {
    recall: 0.9,
    precision: 0.8,
    hallucinationRate: 0.01,
    citationAccuracy: 0.97,
    top3Relevance: 0.85,
    generatedAt: 1_776_000_000_000,
  };

  it('THROWS when n is missing', () => {
    // RO-2's enforcement point. "92% recall on 12 examples is not a 92% recall",
    // and the only way to guarantee that is to make the number unable to travel
    // without its denominator.
    expect(() => buildReport({ ...body })).toThrowError(
      /n \(eval-set size\) is required — RO-2/,
    );
  });

  it('THROWS when n is explicitly undefined', () => {
    expect(() => buildReport({ ...body, n: undefined })).toThrowError(/RO-2/);
  });

  it('accepts n = 0 — an empty eval set is honest, an unstated size is not', () => {
    // 0 is a legitimate sample size to REPORT. It must not be conflated with
    // "absent" by a falsy check, which is the bug this test exists to prevent.
    expect(buildReport({ ...body, n: 0 }).n).toBe(0);
  });

  it('returns the report with n set when it is supplied', () => {
    const report = buildReport({ ...body, n: 5 });
    expect(report.n).toBe(5);
    expect(report.recall).toBe(0.9);
    expect(report.generatedAt).toBe(1_776_000_000_000);
  });
});

describe('report rendering', () => {
  const report = buildReport({
    n: 5,
    recall: 0.9,
    precision: 0.8,
    hallucinationRate: 0.0,
    citationAccuracy: 1,
    top3Relevance: 0.75,
    counts: {
      recall: { value: 0.9, numerator: 9, denominator: 10 },
      precision: { value: 0.8, numerator: 8, denominator: 10 },
      hallucinationRate: { value: 0, numerator: 0, denominator: 12 },
      citationAccuracy: { value: 1, numerator: 12, denominator: 12 },
      top3Relevance: { value: 0.75, numerator: 3, denominator: 4 },
      top3Skipped: 1,
    },
    generatedAt: 1_776_000_000_000,
  });

  it('states n in the headline, next to every metric', () => {
    expect(renderHeadline(report)).toContain('n=5 examples');
    expect(renderHeadline(report)).toContain('recall 90.0%');
  });

  it('states n and every per-metric denominator in the markdown', () => {
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('**Eval-set size: n = 5 labeled examples.**');
    expect(markdown).toContain('9/10 items');
    expect(markdown).toContain('8/10 items');
    expect(markdown).toContain('0/12 claims');
    expect(markdown).toContain('12/12 citations');
    expect(markdown).toContain('3/4 cases');
  });

  it('discloses the AC-7 exclusions rather than hiding them', () => {
    expect(renderMarkdown(report)).toContain('1 example(s) are excluded from the AC-7 denominator');
  });

  it('labels a SUBSET run so its numbers cannot be quoted as the set (RO-2)', () => {
    const subset = buildReport({
      n: 5,
      available: 30,
      selectedFixtureIds: ['eng-mgr-vacation-01', 'injection-01'],
      recall: 0.8,
      precision: 0.8,
      hallucinationRate: 0,
      citationAccuracy: 1,
      top3Relevance: 1,
      generatedAt: 1_776_000_000_000,
    });
    expect(renderHeadline(subset)).toContain('n=5 of 30 examples (SUBSET)');
    const markdown = renderMarkdown(subset);
    expect(markdown).toContain('n = 5 labeled examples, selected from 30 available');
    expect(markdown).toContain('**This is a SUBSET run');
    expect(markdown).toContain('25 labeled example(s) in');
    expect(markdown).toContain('`eng-mgr-vacation-01`');
  });

  it('does not add a subset banner when the whole set was run', () => {
    const full = buildReport({
      n: 30,
      available: 30,
      recall: 1,
      precision: 1,
      hallucinationRate: 0,
      citationAccuracy: 1,
      top3Relevance: 1,
      generatedAt: 1_776_000_000_000,
    });
    expect(renderHeadline(full)).toContain('n=30 examples');
    expect(renderHeadline(full)).not.toContain('SUBSET');
    expect(renderMarkdown(full)).not.toContain('SUBSET run');
  });

  it('grades each criterion against its target', () => {
    const markdown = renderMarkdown(report);
    // recall 90% ≥ 90% → PASS; top-3 75% < 80% → FAIL.
    expect(markdown).toMatch(/AC-3 \| Pending-item recall \| 90\.0% \|.*\| PASS \|/);
    expect(markdown).toMatch(/AC-7 \| Top-3 relevance \| 75\.0% \|.*\| FAIL \|/);
  });
});
