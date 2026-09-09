'use client';

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

/**
 * One briefing bullet: the claim sentence, its citation chip, and — when the
 * model was unsure — a visible low-confidence flag (Task 3.6, FR-6).
 *
 * The citation chip is a real `<button>` (MUI `Chip clickable` with
 * `component="button"`), never a `<span onClick>`: it is the entry point to
 * drill-down provenance, and provenance only mouse users can reach is half the
 * point of the feature lost (NFR-9).
 *
 * Kept as an `<li>` with the same accessible tree as before the MUI restyle —
 * the citation chip's accessible name is still {@link CITATION_CHIP_LABEL}, the
 * low-confidence flag still carries `role="note"` + the words "low confidence"
 * and `data-testid="low-confidence-flag"` — so `briefingView.test.tsx` reads it
 * unchanged. Only the visual chrome is MUI now.
 */

export const CITATION_CHIP_LABEL = 'sources';

/**
 * Claims at or below this confidence get a visible "verify this" flag.
 *
 * DUPLICATED ON PURPOSE from `LOW_CONFIDENCE_FLAG_THRESHOLD` in `@cr/ai`'s
 * `src/layer2/pending.ts` (`confidence < 0.5` is flagged). The renderer
 * deliberately does not depend on `@cr/ai`: that package pulls in `@cr/store`,
 * and therefore `better-sqlite3`, a native module the statically exported UI
 * bundle must never touch. If the AI threshold moves, move this with it.
 */
export const LOW_CONFIDENCE_FLAG_THRESHOLD = 0.5;

/** Leading words of every low-confidence flag (claim-level and pending-level). */
export const LOW_CONFIDENCE_PREFIX = 'low confidence';

/** Default advisory for a claim the model was unsure about. */
export const DEFAULT_LOW_CONFIDENCE_NOTE = 'verify before acting';

export interface ClaimBulletProps {
  /** The rendered claim sentence. */
  text: string;
  /**
   * Identifier handed to `claim.drilldown` when the chip is clicked. Null when
   * the caller has nothing to cite (template-mode connective text) — no chip is
   * rendered then, because a chip that drills into nothing is a broken promise.
   */
  claimId?: string | null;
  /** Chip label — every caller passes {@link CITATION_CHIP_LABEL}. Null hides the chip. */
  citationLabel?: string | null;
  /**
   * Declared project this item belongs to, rendered as its most prominent
   * badge. Absent for an untagged item — the ordinary case.
   *
   * Deliberately louder than the citation chip and the confidence flag, and
   * placed FIRST: the project is the largest ranking weight after obligation,
   * and until it appeared here the user had no way to see that the declaration
   * they made at onboarding was doing anything at all.
   */
  projectName?: string | undefined;
  /** Model confidence in [0, 1]. Omitted for claims that carry no score. */
  confidence?: number;
  /** Advisory shown after `LOW_CONFIDENCE_PREFIX` when the flag fires (Task 4.5). */
  lowConfidenceNote?: string;
  /** Invoked with `claimId` when the citation chip is activated. */
  onCitationClick?: (claimId: string) => void;
  /** Slot for the drill-down panel and feedback controls belonging to this claim. */
  children?: ReactNode;
}

// The `<li>` carries no borders/spacing of its own — the containing list
// (`PendingSection`, `BriefingView`'s changed list) styles `& > li` so pending
// items can read as accent cards while changed items are a hairline-ruled list.
const LI_SX = { listStyle: 'none' } as const;

const META_SX = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 0.75,
  mt: 0.75,
} as const;

/**
 * The project badge: filled, not outlined, so it reads before the quieter
 * `sources` chip beside it.
 *
 * NFR-9: colour is reinforcement, never the message. The project's NAME is the
 * whole signal and it is plain text inside the chip, so the badge survives
 * greyscale, a colour-blind reader and a screen reader identically — the
 * `aria-label` restates what it is, because "Migration" alone does not say
 * "project" to somebody who cannot see the styling.
 */
const PROJECT_CHIP_SX = {
  fontWeight: 700,
  letterSpacing: '0.01em',
  maxWidth: '22ch',
} as const;

export function ClaimBullet({
  text,
  claimId = null,
  citationLabel = null,
  projectName,
  confidence,
  lowConfidenceNote = DEFAULT_LOW_CONFIDENCE_NOTE,
  onCitationClick,
  children,
}: ClaimBulletProps): ReactNode {
  const lowConfidence = confidence !== undefined && confidence < LOW_CONFIDENCE_FLAG_THRESHOLD;
  const chipVisible = claimId !== null && citationLabel !== null;
  const project = projectName?.trim() ?? '';
  const projectVisible = project !== '';
  const hasMeta = chipVisible || lowConfidence || projectVisible;

  return (
    <Box component="li" sx={LI_SX}>
      <Typography sx={{ color: 'text.primary', lineHeight: 1.55 }}>{text}</Typography>

      {hasMeta ? (
        <Box sx={META_SX}>
          {projectVisible ? (
            <Chip
              size="small"
              color="primary"
              label={project}
              aria-label={`Project: ${project}`}
              data-testid="project-badge"
              sx={PROJECT_CHIP_SX}
            />
          ) : null}
          {chipVisible ? (
            <Chip
              component="button"
              type="button"
              clickable
              size="small"
              variant="outlined"
              color="primary"
              label={citationLabel}
              onClick={() => onCitationClick?.(claimId)}
            />
          ) : null}
          {lowConfidence ? (
            // NFR-9: not a colour-only signal. The words "low confidence" plus
            // the advisory carry the whole meaning; the tint and the ⚠ are
            // redundant reinforcement. The glyph is `aria-hidden` — "warning
            // sign" read aloud adds nothing — and `aria-label` restates the
            // whole flag for assistive tech.
            <Chip
              size="small"
              variant="outlined"
              color="warning"
              role="note"
              aria-label={`Low confidence: ${lowConfidenceNote}`}
              data-testid="low-confidence-flag"
              label={
                <>
                  <Box component="span" aria-hidden="true">
                    {'⚠ '}
                  </Box>
                  {`${LOW_CONFIDENCE_PREFIX}: ${lowConfidenceNote}`}
                </>
              }
            />
          ) : null}
        </Box>
      ) : null}

      {children}
    </Box>
  );
}

export default ClaimBullet;
