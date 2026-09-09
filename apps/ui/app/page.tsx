'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { BriefingView } from '../components/BriefingView';
import { PageToolbar } from '../components/PageToolbar';
import { WarmingNotice } from '../components/WarmingNotice';
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
  const requestBriefing = useCallback((): void => {
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
  }, []);

  /**
   * Option 3: the home screen IS the briefing. Instead of a hero "Brief me"
   * button, request one automatically as soon as the OI-3 gate opens and there
   * is nothing already on screen (a restored `briefingId` from a Settings
   * round-trip counts). `requestBriefing` is `useCallback([])`-stable and sets
   * `briefingId` on success, so this fires exactly once per gate-open; a failed
   * request leaves `briefingId` null but does not re-fire (no dep changed) —
   * the Refresh button in the toolbar is the retry.
   */
  useEffect(() => {
    if (readyForBriefing && briefingId === null) requestBriefing();
  }, [readyForBriefing, briefingId, requestBriefing]);

  const noProjects = status !== null && status.projectsDeclared.length === 0;

  return (
    <>
      <PageToolbar title="What you missed">
        <Button
          size="small"
          variant="outlined"
          disabled={!readyForBriefing}
          onClick={requestBriefing}
        >
          Refresh
        </Button>
      </PageToolbar>

      <Box sx={{ maxWidth: 640, mx: 'auto', width: '100%', p: 3 }}>
        {noProjects ? (
          <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem', mb: 2 }}>
            Declare a project before your first briefing — it is what ranks the briefing by what
            matters instead of by what is newest.{' '}
            {/* Root-relative with the filename spelled out: the bundle is served over the
                `app://` fixed-host scheme, whose handler cannot fetch a directory-style URL. */}
            <Box component="a" href="/onboarding/index.html" sx={{ color: 'primary.main' }}>
              Add some
            </Box>
            .
          </Typography>
        ) : null}

        {error !== null ? (
          <Typography role="alert" sx={{ color: 'error.main', mb: 2 }}>
            Bridge unavailable: {error}
          </Typography>
        ) : null}
        {briefingError !== null ? (
          <Typography role="alert" sx={{ color: 'error.main', mb: 2 }}>
            Briefing failed: {briefingError}
          </Typography>
        ) : null}

        {/* F2: above the briefing, not instead of it. A backlog does not make
            the briefing wrong — it makes it INCOMPLETE, and the deterministic
            path still renders whatever deltas already exist. Saying so is the
            difference between "this app is still reading your mail" and "this
            app does not work", which are indistinguishable on an empty page. */}
        <WarmingNotice />

        {/* This page owns the request (the OI-3 gate above is the single place
            that decides whether a briefing may be generated); `BriefingView`
            subscribes to the stream and paints "Waiting on you" from
            `briefing:pending`. */}
        {briefingId !== null ? <BriefingView briefingId={briefingId} /> : null}
      </Box>
    </>
  );
}
