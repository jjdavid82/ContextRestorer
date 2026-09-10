/**
 * The channel→project tag, read from the graph — one implementation, shared.
 *
 * `belongs_to` edges are materialised by `rebuildProjectLinks` from the project
 * each Slack channel was tagged with in onboarding or Settings. Three callers
 * need to resolve one for an artifact, and they live in modules that already
 * depend on each other in one direction:
 *
 *   - `briefing.ts` labels each claim and obligation with the project name;
 *   - `claim.ts` uses the tag as the strongest input to project detection;
 *   - the renderer filters a briefing by project.
 *
 * `briefing.ts` imports `claim.ts` (for `resolveEvents`/`deepLinkFor`), so
 * putting this in either one and importing it from the other would close an
 * import cycle. It lives here instead, below both.
 */

/**
 * The slice of `GraphRepo` a project tag is resolved through.
 *
 * `name` is optional so every existing test double — which only ever needed
 * the weight — still satisfies this interface. A `GraphRepo` returns a full
 * `Project` and therefore always carries it; a double that omits it simply
 * yields no project label, which the renderer already has to handle for the
 * untagged case.
 */
export interface StakesReader {
  relatedIds(fromId: string, rel: string): string[];
  getProject(projectId: string): { stakesWeight: number; name?: string } | undefined;
}

/** The graph edge linking an artifact to the project it belongs to. */
export const PROJECT_REL = 'belongs_to';

/**
 * The project an artifact belongs to, identified as well as named.
 *
 * Picks the HIGHEST-stakes project when an artifact belongs to several, which
 * is deliberately the same rule `stakesWeightFor` applies. The label has to
 * name the project that actually moved this item up the list; showing a
 * different one would be worse than showing none.
 *
 * The `projectId` is what makes the tag usable as more than decoration. A tag
 * is a decision the user actually made (per channel, in onboarding or
 * Settings), so it is the strongest project signal available for a claim they
 * have not filed by hand — stronger than the name match in `projectMatch.ts`,
 * which is an inference. Two callers need to compare it against a
 * `projects.project_id` rather than render it: the per-claim suggestion and the
 * briefing's project filter. Both had only a display string before, so neither
 * could.
 *
 * `undefined` for an untagged artifact — the ordinary case, not a defect.
 */
export function projectForArtifact(
  graph: StakesReader | undefined,
  artifactId: string | null,
): { projectId: string; name: string } | undefined {
  if (graph === undefined || artifactId === null) return undefined;

  let best: { weight: number; projectId: string; name: string } | undefined;
  for (const projectId of graph.relatedIds(artifactId, PROJECT_REL)) {
    const project = graph.getProject(projectId);
    const name = project?.name?.trim();
    if (project === undefined || name === undefined || name === '') continue;
    const weight = Number.isFinite(project.stakesWeight) ? project.stakesWeight : 0;
    if (best === undefined || weight > best.weight) best = { weight, projectId, name };
  }
  return best === undefined ? undefined : { projectId: best.projectId, name: best.name };
}
