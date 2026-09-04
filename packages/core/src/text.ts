/**
 * Content-token utilities shared by the runtime citation gate and the offline
 * eval harness.
 *
 * These live in `@cr/core` for one reason: **the two must not diverge.**
 * `@cr/eval` measures AC-5 (hallucination rate) by asking whether a cited
 * artifact's text supports a claim; `@cr/ai`'s citation gate now asks the same
 * question at generation time, to drop the claim rather than merely count it
 * afterwards (F-4). If those two used separate tokenizers or separate
 * thresholds, the metric would stop describing the thing that shipped — the
 * eval would be scoring a different function from the one running in the app.
 *
 * `@cr/eval` depends on `@cr/ai`, so the shared code cannot live in either;
 * `@cr/core` is the only package both already depend on.
 */

/**
 * Words carrying no discriminating signal about *what* a claim asserts.
 *
 * Kept deliberately small: function words plus the handful of verbs that appear
 * in essentially every obligation ("need", "please"), and nothing
 * domain-specific. A large stopword list would start deciding what a claim is
 * *about*, which is the check's job to measure, not to assume.
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
 * can be the entire distinction between a claim and its reversal, and a
 * three-character floor would erase it.
 *
 * A set, not a bag: repeating a word does not make a claim more grounded.
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
 * Symmetric, and monotone in both token precision and token recall, so one
 * threshold governs both directions of error. Returns 0 when either side has no
 * content tokens — an empty description matches nothing, including another
 * empty one.
 */
export function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return (2 * intersectionSize(a, b)) / (a.size + b.size);
}

/**
 * Fraction of `needle`'s tokens that appear in `haystack`.
 *
 * Asymmetric on purpose: this answers "is everything this sentence says present
 * in that source text?", which is the GROUNDING question, not the similarity
 * question. A claim that adds a fact the source never mentions scores below 1
 * however well the rest matches — which is exactly the fabrication shape AC-5
 * measures and F-4 drops.
 *
 * Returns 0 for an empty needle: a claim with no content tokens asserts nothing
 * checkable, and calling that "fully grounded" would let a stopword-only
 * sentence through unexamined.
 */
export function containment(needle: ReadonlySet<string>, haystack: ReadonlySet<string>): number {
  if (needle.size === 0) return 0;
  return intersectionSize(needle, haystack) / needle.size;
}
