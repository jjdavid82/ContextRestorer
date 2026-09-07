'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../../lib/bridge';
import type { LocalMetrics, MetricCount, MetricDuration } from '../../types/bridge';
import { PanelHeading } from './PanelHeading';

/**
 * Diagnostics panel (Task 4.4, step 4).
 *
 * Everything comes from `debug:metrics`, which reads `ai_calls`, `briefings` and
 * the last seven days of `trace-*.jsonl`. Nothing leaves the machine and nothing
 * is on a timer — cumulative, slow-moving numbers, so a Refresh button, not a
 * poll.
 *
 * Two layers on purpose: an "at a glance" summary (plain-language rows with a
 * status chip) answering "is briefing generation healthy?", and a collapsed
 * "Details" block with the raw `ai_calls` tables for anyone filing a bug. Only
 * a briefing P95 past the OI-1 budget and an `injection_pattern` gate drop earn
 * "Needs a look"; redaction counts are framed as the safety net working.
 *
 * "Not wired" is not "zero": the channel is registered only when the main
 * process got all three readers. When missing, the invoke rejects and this
 * panel says so — a fresh install legitimately reports zeros, and a wiring
 * mistake that looked identical would be undiscoverable.
 *
 * The collapsed Details tables still use the `.diag-*` / `.data-table` classes
 * in `globals.css` — dense read-only tables MUI would not improve; migrating
 * them is a later cleanup.
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
          lead="How briefing generation has been doing on this machine over the last 7 days. Read-only, and nothing here leaves the device."
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
        </>
      )}
    </Box>
  );
}
