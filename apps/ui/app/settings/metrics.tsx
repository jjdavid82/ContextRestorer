'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge } from '../../lib/bridge';
import type { LocalMetrics, MetricCount, MetricDuration } from '../../types/bridge';

/**
 * Local metrics panel (Task 4.4, step 4).
 *
 * A debugging surface, and shaped like one: plain definition lists and plain
 * tables, no charts, no colour, no thresholds, no opinion about which numbers
 * are bad. Everything it shows comes from `debug:metrics`, which reads
 * `ai_calls`, `briefings` and the last seven days of `trace-*.jsonl`.
 *
 * ## What it is for
 *
 * Four of the numbers here had no reader at all before this task, which is the
 * only reason the panel exists:
 *
 *   - **gate drops by reason.** `injection_pattern` is the T-1 detector having
 *     fired: the model obeyed an instruction planted in a thread and the gate
 *     caught it. That event was completely invisible before Task 4.4.
 *   - **`all_claims_dropped`** in the outcome table: a generation that published
 *     nothing, which used to be recorded as `ok`.
 *   - **redaction counts** (SEC-5): a leak that was caught. A leak caught
 *     silently is indistinguishable from no leak.
 *   - **trigger outcomes** (D-7): how often a fired thread actually produced a
 *     delta, versus deciding nothing was meaningful.
 *
 * ## "Not wired" is not "zero"
 *
 * The channel is registered only when the main process was given all three
 * readers. When it is missing, the invoke rejects and this panel says so —
 * because a fresh install legitimately reports zero of everything, and a wiring
 * mistake that looked identical to a quiet install would be undiscoverable.
 *
 * Nothing here is on a timer: the numbers are cumulative and slow-moving, so a
 * poll loop would burn a SQL round trip per interval to redraw the same table.
 * There is a Refresh button.
 */

/** Render a duration in whole ms, or an em dash when there is no observation. */
function ms(value: number | null): string {
  return value === null ? '—' : `${value.toLocaleString()} ms`;
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

/** A `{ key, count }` list, or an explicit "none" so an empty list is legible. */
function Counts({ rows, empty }: { rows: MetricCount[]; empty: string }): ReactNode {
  if (rows.length === 0) return <p className="metrics__line">{empty}</p>;
  return (
    <ul className="metrics__list">
      {rows.map((row) => (
        <li key={row.key}>
          <code>{row.key}</code>: <strong>{row.count}</strong>
        </li>
      ))}
    </ul>
  );
}

export default function LocalMetricsPanel(): ReactNode {
  const [metrics, setMetrics] = useState<LocalMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setMetrics(await getBridge().debug.metrics());
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

  return (
    <section className="card">
      <h2>Diagnostics</h2>
      <p>
        <small>
          Local counters from this machine only, over the last 7 days of trace logs. Nothing here
          leaves the device.
        </small>
      </p>
      <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void load()}>
        {busy ? 'Reading…' : 'Refresh'}
      </button>

      {error !== null ? (
        <p role="alert">
          Metrics are not available: {error}
          <br />
          <small>This usually means the main process was started without the metrics readers.</small>
        </p>
      ) : null}

      {metrics === null ? null : !metrics.available ? (
        <p role="alert">Metrics could not be read: {metrics.reason ?? 'unknown reason'}</p>
      ) : (
        <>
          <h3>Model calls by layer</h3>
          {metrics.layers.length === 0 ? (
            <p>No model calls recorded yet.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th align="left">Layer</th>
                  <th align="right">Calls</th>
                  <th align="right">Mean latency</th>
                </tr>
              </thead>
              <tbody>
                {metrics.layers.map((row) => (
                  <tr key={row.layer}>
                    <td>{row.layer}</td>
                    <td align="right">{row.calls.toLocaleString()}</td>
                    <td align="right">{ms(row.meanLatencyMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Outcomes</h3>
          {metrics.outcomes.length === 0 ? (
            <p>Nothing recorded yet.</p>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th align="left">Layer</th>
                  <th align="left">Outcome</th>
                  <th align="right">Calls</th>
                </tr>
              </thead>
              <tbody>
                {metrics.outcomes.map((row) => (
                  <tr key={`${row.layer}:${row.outcome}`}>
                    <td>{row.layer}</td>
                    <td>
                      <code>{row.outcome}</code>
                    </td>
                    <td align="right">{row.calls.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>Briefing latency</h3>
          <Distribution label="End to end" value={metrics.briefingLatency} />
          <Distribution label="Time to re-entry" value={metrics.reEntry} />

          <h3>Citation gate</h3>
          {/* The T-1 line. `injection_pattern` here means the detector fired on
              real generated output, which is worth a human look. */}
          <Counts rows={metrics.gateDrops} empty="No claims have been withheld." />

          <h3>Output redaction (SEC-5)</h3>
          <p className="metrics__line">
            <strong>{metrics.redactionCount}</strong> value(s) removed from{' '}
            <strong>{metrics.redactedClaims}</strong> published claim(s).
          </p>
          <p className="metrics__line">
            Kinds:{' '}
            {metrics.redactionKinds.length === 0 ? 'none' : metrics.redactionKinds.join(', ')}
          </p>

          <h3>Synthesis triggers</h3>
          <p className="metrics__line">
            <strong>{metrics.triggers.total}</strong> trigger(s) logged.
          </p>
          <Counts rows={metrics.triggers.byReason} empty="No triggers logged." />
          <Counts rows={metrics.triggers.byOutcome} empty="No trigger outcomes logged." />

          <p>
            <small>
              Read {metrics.tracesRead.toLocaleString()} trace line(s)
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
