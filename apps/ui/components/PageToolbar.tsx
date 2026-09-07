'use client';

import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

/**
 * The sticky per-screen top bar in the Option 3 shell: the screen's name on the
 * left, screen-specific controls on the right (on Home: the briefing window
 * range and a Refresh button). Flat — `color="default"`, no elevation — so it
 * reads as a header for the content below, not a floating surface.
 */
export interface PageToolbarProps {
  title: string;
  /** Optional slot below the title for supporting context (e.g. the window range). */
  subtitle?: ReactNode;
  /** Right-aligned controls. */
  children?: ReactNode;
}

export function PageToolbar({ title, subtitle, children }: PageToolbarProps): ReactNode {
  return (
    <AppBar
      position="sticky"
      color="default"
      sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}
    >
      <Toolbar sx={{ gap: 2, minHeight: { xs: 52, sm: 56 } }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, minWidth: 0 }}>
          <Typography component="h1" sx={{ fontSize: '0.95rem', fontWeight: 650 }}>
            {title}
          </Typography>
          {subtitle !== undefined ? (
            <Box sx={{ color: 'text.secondary', fontSize: 12, whiteSpace: 'nowrap' }}>{subtitle}</Box>
          ) : null}
        </Box>
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>{children}</Box>
      </Toolbar>
    </AppBar>
  );
}

export default PageToolbar;
