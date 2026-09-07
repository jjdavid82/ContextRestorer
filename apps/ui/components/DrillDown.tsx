'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useEffect, useState, type ReactNode } from 'react';

import { getBridge } from '../lib/bridge';
import type { DrillDown } from '../types/bridge';
import { ExternalLink } from './ExternalLink';

/**
 * Drill-down provenance panel (Task 3.6, FR-6).
 *
 * Answers "where did this come from?" via `claim:drilldown` — the raw source
 * events behind a claim, each with its external deep link. This is the trust
 * mechanism for the whole product: a briefing the user cannot verify is one
 * they have to re-check by hand, which is the work the app removes.
 *
 * Exported as `DrillDownPanel` so the name does not collide with the `DrillDown`
 * payload type from the bridge. Rendered inside `BriefingView`'s `Collapse` for
 * a claim; the accent-left inset styling stays so it reads as evidence beneath
 * the claim rather than a peer of it.
 */

export interface DrillDownPanelProps {
  /** Claim to fetch provenance for. Changing it refetches. */
  claimId: string;
  /** Renders a close control when provided. */
  onClose?: () => void;
}

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const PANEL_SX = {
  mt: 1,
  p: 1.5,
  borderLeft: 3,
  borderColor: 'primary.main',
  borderRadius: '0 4px 4px 0',
  bgcolor: 'action.hover',
  '& a': { color: 'primary.main', fontSize: 13 },
} as const;

const EVENT_SX = { mb: 1.5, '&:last-of-type': { mb: 0 } } as const;

export function DrillDownPanel({ claimId, onClose }: DrillDownPanelProps): ReactNode {
  const [drilldown, setDrilldown] = useState<DrillDown | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guards against a resolve landing after the panel closed or switched claims.
    let active = true;
    setDrilldown(null);
    setError(null);

    try {
      getBridge()
        .claim.drilldown(claimId)
        .then((result) => {
          if (active) setDrilldown(result);
        })
        .catch((cause: unknown) => {
          if (active) setError(describe(cause));
        });
    } catch (cause) {
      // `getBridge()` throws synchronously outside Electron.
      setError(describe(cause));
    }

    return () => {
      active = false;
    };
  }, [claimId]);

  return (
    <Box aria-label="Sources behind this claim" sx={PANEL_SX}>
      <Typography
        component="h4"
        sx={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'text.secondary', mb: 1 }}
      >
        Where this came from
      </Typography>

      {error !== null ? (
        <Typography role="alert" sx={{ color: 'error.main' }}>
          Could not load sources: {error}
        </Typography>
      ) : drilldown === null ? (
        <Typography sx={{ color: 'text.secondary' }}>Loading sources…</Typography>
      ) : drilldown.events.length === 0 ? (
        <Typography sx={{ color: 'text.secondary' }}>
          No source events are recorded for this claim.
        </Typography>
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
          {drilldown.events.map((event) => (
            <Box component="li" key={event.eventId} sx={EVENT_SX}>
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                <Box component="strong" sx={{ color: 'text.primary' }}>
                  {event.author}
                </Box>
                {' · '}
                {event.source}
                {' · '}
                {new Date(event.occurredAt).toLocaleString()}
              </Typography>
              <Typography sx={{ fontSize: 13 }}>{event.text}</Typography>
              {event.externalUrl !== undefined ? (
                // FR-6: the escape hatch into the real thread. A real anchor
                // (keyboard reachable, announced as a link), but the click is
                // routed through `shell:openExternal` — see `ExternalLink`.
                <ExternalLink href={event.externalUrl}>open in {event.source}</ExternalLink>
              ) : (
                <Typography component="span" sx={{ fontSize: 12, color: 'text.secondary' }}>
                  no deep link available
                </Typography>
              )}
            </Box>
          ))}
        </Box>
      )}

      {onClose !== undefined ? (
        <Button size="small" onClick={onClose} sx={{ mt: 1 }}>
          Close sources
        </Button>
      ) : null}
    </Box>
  );
}

export default DrillDownPanel;
