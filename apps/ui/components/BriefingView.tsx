'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { getBridge } from '../lib/bridge';
import type {
  BriefingDone,
  BriefingWindow,
  ClaimChunk,
  FeedbackInput,
  PendingItemView,
  Unsubscribe,
} from '../types/bridge';
import { CaughtUpButton } from './CaughtUpButton';
import { CITATION_CHIP_LABEL, ClaimBullet } from './ClaimBullet';
import { DrillDownPanel } from './DrillDown';
import { FeedbackControls } from './FeedbackControls';
import { PendingSection } from './PendingSection';
import { SectionInfoIcon } from './SectionInfoIcon';

/**
 * The briefing surface (Task 3.6).
 *
 * Lifecycle, in the order the bridge requires it:
 *
 *   1. subscribe to `briefing:chunk` / `briefing:done`
 *   2. `briefing:request(window)` → `{ briefingId }`
 *   3. `briefing:pending(briefingId)` → paint "Waiting on you" immediately
 *   4. append streamed claims as they arrive
 *
 * Step 1 comes before step 2 on purpose: subscribing after the request opens a
 * window in which the main process can emit the first chunk with nobody
 * listening, and a dropped first chunk is invisible — the briefing just silently
 * misses a bullet.
 *
 * Sections always render in the canonical order (Waiting on you → What moved →
 * Quietly resolved → Worth knowing) regardless of the order chunks arrive in.
 * The generator sorts its own output, but the renderer must not *depend* on
 * that: a template-mode fallback, a retry, or an out-of-order flush would
 * otherwise reshuffle the user's briefing into nonsense.
 *
 * Styled via the shared design tokens/classes in `globals.css` — including the
 * `:focus-visible`/`:hover` rules for `.cr-interactive`/`.cr-chip`, which used
 * to live in a scoped `<style>` block here (moved once a real stylesheet
 * existed, so there is one source of truth for this component's CSS).
 */

/** The four sections, in the order the briefing must present them. */
export const BRIEFING_SECTIONS = [
  'Waiting on you',
  'What moved',
  'Quietly resolved',
  'Worth knowing',
] as const;

export type BriefingSection = (typeof BRIEFING_SECTIONS)[number];

/** `section name → meaning`, shown as a tooltip on each section heading. */
const SECTION_MEANING: Record<BriefingSection, string> = {
  'Waiting on you': 'Outstanding obligations that are on this person right now',
  'What moved': 'Decisions made and work that visibly advanced',
  'Quietly resolved': "Questions/blockers/obligations that closed without the user's input",
  'Worth knowing': "Context they'd want but that requires nothing from them",
};

/**
 * Bucket for a claim whose `section` is not one of the four.
 *
 * Matches `DEFAULT_SECTION` in `@cr/ai`'s generator: "Worth knowing" is the only
 * section that asserts nothing about urgency, so misfiling into it is the least
 * harmful failure. Dropping the claim instead would lose cited information.
 */
const DEFAULT_SECTION: BriefingSection = 'Worth knowing';

/** The three sections that are streamed rather than painted from `pending_items`. */
const STREAMED_SECTIONS = BRIEFING_SECTIONS.filter((s) => s !== 'Waiting on you');

/** How far back a self-initiated briefing looks. */
const BRIEFING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The phrase a template-mode briefing is announced with (Task 4.3, §7.8).
 *
 * Mirrors `SIMPLIFIED_BRIEFING_LABEL` in `@cr/ai`'s `layer3/template.ts`, which
 * is where the fallback decides that `briefings.mode = 'template'`. The renderer
 * cannot import from `@cr/ai` (it is a separately-compiled static export), so
 * the two constants are kept in sync by hand, exactly as `types/bridge.d.ts` is
 * kept in sync with the preload.
 */
export const SIMPLIFIED_BRIEFING_LABEL = 'Simplified briefing';

/** The remedy shown with it. Actionable, and short enough to read in a banner. */
export const SIMPLIFIED_BRIEFING_REMEDY =
  'Check that Ollama is running, then request a new briefing.';

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Canonical section for a chunk, folding anything unrecognised into the default. */
function sectionOf(chunk: ClaimChunk): BriefingSection {
  const match = BRIEFING_SECTIONS.find((s) => s.toLowerCase() === chunk.section.toLowerCase());
  return match ?? DEFAULT_SECTION;
}

/**
 * The identifier a chunk drills down with.
 *
 * `briefing:chunk` carries a `Citation`, not a `claimId` — the claim row's id is
 * not on the wire (see `apps/desktop/src/preload.cts`). The artifact id is the
 * stable handle the UI actually has, and it is what `claim:drilldown` resolves
 * provenance from. Kept in one function so that when the chunk payload grows a
 * real `claimId`, exactly one line changes.
 */
function claimIdOf(chunk: ClaimChunk): string {
  return chunk.citation.artifactId;
}

export interface BriefingViewProps {
  /**
   * An already-requested briefing. When omitted, this component requests one
   * itself on mount; when supplied, the parent owns the request and this
   * component only subscribes and fetches pending items.
   */
  briefingId?: string;
  /** Window for the self-initiated request. Defaults to the last 24 hours. */
  briefingWindow?: BriefingWindow;
}

export function BriefingView({
  briefingId: externalBriefingId,
  briefingWindow,
}: BriefingViewProps = {}): ReactNode {
  const [briefingId, setBriefingId] = useState<string | null>(externalBriefingId ?? null);
  const [pending, setPending] = useState<PendingItemView[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [claims, setClaims] = useState<ClaimChunk[]>([]);
  const [done, setDone] = useState<BriefingDone | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openClaimId, setOpenClaimId] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [claimVerdicts, setClaimVerdicts] = useState<Record<string, FeedbackInput['verdict']>>({});
  // Tracks which claim ids a lookup has already been sent for, so a claim that
  // comes back with NO verdict does not get re-queried on every re-render.
  const requestedVerdictIds = useRef<Set<string>>(new Set());

  // Frozen on first render so the effect's dependency array stays stable; a
  // window recomputed every render would re-request the briefing in a loop.
  const [defaultWindow] = useState<BriefingWindow>(() => {
    const windowEnd = Date.now();
    return { windowStart: windowEnd - BRIEFING_WINDOW_MS, windowEnd };
  });
  const requestWindow = briefingWindow ?? defaultWindow;
  const { windowStart, windowEnd } = requestWindow;

  useEffect(() => {
    // Guards every setState behind "is this effect run still the current one",
    // so an in-flight promise cannot write into an unmounted tree.
    let active = true;
    let unsubscribeChunk: Unsubscribe | undefined;
    let unsubscribeDone: Unsubscribe | undefined;

    // `briefing:chunk`/`briefing:done` are a single main-process broadcast, not
    // scoped per-listener: a PREVIOUS request's generation can still be
    // in-flight (fire-and-forget, never cancelled — see `beginBriefing`) and
    // deliver its chunks after this effect has already resubscribed for a NEW
    // briefingId. Left unfiltered, the two streams interleave into the same
    // `claims` array and every claim from the stale run reappears as a
    // duplicate of (or alongside) the current one.
    //
    // `null` means "not yet known" (the self-initiated branch below is still
    // awaiting its own `briefing:request`) rather than "reject everything": a
    // chunk for THIS request can legitimately arrive before that promise
    // resolves, since the id it carries was minted and returned to us before
    // the id round-trips back through `await`. Once `load` learns the id, it
    // is set below and every subsequent chunk is checked against it —
    // including late ones from whatever request this replaced.
    let expectedBriefingId: string | null = externalBriefingId ?? null;

    try {
      const bridge = getBridge();

      // Subscribe first — see the header comment. Both subscriptions return an
      // unsubscribe fn that MUST be called on teardown: without it, a remount
      // leaves the previous listener attached and every chunk is rendered twice
      // (bridge.d.ts spells this contract out).
      unsubscribeChunk = bridge.briefing.onChunk((chunk) => {
        if (active && (expectedBriefingId === null || chunk.briefingId === expectedBriefingId)) {
          setClaims((current) => [...current, chunk]);
        }
      });
      unsubscribeDone = bridge.briefing.onDone((event) => {
        if (active && (expectedBriefingId === null || event.briefingId === expectedBriefingId)) {
          setDone(event);
        }
      });

      const load = async (): Promise<void> => {
        const id =
          externalBriefingId ??
          (await bridge.briefing.request({ windowStart, windowEnd })).briefingId;
        if (!active) return;
        expectedBriefingId = id;
        setBriefingId(id);

        const [items, snapshot] = await Promise.all([
          bridge.briefing.pending(id),
          bridge.briefing.snapshot(id),
        ]);
        if (!active) return;
        setPending(items);
        setPendingLoading(false);

        // Rehydration: a briefing that already finished generating in a PRIOR
        // mount of this component (e.g. the user navigated to Settings and
        // back — a real page load, which dropped the `onChunk`/`onDone`
        // subscriptions above along with every piece of state) has nothing
        // left to stream. Repaint what `briefing:snapshot` found already
        // persisted instead of sitting on "Still writing…" forever. A freshly
        // requested id has no row yet, so `snapshot.found` is false and this
        // is a no-op — the live listeners above are what paint it.
        if (snapshot.found) {
          setClaims(snapshot.claims);
          if (snapshot.done !== null) setDone(snapshot.done);
        }
      };

      load().catch((cause: unknown) => {
        if (!active) return;
        setError(describe(cause));
        setPendingLoading(false);
      });
    } catch (cause) {
      // `getBridge()` throws synchronously when the preload bridge is absent
      // (plain browser / static export), which must not blank the page.
      setError(describe(cause));
      setPendingLoading(false);
    }

    return () => {
      active = false;
      unsubscribeChunk?.();
      unsubscribeDone?.();
    };
  }, [externalBriefingId, windowStart, windowEnd]);

  const toggleDrilldown = useCallback((claimId: string): void => {
    setOpenClaimId((current) => (current === claimId ? null : claimId));
  }, []);

  // Replays feedback already on file (FR-12) as claim ids appear, so a restart
  // — or a still-open pending item resurfacing under a new `briefingId` — does
  // not ask the user to re-judge a claim they already answered. Runs off
  // `pending`/`claims` rather than once on mount: streamed claims arrive one
  // chunk at a time, each with a claim id nothing has looked up yet.
  useEffect(() => {
    const ids = new Set<string>();
    for (const item of pending) {
      if (item.citationArtifactId !== null) ids.add(item.citationArtifactId);
    }
    for (const c of claims) ids.add(claimIdOf(c));

    const newIds = [...ids].filter((id) => !requestedVerdictIds.current.has(id));
    if (newIds.length === 0) return;
    for (const id of newIds) requestedVerdictIds.current.add(id);

    try {
      getBridge()
        .feedback.claimVerdicts(newIds)
        .then((result) => {
          setClaimVerdicts((current) => ({ ...current, ...result }));
        })
        .catch(() => {
          // Best-effort: a failed lookup just leaves those claims seeded as
          // unanswered, same as before this feature existed.
          for (const id of newIds) requestedVerdictIds.current.delete(id);
        });
    } catch {
      for (const id of newIds) requestedVerdictIds.current.delete(id);
    }
  }, [pending, claims]);

  // A streamed "Waiting on you" claim only becomes a real, resolvable
  // `pending_items` row once `persist()` runs at the end of `generate()` — see
  // `generate.ts`'s `persist()`. Re-fetching here, once the stream ends, is what
  // lets those claims pick up a `pendingId` and the "Mark resolved" control
  // without the user having to reload the page.
  useEffect(() => {
    if (done === null || briefingId === null) return;
    let active = true;

    try {
      getBridge()
        .briefing.pending(briefingId)
        .then((items) => {
          if (active) setPending(items);
        })
        .catch(() => {
          // Best-effort: the live-streamed bullets still render without the
          // control, same as before this refresh existed.
        });
    } catch {
      // `getBridge()` throwing here is unreachable in practice (the effect
      // above already proved the bridge exists), but this must not crash render.
    }

    return () => {
      active = false;
    };
  }, [done, briefingId]);

  /**
   * The user manually declaring a "Waiting on you" item dealt with — the only
   * way one leaves that list today, short of the model later detecting a reply
   * that superseded it (see `@cr/ai`'s `resolvePendingItemsForSupersededDelta`).
   * Removed from local state immediately on success so the list does not sit
   * stale until the next full reload.
   */
  const resolvePendingItem = useCallback((pendingId: string): void => {
    setResolveError(null);
    try {
      getBridge()
        .briefing.resolvePending(pendingId)
        .then((result) => {
          if (result.ok) {
            setPending((current) => current.filter((item) => item.pendingId !== pendingId));
          } else {
            setResolveError(result.reason ?? 'could not resolve this item');
          }
        })
        .catch((cause: unknown) => setResolveError(describe(cause)));
    } catch (cause) {
      setResolveError(describe(cause));
    }
  }, []);

  /**
   * Drill-down panel + feedback for a claim, rendered only while it is open.
   *
   * `resolveAction` is `PendingSection`'s "Mark resolved" button, threaded
   * through rather than rendered by the caller directly: it needs to land
   * INSIDE `FeedbackControls`' row (same line as Relevant/Not relevant/Wrong),
   * and only this function has the `FeedbackControls` element to put it in.
   * `bulletsFor` (streamed claims, no pending item behind them) calls this
   * with no second argument, so nothing extra renders there.
   */
  const renderDetail = useCallback(
    (claimId: string, resolveAction?: ReactNode): ReactNode => {
      const detail: ReactNode[] = [];
      if (openClaimId === claimId) {
        detail.push(
          <DrillDownPanel
            key="drilldown"
            claimId={claimId}
            onClose={() => setOpenClaimId(null)}
          />,
        );
      }
      if (briefingId !== null) {
        const verdict = claimVerdicts[claimId];
        detail.push(
          <FeedbackControls
            key="feedback"
            briefingId={briefingId}
            claimId={claimId}
            {...(verdict === undefined ? {} : { initialVerdict: verdict })}
          >
            {resolveAction}
          </FeedbackControls>,
        );
      } else if (resolveAction !== undefined) {
        // Should not happen in practice (pending items only render once a
        // briefingId exists), but a resolve action must never be silently
        // dropped just because feedback controls did not render.
        detail.push(resolveAction);
      }
      return detail.length === 0 ? null : detail;
    },
    [briefingId, openClaimId, claimVerdicts],
  );

  const bulletsForChunks = (chunks: readonly ClaimChunk[]): ReactNode[] =>
    chunks.map((chunk, index) => {
      const claimId = claimIdOf(chunk);
      return (
        <ClaimBullet
          // Artifact ids repeat across claims (one thread can back several),
          // so the index keeps sibling keys unique. Claims are append-only and
          // never reordered, so index-as-key is stable here.
          key={`${claimId}:${index}`}
          text={chunk.claim}
          claimId={claimId}
          citationLabel={CITATION_CHIP_LABEL} // standardized across every claim, see ClaimBullet.tsx
          onCitationClick={toggleDrilldown}
        >
          {renderDetail(claimId)}
        </ClaimBullet>
      );
    });

  const bulletsFor = (section: BriefingSection): ReactNode[] =>
    bulletsForChunks(claims.filter((chunk) => sectionOf(chunk) === section));

  // Artifact ids already backed by a real `pending_items` row (painted by
  // `PendingSection` itself, with the "Mark resolved" control). Excluded here so
  // a claim that just got promoted via the refetch above does not also render as
  // a plain, button-less bullet.
  const pendingArtifactIds = new Set(
    pending.flatMap((item) => (item.citationArtifactId !== null ? [item.citationArtifactId] : [])),
  );
  const waitingOnYouClaims = claims.filter(
    (chunk) => sectionOf(chunk) === 'Waiting on you' && !pendingArtifactIds.has(claimIdOf(chunk)),
  );

  return (
    <section className="cr-briefing" aria-label="Briefing">
      <h2 className="briefing-view__title">What you missed</h2>
      {/*
        R-6: set the expectation before the output disappoints — but truthfully.

        This used to read "Still learning your preferences — early briefings will
        be rough, and the feedback buttons sharpen them." Nothing learns. X-2
        excludes learned ranking from the POC outright, `ranker.ts` carries a
        guardrail forbidding any feedback-derived value from entering the scoring
        input, and FR-7 states feedback feeds the offline eval only. The sentence
        promised a loop the design deliberately does not have, on the one screen
        whose whole character is disclosure (partial-generation notices,
        threads-still-processing counts, the simplified-briefing banner).

        The replacement keeps R-6's job — say the output will be imperfect before
        the user discovers it — while describing what the ranker actually uses.
      */}
      <p className="briefing-view__subtitle">
        Ranked by the projects you declared — nothing is learned from what you click. Early
        briefings will be rough; flagging a wrong item helps us fix the model offline.
      </p>

      {error !== null ? (
        <p role="alert" className="briefing-view__error">
          Briefing unavailable: {error}
        </p>
      ) : null}

      {/*
        §7.8 / Task 4.3: the local model was not available, so this briefing was
        assembled from stored state changes by the deterministic template. Every
        line on the page is still cited — the difference is the *prose*, not the
        provenance — but the user has to be told, or they will read a terser
        briefing as "nothing much happened" rather than "the writer was down".

        Not colour-only (NFR-9): the label is words, in bold, prefixed by an
        icon-free "Simplified briefing" string and given `role="status"` so it is
        announced. The left border is decoration on top of that, not the signal.
      */}
      {done !== null && done.mode === 'template' ? (
        <p
          role="status"
          data-testid="simplified-briefing-banner"
          className="briefing-view__banner"
        >
          <strong>{SIMPLIFIED_BRIEFING_LABEL}</strong> — local model unavailable, so this was
          written from recorded state changes rather than generated.{' '}
          {SIMPLIFIED_BRIEFING_REMEDY}
        </p>
      ) : null}

      {/*
        The streaming region. `aria-live="polite"` is what makes a briefing that
        arrives a sentence at a time usable without sight: new bullets are
        announced as they land, at the next natural pause rather than by
        interrupting. `aria-busy` suppresses that chatter until the stream ends
        — announcing a half-written briefing is worse than announcing it late.
      */}
      <div aria-live="polite" aria-busy={done === null} data-testid="briefing-stream">
        {resolveError !== null ? (
          <p role="alert">Could not mark resolved: {resolveError}</p>
        ) : null}
        <PendingSection
          items={pending}
          loading={pendingLoading}
          onCitationClick={toggleDrilldown}
          renderDetail={renderDetail}
          onResolve={resolvePendingItem}
        >
          {waitingOnYouClaims.length > 0 ? (
            <ul className="briefing-view__waiting-list">
              {bulletsForChunks(waitingOnYouClaims)}
            </ul>
          ) : null}
        </PendingSection>

        {STREAMED_SECTIONS.map((section) => {
          const bullets = bulletsFor(section);
          return (
            <section key={section} aria-label={section}>
              <h3 className="section-heading">
                {section}
                <SectionInfoIcon meaning={SECTION_MEANING[section]} />
              </h3>
              {bullets.length > 0 ? (
                <ul className="bullet-list">{bullets}</ul>
              ) : (
                <p className="muted-note">
                  {done === null ? 'Still writing…' : 'Nothing here.'}
                </p>
              )}
            </section>
          );
        })}
      </div>

      <footer className="briefing-view__footer">
        {/* OI-1: a briefing generated while threads are still ingesting is
            incomplete, and the user needs to know that before they act on it —
            or on its silence. Hidden entirely when the backlog is drained. */}
        {done !== null && done.threadsStillProcessing > 0 ? (
          <p role="status" className="briefing-view__processing-note">
            {done.threadsStillProcessing} threads still processing — this briefing may be
            incomplete.
          </p>
        ) : null}

        {briefingId !== null ? (
          <>
            <CaughtUpButton briefingId={briefingId} />
            {/* FR-7: briefing-level feedback, submitted with no `claimId`,
                because "you missed something" is by definition about a claim
                that is not on the page. */}
            <FeedbackControls briefingId={briefingId} />
          </>
        ) : null}
      </footer>
    </section>
  );
}

export default BriefingView;
