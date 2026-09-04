/**
 * Channel → project → artifact linking (FR-5 / FR-8, A-2).
 *
 * This module is the write path that was missing under the entire stakes
 * ranker. `ranker.ts` scores `isDeclaredProject` at `wStakes` (3.0 — the
 * largest weight after obligation) and `retrieval.ts` multiplies chunk scores
 * by the project's `stakes_weight`; both answer the question by looking for a
 * `belongs_to` edge from an artifact to a project. No code ever created that
 * edge, so the answer was always "no" and FR-5 quietly degraded to recency plus
 * participation.
 *
 * The user states the mapping once per channel (`slack_selected_channels.project_id`,
 * migration 006). This module projects that statement onto the artifacts it
 * implies, in both directions in time:
 *
 * - **Backwards**, via {@link rebuildProjectLinks}: threads already ingested
 *   from a tagged channel get edges immediately. Without this, tagging a
 *   channel would only affect threads that arrive afterwards, and the first
 *   briefing after onboarding — the one the whole R-6 cold-start problem is
 *   about — would see none of it.
 * - **Forwards**, via {@link SlackChannelProjectResolver}: the ingestion
 *   pipeline links each new thread artifact as it is created.
 *
 * ### Why the edge, and not a lookup at read time
 *
 * Resolving "which project is this artifact's channel tagged with?" inside the
 * ranker would work, and would be wrong: it puts Slack-specific string surgery
 * (`threadKey` is `${channelId}:${ts}`) into a module whose entire contract is
 * that {@link import('@cr/ai').RankableDelta} is the complete scoring input. The
 * graph stays the single source of truth for "what belongs to what", and this
 * module is the only thing that writes that particular kind of edge.
 *
 * ### X-2
 *
 * Nothing here infers anything. A channel carries a project because the user
 * said so in Settings; an untagged channel earns nothing. There is no
 * clustering, no similarity, and no behavioural signal — which is what keeps a
 * feature that changes ranking inside the POC's stated bounds.
 */

import type { GraphRepo } from './repos/graph.js';
import type { SelectedSlackChannel } from './repos/slackChannels.js';

/** Edge kind joining an artifact to the project it belongs to. */
export const PROJECT_REL = 'belongs_to';

/** Slack thread keys are `${channelId}:${ts}` — the channel is a literal prefix. */
const SLACK_SOURCE = 'slack';

/** What one rebuild changed. Returned so a caller can report or log it. */
export interface ProjectLinkSummary {
  /** Edges created (or re-asserted) across every tagged channel. */
  linked: number;
  /** Stale edges removed because a channel was re-tagged or untagged. */
  unlinked: number;
  /** Channels that carried a tag and therefore contributed. */
  taggedChannels: number;
}

/**
 * The graph capability this module needs — a `Pick`, so a test can supply a
 * double and so the write surface is visible at a glance.
 */
export type ProjectLinkGraph = Pick<
  GraphRepo,
  'artifactIdsByExternalRefPrefix' | 'relatedIds' | 'relate' | 'unrelate' | 'getProject'
>;

/**
 * Rebuild every Slack artifact's `belongs_to` edge from the current channel
 * tags.
 *
 * Idempotent and total: it is safe to run on every settings save and on every
 * app start, and running it twice changes nothing the second time.
 *
 * **Stale edges are removed, not merely superseded.** An artifact linked to two
 * projects takes the HIGHEST stakes weight (`retrieval.stakesWeightFor`,
 * `toRankableDelta`), so leaving the previous project's edge in place after a
 * re-tag would let the answer the user just replaced keep outranking the one
 * they gave. Only edges this module is responsible for are touched: an artifact
 * belonging to a channel that is no longer tagged, or tagged differently, has
 * its `belongs_to` edges cleared and the current one re-asserted.
 *
 * A tag naming a project that no longer exists is treated as untagged rather
 * than as an error — the FK is `ON DELETE SET NULL`, so this covers only the
 * narrow window where a project was removed without the column being updated.
 */
export function rebuildProjectLinks(
  channels: readonly SelectedSlackChannel[],
  graph: ProjectLinkGraph,
): ProjectLinkSummary {
  let linked = 0;
  let unlinked = 0;
  let taggedChannels = 0;

  for (const channel of channels) {
    const projectId =
      channel.projectId !== null && graph.getProject(channel.projectId) !== undefined
        ? channel.projectId
        : null;
    if (projectId !== null) taggedChannels += 1;

    for (const artifactId of graph.artifactIdsByExternalRefPrefix(
      SLACK_SOURCE,
      `${channel.channelId}:`,
    )) {
      const current = graph.relatedIds(artifactId, PROJECT_REL);

      // Remove anything that is not the answer the user currently gives. When
      // the channel is untagged this clears every edge; when it is re-tagged it
      // clears the previous project only.
      for (const existing of current) {
        if (existing === projectId) continue;
        unlinked += graph.unrelate({ fromId: artifactId, rel: PROJECT_REL, toId: existing });
      }

      if (projectId === null || current.includes(projectId)) continue;
      graph.relate({ fromId: artifactId, rel: PROJECT_REL, toId: projectId });
      linked += 1;
    }
  }

  return { linked, unlinked, taggedChannels };
}

/**
 * The forward half: resolves a freshly-ingested event's thread artifact to a
 * project, so a new thread carries stakes from its first message rather than
 * from the next time settings are saved.
 *
 * Built from a snapshot of the channel list rather than querying per event: the
 * pipeline calls this once per ingested event, the list changes only when the
 * user edits settings, and a prepared-statement read per message would be a
 * real cost for a value that is nearly always the same.
 *
 * Callers rebuild the resolver when the selection changes — see
 * `apps/desktop/src/main.ts`.
 */
export class SlackChannelProjectResolver {
  private readonly byChannel: ReadonlyMap<string, string>;

  constructor(channels: readonly SelectedSlackChannel[]) {
    const map = new Map<string, string>();
    for (const channel of channels) {
      if (channel.projectId !== null) map.set(channel.channelId, channel.projectId);
    }
    this.byChannel = map;
  }

  /**
   * Project for a Slack `threadKey`, or `null` when its channel is untagged.
   *
   * Splits on the FIRST colon only: a Slack timestamp contains one
   * (`1712345678.000200` does not, but `channelId:ts` split naively by every
   * colon would still be wrong for any future key shape), and the channel id is
   * by construction the leading segment.
   */
  projectFor(source: string, threadKey: string): string | null {
    if (source !== SLACK_SOURCE) return null;
    const separator = threadKey.indexOf(':');
    if (separator <= 0) return null;
    return this.byChannel.get(threadKey.slice(0, separator)) ?? null;
  }

  /** True when no channel carries a tag — lets a caller skip the work entirely. */
  get isEmpty(): boolean {
    return this.byChannel.size === 0;
  }
}
