'use client';

import type { ReactNode } from 'react';

import type { PendingItemView } from '../types/bridge';
import { CITATION_CHIP_LABEL, ClaimBullet } from './ClaimBullet';

/**
 * The "Waiting on you" section (Task 3.6).
 *
 * Painted straight from `briefing:pending` — i.e. from `pending_items` rows the
 * extraction layer already produced — *before* the narrative starts streaming.
 * That ordering is the whole reason this section is a separate component: it is
 * the app's answer to "first token under 5s is gated on retrieval" (NFR-2). The
 * user sees the thing they owe someone within a few hundred milliseconds, while
 * the LLM is still warming up.
 *
 * Streamed claims that the model also filed under "Waiting on you" are appended
 * beneath the pending list via `children`, so the section stays one coherent
 * block instead of appearing twice under the same heading.
 *
 * Task 4.5 adds the §7.6 confidence contract to this section: a low-confidence
 * item is shown *with a flag* (`PENDING_LOW_CONFIDENCE_NOTE`), never hidden,
 * while an item with no citation is hidden and never flagged.
 */

/**
 * The §7.6 advisory shown on a low-confidence pending item (Task 4.5).
 *
 * VERBATIM from the design doc's §7.6 "Confidence flagging" bullet: "Low-confidence
 * items are still shown to the user but with a visible flag (e.g. 'this might be
 * waiting on you — verify in the source'). User decides whether to act."
 *
 * The wording is deliberate and worth preserving: it hedges ("might"), names the
 * remedy ("verify in the source") and leaves the decision with the user. Do not
 * soften it into "possibly relevant" or harden it into "you owe someone a reply".
 */
export const PENDING_LOW_CONFIDENCE_NOTE = 'this might be waiting on you — verify in the source';

/**
 * True when a pending item has an artifact to point at.
 *
 * Defence in depth, not routine filtering (§7.6, T-4): "items without source
 * references are suppressed". `pending_items.citation_artifact_id` is nullable in
 * the store, so `PendingItemView.citationArtifactId` is nullable here, and an
 * uncited row would otherwise reach the user as an unverifiable assertion. Note
 * the asymmetry that §7.6 draws and this component implements:
 *
 *   - LOW CONFIDENCE  → shown, with a flag. Never hidden.
 *   - NO CITATION     → hidden. Never shown with a flag.
 *
 * The empty-string check is not paranoia about types but about serialisation: a
 * value that crossed the context bridge as `''` is as uncitable as `null`.
 */
function hasCitation(citationArtifactId: string | null): citationArtifactId is string {
  return citationArtifactId !== null && citationArtifactId.trim() !== '';
}

/** A pending item that survived the citation check, with the null ruled out. */
interface CitedPendingItem extends Omit<PendingItemView, 'citationArtifactId'> {
  citationArtifactId: string;
}

export interface PendingSectionProps {
  items: PendingItemView[];
  /** True until `briefing:pending` has resolved. */
  loading?: boolean;
  /** Invoked with the pending item's artifact id when its citation chip is clicked. */
  onCitationClick?: (claimId: string) => void;
  /**
   * Per-item slot (drill-down panel, feedback); receives the item's claim id
   * and, when {@link PendingSectionProps.onResolve} is wired, the "Mark
   * resolved" button as a second argument — passed through rather than
   * rendered here so it lands INSIDE `FeedbackControls`' row (same line as
   * Relevant/Not relevant/Wrong) instead of on a line of its own.
   */
  renderDetail?: (claimId: string, resolveAction?: ReactNode) => ReactNode;
  /**
   * Invoked with the pending item's own `pendingId` — NOT its citation artifact
   * id — when the user marks it dealt with. Omitted entirely hides the control,
   * matching every other optional callback in this component.
   */
  onResolve?: (pendingId: string) => void;
  /** Streamed "Waiting on you" claims, rendered beneath the pending items. */
  children?: ReactNode;
}

export function PendingSection({
  items,
  loading = false,
  onCitationClick,
  renderDetail,
  onResolve,
  children,
}: PendingSectionProps): ReactNode {
  // Filtered before the empty check, so a page of uncited items reads as
  // "nothing is waiting on you" rather than as an empty bulleted list.
  // `flatMap` rather than `filter` so the survivors are typed with a non-null
  // `citationArtifactId` — a field-level type guard cannot narrow the object.
  const citedItems: CitedPendingItem[] = items.flatMap((item) =>
    hasCitation(item.citationArtifactId)
      ? [{ ...item, citationArtifactId: item.citationArtifactId }]
      : [],
  );

  return (
    <section aria-labelledby="cr-section-waiting-on-you">
      <h3 id="cr-section-waiting-on-you" className="section-heading">
        Waiting on you
      </h3>

      {loading ? (
        // #595959 on #ffffff — 7.0:1.
        <p className="muted-note">Checking what needs your reply…</p>
      ) : citedItems.length === 0 ? (
        <p className="muted-note">Nothing is waiting on you right now.</p>
      ) : (
        <ul className="bullet-list">
          {citedItems.map((item) => {
            const claimId = item.citationArtifactId;
            const resolveAction =
              onResolve === undefined ? undefined : (
                <button
                  type="button"
                  className="cr-interactive feedback-button"
                  onClick={() => onResolve(item.pendingId)}
                >
                  Mark resolved
                </button>
              );
            return (
              <ClaimBullet
                key={item.pendingId}
                text={item.description}
                claimId={claimId}
                citationLabel={CITATION_CHIP_LABEL}
                confidence={item.confidence}
                lowConfidenceNote={PENDING_LOW_CONFIDENCE_NOTE}
                {...(onCitationClick === undefined ? {} : { onCitationClick })}
              >
                {renderDetail !== undefined ? renderDetail(claimId, resolveAction) : resolveAction}
              </ClaimBullet>
            );
          })}
        </ul>
      )}

      {children}
    </section>
  );
}

export default PendingSection;
