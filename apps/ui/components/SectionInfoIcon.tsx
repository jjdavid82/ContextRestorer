'use client';

import type { ReactNode } from 'react';

/**
 * A small "?" badge next to a section heading, carrying the section's meaning
 * as a native tooltip (`title`).
 *
 * A separate focusable element rather than a `title` on the heading itself:
 * the heading text is the thing a screen reader announces as the section
 * name, and hovering prose to discover it has a tooltip is not discoverable —
 * a visible affordance is. `tabIndex=0` plus `aria-label` gives keyboard and
 * assistive-tech users the same meaning sighted mouse users get from the
 * tooltip.
 */
export function SectionInfoIcon({ meaning }: { meaning: string }): ReactNode {
  return (
    <span
      className="section-heading__info"
      title={meaning}
      aria-label={meaning}
      tabIndex={0}
    >
      ?
    </span>
  );
}

export default SectionInfoIcon;
