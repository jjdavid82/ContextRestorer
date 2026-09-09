'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../../lib/bridge';
import type { ActivityEvent, LocalMetrics, MetricCount, MetricDuration } from '../../types/bridge';
import { PanelHeading } from './PanelHeading';

/**
 * Diagnostics panel.
 *
 * Everything comes from `debug:metrics`, which reads `ai_calls`, `briefings` and
 * the last seven days of `trace-*.jsonl`. Nothing leaves the machine and nothing
 * is on a timer — cumulative, slow-moving numbers, so a Refresh button, not a
 * poll.
 *
 * Three zones, built for a non-technical user:
 *
 *   1. **Status** — one verdict (`healthy` / `needs a look`) and two or three
 *      plain lines: how fast briefings run, and the local-only reassurance.
 *   2. **Recent activity** — the pipeline failures and deliberate discards from
 *      the last 7 days, each as one plain sentence with a relative time. This is
 *      the part that answers "did something get dropped?", which the old panel
 *      only ever showed as a 7-day count buried in a table.
 *   3. **Technical details** — the previous panel in full (summary rows + every
 *      raw `ai_calls` / trace table), collapsed. Unchanged; it is the bug-report
 *      payload and still uses the `.diag-*` / `.data-table` classes in
 *      `globals.css`.
 *
 * "Not wired" is not "zero": the channel is registered only when the main
 * process got all its readers. When missing, the invoke rejects and this panel
 * says so — a fresh install legitimately reports zeros, and a wiring mistake
 * that looked identical would be undiscoverable.
 */

/** OI-1: the synchronous briefing path carries a 45s P95 target. */
const BRIEFING_P95_BUDGET_MS = 45_000;

const LAYER_NAMES: Record<number, string> = { 1: 'Extraction', 2: 'Synthesis', 3: 'Briefing' };

function layerLabel(layer: number): string {
  const name = LAYER_NAMES[layer];
  return name === undefined ? `Layer ${layer}` : `${name} (Layer ${layer})`;
}

const OUTCOME_LABELS: Record<string, string> = {
  ok: 'Completed',
  error: 'Failed',
  stream_error: 'Interrupted mid-stream',
  budget_exceeded: 'Ran over the time budget',
  all_claims_dropped: 'Finished, but published nothing',
};

const GATE_REASON_LABELS: Record<string, string> = {
  no_citation: 'No source cited',
  not_in_context: 'Cited a source it was never shown',
  unknown_artifact: 'Cited a source that does not exist',
  injection_pattern: 'Looked like a planted instruction (prompt injection)',
  unsupported: 'Cited source did not back up the claim',
};

const TRIGGER_REASON_LABELS: Record<string, string> = {
  quiet: 'Conversation went quiet',
  hard_cap: 'Maximum wait reached',
};

const TRIGGER_OUTCOME_LABELS: Record<string, string> = {
  ok: 'Produced an update',
  not_meaningful: 'Nothing meaningful had changed',
  no_context: 'No citable context to work from',
  no_citations: 'Model gave an update with no citations',
  error: 'Failed',
};

/** `snake_case` → "Snake case", the fallback when a code has no friendly label. */
function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Render a duration in whole ms, or an em dash when there is no observation. */
function ms(value: number | null): string {
  return value === null ? '—' : `${value.toLocaleString()} ms`;
}

/** A compact, human duration: "420 ms", "8.2s", "1m 5s", or "no data". */
function humanDuration(value: number | null): string {
  if (value === null) return 'no data';
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}m ${s}s`;
}

/** Sum the `count` field across a `{ key, count }` list. */
function total(rows: MetricCount[]): number {
  return rows.reduce((n, row) => n + row.count, 0);
}

type Tone = 'good' | 'attention' | 'info' | 'none';

const CHIP_TEXT: Record<Tone, string> = {
  good: 'Healthy',
  attention: 'Needs a look',
  info: 'For info',
  none: 'No data yet',
};

const CHIP_COLOR: Record<Tone, 'success' | 'warning' | 'default'> = {
  good: 'success',
  attention: 'warning',
  info: 'default',
  none: 'default',
};

interface SummaryRow {
  key: string;
  label: string;
  tone: Tone;
  value: string;
  hint?: string;
}

/**
 * Turn the raw view into the "at a glance" rows. Deliberately conservative about
 * `attention`: only a briefing P95 past the OI-1 budget and an
 * `injection_pattern` gate drop earn it.
 */
function summarize(m: LocalMetrics): SummaryRow[] {
  const rows: SummaryRow[] = [];

  const bl = m.briefingLatency;
  if (bl.count === 0) {
    rows.push({
      key: 'speed',
      label: 'Briefing speed',
      tone: 'none',
      value: 'No briefings generated in the last 7 days.',
    });
  } else {
    const overBudget = bl.p95Ms !== null && bl.p95Ms > BRIEFING_P95_BUDGET_MS;
    rows.push({
      key: 'speed',
      label: 'Briefing speed',
      tone: overBudget ? 'attention' : 'good',
      value: `Usually ${humanDuration(bl.p50Ms)}, up to ${humanDuration(bl.p95Ms)} — over ${bl.count} briefing${bl.count === 1 ? '' : 's'}.`,
      ...(overBudget
        ? {
            hint: `The slowest runs are past the ${humanDuration(BRIEFING_P95_BUDGET_MS)} target. Switching to a smaller chat model (Chat model panel) is the usual fix.`,
          }
        : {}),
    });
  }

  const drops = total(m.gateDrops);
  const injection = m.gateDrops.find((r) => r.key === 'injection_pattern')?.count ?? 0;
  if (drops === 0) {
    rows.push({
      key: 'gate',
      label: 'Held-back claims',
      tone: 'good',
      value: 'Nothing withheld — every generated line was properly sourced.',
    });
  } else if (injection > 0) {
    rows.push({
      key: 'gate',
      label: 'Held-back claims',
      tone: 'attention',
      value: `${drops} line${drops === 1 ? '' : 's'} withheld; ${injection} because ${injection === 1 ? 'it' : 'they'} looked like a planted instruction.`,
      hint: 'Worth a look — open a recent briefing and check nothing important is missing. Full breakdown under Details below.',
    });
  } else {
    rows.push({
      key: 'gate',
      label: 'Held-back claims',
      tone: 'info',
      value: `${drops} line${drops === 1 ? '' : 's'} withheld for missing or weak citations — the gate working as intended.`,
      hint: 'Per-reason breakdown under Details below.',
    });
  }

  if (m.redactionCount === 0) {
    rows.push({
      key: 'redaction',
      label: 'Sensitive-data redaction',
      tone: 'good',
      value: 'No sensitive values found in delivered briefings.',
    });
  } else {
    rows.push({
      key: 'redaction',
      label: 'Sensitive-data redaction',
      tone: 'info',
      value: `${m.redactionCount} value${m.redactionCount === 1 ? '' : 's'} removed from ${m.redactedClaims} published line${m.redactedClaims === 1 ? '' : 's'} before delivery.`,
      hint: 'This is the safety net doing its job, not an error.',
    });
  }

  const calls = m.layers.reduce((n, row) => n + row.calls, 0);
  rows.push({
    key: 'activity',
    label: 'Local model activity',
    tone: calls === 0 ? 'none' : 'info',
    value:
      calls === 0
        ? 'No model calls recorded yet.'
        : `${calls.toLocaleString()} call${calls === 1 ? '' : 's'} across ${m.layers.length} stage${m.layers.length === 1 ? '' : 's'}, all on this machine.`,
  });

  return rows;
}

/** One "at a glance" row: chip, label, plain-language value, optional hint. */
function SummaryItem({ row }: { row: SummaryRow }): ReactNode {
  return (
    <Box component="li" sx={{ p: 1.75, '& + li': { borderTop: 1, borderColor: 'divider' } }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Chip
          size="small"
          variant="outlined"
          color={CHIP_COLOR[row.tone]}
          label={CHIP_TEXT[row.tone]}
        />
        <Typography sx={{ fontWeight: 600 }}>{row.label}</Typography>
      </Box>
      <Typography sx={{ lineHeight: 1.5 }}>{row.value}</Typography>
      {row.hint !== undefined ? (
        <Typography sx={{ mt: 0.5, fontSize: '0.85rem', color: 'text.secondary' }}>
          {row.hint}
        </Typography>
      ) : null}
    </Box>
  );
}

// ===========================================================================
// Zone 1 — Status headline
// ===========================================================================

interface Verdict {
  tone: Tone;
  headline: string;
}

/**
 * One plain-language verdict for the top of the panel. Deliberately only two
 * real states: `attention` when the recent-activity feed holds anything the
 * user should look at (a parked thread, an injection-shaped drop) or the slowest
 * briefings run past the OI-1 budget; `good` otherwise. `none` is the untouched
 * install.
 */
function computeVerdict(m: LocalMetrics): Verdict {
  const idle = m.briefingLatency.count === 0 && m.layers.length === 0;
  if (idle) {
    return { tone: 'none', headline: 'Nothing has run yet' };
  }
  const needsLook =
    m.recentActivity.some((e) => e.severity === 'attention') ||
    (m.briefingLatency.p95Ms !== null && m.briefingLatency.p95Ms > BRIEFING_P95_BUDGET_MS);
  return needsLook
    ? { tone: 'attention', headline: 'A few things are worth a look' }
    : { tone: 'good', headline: 'Everything looks healthy' };
}

function StatusHeadline({ metrics, nowMs }: { metrics: LocalMetrics; nowMs: number }): ReactNode {
  const verdict = computeVerdict(metrics);
  const bl = metrics.briefingLatency;
  const slow = bl.p95Ms !== null && bl.p95Ms > BRIEFING_P95_BUDGET_MS;

  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 2,
        mb: 3,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
      }}
    >
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        <Chip
          size="small"
          variant="outlined"
          color={CHIP_COLOR[verdict.tone]}
          label={CHIP_TEXT[verdict.tone]}
        />
        <Typography sx={{ fontWeight: 650, fontSize: '1rem' }}>{verdict.headline}</Typography>
      </Box>

      {bl.count > 0 ? (
        <Typography sx={{ fontSize: '0.9rem', lineHeight: 1.5 }}>
          Briefings usually finish in about {humanDuration(bl.p50Ms)}
          {slow ? `, but the slowest have run past the ${humanDuration(BRIEFING_P95_BUDGET_MS)} target` : ''} —
          over {bl.count} in the last 7 days.
          {slow ? ' Switching to a smaller chat model (Chat model panel) is the usual fix.' : ''}
        </Typography>
      ) : (
        <Typography sx={{ fontSize: '0.9rem', color: 'text.secondary' }}>
          No briefings have been generated in the last 7 days.
        </Typography>
      )}

      {metrics.lastBriefingAt !== null ? (
        <Typography sx={{ fontSize: '0.9rem', color: 'text.secondary' }}>
          Last briefing: {relativeTime(metrics.lastBriefingAt, nowMs)}.
        </Typography>
      ) : null}

      <Typography sx={{ fontSize: '0.9rem', color: 'text.secondary', lineHeight: 1.5 }}>
        All processing runs on this computer. Nothing here — messages, summaries, or briefings — is ever
        sent to a server.
      </Typography>
    </Box>
  );
}

// ===========================================================================
// Zone 2 — Recent activity feed
// ===========================================================================

/** A compact, human "time since": "just now", "12 min ago", "yesterday". */
function relativeTime(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Plain-language copy per event kind. `next` is the dim "what happens now" line. */
const ACTIVITY_COPY: Record<ActivityEvent['kind'], (n: number) => { text: string; next?: string }> = {
  // Only reached now by a thread that genuinely kept failing. A thread whose
  // messages are all chatter no longer lands here: Layer 2 reports that as a
  // settled `no_signal` rather than spending ten retries and reporting a
  // failure (`layer2/synthesize.ts`), which is what used to fill this feed.
  //
  // The old "next" line — "it will be picked up again automatically as the
  // conversation continues" — was false: a new message restarts the quiet clock
  // but never cleared the attempt counter, and a parked thread is filtered out
  // of `due()`, so nothing ever picked it up again. It is true now, and stated
  // as the narrower thing it actually is: new content that can be summarized.
  thread_parked: () => ({
    text: 'A conversation kept failing to summarize, so it was set aside.',
    next: 'It will be tried again once a new message arrives on it with something to summarize.',
  }),
  gate_injection: (n) => ({
    text: `${n} ${n === 1 ? 'line was' : 'lines were'} kept out of a briefing for looking like a planted instruction.`,
    next: 'Worth opening the most recent briefing to check nothing important is missing.',
  }),
  gate_drops: (n) => ({
    text: `${n} ${n === 1 ? 'line was' : 'lines were'} left out of a briefing because ${
      n === 1 ? 'it wasn’t' : 'they weren’t'
    } backed by a source.`,
  }),
  // NOT "a briefing used a simpler format": under P0 the deterministic
  // briefing is the designed output, and every delivered one takes that path.
  // This row now fires only when the model was genuinely unavailable, which is
  // a different and much rarer thing.
  briefing_fallback: () => ({
    text: 'A briefing was written without the model because it wasn’t available.',
    next: 'Check that Ollama is running; the briefing itself is complete and cited either way.',
  }),
  extraction_writeoff: (n) => ({
    text: `${n} ${n === 1 ? 'message' : 'messages'} couldn’t be read by the model and ${
      n === 1 ? 'was' : 'were'
    } set aside.`,
  }),
  model_error: () => ({
    text: 'A processing step failed and was retried.',
  }),
  noise_skipped: (n) => ({
    text: `${n} automated ${n === 1 ? 'message' : 'messages'} (bots, notifications) skipped — this is normal.`,
  }),
};

const DOT_COLOR: Record<ActivityEvent['severity'], string> = {
  attention: 'var(--mui-palette-warning-main)',
  info: 'var(--mui-palette-text-secondary)',
};

function ActivityRow({ event, nowMs }: { event: ActivityEvent; nowMs: number }): ReactNode {
  const copy = ACTIVITY_COPY[event.kind]?.(event.count) ?? { text: humanize(event.kind) };
  return (
    <Box
      component="li"
      sx={{ display: 'flex', gap: 1.25, p: 1.5, '& + li': { borderTop: 1, borderColor: 'divider' } }}
    >
      {/* Runtime colour → a plain `style` attribute (CSP `style-src-attr`), not
          `sx`, which Pigment cannot extract for a computed value. */}
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          flexShrink: 0,
          marginTop: 6,
          backgroundColor: DOT_COLOR[event.severity],
        }}
      />
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: '0.72rem', color: 'text.secondary', mb: 0.25 }}>
          {relativeTime(event.atMs, nowMs)}
        </Typography>
        <Typography sx={{ fontSize: '0.9rem', lineHeight: 1.45 }}>{copy.text}</Typography>
        {copy.next !== undefined ? (
          <Typography sx={{ fontSize: '0.82rem', color: 'text.secondary', mt: 0.25 }}>
            {copy.next}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}

/** How many activity rows show before the "See more" toggle. A feed, not a log. */
const ACTIVITY_PREVIEW_COUNT = 5;

function RecentActivity({ events, nowMs }: { events: ActivityEvent[]; nowMs: number }): ReactNode {
  const attention = events.filter((e) => e.severity === 'attention').length;
  const [expanded, setExpanded] = useState(false);
  const hasMore = events.length > ACTIVITY_PREVIEW_COUNT;
  const visible = expanded || !hasMore ? events : events.slice(0, ACTIVITY_PREVIEW_COUNT);
  return (
    <Box sx={{ mb: 3 }}>
      <Typography
        component="h3"
        sx={{
          fontSize: '0.7rem',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'text.secondary',
          mb: 1,
        }}
      >
        Recent activity · last 7 days
      </Typography>

      {events.length === 0 ? (
        <Typography sx={{ fontSize: '0.9rem', color: 'text.secondary' }}>
          Nothing has been dropped or failed. Everything the app took in was processed.
        </Typography>
      ) : (
        <>
          <Box
            component="ul"
            sx={{
              listStyle: 'none',
              p: 0,
              m: 0,
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              overflow: 'hidden',
            }}
          >
            {visible.map((event, i) => (
              <ActivityRow key={`${event.kind}-${event.atMs}-${i}`} event={event} nowMs={nowMs} />
            ))}
          </Box>
          {hasMore ? (
            <Button
              size="small"
              variant="text"
              onClick={() => setExpanded((v) => !v)}
              sx={{ mt: 0.5, px: 0.5 }}
            >
              {expanded
                ? 'See fewer'
                : `See ${events.length - ACTIVITY_PREVIEW_COUNT} more`}
            </Button>
          ) : null}
          <Typography sx={{ mt: 1, fontSize: '0.82rem', color: 'text.secondary' }}>
            {attention === 0
              ? 'None of this needs your attention — it’s the pipeline working as intended.'
              : `${attention} of these may need a look (marked in amber).`}
          </Typography>
        </>
      )}
    </Box>
  );
}

// ===========================================================================
// Zone 3 — Technical details (unchanged from the previous panel)
// ===========================================================================

/** A `{ key, count }` list with friendly labels, or an explicit empty line. */
function LabeledCounts({
  rows,
  labels,
  empty,
}: {
  rows: MetricCount[];
  labels: Record<string, string>;
  empty: string;
}): ReactNode {
  if (rows.length === 0) return <p className="diag-section__empty">{empty}</p>;
  return (
    <ul className="diag-count-list">
      {rows.map((row) => (
        <li key={row.key} className="diag-count-list__item">
          <span className="diag-count-list__n">{row.count.toLocaleString()}</span>
          <span>
            {labels[row.key] ?? humanize(row.key)}{' '}
            <code className="diag-count-list__code">{row.key}</code>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A `{ count, p50, p95 }` distribution as one line. */
function Distribution({ label, value }: { label: string; value: MetricDuration }): ReactNode {
  return (
    <p className="metrics__line">
      {label}: <strong>{value.count}</strong> observation(s), P50 {ms(value.p50Ms)}, P95{' '}
      {ms(value.p95Ms)}
    </p>
  );
}

/** A collapsed detail block. */
function DetailSection({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <details className="diag-section">
      <summary>{title}</summary>
      <div className="diag-section__body">{children}</div>
    </details>
  );
}

const CALLOUT_SX = {
  border: 1,
  borderLeft: 4,
  borderColor: 'divider',
  borderLeftColor: 'text.secondary',
  borderRadius: 1,
  p: 2,
  my: 2,
} as const;

export default function LocalMetricsPanel(): ReactNode {
  const [metrics, setMetrics] = useState<LocalMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setMetrics(await getBridge().debug.metrics());
      setLoadedAt(Date.now());
    } catch (cause) {
      // The expected failure when the main process was wired without the metrics
      // readers: an unhandled channel. Reported, never swallowed.
      setError(cause instanceof Error ? cause.message : String(cause));
      setMetrics(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!hasBridge()) {
      setError('Diagnostics are only available inside the Context Restorer desktop app.');
      return;
    }
    void load();
  }, [load]);

  return (
    <Box aria-label="Diagnostics">
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
        <PanelHeading
          title="Diagnostics"
          lead="How the app has been doing on this machine over the last 7 days, and anything it had to drop or retry. Read-only, and nothing here leaves the device."
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {loadedAt !== null ? (
            <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
              Updated {new Date(loadedAt).toLocaleTimeString()}
            </Typography>
          ) : null}
          <Button size="small" variant="outlined" disabled={busy} onClick={() => void load()}>
            {busy ? 'Reading…' : 'Refresh'}
          </Button>
        </Box>
      </Box>

      {error !== null ? (
        <Box role="status" sx={CALLOUT_SX}>
          <Typography sx={{ fontWeight: 600 }}>Diagnostics aren’t available right now</Typography>
          <Typography sx={{ color: 'text.secondary', mt: 0.5 }}>
            The app started without its metrics readers, so there is nothing to show. This is a
            setup detail, not a fault — a healthy install with the readers wired simply shows zeros
            until briefings start running.
          </Typography>
          <Typography sx={{ color: 'text.secondary', mt: 0.5, fontSize: '0.8rem' }}>
            Technical detail: {error}
          </Typography>
        </Box>
      ) : null}

      {metrics === null ? (
        error === null ? (
          <Typography sx={{ color: 'text.secondary' }}>Loading…</Typography>
        ) : null
      ) : !metrics.available ? (
        <Box role="status" sx={CALLOUT_SX}>
          <Typography sx={{ fontWeight: 600 }}>Diagnostics couldn’t be read</Typography>
          <Typography sx={{ color: 'text.secondary', mt: 0.5 }}>
            {metrics.reason ?? 'unknown reason'}
          </Typography>
        </Box>
      ) : (
        <>
          <StatusHeadline metrics={metrics} nowMs={loadedAt ?? Date.now()} />
          <RecentActivity events={metrics.recentActivity} nowMs={loadedAt ?? Date.now()} />

          <details className="diag-section">
            <summary>Technical details</summary>
            <div className="diag-section__body">
          <Box
            component="ul"
            sx={{ listStyle: 'none', p: 0, m: '0 0 24px', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}
          >
            {summarize(metrics).map((row) => (
              <SummaryItem key={row.key} row={row} />
            ))}
          </Box>

          <div className="diag-details">
            <Typography
              component="h3"
              sx={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.secondary', mb: 1 }}
            >
              Details
            </Typography>

            <DetailSection title="Model calls by stage">
              {metrics.layers.length === 0 ? (
                <p className="diag-section__empty">No model calls recorded yet.</p>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th align="left">Stage</th>
                      <th align="right">Calls</th>
                      <th align="right">Average time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.layers.map((row) => (
                      <tr key={row.layer}>
                        <td>{layerLabel(row.layer)}</td>
                        <td align="right">{row.calls.toLocaleString()}</td>
                        <td align="right">{ms(row.meanLatencyMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DetailSection>

            <DetailSection title="Call outcomes">
              {metrics.outcomes.length === 0 ? (
                <p className="diag-section__empty">Nothing recorded yet.</p>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th align="left">Stage</th>
                      <th align="left">Outcome</th>
                      <th align="right">Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.outcomes.map((row) => (
                      <tr key={`${row.layer}:${row.outcome}`}>
                        <td>{layerLabel(row.layer)}</td>
                        <td>
                          {OUTCOME_LABELS[row.outcome] ?? humanize(row.outcome)}{' '}
                          <code className="diag-count-list__code">{row.outcome}</code>
                        </td>
                        <td align="right">{row.calls.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DetailSection>

            <DetailSection title="Briefing timing">
              <Distribution label="End to end" value={metrics.briefingLatency} />
              <Distribution label="Time to re-entry" value={metrics.reEntry} />
              <p className="diag-section__empty">
                Target: 95% of briefings within {humanDuration(BRIEFING_P95_BUDGET_MS)} (OI-1).
              </p>
            </DetailSection>

            <DetailSection title="Held-back claims by reason">
              <LabeledCounts
                rows={metrics.gateDrops}
                labels={GATE_REASON_LABELS}
                empty="No claims have been withheld."
              />
            </DetailSection>

            <DetailSection title="Sensitive-data redaction (SEC-5)">
              <p className="metrics__line">
                <strong>{metrics.redactionCount}</strong> value(s) removed from{' '}
                <strong>{metrics.redactedClaims}</strong> published claim(s).
              </p>
              <p className="metrics__line">
                Kinds detected:{' '}
                {metrics.redactionKinds.length === 0 ? 'none' : metrics.redactionKinds.join(', ')}
              </p>
            </DetailSection>

            <DetailSection title="Synthesis triggers">
              <p className="metrics__line">
                <strong>{metrics.triggers.total}</strong> trigger(s) logged.
              </p>
              <p className="diag-section__subhead">Why they fired</p>
              <LabeledCounts
                rows={metrics.triggers.byReason}
                labels={TRIGGER_REASON_LABELS}
                empty="No triggers logged."
              />
              <p className="diag-section__subhead">What came of them</p>
              <LabeledCounts
                rows={metrics.triggers.byOutcome}
                labels={TRIGGER_OUTCOME_LABELS}
                empty="No trigger outcomes logged."
              />
            </DetailSection>
          </div>

          <Typography sx={{ mt: 2, fontSize: '0.8rem', color: 'text.secondary' }}>
            Based on {metrics.tracesRead.toLocaleString()} trace entr
            {metrics.tracesRead === 1 ? 'y' : 'ies'} from the last 7 days
            {metrics.unparseableTraceLines > 0
              ? `; ${metrics.unparseableTraceLines} line(s) could not be parsed`
              : ''}
            .
          </Typography>
            </div>
          </details>
        </>
      )}
    </Box>
  );
}
