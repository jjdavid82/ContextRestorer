/**
 * Eval metrics (Task 5.1) — the five numbers AC-3…AC-7 are graded against.
 *
 * Everything in this module is a **pure function over already-collected
 * results**. Nothing here opens a database, calls a model, or reads a fixture:
 * that is `harness.ts`'s job. The split is deliberate and load-bearing —
 * `test/metrics.test.ts` grades the arithmetic against hand-computed values with
 * no Ollama anywhere near it, which is the only way a metric bug can be told
 * apart from a model regression.
 *
 * ---------------------------------------------------------------------------
 * THE MATCHING RULE (design §10, Task 5.1)
 *
 * Matching a *predicted* pending item to a *ground-truth* one is:
 *
 *   - **FUZZY on `description`.** A real model will not phrase an obligation the
 *     way a human labeler did, so exact string equality would report 0% recall
 *     on a system that works. See {@link descriptionSimilarity}.
 *   - **STRICT on `citation`.** A right-sounding item carrying the WRONG
 *     artifact id is *not* a match. It counts as:
 *       · a **miss** for {@link recall} — the ground-truth item was never
 *         actually surfaced, only something that resembled it; and
 *       · a **citation error** — the item points the user at a message that does
 *         not support it, which is the AC-6 failure `wrong_citation` names.
 *     It is emphatically NOT a pass. `pm-wrong-citation-01.json` exists to catch
 *     exactly this, and `metrics.test.ts` asserts it directly.
 *
 * That asymmetry is why {@link MatchedItem} keeps `predicted` and
 * `citationCorrect` as two separate fields rather than collapsing a
 * wrong-citation pair to `predicted: null`. A wrong-citation miss and a
 * never-surfaced miss are both misses, but only the first one is evidence about
 * *citation* quality, and a report that could not tell them apart would hide the
 * single most actionable failure mode in the set.
 * ---------------------------------------------------------------------------
 *
 * ### Empty denominators
 *
 * Every metric returns a {@link MetricDetail} carrying its raw numerator and
 * denominator, and the aggregate report publishes both. That matters because of
 * the vacuous cases: a fixture labeled `expect_no_pending` contributes zero
 * ground-truth items, so its recall denominator is 0. The convention is:
 *
 *   - "higher is better" metrics (recall, precision, citation accuracy, top-3)
 *     return **1** on an empty denominator — nothing was missed and nothing
 *     false was surfaced;
 *   - the one "lower is better" metric ({@link hallucinationRate}) returns **0**.
 *
 * A bare `1.0` from an empty denominator is meaningless, which is precisely why
 * RO-2 forces the sample size to travel with the number. The harness pools raw
 * counts across fixtures rather than averaging per-fixture ratios, so a
 * zero-denominator fixture contributes nothing to the aggregate instead of
 * contributing a free 1.0.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One labeled obligation: what a correct system must surface, and from where. */
export interface GroundTruthPendingItem {
  /** Plain-language statement of what is owed. Matched fuzzily. */
  description: string;
  /** `artifact_id` of the message that proves it. Matched strictly. */
  citation: string;
}

/** One obligation the system under test actually produced. */
export interface PredictedPendingItem {
  /** The description the system wrote. */
  description: string;
  /**
   * The artifact the system cited, or `null` when it cited nothing.
   *
   * `null` can never be citation-correct: an uncited obligation is untraceable,
   * which is the failure `pending_items.citation_artifact_id`'s NOT NULL
   * constraint exists to prevent in the first place.
   */
  citation: string | null;
}

/**
 * The result of pairing one ground-truth item against the predictions.
 *
 * Exactly one of three states, and they must not be conflated:
 *
 * | `predicted` | `citationCorrect` | meaning                                   |
 * |-------------|-------------------|-------------------------------------------|
 * | non-null    | `true`            | genuinely surfaced — counts toward recall |
 * | non-null    | `false`           | **wrong citation**: a miss AND a citation error |
 * | `null`      | `false`           | never surfaced at all — a plain miss      |
 */
export interface MatchedItem {
  groundTruth: GroundTruthPendingItem;
  /**
   * The prediction whose description matched, or `null` when nothing did.
   *
   * Non-null with `citationCorrect: false` is the wrong-citation case. It is
   * retained (rather than nulled) so a report can say "we found it and cited the
   * wrong message" instead of the much less useful "we missed it".
   */
  predicted: PredictedPendingItem | null;
  /** True only when `predicted` is non-null AND its citation is the right one. */
  citationCorrect: boolean;
}

/** One citation attached to a generated claim, with its support verdict. */
export interface PredictedCitation {
  artifactId: string;
  /**
   * Does the cited artifact ACTUALLY support the claim?
   *
   * Supplied by the caller, because answering it requires the fixture's labels
   * and the artifact's source text — neither of which this module knows about.
   * See `harness.ts`'s `classifyClaim` for how the eval harness decides it.
   */
  supportsClaim: boolean;
}

/**
 * One claim from a generated briefing.
 *
 * The citations carry their own verdicts rather than living in a parallel
 * boolean array: a positional array can fall out of alignment with the ids it
 * describes, and a misaligned citation verdict is a silently wrong metric.
 */
export interface PredictedClaim {
  text: string;
  /** Every artifact the claim cited. Empty means the claim cited nothing. */
  citations: PredictedCitation[];
}

/**
 * One labeled case for the AC-7 top-3 ranking check.
 *
 * `rankedItems` is in the order the briefing PRESENTED them, best first — the
 * ranking the user actually sees, not the ranker's internal score order.
 */
export interface EvalCase {
  id: string;
  /** Items as ranked and shown, most important first. */
  rankedItems: PredictedPendingItem[];
  /** The labeled correct answer for this case. */
  groundTruth: GroundTruthPendingItem[];
  /**
   * Per-case citation equivalence, when this case needs one (see
   * {@link MatchOptions.citationMatches}). Fixtures resolve citations against
   * their own artifact model, so the rule is per case, not global.
   */
  citationMatches?: CitationEquivalence;
}

/** A metric plus the counts it was computed from. RO-2 in type form. */
export interface MetricDetail {
  /** `numerator / denominator`, or the documented empty-denominator value. */
  value: number;
  numerator: number;
  denominator: number;
}

/**
 * Decides whether a predicted citation counts as the ground-truth one.
 *
 * Injectable because "the same artifact" is not always string equality. The eval
 * harness supplies a resolver that maps the pipeline's *thread*-granular
 * artifact ids back onto the fixture's *message*-granular ones — see
 * `harness.ts`. The default ({@link strictCitationMatch}) is plain equality, so
 * the fuzzy/strict asymmetry is never accidentally loosened.
 */
export type CitationEquivalence = (predicted: string | null, groundTruth: string) => boolean;

/** Options for {@link matchPendingItems}. */
export interface MatchOptions {
  /** Description-similarity floor. Defaults to {@link DESCRIPTION_MATCH_THRESHOLD}. */
  threshold?: number;
  /** Citation comparison. Defaults to {@link strictCitationMatch}. */
  citationMatches?: CitationEquivalence;
}

// ---------------------------------------------------------------------------
// Fuzzy description matching
// ---------------------------------------------------------------------------

/**
 * Words carrying no discriminating signal about *which* obligation this is.
 *
 * Kept deliberately small: it covers function words and the handful of verbs
 * that appear in essentially every obligation ("need", "please"), and nothing
 * domain-specific. A large stopword list would start deciding what an
 * obligation is *about*, which is the metric's job to measure, not to assume.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'back',
  'be', 'because', 'been', 'before', 'being', 'but', 'by', 'can', 'cannot', 'could', 'did',
  'do', 'does', 'doing', 'done', 'for', 'from', 'get', 'gets', 'give', 'got', 'had', 'has',
  'have', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'just', 'me', 'more', 'most', 'must', 'my', 'need', 'needed', 'needs', 'no',
  'not', 'now', 'of', 'on', 'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own',
  'please', 'said', 'same', 'says', 'she', 'should', 'since', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'until', 'up', 'us', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/**
 * Content tokens of `text`, as a set.
 *
 * Lowercased, split on every non-alphanumeric run, single characters and
 * stopwords dropped. Two-character tokens are KEPT on purpose — `v2` and `v3`
 * are the entire distinction in `injection-01.json`, and a three-character floor
 * would erase it.
 *
 * A set, not a bag: repeating a word does not make an obligation more similar to
 * another one that repeats it.
 */
export function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

/** Size of `a ∩ b`. */
function intersectionSize(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  // Iterate the smaller set: the cost is |min|, not |a|.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared += 1;
  return shared;
}

/**
 * Sørensen–Dice coefficient over two token sets: `2|A∩B| / (|A|+|B|)`.
 *
 * Dice rather than Jaccard, and rather than a containment coefficient, because
 * the two failure modes here pull in opposite directions:
 *
 *  - **Jaccard is too harsh on length asymmetry.** A labeled ground-truth
 *    description is a long, careful sentence; a model's is short. A perfectly
 *    correct 10-token prediction against a 20-token label with 6 tokens shared
 *    scores Jaccard 6/24 = 0.25 — indistinguishable from noise.
 *  - **Containment (`|A∩B| / min(|A|,|B|)`) is too lenient.** A two-token
 *    prediction that happens to be a subset of the label scores 1.0.
 *
 * Dice sits between them: the same 10-vs-20-token pair scores 12/30 = 0.40,
 * while the two-token subset scores 4/22 = 0.18. It is symmetric, standard, and
 * monotone in both token precision and token recall, so one threshold governs
 * both directions of error.
 *
 * Returns 0 when either side has no content tokens — an empty description
 * matches nothing, including another empty one.
 */
export function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return (2 * intersectionSize(a, b)) / (a.size + b.size);
}

/**
 * Fraction of `needle`'s tokens that appear in `haystack`.
 *
 * Asymmetric on purpose: this answers "is everything this sentence says present
 * in that source text?", which is the grounding question, not the similarity
 * question. Used by the harness to decide whether a cited artifact supports a
 * claim; exported here so the two live next to the tokenizer they share.
 */
export function containment(needle: ReadonlySet<string>, haystack: ReadonlySet<string>): number {
  if (needle.size === 0) return 0;
  return intersectionSize(needle, haystack) / needle.size;
}

/**
 * Dice similarity of two descriptions' content-token sets, in `[0, 1]`.
 *
 * This is the ONLY fuzziness in the matching rule. Citations are never fuzzy.
 */
export function descriptionSimilarity(a: string, b: string): number {
  return dice(contentTokens(a), contentTokens(b));
}

/**
 * Similarity at or above which two descriptions are considered the same
 * obligation.
 *
 * **0.30.** Calibrated against the committed fixtures rather than guessed:
 *
 *  - A faithful but tersely-reworded prediction of `eng-mgr-vacation-01`'s
 *    obligation ("Provide a yes/no on whether to hold the queue-migration
 *    cutover for the audit freeze", 10 content tokens) shares 6 tokens with the
 *    20-token label → Dice 0.40. **Matches**, as it must.
 *  - A generic near-miss ("Approve the pricing sheet", 3 tokens) against
 *    `pm-wrong-citation-01`'s 13-token label shares 1 token → Dice 0.125. **Does
 *    not match**, as it must not.
 *
 * 0.30 sits with clear air on both sides of that gap. It is a threshold on a
 * heuristic, not a law: it is exported so a caller can vary it, and every report
 * states the value that produced its numbers.
 */
export const DESCRIPTION_MATCH_THRESHOLD = 0.3;

/** True when two descriptions clear {@link DESCRIPTION_MATCH_THRESHOLD}. */
export function descriptionsMatch(
  a: string,
  b: string,
  threshold: number = DESCRIPTION_MATCH_THRESHOLD,
): boolean {
  return descriptionSimilarity(a, b) >= threshold;
}

/**
 * The default citation rule: exact string equality, and `null` never matches.
 *
 * Strict, with no normalization whatsoever. Trimming or case-folding artifact
 * ids would be the first step down a road that ends with "close enough"
 * citations, and a citation that is close enough points the user at the wrong
 * message.
 */
export const strictCitationMatch: CitationEquivalence = (predicted, groundTruth) =>
  predicted !== null && predicted === groundTruth;

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** A ground-truth/prediction pair that cleared the description threshold. */
interface Candidate {
  groundTruthIndex: number;
  predictionIndex: number;
  similarity: number;
  citationCorrect: boolean;
}

/**
 * Pair each ground-truth item with at most one prediction.
 *
 * Greedy best-first over every pair that clears the description threshold, with
 * candidates ordered by:
 *
 *   1. **citation-correct first.** Two predictions may describe the same
 *      obligation — one citing the right message, one citing a distractor (which
 *      is precisely the `pm-wrong-citation-01` scenario, and precisely what a
 *      chatty model produces). Preferring the correct citation means a duplicate
 *      cannot steal the slot and turn a genuine hit into a reported miss. The
 *      *harsh* reading is not the accurate one here: we are measuring whether
 *      the system surfaced the obligation with the right provenance, and it did.
 *   2. then descending description similarity;
 *   3. then index order, so the pairing is total and reproducible.
 *
 * One-to-one: a prediction is consumed by the first ground-truth item it wins,
 * so two labels cannot both be credited to a single output line.
 *
 * @returns one {@link MatchedItem} per ground-truth item, in label order.
 *   Predictions that won no pairing are false positives; {@link precision} finds
 *   them by identity against the array the caller passed in.
 */
export function matchPendingItems(
  groundTruth: readonly GroundTruthPendingItem[],
  predictions: readonly PredictedPendingItem[],
  options: MatchOptions = {},
): MatchedItem[] {
  const threshold = options.threshold ?? DESCRIPTION_MATCH_THRESHOLD;
  const citationMatches = options.citationMatches ?? strictCitationMatch;

  const labels = groundTruth.map((item) => ({ item, tokens: contentTokens(item.description) }));
  const outputs = predictions.map((item) => ({ item, tokens: contentTokens(item.description) }));

  const candidates: Candidate[] = [];
  labels.forEach((label, groundTruthIndex) => {
    outputs.forEach((output, predictionIndex) => {
      const similarity = dice(label.tokens, output.tokens);
      if (similarity < threshold) return;
      candidates.push({
        groundTruthIndex,
        predictionIndex,
        similarity,
        citationCorrect: citationMatches(output.item.citation, label.item.citation),
      });
    });
  });

  candidates.sort(
    (a, b) =>
      Number(b.citationCorrect) - Number(a.citationCorrect) ||
      b.similarity - a.similarity ||
      a.groundTruthIndex - b.groundTruthIndex ||
      a.predictionIndex - b.predictionIndex,
  );

  const usedLabels = new Set<number>();
  const usedOutputs = new Set<number>();
  const pairing = new Map<number, Candidate>();
  for (const candidate of candidates) {
    if (usedLabels.has(candidate.groundTruthIndex)) continue;
    if (usedOutputs.has(candidate.predictionIndex)) continue;
    usedLabels.add(candidate.groundTruthIndex);
    usedOutputs.add(candidate.predictionIndex);
    pairing.set(candidate.groundTruthIndex, candidate);
  }

  return labels.map((label, index) => {
    const candidate = pairing.get(index);
    const predicted = candidate === undefined ? undefined : outputs[candidate.predictionIndex];
    if (candidate === undefined || predicted === undefined) {
      return { groundTruth: label.item, predicted: null, citationCorrect: false };
    }
    return {
      groundTruth: label.item,
      predicted: predicted.item,
      citationCorrect: candidate.citationCorrect,
    };
  });
}

/**
 * True when a ground-truth item was genuinely surfaced: a description match AND
 * the right citation.
 *
 * This one predicate is what makes the strict-citation rule impossible to
 * bypass. Every metric that asks "did we get this item?" routes through it, so
 * a wrong-citation pair can never be counted as a hit by any of them.
 */
export function isSurfaced(match: MatchedItem): boolean {
  return match.predicted !== null && match.citationCorrect;
}

/**
 * True when a ground-truth item was *described* correctly but cited wrongly —
 * the AC-6 `wrong_citation` failure.
 *
 * Reported alongside the misses so a low recall can be attributed: "we never saw
 * it" and "we saw it and pointed at the wrong message" call for entirely
 * different fixes.
 */
export function isWrongCitation(match: MatchedItem): boolean {
  return match.predicted !== null && !match.citationCorrect;
}

/** `numerator / denominator`, with the documented empty-denominator value. */
function detail(numerator: number, denominator: number, whenEmpty: number): MetricDetail {
  return { value: denominator === 0 ? whenEmpty : numerator / denominator, numerator, denominator };
}

// ---------------------------------------------------------------------------
// The five metrics
// ---------------------------------------------------------------------------

/** {@link recall} plus its raw counts (RO-2). */
export function recallDetail(matches: readonly MatchedItem[]): MetricDetail {
  return detail(matches.filter(isSurfaced).length, matches.length, 1);
}

/**
 * AC-3 — pending-item recall: the fraction of ground-truth items the system
 * surfaced *at all*, with a correct citation.
 *
 * Denominator is the number of labeled items, i.e. `matches.length`. A
 * wrong-citation pair is a MISS here; see the module comment.
 */
export function recall(matches: MatchedItem[]): number {
  return recallDetail(matches).value;
}

/** {@link precision} plus its raw counts (RO-2). */
export function precisionDetail(
  predictions: readonly PredictedPendingItem[],
  matches: readonly MatchedItem[],
): MetricDetail {
  // Identity, not deep equality: two genuinely distinct predictions can carry
  // identical text, and structural comparison would credit both for one match.
  // `matches` holds references into `predictions`, which is what makes this work
  // — and what obliges the caller to pass the same array it matched against.
  const real = new Set<PredictedPendingItem>();
  for (const match of matches) {
    if (isSurfaced(match) && match.predicted !== null) real.add(match.predicted);
  }
  return detail(
    predictions.filter((prediction) => real.has(prediction)).length,
    predictions.length,
    1,
  );
}

/**
 * AC-4 — pending-item precision: the fraction of surfaced items that were real.
 *
 * A "real" surfaced item is one that won a citation-correct pairing with a
 * ground-truth item. Everything else the system emitted is a false positive:
 * an obligation that does not exist, a duplicate of one already counted, or a
 * right-sounding one attached to the wrong artifact.
 *
 * @param predictions - The exact array passed to {@link matchPendingItems}.
 * @param matches - Its output.
 */
export function precision(
  predictions: PredictedPendingItem[],
  matches: MatchedItem[],
): number {
  return precisionDetail(predictions, matches).value;
}

/**
 * True when NO citation on the claim supports it.
 *
 * A claim with zero citations is hallucinated by this definition, and that is
 * correct rather than pedantic: an uncited claim has no supporting artifact, so
 * the numerator's own words apply to it. (In the real pipeline such a claim is
 * dropped by the citation gate before it can reach a briefing, so it should
 * never appear — if one does, the harness has found something worth knowing.)
 */
export function isHallucinated(claim: PredictedClaim): boolean {
  return !claim.citations.some((citation) => citation.supportsClaim);
}

/** {@link hallucinationRate} plus its raw counts (RO-2). */
export function hallucinationRateDetail(claims: readonly PredictedClaim[]): MetricDetail {
  return detail(claims.filter(isHallucinated).length, claims.length, 0);
}

/**
 * AC-5 — hallucination rate: claims with NO supporting artifact ÷ total claims.
 *
 * The release gate (< 2%). Returns **0** rather than 1 on an empty denominator:
 * it is the one metric where lower is better, so the vacuous value must be the
 * good one for the same reason the others' is 1.
 */
export function hallucinationRate(claims: PredictedClaim[]): number {
  return hallucinationRateDetail(claims).value;
}

/** {@link citationAccuracy} plus its raw counts (RO-2). */
export function citationAccuracyDetail(claims: readonly PredictedClaim[]): MetricDetail {
  let supporting = 0;
  let total = 0;
  for (const claim of claims) {
    for (const citation of claim.citations) {
      total += 1;
      if (citation.supportsClaim) supporting += 1;
    }
  }
  return detail(supporting, total, 1);
}

/**
 * AC-6 — citation accuracy: citations whose artifact ACTUALLY supports the claim
 * ÷ total citations.
 *
 * Per-CITATION, not per-claim. A claim citing three artifacts of which one is
 * wrong contributes 2/3 here, while {@link hallucinationRate} counts it as
 * supported (something did back it up). The two questions are different: "is
 * this claim invented?" versus "does this link go where it says it does?".
 */
export function citationAccuracy(claims: PredictedClaim[]): number {
  return citationAccuracyDetail(claims).value;
}

/** How many of the ranked items the AC-7 check looks at. */
export const TOP_N = 3;

/** {@link top3Relevance} plus its counts, and the cases it could not score. */
export interface Top3Detail extends MetricDetail {
  /**
   * Cases excluded from the denominator because they have no ground-truth items
   * at all (`expect_no_pending`).
   *
   * "Do the top 3 contain a relevant item?" has no answer when no item is
   * relevant. Scoring such a case as a pass would inflate AC-7 with fixtures
   * that never tested ranking; scoring it as a failure would punish the correct
   * behaviour of surfacing nothing. It is excluded and counted, and the report
   * prints the count — a silent exclusion is a lie about the sample size (RO-2).
   */
  skipped: number;
}

/** {@link top3Relevance} plus its raw counts and exclusions (RO-2). */
export function top3RelevanceDetail(
  cases: readonly EvalCase[],
  options: MatchOptions = {},
): Top3Detail {
  let numerator = 0;
  let denominator = 0;
  let skipped = 0;

  for (const evalCase of cases) {
    if (evalCase.groundTruth.length === 0) {
      skipped += 1;
      continue;
    }
    denominator += 1;

    const top = evalCase.rankedItems.slice(0, TOP_N);
    const matches = matchPendingItems(evalCase.groundTruth, top, {
      ...options,
      // A per-case rule wins over the global one: each fixture resolves
      // citations against its own artifact model.
      ...(evalCase.citationMatches === undefined
        ? {}
        : { citationMatches: evalCase.citationMatches }),
    });
    if (matches.some(isSurfaced)) numerator += 1;
  }

  return { ...detail(numerator, denominator, 1), skipped };
}

/**
 * AC-7 — top-3 relevance: the fraction of cases whose top-3-ranked items contain
 * a relevant item.
 *
 * "Relevant" means the same thing it means everywhere else in this module: it
 * clears the fuzzy description threshold AND carries the right citation. A
 * plausible-looking bullet in slot one that cites the wrong message has not put
 * relevant content in front of the user.
 */
export function top3Relevance(cases: EvalCase[]): number {
  return top3RelevanceDetail(cases).value;
}
