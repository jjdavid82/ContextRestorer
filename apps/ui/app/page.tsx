'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { BriefingView } from '../components/BriefingView';
import { PipelineStatusPanel } from '../components/PipelineStatus';
import { SourceHealthPanel } from '../components/SourceHealth';
import { getBridge } from '../lib/bridge';
import type { OnboardingStatus } from '../types/bridge';

/** How far back an on-demand briefing looks. */
const BRIEFING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Placeholder home page.
 *
 * Beyond proving the preload bridge types resolve (Task 0.8), this reads
 * `onboarding:status` to decide whether the briefing action can run yet. The
 * original OI-3 gate required declared projects first; that requirement was
 * relaxed (declared-project stakes have no ranking effect until project
 * linking is implemented, so nothing was actually gated on a real signal).
 * The only remaining requirement is that status has loaded at all — a status
 * that failed to load still fails CLOSED, since `readyForBriefing` is derived
 * from it being non-null.
 */
export default function HomePage(): ReactNode {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [briefingId, setBriefingId] = useState<string | null>(null);

  useEffect(() => {
    // Guards against setting state after the component unmounts mid-request.
    let active = true;

    const fail = (cause: unknown): void => {
      if (active) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    try {
      // `getBridge()` throws synchronously when the preload bridge is missing,
      // so the call itself has to sit inside the try, not just the promise.
      getBridge()
        .onboarding.status()
        .then((next) => {
          if (active) {
            setStatus(next);
          }
        })
        .catch(fail);
    } catch (cause) {
      fail(cause);
    }

    return () => {
      active = false;
    };
  }, []);

  // Declaring projects is optional (OI-3 relaxed — see `onboarding/page.tsx`):
  // declared-project stakes have no ranking effect yet, so there is nothing to
  // gate the briefing action on beyond having loaded onboarding status at all.
  const readyForBriefing = status !== null;

  const requestBriefing = (): void => {
    setBriefingError(null);
    const windowEnd = Date.now();
    try {
      getBridge()
        .briefing.request({ windowStart: windowEnd - BRIEFING_WINDOW_MS, windowEnd })
        .then((handle) => setBriefingId(handle.briefingId))
        .catch((cause: unknown) =>
          setBriefingError(cause instanceof Error ? cause.message : String(cause)),
        );
    } catch (cause) {
      setBriefingError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <main className="dashboard-main">
      {/* "Context Restorer" already appears once, in the persistent nav brand
          (`app/layout.tsx`) — a second `<h1>` here just repeated it. */}
      <section className="dashboard-primary">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!readyForBriefing}
          onClick={requestBriefing}
        >
          Brief me on what I missed
        </button>
        {status !== null && status.projectsDeclared.length === 0 ? (
          <p>
            <small>
              No projects declared yet — optional, but{' '}
              {/* Root-relative, with the filename spelled out: the bundle is served
                  over the `app://` protocol (a fixed-host "standard" scheme), whose
                  handler cannot fetch a directory-style URL, and whose root-relative
                  resolution is what makes this correct from any route depth. */}
              <a href="/onboarding/index.html">you can add some</a>.
            </small>
          </p>
        ) : null}
        {error !== null ? <p role="alert">Bridge unavailable: {error}</p> : null}
        {briefingError !== null ? <p role="alert">Briefing failed: {briefingError}</p> : null}

        {/* The briefing itself (Task 3.6), kept in the SAME section as the button
            that requests it — "What you missed" is this action's direct result,
            not an unrelated part of the page — but rendered as its OWN card
            (`.cr-briefing`, in `BriefingView.tsx`) rather than folded into the
            button's plain surroundings, so the result reads as visually distinct
            from the control that produced it. Mounted only once a briefing has
            been requested, and handed the resulting id: this page owns the
            request so the OI-3 gate above stays the single place that decides
            whether a briefing may be generated at all. `BriefingView` then
            subscribes to the stream and paints "Waiting on you" from
            `briefing:pending`. */}
        {briefingId !== null ? <BriefingView briefingId={briefingId} /> : null}
      </section>

      {/* Secondary, at-a-glance status — connector health and pipeline activity.
          Demoted below the briefing itself (no card shadow): useful to have on
          screen, but neither is what the user came here for. */}
      <div className="dashboard-secondary">
        {/* Live `health:sources` strip; independent of the onboarding fetch above,
            so a failed status call does not hide connector health. */}
        <SourceHealthPanel />

        {/* Live `pipeline:status` strip — makes the silent ingest → extract →
            synthesize pipeline visible while a briefing is not yet available to
            show anything for it. */}
        <PipelineStatusPanel />
      </div>
    </main>
  );
}
