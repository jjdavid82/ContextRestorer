'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { ReactNode } from 'react';

/**
 * The title + one-line lead at the top of each settings panel
 * (`settings/page.tsx`). The panel name is an `<h2>` — the screen name
 * ("Settings") is the `<h1>` in `PageToolbar`.
 */
export function PanelHeading({ title, lead }: { title: string; lead?: string }): ReactNode {
  return (
    <Box sx={{ mb: 2.5 }}>
      <Typography component="h2" sx={{ fontSize: '1.15rem', fontWeight: 650 }}>
        {title}
      </Typography>
      {lead !== undefined ? (
        <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mt: 0.5, maxWidth: '52ch' }}>
          {lead}
        </Typography>
      ) : null}
    </Box>
  );
}

export default PanelHeading;
