'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../lib/bridge';
import type { PipelineStatus, SourceHealth } from '../types/bridge';

/**
 * The always-visible status block at the foot of the navigation rail
 * (`AppShell`). Replaces the two dashboard cards `SourceHealthPanel` /
 * `PipelineStatusPanel` — same `health:sources` / `pipeline:status`
 * subscriptions, condensed to what reads at a glance from the rail: a coloured
 * dot + name + lag per source, and one line of pipeline activity.
 *
 * The fuller wording those cards carried (per-status remedies, rate-limit
 * explanation — R-5) moves to a tooltip on each row so nothing is lost.
 */

const DOT_COLOR: Record<SourceHealth['status'], string> = {
  ok: 'var(--mui-palette-success-main)',
  degraded: 'var(--mui-palette-warning-main)',
  'rate-limited': 'var(--mui-palette-warning-main)',
  disconnected: 'var(--mui-palette-error-main)',
};

const STATUS_TITLE: Record<SourceHealth['status'], string> = {
  ok: 'Syncing normally',
  degraded: 'Recent polls failed; retrying with backoff',
  'rate-limited': 'The provider is throttling us — updates are delayed, not lost',
  disconnected: 'Not connected — reconnect this source to resume ingestion',
};

function formatLag(lagMs: number | null): string {
  if (lagMs === null) return 'lag unknown';
  if (lagMs < 60_000) return 'up to date';
  const minutes = Math.round(lagMs / 60_000);
  return minutes < 60 ? `${minutes}m behind` : `${Math.round(minutes / 60)}h behind`;
}

function pipelineLine(status: PipelineStatus | null): string {
  if (status === null) return 'Waiting for first status…';
  if (status.extractionBacklog > 0) {
    return `Reading ${status.extractionBacklog} new message${status.extractionBacklog === 1 ? '' : 's'}…`;
  }
  if (status.synthesisInFlight > 0) {
    return `Summarizing ${status.synthesisInFlight} conversation${status.synthesisInFlight === 1 ? '' : 's'}…`;
  }
  if (status.synthesisDue > 0) {
    return `${status.synthesisDue} queued for summarizing`;
  }
  return 'Idle';
}

// Static object literals only — Pigment extracts `sx={CONST}` but not a spread
// or a runtime-computed value, so the two eyebrow variants are spelled out.
const EYEBROW_SX = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color: 'text.secondary',
} as const;
const EYEBROW_SX_SPACED = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color: 'text.secondary',
  mt: 0.5,
} as const;

export function RailStatus(): ReactNode {
  const [health, setHealth] = useState<SourceHealth[]>([]);
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (!hasBridge()) {
      setAvailable(false);
      return;
    }
    try {
      const bridge = getBridge();
      const offHealth = bridge.health.onSources(setHealth);
      const offPipeline = bridge.pipeline.onStatus(setPipeline);
      return () => {
        offHealth();
        offPipeline();
      };
    } catch {
      setAvailable(false);
      return;
    }
  }, []);

  if (!available) {
    return (
      <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5, px: 1 }}>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          Status is available in the desktop app.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5, px: 1, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Typography component="h2" sx={EYEBROW_SX}>
        Sources
      </Typography>
      {health.length === 0 ? (
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>Waiting for first report…</Typography>
      ) : (
        health.map((entry) => (
          <Box
            key={entry.source}
            title={STATUS_TITLE[entry.status]}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 12.5 }}
          >
            {/* Per-status colour is runtime data → a plain `style` attribute
                (allowed by the CSP's `style-src-attr`), not `sx`, which Pigment
                would fail to extract and dump an AST into the DOM. */}
            <span
              aria-hidden="true"
              style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, backgroundColor: DOT_COLOR[entry.status] }}
            />
            <Box component="span" sx={{ textTransform: 'capitalize', color: 'text.primary' }}>
              {entry.source}
            </Box>
            <Box component="span" sx={{ ml: 'auto', color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
              {formatLag(entry.lagMs)}
            </Box>
          </Box>
        ))
      )}
      <Typography component="h2" sx={EYEBROW_SX_SPACED}>
        Pipeline
      </Typography>
      <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{pipelineLine(pipeline)}</Typography>
    </Box>
  );
}

export default RailStatus;
