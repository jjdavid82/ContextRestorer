'use client';

import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../lib/bridge';
import { formatEta, formatLag } from '../lib/pipelineFormat';
import type { PipelineStatus, SourceHealth, SourceId } from '../types/bridge';

/**
 * The always-visible status block at the foot of the navigation rail
 * (`AppShell`). Replaces the two dashboard cards `SourceHealthPanel` /
 * `PipelineStatusPanel` — same `health:sources` / `pipeline:status`
 * subscriptions, condensed to what reads at a glance from the rail: a coloured
 * dot + name + lag per source, and one line of pipeline activity.
 *
 * The fuller wording those cards carried (per-status remedies, rate-limit
 * explanation — R-5) moves to a tooltip on each row so nothing is lost.
 *
 * Each source row also carries a "refresh now" icon-button: it calls
 * `poll:refresh`, which forces that source's next poll cycle immediately
 * instead of waiting out the 5-minute interval. The main process rate-limits
 * it to once a minute per source; the button's own disabled state is only an
 * echo of that (`readyAt`, seeded from the result's `retryAfterMs`).
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

/** The conventional refresh glyph — two-thirds of a circle plus an arrowhead. */
const RefreshIcon = (
  <svg
    viewBox="0 0 24 24"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 4v5h-5" />
  </svg>
);

function pipelineLine(status: PipelineStatus | null): string {
  if (status === null) return 'Waiting for first status…';
  if (status.extractionBacklog > 0) {
    const head = `Reading ${status.extractionBacklog} new message${status.extractionBacklog === 1 ? '' : 's'}…`;
    // Appended only once the estimate is earned: `null` means "no completed
    // Layer-1 calls to average yet", which is the first-run state, and the
    // count alone is more honest there than a guess.
    return status.extractionEtaMs === null
      ? head
      : `${head} ${formatEta(status.extractionEtaMs)} left`;
  }
  if (status.synthesisInFlight > 0) {
    return `Summarizing ${status.synthesisInFlight} conversation${status.synthesisInFlight === 1 ? '' : 's'}…`;
  }
  if (status.synthesisDue > 0) {
    return `${status.synthesisDue} queued for summarizing`;
  }
  return 'Idle';
}

/**
 * The bundle is served over the `app://local` fixed-host scheme, where directory
 * URLs don't resolve — every in-app link points at an explicit `index.html`
 * (same reasoning as `AppShell`'s nav). The `#diagnostics` hash tells the
 * settings screen which panel to open.
 */
const DIAGNOSTICS_HREF = '/settings/index.html#diagnostics';

const STUCK_ROW_SX = {
  mt: 0.25,
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
} as const;
const STUCK_LINK_SX = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  color: 'warning.main',
  textDecoration: 'none',
  '&:hover': { textDecoration: 'underline' },
} as const;
const STUCK_DISMISS_BTN_SX = { p: 0.25, color: 'warning.main', flexShrink: 0 } as const;

/**
 * `localStorage` key holding the parked-thread count the user last dismissed the
 * "conversations stuck" notice at. Per-viewer convenience only — every access is
 * wrapped, and a private window that can't persist simply won't remember it.
 */
const STUCK_DISMISS_KEY = 'cr.railStatus.stuckDismissedAt';

function readStuckDismissedCount(): number {
  try {
    const raw = localStorage.getItem(STUCK_DISMISS_KEY);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeStuckDismissedCount(count: number): void {
  try {
    if (count > 0) localStorage.setItem(STUCK_DISMISS_KEY, String(count));
    else localStorage.removeItem(STUCK_DISMISS_KEY);
  } catch {
    // Blocked/again storage — the notice just won't stay dismissed across reloads.
  }
}

/** A plain × — dismisses the stuck-conversation notice. */
const DismissIcon = (
  <svg
    viewBox="0 0 24 24"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

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
const REFRESH_BTN_SX = { p: 0.25, color: 'text.secondary' } as const;

/**
 * Floor on how long the refresh icon keeps spinning after a click.
 *
 * `poll:refresh` only *schedules* the source's next cycle and returns at once —
 * the fetch itself runs later, off in the poller — so the IPC round-trip settles
 * in a few milliseconds and an un-floored spinner would just flicker. Holding it
 * for this long turns the click into visible "on it" feedback; the button's
 * 60-second cooldown disable then carries "done" from there.
 */
const REFRESH_MIN_SPIN_MS = 900;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function RailStatus(): ReactNode {
  const [health, setHealth] = useState<SourceHealth[]>([]);
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [available, setAvailable] = useState(true);
  /** Sources with a `poll:refresh` request currently in flight. */
  const [busy, setBusy] = useState<Partial<Record<SourceId, boolean>>>({});
  /** Epoch ms each source may next be hand-refreshed (from `retryAfterMs`). */
  const [readyAt, setReadyAt] = useState<Partial<Record<SourceId, number>>>({});
  /** Bumped once a second while a cooldown is active, to re-render the countdown. */
  const [nowTs, setNowTs] = useState(() => Date.now());
  /**
   * Parked-thread count at which the user last dismissed the "conversations
   * stuck" notice. Seeded post-mount (below) so the static-export prerender and
   * hydration stay on the un-dismissed markup. The notice re-appears once the
   * count climbs past this — a worsening backlog is worth re-raising.
   */
  const [stuckDismissedCount, setStuckDismissedCount] = useState(0);

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

  // A 1s ticker that exists ONLY while some source is still cooling down — it
  // clears itself the moment the last cooldown lapses, so the rail is not
  // holding a timer at rest.
  useEffect(() => {
    const stillCooling = (): boolean =>
      Object.values(readyAt).some((t) => (t ?? 0) > Date.now());
    if (!stillCooling()) return;
    const id = setInterval(() => {
      // Update first — the tick that ends a cooldown still has to re-render the
      // row so the button re-enables — then stop once nothing is cooling.
      setNowTs(Date.now());
      if (!stillCooling()) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [readyAt]);

  // Seed the dismissed-count from storage once, after mount.
  useEffect(() => {
    setStuckDismissedCount(readStuckDismissedCount());
  }, []);

  // Once a real status reports the backlog fully cleared, forget any dismissal
  // so the next occurrence shows again from scratch. Gated on a non-null
  // `pipeline` so the initial "no status yet" render can't wipe a stored value.
  const parkedThreads = pipeline?.parkedThreads ?? 0;
  useEffect(() => {
    if (pipeline !== null && pipeline.parkedThreads === 0 && stuckDismissedCount !== 0) {
      setStuckDismissedCount(0);
      writeStuckDismissedCount(0);
    }
  }, [pipeline, stuckDismissedCount]);

  const handleDismissStuck = useCallback((count: number): void => {
    setStuckDismissedCount(count);
    writeStuckDismissedCount(count);
  }, []);

  const handleRefresh = useCallback(async (source: SourceId): Promise<void> => {
    setBusy((b) => ({ ...b, [source]: true }));
    const startedAt = Date.now();
    try {
      const res = await getBridge().poll.refresh(source);
      if (typeof res.retryAfterMs === 'number' && res.retryAfterMs > 0) {
        setReadyAt((r) => ({ ...r, [source]: Date.now() + res.retryAfterMs! }));
        setNowTs(Date.now());
      }
    } catch {
      // The bridge went away mid-session — leave the button enabled and let the
      // next click surface the failure.
    } finally {
      // Keep the icon spinning for a beat even when the IPC call returned
      // instantly, so the click always registers visually.
      const remaining = REFRESH_MIN_SPIN_MS - (Date.now() - startedAt);
      if (remaining > 0) await wait(remaining);
      setBusy((b) => ({ ...b, [source]: false }));
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
        health.map((entry) => {
          const isBusy = busy[entry.source] === true;
          const coolMsLeft = (readyAt[entry.source] ?? 0) - nowTs;
          const cooling = coolMsLeft > 0;
          const secondsLeft = Math.ceil(coolMsLeft / 1000);
          return (
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
              <Box component="span" sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Box component="span" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                  {formatLag(entry.lagMs)}
                </Box>
                <IconButton
                  size="small"
                  aria-label={`Refresh ${entry.source} now`}
                  title={
                    cooling
                      ? `Just refreshed — available again in ${secondsLeft}s`
                      : `Check ${entry.source} for new activity now`
                  }
                  disabled={isBusy || cooling}
                  onClick={() => void handleRefresh(entry.source)}
                  sx={REFRESH_BTN_SX}
                >
                  {/* The spin keyframe is in globals.css — Pigment only extracts
                      static sx, and this class is applied conditionally. */}
                  <Box component="span" className={isBusy ? 'cr-spin' : undefined} sx={{ display: 'inline-flex' }}>
                    {RefreshIcon}
                  </Box>
                </IconButton>
              </Box>
            </Box>
          );
        })
      )}
      <Typography component="h2" sx={EYEBROW_SX_SPACED}>
        Pipeline
      </Typography>
      <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{pipelineLine(pipeline)}</Typography>
      {parkedThreads > 0 && parkedThreads > stuckDismissedCount ? (
        <Box sx={STUCK_ROW_SX}>
          <Box
            component="a"
            href={DIAGNOSTICS_HREF}
            sx={STUCK_LINK_SX}
            title="These threads failed to summarize repeatedly. Open Diagnostics for details."
          >
            {parkedThreads === 1
              ? '1 conversation stuck — see Diagnostics'
              : `${parkedThreads} conversations stuck — see Diagnostics`}
          </Box>
          <IconButton
            size="small"
            aria-label="Dismiss stuck-conversation notice"
            title="Dismiss — returns if more conversations get stuck"
            onClick={() => handleDismissStuck(parkedThreads)}
            sx={STUCK_DISMISS_BTN_SX}
          >
            {DismissIcon}
          </IconButton>
        </Box>
      ) : null}
    </Box>
  );
}

export default RailStatus;
