'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useCallback, useState, type ReactNode } from 'react';

import { getBridge } from '../lib/bridge';

/**
 * "I'm caught up" control (Task 3.6).
 *
 * Calls `briefing:caughtUp`, which marks the briefing's deltas as seen so the
 * next briefing starts from here instead of repeating what was already read.
 * Because that side effect is invisible, the button confirms it happened: it
 * flips to a disabled, acknowledged state on success. A user who cannot tell
 * whether the click landed will click again — re-marking is cheap but the
 * doubt is not.
 */

export interface CaughtUpButtonProps {
  briefingId: string;
  /** Notifies the parent after a successful acknowledgement. */
  onCaughtUp?: () => void;
}

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function CaughtUpButton({ briefingId, onCaughtUp }: CaughtUpButtonProps): ReactNode {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const markCaughtUp = useCallback((): void => {
    setError(null);
    setState('busy');
    try {
      getBridge()
        .briefing.caughtUp(briefingId)
        .then((result) => {
          if (result.ok) {
            setState('done');
            onCaughtUp?.();
          } else {
            setState('idle');
            setError(result.reason ?? 'could not mark this briefing as read');
          }
        })
        .catch((cause: unknown) => {
          setState('idle');
          setError(describe(cause));
        });
    } catch (cause) {
      setState('idle');
      setError(describe(cause));
    }
  }, [briefingId, onCaughtUp]);

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
      <Button
        size="small"
        variant={state === 'done' ? 'contained' : 'outlined'}
        color={state === 'done' ? 'success' : 'primary'}
        disabled={state !== 'idle'}
        onClick={markCaughtUp}
      >
        {state === 'done' ? '✓ Marked as caught up' : state === 'busy' ? 'Marking…' : "I'm caught up"}
      </Button>
      {/* Announced, not just recoloured: the confirmation is the entire point. */}
      {state === 'done' ? (
        <Typography component="span" role="status" sx={{ fontSize: '0.85em', color: 'text.primary' }}>
          Your next briefing will start from here.
        </Typography>
      ) : null}
      {error !== null ? (
        <Typography component="span" role="alert" sx={{ fontSize: '0.85em', color: 'error.main' }}>
          {error}
        </Typography>
      ) : null}
    </Box>
  );
}

export default CaughtUpButton;
