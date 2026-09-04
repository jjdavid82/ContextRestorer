'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { BriefingView } from '../components/BriefingView';
import { PipelineStatusPanel } from '../components/PipelineStatus';
import { SourceHealthPanel } from '../components/SourceHealth';
import { getBridge } from '../lib/bridge';
import {
  parseWindowStart,
  readSavedBriefingWindowStart,
  resolveBriefingWindow,
} from '../lib/briefingWindow';
import type { OnboardingStatus } from '../types/bridge';

/**
 * `sessionStorage` key this page remembers its last requested briefing under.
 *
 * `layout.tsx`'s nav is plain `<a href>` markup (deliberately, not a client
 * router), so switching to Settings and back is a real page load: every piece
 * of this component's React state — including `briefingId` — is destroyed and
 * rebuilt from scratch. Without this, the briefing on screen would vanish and
 * the only way back would be re-clicking "Brief me on what I missed", which
 * mints a brand-new id and reruns the whole Layer 3 pipeline for content that
 * was already generated a moment ago.
 *
 * `sessionStorage` (not `localStorage`) is deliberate: it survives navigation
 * within the same window session but clears when the app actually restarts,
 * so a stale briefing id from a previous run is never resurrected.
 */
const HOME_SESSION_KEY = 'cr:home-briefing';

interface StoredHomeState {
  briefingId: string;
}

/** The last requested briefing's id, or `null` if unset/unusable/unavailable. */
function readStoredHomeState(): StoredHomeState | null {
  // Same guard `lib/bridge.ts`'s `hasBridge()` uses: this file is also
  // prerendered during the static export build, where there is no `window`
  // (and therefore no `sessionStorage`) at all.
  if (typeof window === 'undefined') return null;

  try {
    const raw = sessionStorage.getItem(HOME_SESSION_KEY);
    if (raw === null) return null;

    const parsed = JSON.parse(raw) as Partial<StoredHomeState> | null;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.briefingId !== 'string' ||
      parsed.briefingId === ''
    ) {
      return null;
    }
    return { briefingId: parsed.briefingId };
  } catch {
    // Storage disabled, or a malformed/foreign value under this key — fall
    // back to the normal fresh-mount defaults rather than throwing.
    return null;
  }
}

/**
 * Placeholder home page.
 *
 * Reads `onboarding:status` to decide whether the briefing action can run yet.
 * The OI-3 gate (declare a project first) was relaxed while nothing wrote the
 * `belongs_to` edge that made declarations matter; A-2 restored that write
 * path, so the gate is back — see `readyForBriefing` below.
 */
export default function HomePage(): ReactNode {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  // Restored from a PRIOR mount's `sessionStorage` write when this is a
  // remount after a Settings round-trip, rather than the app's first paint.
  const [briefingId, setBriefingId] = useState<string | null>(
    () => readStoredHomeState()?.briefingId ?? null,
  );

  // Persists the id above so a Settings round-trip can restore it.
  useEffect(() => {
    if (briefingId === null) return;
    try {
      sessionStorage.setItem(HOME_SESSION_KEY, JSON.stringify({ briefingId }));
    } catch {
      // Best-effort: storage can be disabled or full. Worst case, the next
      // Settings round-trip regenerates instead of rehydrating — no worse
      // than before this feature existed.
    }
  }, [briefingId]);

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

  /**
   * OI-3, restored (A-2): at least one declared project before a briefing.
   *
   * This gate was relaxed to "status loaded at all" because declared-project
   * stakes had no ranking effect — nothing wrote the `belongs_to` edge
   * `wStakes` reads, so requiring declarations gated on a signal the system
   * could not use. A-2 supplies that write path (tag a Slack channel with a
   * project in Settings), so the requirement is load-bearing again.
   *
   * Deliberately >= 1 rather than OI-3's stated 3-5: the config's
   * `minDeclaredProjects` (3) governs the DECLARATION step in onboarding, which
   * is where that floor belongs. Blocking the primary action of an app the user
   * has already onboarded, because they since removed a project, would be a
   * worse failure than a slightly under-informed ranking. Fails CLOSED on a
   * status that never loaded, as before.
   */
  const readyForBriefing = status !== null && status.projectsDeclared.length > 0;

  /**
   * Request a briefing over the window the user actually wants (F-2).
   *
   * The window is resolved at click time, from two sources in precedence order:
   * an explicit Settings override, then `briefing:resumePoint` — the `window_end`
   * of the last briefing they acknowledged. Neither present means first run, and
   * `resolveBriefingWindow` falls back to a 24h lookback.
   *
   * This is what makes `CaughtUpButton`'s long-standing promise ("the next
   * briefing starts from here") true. Before it, the start came from a
   * `datetime-local` value defaulting to 30 days ago that only ever changed when
   * the user edited it by hand, so the button re-briefed the same month on every
   * press and "I'm caught up" changed nothing but a metric.
   */
  const requestBriefing = (): void => {
    setBriefingError(null);

    // Read at click time, not held in state: both inputs can change while this
    // page is mounted — the override on the Settings page, the resume point via
    // the "I'm caught up" button in the briefing below.
    const saved = readSavedBriefingWindowStart();
    const override = saved === null ? undefined : parseWindowStart(saved);
    if (override !== undefined && 'error' in override) {
      setBriefingError(override.error);
      return;
    }

    try {
      const bridge = getBridge();
      bridge.briefing
        .resumePoint()
        // A failed lookup is not a failed briefing: fall through to `null`, which
        // `resolveBriefingWindow` answers with the first-run lookback. The button
        // must not become unusable because one read went wrong.
        .catch(() => ({ windowStart: null }))
        .then((resume) => {
          const window = resolveBriefingWindow({
            now: Date.now(),
            resumeFrom: resume.windowStart,
            ...(override === undefined ? {} : { override: override.window.windowStart }),
          });
          return bridge.briefing.request(window);
        })
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
              Declare a project before your first briefing — it is what ranks your briefing by
              what matters instead of by what is newest.{' '}
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
