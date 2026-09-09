/**
 * Deterministic project detection for a briefing row — the auto half of the
 * per-claim label (migrations 010/011).
 *
 * ## Why this is not a model call
 *
 * The obvious implementation is "ask Layer 1 which project this belongs to".
 * On this project's own measured hardware a single Layer 1 call runs 70-130s
 * (see `ollama.ts`'s header and `MAX_BATCH_EVENTS`), and a briefing renders
 * many rows at once. A suggestion the user waits minutes for is not a
 * suggestion, it is a second pipeline. Name matching answers the same question
 * in microseconds, and — unlike a model — can explain itself: every suggestion
 * here is "your project's name appears, in full, in the source text".
 *
 * ## Why it abstains so eagerly
 *
 * X-2 permits inference that SUGGESTS and forbids inference that DECIDES:
 * `suggestProjects.ts` (assisted onboarding) is the precedent — "a suggestion
 * list, never a decision". A wrong label is worse than no label here, because
 * the user's own filing is the thing this feature exists to preserve. So the
 * rule is deliberately strict:
 *
 *   - the project's WHOLE name must appear as a phrase, on word boundaries
 *   - ties abstain: two projects matching means the text is about both, or
 *     about neither, and picking one would be a coin flip wearing a label
 *   - no substring, stem, synonym or fuzzy matching
 *
 * That last exclusion is what keeps short names safe. This user has projects
 * named `Q1`, `Q2` and `Q3 migration`; substring matching would fire `Q1` on
 * "SQ1", "q10" and every UUID fragment containing `q1`, and a stemmer would
 * collapse `Q3 migration` into `Q1`'s neighbourhood. Word-boundary phrase
 * matching fires `Q1` on "the Q1 numbers" and nothing else, and an email
 * discussing both quarters matches two projects and is therefore left blank —
 * which is the honest answer.
 *
 * The cost is recall: a thread that is obviously about a project but never
 * writes its name earns no suggestion. That is the intended trade. The user
 * fills those in themselves, which is exactly the workflow the dropdown
 * already supports.
 */

/** A declared project, narrowed to what matching reads. */
export interface MatchableProject {
  projectId: string;
  name: string;
}

/**
 * Characters that separate words for matching purposes: everything that is not
 * a letter or a digit. Deliberately Unicode-aware (`\p{L}`/`\p{N}`) rather than
 * `\w`, so a project named `Café` or `日次レポート` behaves like any other.
 */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * Fold text to space-separated lowercase words.
 *
 * Both the haystack and each project name go through this, so matching compares
 * like with like: `"Q3-migration!"` and `"Q3 Migration"` both become
 * `"q3 migration"`, and the phrase check below is then a plain, predictable
 * substring test on a normalized string with guaranteed word boundaries.
 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(NON_WORD, ' ').trim();
}

/**
 * True when `phrase` occurs in `haystack` as a whole word sequence.
 *
 * Both arguments must already be normalized. Padding both sides with a space
 * turns "is this on a word boundary" into a substring test that cannot match
 * mid-word: `" q1 "` is not inside `" sq1 numbers "`, but is inside
 * `" the q1 numbers "`.
 */
export function containsPhrase(haystack: string, phrase: string): boolean {
  if (phrase === '') return false;
  return ` ${haystack} `.includes(` ${phrase} `);
}

/** A suggestion, with the evidence that produced it. */
export interface ProjectMatch {
  projectId: string;
  /** The project name as matched, for the UI to explain the suggestion with. */
  name: string;
}

/**
 * The one project whose name appears in `text`, or `null` when that is not
 * exactly one.
 *
 * `null` covers three genuinely different situations on purpose — no project
 * named, several named, or no projects declared at all. All three mean the same
 * thing to the caller ("leave it blank, the user decides"), and inventing a
 * distinction the UI would render identically is not worth the wire format.
 *
 * Projects whose name normalizes to nothing (punctuation only) are skipped
 * rather than matched: an empty phrase would otherwise match every text.
 */
export function detectProject(
  text: string,
  projects: ReadonlyArray<MatchableProject>,
): ProjectMatch | null {
  const haystack = normalizeForMatch(text);
  if (haystack === '') return null;

  const hits: ProjectMatch[] = [];
  for (const project of projects) {
    const phrase = normalizeForMatch(project.name);
    if (phrase === '') continue;
    if (containsPhrase(haystack, phrase)) hits.push({ projectId: project.projectId, name: project.name });
  }

  // Two rows for the same project (a duplicate declaration — `projects.name`
  // has no UNIQUE constraint, see `GraphRepo`) is not a tie; the user just
  // declared the same thing twice. Collapse before deciding ambiguity, and
  // take the first, which `listProjects()` orders as the oldest declaration.
  const distinct = new Map(hits.map((hit) => [hit.projectId, hit]));
  if (distinct.size !== 1) return null;

  return [...distinct.values()][0] ?? null;
}
