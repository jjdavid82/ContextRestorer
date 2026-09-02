'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../lib/bridge';
import type { PipelineStatus } from '../types/bridge';

/**
 * Live "what is the pipeline doing right now" strip.
 *
 * Ingestion, Layer 1 extraction, and Layer 2 synthesis all run silently in the
 * background — a user who sends themselves a test email and watches the home
 * page has no way to tell "nothing has happened yet" from "something is
 * broken" without this: both look identical (nothing on screen changes) until
 * a briefing eventually reflects the result, minutes later.
 *
 * Same subscribe/unsubscribe pattern as `SourceHealthPanel`: `pipeline:status`
 * is a push, not an invoke, so the effect subscribes once and tears down on
 * unmount rather than polling.
 */
export function PipelineStatusPanel(): ReactNode {
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBridge()) {
      setError('Pipeline activity is only available inside the Context Restorer desktop app.');
      return;
    }

    try {
      const unsubscribe = getBridge().pipeline.onStatus(setStatus);
      return unsubscribe;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
  }, []);

  if (error !== null) {
    return (
      <section className="card" aria-label="Pipeline activity">
        <p role="alert">{error}</p>
      </section>
    );
  }

  const idle =
    status !== null &&
    status.extractionBacklog === 0 &&
    status.synthesisDue === 0 &&
    status.synthesisInFlight === 0;

  return (
    <section className="card" aria-label="Pipeline activity">
      <h2 className="section-heading section-heading--flush">Processing</h2>
      {status === null ? (
        <p className="muted-note">Waiting for the first status report…</p>
      ) : idle ? (
        <p className="muted-note">Nothing waiting.</p>
      ) : (
        <ul className="bullet-list">
          {status.extractionBacklog > 0 ? (
            <li>
              Reading {status.extractionBacklog} new message
              {status.extractionBacklog === 1 ? '' : 's'}…
            </li>
          ) : null}
          {status.synthesisInFlight > 0 ? (
            <li>
              Summarizing {status.synthesisInFlight} conversation
              {status.synthesisInFlight === 1 ? '' : 's'} right now…
            </li>
          ) : null}
          {status.synthesisDue > 0 ? (
            <li>
              {status.synthesisDue} conversation{status.synthesisDue === 1 ? '' : 's'} queued for
              summarizing — checked at least every 30s.
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

export default PipelineStatusPanel;
