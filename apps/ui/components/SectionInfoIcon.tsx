'use client';

import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import type { ReactNode } from 'react';

/**
 * A small "?" badge next to a section heading, carrying the section's meaning
 * as a tooltip.
 *
 * A separate focusable element rather than a `title` on the heading itself: the
 * heading text is what a screen reader announces as the section name, and a
 * visible affordance is discoverable where hovering prose is not. `tabIndex=0`
 * + `aria-label` give keyboard and assistive-tech users the same meaning the
 * tooltip gives sighted mouse users.
 */
const BADGE_SX = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  borderRadius: '50%',
  border: 1,
  borderColor: 'text.secondary',
  fontSize: 11,
  lineHeight: 1,
  color: 'text.secondary',
  cursor: 'help',
} as const;

export function SectionInfoIcon({ meaning }: { meaning: string }): ReactNode {
  return (
    <Tooltip title={meaning} arrow>
      <Box component="span" aria-label={meaning} tabIndex={0} sx={BADGE_SX}>
        ?
      </Box>
    </Tooltip>
  );
}

export default SectionInfoIcon;
