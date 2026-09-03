'use client';

import { useState, type ReactNode } from 'react';

import {
  clearBriefingWindowStart,
  readSavedBriefingWindowStart,
  writeBriefingWindowStart,
} from '../../lib/briefingWindow';

/**
 * The "Brief me on what I missed" lookback start — now an OVERRIDE, not the
 * primary mechanism (F-2).
 *
 * This control used to be the only thing that decided how far back a briefing
 * looked, defaulting to 30 days ago and never moving unless edited by hand, so
 * the button re-briefed the same month on every press. The default is now the
 * resume point — where the user last tapped "I'm caught up" — and this field
 * exists for the genuine case of wanting to look further back than that.
 *
 * Consequently "unset" is a real, reachable state and the empty string means
 * it: `clearBriefingWindowStart` removes the key rather than writing a date, so
 * the Home page can tell "the user asked for 30 days" apart from "the user has
 * never touched this." Saved on every change — there is no separate "Save".
 */
export default function BriefingWindowSettings(): ReactNode {
  const [windowStartInput, setWindowStartInput] = useState<string>(
    () => readSavedBriefingWindowStart() ?? '',
  );

  const update = (value: string): void => {
    setWindowStartInput(value);
    // An emptied field is a cleared override, not a malformed date.
    if (value === '') clearBriefingWindowStart();
    else writeBriefingWindowStart(value);
  };

  const clear = (): void => update('');

  return (
    <section className="card">
      <h2>Briefing range</h2>
      <p>
        <small>
          By default, &ldquo;Brief me on what I missed&rdquo; starts where you last tapped
          &ldquo;I&rsquo;m caught up&rdquo; and runs through now. Set a date here only to look
          further back than that. &ldquo;Waiting on you&rdquo; ignores this either way — it
          always shows every open obligation, regardless of age.
        </small>
      </p>
      <div className="form-field">
        <label className="form-field__label" htmlFor="briefing-window-start">
          Start from (optional)
        </label>
        <input
          id="briefing-window-start"
          type="datetime-local"
          value={windowStartInput}
          onChange={(e) => update(e.target.value)}
        />
      </div>
      <p aria-live="polite">
        <small>
          {windowStartInput === ''
            ? 'No override — using where you last caught up.'
            : 'Override active — every briefing will start from this date until you clear it.'}
        </small>
      </p>
      <p>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={clear}
          disabled={windowStartInput === ''}
        >
          Clear override
        </button>
      </p>
    </section>
  );
}
