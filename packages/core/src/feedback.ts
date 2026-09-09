/**
 * The identity a user verdict (FR-12) is recorded against.
 *
 * `briefing:chunk` puts no `briefing_claims.claim_id` on the wire, so the
 * renderer can only identify a claim by its citation artifact id plus the claim
 * sentence itself. The artifact id alone is too coarse: one thread's artifact
 * backs a *different* claim in every briefing it recurs in ("reply to Sarah"
 * one week, "Sarah escalated" the next), so an artifact-scoped "not relevant"
 * would silently bury every later, differently-worded claim about that thread.
 * Pairing the artifact id with the exact sentence scopes a verdict to the claim
 * it was actually given on.
 *
 * U+001F (ASCII unit separator) cannot occur in an artifact id and is not
 * produced in model-authored claim text, so splitting the key back apart is
 * unambiguous. The store's `FeedbackRepo.listLabeled` reproduces this join
 * expression with `|| char(31) ||`.
 */
export const FEEDBACK_CLAIM_KEY_SEP = String.fromCharCode(31);

/** Compose the {@link FEEDBACK_CLAIM_KEY_SEP}-joined verdict key. */
export function feedbackClaimKey(artifactId: string, claimText: string): string {
  return `${artifactId}${FEEDBACK_CLAIM_KEY_SEP}${claimText}`;
}

/**
 * Split a key made by {@link feedbackClaimKey} back into its parts, or `null`
 * when `key` carries no separator (a briefing-level verdict, or a value written
 * before verdicts were claim-scoped).
 */
export function parseFeedbackClaimKey(
  key: string | null | undefined,
): { artifactId: string; claimText: string } | null {
  if (key === null || key === undefined) return null;
  const at = key.indexOf(FEEDBACK_CLAIM_KEY_SEP);
  if (at < 0) return null;
  return { artifactId: key.slice(0, at), claimText: key.slice(at + 1) };
}
