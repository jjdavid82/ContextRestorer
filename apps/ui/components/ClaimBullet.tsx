'use client';

import type { ReactNode } from 'react';

import { ExternalLink } from './ExternalLink';

/**
 * One briefing bullet: the claim sentence, its citation chip, and — when the
 * model was unsure — a visible low-confidence flag (Task 3.6, FR-6).
 *
 * The citation chip is a real `<button>`, never a `<span onClick>`: it is the
 * entry point to drill-down provenance, and provenance that only mouse users
 * can reach is provenance half the point of the feature has lost (NFR-9). The
 * button carries `.cr-interactive`, whose `:focus-visible` outline is defined
 * in `globals.css`.
 */

/**
 * The chip label every citation shares, regardless of source or which claim
 * it is attached to.
 *
 * The chip's job is "open provenance", not "identify the artifact" — an
 * artifact id or a source name read as a label add nothing a user acts on,
 * only inconsistency between callers that happened to format it differently
 * (`PendingSection` vs `BriefingView` used to disagree on this before both
 * were pointed at this constant).
 */
export const CITATION_CHIP_LABEL = 'sources';

/**
 * Claims at or below this confidence get a visible "verify this" flag.
 *
 * DUPLICATED ON PURPOSE from `LOW_CONFIDENCE_FLAG_THRESHOLD` in
 * `@cr/ai`'s `src/layer2/pending.ts` (`confidence < 0.5` is flagged). The
 * renderer deliberately does not depend on `@cr/ai`: that package pulls in
 * `@cr/store`, and therefore `better-sqlite3`, a native module the statically
 * exported UI bundle must never touch. Dragging a native-module dependency
 * chain into the browser bundle to share one float would be a bad trade.
 *
 * If the AI threshold moves, move this with it.
 */
export const LOW_CONFIDENCE_FLAG_THRESHOLD = 0.5;

/**
 * Leading words of every low-confidence flag.
 *
 * Kept as a separate constant from the advisory that follows it so both the
 * claim-level and the pending-level flag (see `PENDING_LOW_CONFIDENCE_NOTE` in
 * `PendingSection.tsx`) open with the same three words: the *state* is always
 * named in words, and only the *advice* varies by context.
 */
export const LOW_CONFIDENCE_PREFIX = 'low confidence';

/**
 * Default advisory for a claim the model was unsure about.
 *
 * Pending items override this with the design's §7.6 wording, which is written
 * for the "Waiting on you" case specifically.
 */
export const DEFAULT_LOW_CONFIDENCE_NOTE = 'verify before acting';

export interface ClaimBulletProps {
  /** The rendered claim sentence. */
  text: string;
  /**
   * Identifier handed to `claim.drilldown` when the chip is clicked.
   *
   * Null when the caller has nothing to cite (template-mode connective text) —
   * in that case no chip is rendered at all, because a chip that drills into
   * nothing is a broken promise.
   *
   * A *factual* uncited claim never gets this far: the citation gate drops it
   * before persistence (Task 3.3/3.4, §7.6 + T-4), and `PendingSection` drops
   * uncited pending items as a second line of defence.
   */
  claimId?: string | null;
  /** Chip label — every caller passes {@link CITATION_CHIP_LABEL}. Null hides the chip. */
  citationLabel?: string | null;
  /** Deep link into Slack/Gmail, when the citation carries one (FR-6). */
  externalUrl?: string | null;
  /** Model confidence in [0, 1]. Omitted for claims that carry no score. */
  confidence?: number;
  /**
   * Advisory shown after `LOW_CONFIDENCE_PREFIX` when the flag fires (Task 4.5).
   *
   * Defaults to the claim-level phrasing; `PendingSection` passes the §7.6
   * pending-item wording instead. Low confidence is *always* shown, never
   * suppressed — suppression is reserved for uncited content (§7.6, T-4).
   */
  lowConfidenceNote?: string;
  /** Invoked with `claimId` when the citation chip is activated. */
  onCitationClick?: (claimId: string) => void;
  /** Slot for the drill-down panel and feedback controls belonging to this claim. */
  children?: ReactNode;
}

export function ClaimBullet({
  text,
  claimId = null,
  citationLabel = null,
  externalUrl = null,
  confidence,
  lowConfidenceNote = DEFAULT_LOW_CONFIDENCE_NOTE,
  onCitationClick,
  children,
}: ClaimBulletProps): ReactNode {
  const lowConfidence = confidence !== undefined && confidence < LOW_CONFIDENCE_FLAG_THRESHOLD;
  const chipVisible = claimId !== null && citationLabel !== null;

  const hasMeta = chipVisible || (externalUrl !== null && externalUrl !== undefined) || lowConfidence;

  return (
    <li className="claim-bullet">
      {/* #1a1a1a on #ffffff — 16.1:1, comfortably past the 4.5:1 floor (NFR-9). */}
      <span className="claim-bullet__text">{text}</span>
      {/* The citation chip, deep link and low-confidence flag are metadata
          ABOUT the claim, not part of its sentence — given their own row so a
          short claim does not leave them sitting inline right after the text
          (where a long claim would have wrapped them below anyway, making the
          layout inconsistent from one bullet to the next). */}
      {hasMeta ? (
        <div className="claim-bullet__meta">
          {chipVisible ? (
            <button
              type="button"
              // #0b5fff on #eef3ff — 4.8:1. Chips read as links without being links:
              // they open in-app provenance, they do not navigate.
              className="cr-interactive cr-chip claim-bullet__chip"
              onClick={() => onCitationClick?.(claimId)}
            >
              {citationLabel}
            </button>
          ) : null}
          {externalUrl !== null && externalUrl !== undefined ? (
            // Routed through `shell:openExternal` rather than navigating: the shell
            // blocks every non-`app://` navigation (Task 4.6). See `ExternalLink`.
            // #0b3fbf on #ffffff — 8.3:1.
            <ExternalLink className="cr-interactive claim-bullet__link" href={externalUrl}>
              open in source
            </ExternalLink>
          ) : null}
          {lowConfidence ? (
            // NFR-9: not a colour-only signal. The words "low confidence" plus the
            // advisory carry the whole meaning, so the flag survives greyscale,
            // colour blindness, a 200% zoom and a screen reader; the tint and the
            // border are redundant reinforcement, never the message. `aria-label`
            // restates it for assistive tech minus the decorative glyph.
            // #7a3e00 on #ffffff — 8.4:1, past the 4.5:1 floor.
            <span
              role="note"
              aria-label={`Low confidence: ${lowConfidenceNote}`}
              data-testid="low-confidence-flag"
              className="claim-bullet__low-confidence"
            >
              {/* Decorative only — "warning sign" read aloud adds nothing to the text. */}
              <span aria-hidden="true">⚠ </span>
              {LOW_CONFIDENCE_PREFIX}: {lowConfidenceNote}
            </span>
          ) : null}
        </div>
      ) : null}
      {children}
    </li>
  );
}

export default ClaimBullet;
