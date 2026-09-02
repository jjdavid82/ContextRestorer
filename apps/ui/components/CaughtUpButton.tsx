'use client';

import { useCallback, useState, type ReactNode } from 'react';

import { getBridge } from '../lib/bridge';

/**
 * "I'm caught up" control (Task 3.6).
 *
 * Calls `briefing:caughtUp`, which marks the briefing's deltas as seen so the
 * next briefing starts from here instead of repeating what the user has already
 * read. Because that side effect is invisible, the button has to confirm it
 * happened: it flips to a disabled, acknowledged state on success. A user who
 * cannot tell whether the click landed will click it again, and re-marking is
 * cheap but the doubt is not.
 *
 * No toast system, no global store — a local state flip is the whole feature.
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
    <p className="caught-up">
      <button
        type="button"
        className={[
          'cr-interactive',
          'caught-up__button',
          state === 'idle' ? 'caught-up__button--idle' : null,
          state === 'done' ? 'caught-up__button--done' : null,
        ]
          .filter(Boolean)
          .join(' ')}
        disabled={state !== 'idle'}
        onClick={markCaughtUp}
      >
        {state === 'done'
          ? '✓ Marked as caught up'
          : state === 'busy'
            ? 'Marking…'
            : "I'm caught up"}
      </button>
      {/* Announced, not just recoloured: the confirmation is the entire point. */}
      {state === 'done' ? (
        <span role="status" className="caught-up__status">
          Your next briefing will start from here.
        </span>
      ) : null}
      {error !== null ? (
        <span role="alert" className="caught-up__error">
          {error}
        </span>
      ) : null}
    </p>
  );
}

export default CaughtUpButton;
