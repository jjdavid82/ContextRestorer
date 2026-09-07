'use client';

import Box from '@mui/material/Box';
import ToggleButton from '@mui/material/ToggleButton';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge } from '../lib/bridge';
import type { FeedbackInput } from '../types/bridge';

/**
 * Feedback controls (Task 3.6, FR-7): relevant / not relevant / wrong for one
 * claim, as individual toggle buttons.
 *
 * Every control has exactly one `onClick` and nothing above it in the tree
 * listens for clicks. The classic bug here is a handler bound both on the
 * button and a wrapping row (or a `<button>` in a `<form>` defaulting to
 * `type="submit"`), which double-weights the verdict. `briefingView.test.tsx`
 * asserts a single click produces exactly one `feedback.submit` call — so the
 * `ToggleButton`s use `onClick` + `selected`, NOT the group's `onChange`
 * (which would also fire `null` on re-click and swallow a repeat verdict).
 */

/** The claim-level verdicts, in display order. */
const CLAIM_VERDICTS: ReadonlyArray<{ verdict: FeedbackInput['verdict']; label: string }> = [
  { verdict: 'relevant', label: 'Relevant' },
  { verdict: 'irrelevant', label: 'Not relevant' },
  { verdict: 'wrong', label: 'Wrong' },
];

export interface FeedbackControlsProps {
  briefingId: string;
  claimId: string;
  /**
   * A verdict already on file for this claim, from a prior briefing/run
   * (`feedback.claimVerdicts`). Seeds the pressed button so a claim the user
   * already judged does not read as unanswered when a still-open pending item
   * resurfaces under a new `briefingId`.
   */
  initialVerdict?: FeedbackInput['verdict'];
  /** Extra controls on the SAME row as the verdict buttons — today, "Mark resolved". */
  children?: ReactNode;
}

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const ROW_SX = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.75, mt: 0.5 } as const;

export function FeedbackControls({
  briefingId,
  claimId,
  initialVerdict,
  children,
}: FeedbackControlsProps): ReactNode {
  const [recorded, setRecorded] = useState<FeedbackInput['verdict'] | null>(initialVerdict ?? null);
  const [error, setError] = useState<string | null>(null);

  // `initialVerdict` typically arrives AFTER mount (fetched over IPC while this
  // paints immediately). Seed the pressed button retroactively once it resolves,
  // without clobbering a verdict the user has since clicked here.
  useEffect(() => {
    if (initialVerdict !== undefined) setRecorded((current) => current ?? initialVerdict);
  }, [initialVerdict]);

  const submit = useCallback(
    (verdict: FeedbackInput['verdict']): void => {
      setError(null);
      const input: FeedbackInput = { briefingId, claimId, verdict };

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

  return (
    <Box sx={ROW_SX} role="group" aria-label="Feedback on this claim">
      {/* Individual `ToggleButton`s in the row rather than a `ToggleButtonGroup`
          — the group renders them flush as a segmented control; these read as
          three separate small toggles with the row's own gap between them.
          Always clickable, even once a verdict is recorded (the user must be
          able to change their mind); `recorded` tracks only the latest, and
          every click re-fires `submit`, writing another row. `selected` →
          MUI mirrors it to `aria-pressed`. */}
      <Box role="group" aria-label="Was this claim relevant?" sx={{ display: 'flex', gap: 0.75 }}>
        {CLAIM_VERDICTS.map(({ verdict, label }) => (
          <ToggleButton
            key={verdict}
            value={verdict}
            size="small"
            selected={recorded === verdict}
            onClick={() => submit(verdict)}
            sx={{ py: 0.25, px: 1, textTransform: 'none', lineHeight: 1.4 }}
          >
            {label}
          </ToggleButton>
        ))}
      </Box>

      {children}

      {error !== null ? (
        <Typography component="span" role="alert" sx={{ fontSize: '0.8em', color: 'error.main' }}>
          Could not record feedback: {error}
        </Typography>
      ) : null}
    </Box>
  );
}

export default FeedbackControls;
