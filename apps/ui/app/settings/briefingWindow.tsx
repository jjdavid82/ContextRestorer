'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useState, type ReactNode } from 'react';

import {
  clearBriefingWindowStart,
  readSavedBriefingWindowStart,
  writeBriefingWindowStart,
} from '../../lib/briefingWindow';
import { PanelHeading } from './PanelHeading';

/**
 * The briefing lookback start — an OVERRIDE, not the primary mechanism (F-2).
 *
 * The default is the resume point (where the user last tapped "I'm caught up");
 * this field exists for the genuine case of wanting to look further back.
 * "Unset" is a real, reachable state — the empty string means it, and
 * `clearBriefingWindowStart` removes the key rather than writing a date, so Home
 * can tell "the user asked for a fixed start" apart from "never touched this."
 * Saved on every change — there is no separate Save.
 *
 * No bridge here: the value lives in `localStorage` via `lib/briefingWindow`.
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

  return (
    <Box>
      <PanelHeading
        title="Briefing window"
        lead={
          'By default, a briefing starts where you last tapped "I’m caught up" and runs through ' +
          'now. Set a date here only to look further back. "Waiting on you" ignores this either ' +
          'way — it always shows every open obligation, regardless of age.'
        }
      />

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, maxWidth: 360 }}>
        <TextField
          id="briefing-window-start"
          type="datetime-local"
          size="small"
          label="Start from (optional)"
          value={windowStartInput}
          onChange={(e) => update(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <Typography aria-live="polite" sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
          {windowStartInput === ''
            ? 'No override — using where you last caught up.'
            : 'Override active — every briefing will start from this date until you clear it.'}
        </Typography>
        <Box>
          <Button
            variant="outlined"
            size="small"
            onClick={() => update('')}
            disabled={windowStartInput === ''}
          >
            Clear override
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
