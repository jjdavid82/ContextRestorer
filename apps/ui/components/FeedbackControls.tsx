'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge } from '../lib/bridge';
import type { FeedbackInput } from '../types/bridge';

/**
 * Feedback controls (Task 3.6, FR-7).
 *
 * Two modes, chosen by whether a `claimId` is supplied:
 *
 *  - **claim level** (`claimId` given) — relevant / not relevant / wrong.
 *  - **briefing level** (`claimId` omitted) — "I missed something", submitted
 *    with no `claimId` at all, because the whole point of that verdict is that
 *    the thing the user cares about is *not* in the briefing and therefore has
 *    no claim to attach to.
 *
 * Every control is a `<button type="button">` with exactly one `onClick`, and
 * nothing above it in the tree listens for clicks. That is deliberate: the
 * classic bug here is a handler bound both on the button and on a wrapping row
 * (or a `<button>` inside a `<form>` defaulting to `type="submit"`), which
 * records the user's verdict twice and silently double-weights it in the
 * relevance model. `briefingView.test.tsx` asserts a single click produces
 * exactly one `feedback.submit` call.
 */

/** The claim-level verdicts, in display order. Labels are user-facing wording. */
const CLAIM_VERDICTS: ReadonlyArray<{ verdict: FeedbackInput['verdict']; label: string }> = [
  { verdict: 'relevant', label: 'Relevant' },
  { verdict: 'irrelevant', label: 'Not relevant' },
  { verdict: 'wrong', label: 'Wrong' },
];

export interface FeedbackControlsProps {
  briefingId: string;
  /** Omit for briefing-level feedback (FR-7 "missed something"). */
  claimId?: string;
  /**
   * A verdict already on file for this claim, from a PRIOR briefing or a prior
   * run of the app (`feedback.claimVerdicts`). Seeds the pressed button so a
   * claim the user already judged does not read as unanswered just because a
   * still-open pending item resurfaced under a new `briefingId` — see
   * `BriefingView`'s claim-verdicts fetch.
   */
  initialVerdict?: FeedbackInput['verdict'];
  /**
   * Extra controls rendered on the SAME row as the verdict buttons — today
   * that is `PendingSection`'s "Mark resolved" action. A plain slot rather
   * than a `pendingId` prop: this component has no business knowing what a
   * pending item is, only that the caller may have one more button to place
   * beside its own.
   */
  children?: ReactNode;
}

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function FeedbackControls({
  briefingId,
  claimId,
  initialVerdict,
  children,
}: FeedbackControlsProps): ReactNode {
  const [recorded, setRecorded] = useState<FeedbackInput['verdict'] | null>(initialVerdict ?? null);
  const [error, setError] = useState<string | null>(null);

  // `initialVerdict` typically arrives AFTER mount (it is fetched over IPC,
  // while this control paints immediately), so the `useState` initializer
  // above only covers the rare case where it was already known. This effect
  // covers the common one: seed the pressed button retroactively once the
  // lookup resolves, without clobbering a verdict the user has since clicked
  // here.
  useEffect(() => {
    if (initialVerdict !== undefined) setRecorded((current) => current ?? initialVerdict);
  }, [initialVerdict]);

  const submit = useCallback(
    (verdict: FeedbackInput['verdict']): void => {
      setError(null);
      // `exactOptionalPropertyTypes` forbids `claimId: undefined`, so the key is
      // added only when there is one — which is also exactly the wire shape the
      // briefing-level verdict needs.
      const input: FeedbackInput =
        claimId === undefined ? { briefingId, verdict } : { briefingId, claimId, verdict };

      try {
        getBridge()
          .feedback.submit(input)
          .then((result) => {
            if (result.ok) {
              setRecorded(verdict);
            } else {
              setError(result.reason ?? 'feedback was rejected');
            }
          })
          .catch((cause: unknown) => setError(describe(cause)));
      } catch (cause) {
        setError(describe(cause));
      }
    },
    [briefingId, claimId],
  );

  const isBriefingLevel = claimId === undefined;

  return (
    <div
      className="feedback-controls"
      aria-label={isBriefingLevel ? 'Briefing feedback' : 'Feedback on this claim'}
      role="group"
    >
      {isBriefingLevel ? (
        <button
          type="button"
          // Sits next to `CaughtUpButton` in the footer — `--standalone` matches
          // its size/typography (the per-claim verdict buttons below stay
          // smaller; they're inline next to a bullet, not a standalone action).
          className="cr-interactive feedback-button feedback-button--standalone"
          aria-pressed={recorded === 'missed'}
          onClick={() => submit('missed')}
        >
          I missed something
        </button>
      ) : (
        CLAIM_VERDICTS.map(({ verdict, label }) => (
          <button
            key={verdict}
            type="button"
            // Always clickable, even once a verdict is recorded (`aria-pressed`
            // highlights the current one, it never disables the others) — the
            // user must be able to change their mind without a separate "edit"
            // step. `recorded` merely tracks the LATEST submitted verdict, and
            // every click still fires `submit`, which just writes another row.
            className="cr-interactive feedback-button"
            aria-pressed={recorded === verdict}
            onClick={() => submit(verdict)}
          >
            {label}
          </button>
        ))
      )}

      {children}

      {error !== null ? (
        <span role="alert" className="feedback-controls__error">
          Could not record feedback: {error}
        </span>
      ) : null}
    </div>
  );
}

export default FeedbackControls;
