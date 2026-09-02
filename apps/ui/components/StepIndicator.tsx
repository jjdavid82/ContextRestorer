import type { ReactNode } from 'react';

export interface StepIndicatorProps {
  /** 1-based index of the current step. */
  current: number;
  total: number;
  /** One label per step, rendered in order. */
  labels: readonly string[];
}

/**
 * Purely presentational step indicator for the onboarding wizard.
 *
 * Replaces the plain-text "Step N of 4 — label" with a visual progress trail.
 * No IPC/bridge access and no internal state — `current` is derived by the
 * caller from its own step machine, exactly as the removed text was.
 *
 * The same information stays available to assistive tech: the list is a
 * `role="group"` with an `aria-label` stating the step count, and the active
 * item carries `aria-current="step"`. Done markers reuse this app's existing
 * pattern of a decorative glyph (✓) hidden from the accessibility tree.
 */
export function StepIndicator({ current, total, labels }: StepIndicatorProps): ReactNode {
  const steps = Array.from({ length: total }, (_, index) => labels[index] ?? '');

  return (
    <ol
      className="step-indicator"
      role="group"
      aria-label={`Onboarding progress, step ${current} of ${total}`}
    >
      {steps.map((label, index) => {
        const stepNumber = index + 1;
        const status =
          stepNumber < current ? 'done' : stepNumber === current ? 'current' : 'upcoming';
        return (
          <li
            key={label}
            className={`step-indicator__step step-indicator__step--${status}`}
            aria-current={status === 'current' ? 'step' : undefined}
          >
            <span className="step-indicator__marker" aria-hidden="true">
              {status === 'done' ? '✓' : stepNumber}
            </span>
            <span className="step-indicator__label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default StepIndicator;
