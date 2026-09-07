'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

import type { PendingItemView } from '../types/bridge';
import { CITATION_CHIP_LABEL, ClaimBullet } from './ClaimBullet';
import { SectionInfoIcon } from './SectionInfoIcon';

/**
 * The "Waiting on you" section (Task 3.6).
 *
 * Painted straight from `briefing:pending` — from `pending_items` rows the
 * extraction layer already produced — *before* the narrative starts streaming.
 * That ordering is the whole reason this is a separate component: it is the
 * app's answer to "first token under 5s is gated on retrieval" (NFR-2).
 *
 * In the Option 3 redesign this section is *pinned and lifted*: each obligation
 * is its own accent-left-bordered card at the top of the briefing, visually
 * ahead of the streamed "what changed" list, with the "Mark resolved" action
 * inline. Streamed claims the model also filed here are appended via `children`.
 *
 * §7.6 confidence contract (Task 4.5): a low-confidence item is shown *with a
 * flag*, never hidden; an item with no citation is hidden and never flagged.
 */

/**
 * The §7.6 advisory shown on a low-confidence pending item (Task 4.5).
 *
 * VERBATIM from the design doc's §7.6: "Low-confidence items are still shown to
 * the user but with a visible flag (e.g. 'this might be waiting on you — verify
 * in the source'). User decides whether to act." The wording hedges ("might"),
 * names the remedy ("verify in the source") and leaves the decision with the
 * user — do not soften or harden it.
 */
export const PENDING_LOW_CONFIDENCE_NOTE = 'this might be waiting on you — verify in the source';

/**
 * True when a pending item has an artifact to point at.
 *
 * Defence in depth (§7.6, T-4): "items without source references are
 * suppressed". The asymmetry §7.6 draws and this implements:
 *   - LOW CONFIDENCE  → shown, with a flag. Never hidden.
 *   - NO CITATION     → hidden. Never shown with a flag.
 * The empty-string check is about serialisation: a value that crossed the
 * bridge as `''` is as uncitable as `null`.
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
   * resolved" button as a second argument — passed through rather than rendered
   * here so it lands INSIDE `FeedbackControls`' row.
   */
  renderDetail?: (claimId: string, resolveAction?: ReactNode) => ReactNode;
  /** Invoked with the pending item's own `pendingId` when the user marks it dealt with. */
  onResolve?: (pendingId: string) => void;
  /** Streamed "Waiting on you" claims, rendered beneath the pending items. */
  children?: ReactNode;
}

const HEADING_SX = { display: 'flex', alignItems: 'center', gap: 0.5, fontSize: '1.05rem', mb: 1.5 } as const;

// Each obligation is an accent-left card. Styled on the list so `ClaimBullet`
// stays a dumb `<li>` (a per-variant `sx` on the child can't be statically
// extracted by Pigment).
const PENDING_LIST_SX = {
  listStyle: 'none',
  p: 0,
  m: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 1.25,
  '& > li': {
    border: 1,
    borderColor: 'divider',
    borderLeft: 3,
    borderLeftColor: 'primary.main',
    borderRadius: 1,
    bgcolor: 'background.paper',
    p: 1.75,
  },
} as const;

const QUOTE_SX = {
  m: 0,
  mt: 1,
  pl: 1.25,
  borderLeft: 2,
  borderColor: 'divider',
  color: 'text.primary',
  fontStyle: 'normal',
} as const;

export function PendingSection({
  items,
  loading = false,
  onCitationClick,
  renderDetail,
  onResolve,
  children,
}: PendingSectionProps): ReactNode {
  // Filtered before the empty check, so a page of uncited items reads as
  // "nothing is waiting on you" rather than an empty list. `flatMap` so the
  // survivors are typed with a non-null `citationArtifactId`.
  const citedItems: CitedPendingItem[] = items.flatMap((item) =>
    hasCitation(item.citationArtifactId)
      ? [{ ...item, citationArtifactId: item.citationArtifactId }]
      : [],
  );

  return (
    <Box component="section" aria-labelledby="cr-section-waiting-on-you">
      {/*
        P2: the heading is a COUNT, so the reader learns the size of the job
        before reading any of it. Counted over CITED items only. A-4: this list
        is deliberately UNCAPPED — an obligation hidden behind a display cap is
        a recall miss the user cannot see.
      */}
      <Typography component="h3" id="cr-section-waiting-on-you" sx={HEADING_SX}>
        {loading
          ? 'Waiting on you'
          : citedItems.length === 0
            ? 'Nothing needs you'
            : `${citedItems.length} thing${citedItems.length === 1 ? '' : 's'} need${
                citedItems.length === 1 ? 's' : ''
              } you`}
        <SectionInfoIcon meaning="Outstanding obligations that are on this person right now" />
      </Typography>

      {loading ? (
        <Typography sx={{ color: 'text.secondary' }}>Checking what needs your reply…</Typography>
      ) : citedItems.length === 0 ? (
        <Typography sx={{ color: 'text.secondary' }}>Nothing is waiting on you right now.</Typography>
      ) : (
        <Box component="ul" sx={PENDING_LIST_SX}>
          {citedItems.map((item) => {
            const claimId = item.citationArtifactId;
            const resolveAction =
              onResolve === undefined ? undefined : (
                <Button size="small" variant="outlined" onClick={() => onResolve(item.pendingId)}>
                  Mark resolved
                </Button>
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
                {/*
                  P4: verbatim evidence, inline, for obligations only. This is
                  the artifact's OWN text (`sourceQuote`, resolved in
                  `ipc/briefing.ts`), never model output — the claim they most
                  need to check should not require a click to see.
                */}
                {item.sourceQuote !== null ? (
                  <Typography component="blockquote" sx={QUOTE_SX}>
                    {item.sourceQuote}
                  </Typography>
                ) : null}
                {renderDetail !== undefined ? renderDetail(claimId, resolveAction) : resolveAction}
              </ClaimBullet>
            );
          })}
        </Box>
      )}

      {children}
    </Box>
  );
}

export default PendingSection;
