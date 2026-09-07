'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge } from '../../lib/bridge';
import type { LocalMetrics, MetricCount, MetricDuration } from '../../types/bridge';

/**
 * Diagnostics panel (Task 4.4, step 4).
 *
 * Everything it shows comes from `debug:metrics`, which reads `ai_calls`,
 * `briefings` and the last seven days of `trace-*.jsonl`. Nothing here leaves
 * the machine and nothing here is on a timer — the numbers are cumulative and
 * slow-moving, so there is a Refresh button instead of a poll loop.
 *
 * ## Layout
 *
 * The panel is two layers deep on purpose:
 *
 *   - **At a glance** — three or four plain-language rows, each with a status
 *     chip, that answer "is briefing generation healthy, and is there anything
 *     I should look at?" without the reader having to interpret a raw count.
 *   - **Details** — the underlying tables and per-reason breakdowns, collapsed
 *     by default behind native `<details>` disclosures. This is where the raw
 *     `ai_calls` layer/outcome numbers and the trace-log counters live for
 *     anyone filing a bug.
 *
 * The only signals the summary calls "needs a look" are the ones that are
 * genuinely actionable: a briefing P95 past the OI-1 budget, and a citation-gate
 * drop attributed to `injection_pattern` (the T-1 detector firing on real
 * output). Redaction counts are framed as the safety net working, not as a
 * fault — a leak caught silently is indistinguishable from no leak, and the
 * point of surfacing it is reassurance, not alarm.
 *
 * ## "Not wired" is not "zero"
 *
 * The channel is registered only when the main process was given all three
 * readers. When it is missing, the invoke rejects and this panel says so
 * explicitly — because a fresh install legitimately reports zero of everything,
 * and a wiring mistake that looked identical to a quiet install would be
 * undiscoverable.
 */

/** OI-1: the synchronous briefing path carries a 45s P95 target. */
const BRIEFING_P95_BUDGET_MS = 45_000;

/** Human names for the pipeline layers `ai_calls` records as bare integers. */
const LAYER_NAMES: Record<number, string> = {
  1: 'Extraction',
  2: 'Synthesis',
  3: 'Briefing',
};

/** `2` → "Synthesis (Layer 2)"; an unknown layer falls back to "Layer N". */
function layerLabel(layer: number): string {
  const name = LAYER_NAMES[layer];
  return name === undefined ? `Layer ${layer}` : `${name} (Layer ${layer})`;
}

/** `ai_calls.outcome` codes in plain language. */
const OUTCOME_LABELS: Record<string, string> = {
  ok: 'Completed',
  error: 'Failed',
  stream_error: 'Interrupted mid-stream',
  budget_exceeded: 'Ran over the time budget',
  all_claims_dropped: 'Finished, but published nothing',
};

/** Citation-gate drop reasons in plain language. */
const GATE_REASON_LABELS: Record<string, string> = {
  no_citation: 'No source cited',
  not_in_context: 'Cited a source it was never shown',
  unknown_artifact: 'Cited a source that does not exist',
  injection_pattern: 'Looked like a planted instruction (prompt injection)',
  unsupported: 'Cited source did not back up the claim',
};

/** Layer-2 synthesis trigger reasons in plain language. */
const TRIGGER_REASON_LABELS: Record<string, string> = {
  quiet: 'Conversation went quiet',
  hard_cap: 'Maximum wait reached',
};

/** Layer-2 synthesis trigger outcomes in plain language. */
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

interface SummaryRow {
  key: string;
  label: string;
  tone: Tone;
  value: string;
  hint?: string;
}

/**
 * Turn the raw view into the "at a glance" rows.
 *
 * Deliberately conservative about `attention`: only a briefing P95 past the
 * OI-1 budget and an `injection_pattern` gate drop earn it. Everything else is
 * `good`, `info`, or `none`.
 */
function summarize(m: LocalMetrics): SummaryRow[] {
  const rows: SummaryRow[] = [];

  // 1. Briefing speed — against the OI-1 45s P95 target.
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
            hint: `The slowest runs are past the ${humanDuration(BRIEFING_P95_BUDGET_MS)} target. Switching to a smaller chat model (Settings → Chat model) is the usual fix.`,
          }
        : {}),
    });
  }

  // 2. Held-back claims — the citation gate. `injection_pattern` is the one
  //    reason worth pulling a human in.
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

  // 3. Redaction (SEC-5) — reassurance, never framed as a fault.
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

  // 4. Pipeline activity — is the local model being called at all?
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
    <li className="diag-row">
      <div className="diag-row__top">
        <span className={`status-chip status-chip--${row.tone}`}>{CHIP_TEXT[row.tone]}</span>
        <span className="diag-row__label">{row.label}</span>
      </div>
      <p className="diag-row__value">{row.value}</p>
      {row.hint !== undefined ? <p className="diag-row__hint">{row.hint}</p> : null}
    </li>
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
function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <details className="diag-section">
      <summary>{title}</summary>
      <div className="diag-section__body">{children}</div>
    </details>
  );
}

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
    void load();
  }, [load]);

  const refreshButton = (
    <button
      type="button"
      className="btn btn--secondary"
      disabled={busy}
      onClick={() => void load()}
    >
      {busy ? 'Reading…' : 'Refresh'}
    </button>
  );

  return (
    <section className="card" aria-label="Diagnostics">
      <div className="diag-header">
        <h2>Diagnostics</h2>
        <div className="diag-actions">
          {loadedAt !== null ? (
            <span className="diag-updated">
              Updated {new Date(loadedAt).toLocaleTimeString()}
            </span>
          ) : null}
          {refreshButton}
        </div>
      </div>
      <p className="diag-intro">
        How briefing generation has been doing on this machine over the last 7 days. Read-only, and
        nothing here leaves the device.
      </p>

      {error !== null ? (
        <div className="diag-callout diag-callout--muted" role="status">
          <p className="diag-callout__title">Diagnostics aren’t available right now</p>
          <p className="muted-note">
            The app started without its metrics readers, so there is nothing to show. This is a
            setup detail, not a fault — a healthy install with the readers wired simply shows zeros
            until briefings start running.
          </p>
          <p className="muted-note">
            <small>Technical detail: {error}</small>
          </p>
        </div>
      ) : null}

      {metrics === null ? (
        error === null ? (
          <p className="muted-note">Loading…</p>
        ) : null
      ) : !metrics.available ? (
        <div className="diag-callout diag-callout--muted" role="status">
          <p className="diag-callout__title">Diagnostics couldn’t be read</p>
          <p className="muted-note">{metrics.reason ?? 'unknown reason'}</p>
        </div>
      ) : (
        <>
          <ul className="diag-summary list-reset">
            {summarize(metrics).map((row) => (
              <SummaryItem key={row.key} row={row} />
            ))}
          </ul>

          <div className="diag-details">
            <h3 className="diag-details__title">Details</h3>

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
              {/* `injection_pattern` here means the T-1 detector fired on real
                  generated output, which is worth a human look. */}
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
                {metrics.redactionKinds.length === 0
                  ? 'none'
                  : metrics.redactionKinds.join(', ')}
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

          <p className="diag-footer">
            <small>
              Based on {metrics.tracesRead.toLocaleString()} trace entr
              {metrics.tracesRead === 1 ? 'y' : 'ies'} from the last 7 days
              {metrics.unparseableTraceLines > 0
                ? `; ${metrics.unparseableTraceLines} line(s) could not be parsed`
                : ''}
              .
            </small>
          </p>
        </>
      )}
    </section>
  );
}
