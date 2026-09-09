'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { getBridge } from '../lib/bridge';
import type {
  BriefingDone,
  BriefingWindow,
  ClaimChunk,
  DeclaredProject,
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

/**
 * Per-section tooltips are gone with the four-section layout (P2).
 *
 * The three streamed sections now render as one group under
 * {@link CHANGED_GROUP_MEANING}, and "Waiting on you" carries its own wording
 * inside `PendingSection`. The section NAMES still exist — the generator emits
 * them and `briefing_claims.section` stores them — they are simply no longer
 * headings the reader has to triage between.
 */

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

/**
 * P2: the four generator sections collapse into TWO groups on screen.
 *
 * "Quietly resolved" and "Worth knowing" are the lowest-value sections and the
 * ones fabrication fills — `DEFAULT_SECTION` already files every unattributable
 * claim into the latter. Merging them with "What moved" into one *changed* list
 * removes two headings the reader has to triage between without losing a single
 * claim: nothing is dropped, only regrouped.
 *
 * Deliberately a renderer-side mapping rather than a generator change. The
 * prompt still emits four sections and `briefing_claims.section` still stores
 * them, so the eval harness, the persisted narrative and the section ordering
 * contract are all untouched by a presentation decision.
 */
const CHANGED_SECTIONS = STREAMED_SECTIONS;

/**
 * A-4: fallback cap for the changed list, used until `briefing:resumePoint`
 * answers. Mirrors `config/default.json`'s `briefing.maxChangedItems`.
 */
const DEFAULT_MAX_CHANGED_ITEMS = 7;

/**
 * Filter sentinel for "rows carrying no project label".
 *
 * A sentinel rather than `null`, because MUI's `Select` uses `''` for its own
 * empty state and the two mean opposite things here: `''` shows everything,
 * this shows only what has NOT been filed. Prefixed so it can never collide
 * with a real `projectId` (a uuid).
 */
export const UNFILED_FILTER = '@unfiled';

/** Tooltip for the merged changed group — the union of the three sections it replaces. */
const CHANGED_GROUP_MEANING =
  'Decisions, progress, things that closed without you, and context worth knowing';

/** How far back a self-initiated briefing looks. */
const BRIEFING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * @deprecated Nothing renders these since P0 removed the banner.
 *
 * `briefings.mode = 'template'` no longer means "the model was unavailable" —
 * it means "no background pass had written prose for these deltas yet", which
 * is the ordinary case and not something to warn about. Retained only so the
 * strings are greppable while the fallback vocabulary is still in the store.
 */
export const SIMPLIFIED_BRIEFING_LABEL = 'Simplified briefing';

/** @deprecated See {@link SIMPLIFIED_BRIEFING_LABEL}. */
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

/**
 * Identity for "is this the same bullet". `citation.artifactId` alone is not
 * enough — one thread's artifact can legitimately back several distinct
 * claims (see `bulletsForChunks`'s key comment) — so the claim text is part
 * of the key too. Guards against the same claim landing in `claims` twice:
 * a stale-run chunk that slips past the `expectedBriefingId` filter during
 * the brief window before it is known (see the effect below), or a
 * `briefing:snapshot` read racing a still-live `onChunk` delivery of
 * something already persisted.
 */
function claimKey(chunk: ClaimChunk): string {
  return `${chunk.citation.artifactId}::${chunk.claim}`;
}

/** Drops later chunks whose {@link claimKey} already appeared, keeping arrival order. */
function dedupeClaims(chunks: readonly ClaimChunk[]): ClaimChunk[] {
  const seen = new Set<string>();
  const result: ClaimChunk[] = [];
  for (const chunk of chunks) {
    const key = claimKey(chunk);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(chunk);
  }
  return result;
}

/**
 * The changed list (and streamed "Waiting on you" claims): a hairline-ruled
 * flow, not cards. Styled on the `<ul>` so `ClaimBullet` stays a dumb `<li>`
 * (a per-list `sx` on the child cannot be statically extracted by Pigment).
 */
const CHANGED_LIST_SX = {
  listStyle: 'none',
  p: 0,
  m: 0,
  '& > li': { py: 1.5, borderTop: 1, borderColor: 'divider' },
  '& > li:first-of-type': { borderTop: 0, pt: 0 },
} as const;

const SECTION_HEADING_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.5,
  fontSize: '1.05rem',
  fontWeight: 650,
  mb: 1.5,
} as const;

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
  /**
   * Artifact ids of items the user resolved in THIS view. The pinned card is
   * dropped from `pending` on resolve, and that alone would *un-hide* a streamed
   * "Waiting on you" bullet citing the same artifact — the changed-list filter
   * below only suppresses claims still backed by an open pending item. The next
   * briefing drops these claims main-side (a `resolution` delta now supersedes
   * the obligation); this set covers the gap until then.
   */
  const [resolvedArtifactIds, setResolvedArtifactIds] = useState<Set<string>>(() => new Set());
  const [claimVerdicts, setClaimVerdicts] = useState<Record<string, FeedbackInput['verdict']>>({});
  /** A-4 cap for the changed list; replaced by the config value once known. */
  const [maxChangedItems, setMaxChangedItems] = useState(DEFAULT_MAX_CHANGED_ITEMS);
  /** True once the user has expanded past the cap. Never collapses again. */
  const [showAllChanged, setShowAllChanged] = useState(false);
  // Tracks which claim ids a lookup has already been sent for, so a claim that
  // comes back with NO verdict does not get re-queried on every re-render.
  const requestedVerdictIds = useRef<Set<string>>(new Set());

  /**
   * Per-claim project labels (migration 010) — a LABEL only. Choosing a project
   * here records how the user files this row for later filtering; it writes no
   * `belongs_to` edge and changes no ranking, unlike tagging a channel in
   * Settings. Empty list = no declared projects, which hides the control
   * entirely rather than offering a dropdown with nothing in it.
   */
  const [declaredProjects, setDeclaredProjects] = useState<DeclaredProject[]>([]);
  /** `claimId -> projectId`; a claim absent from the map is unlabelled. */
  const [claimProjects, setClaimProjects] = useState<ReadonlyMap<string, string>>(new Map());
  const [labelError, setLabelError] = useState<string | null>(null);
  /**
   * Which project the changed list is filtered to: a project id, the
   * {@link UNFILED_FILTER} sentinel, or `''` for "everything".
   *
   * Deliberately NOT persisted. A filter that survives a restart is a filter
   * the user eventually forgets is on, and this one hides briefing content —
   * the failure mode is believing nothing changed when something did.
   */
  const [projectFilter, setProjectFilter] = useState<string>('');

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
          setClaims((current) =>
            current.some((c) => claimKey(c) === claimKey(chunk)) ? current : [...current, chunk],
          );
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
          setClaims(dedupeClaims(snapshot.claims));
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

  // A-4: the display cap is config-driven (NFR-7), so it is read rather than
  // hard-coded. Best-effort — the constant above stands in if the read fails,
  // because a briefing that renders with a default cap beats one that does not
  // render at all.
  useEffect(() => {
    let active = true;
    try {
      getBridge()
        .briefing.resumePoint()
        .then((resume) => {
          if (active && Number.isInteger(resume.maxChangedItems) && resume.maxChangedItems > 0) {
            setMaxChangedItems(resume.maxChangedItems);
          }
        })
        .catch(() => undefined);
    } catch {
      // No bridge (plain browser / static export) — keep the default.
    }
    return () => {
      active = false;
    };
  }, []);

  const toggleDrilldown = useCallback((claimId: string): void => {
    setOpenClaimId((current) => (current === claimId ? null : claimId));
  }, []);

  /**
   * The declared projects the dropdown offers. Read once — the list changes only
   * from the onboarding page, which is a full page load away.
   *
   * Best-effort: a failed read leaves the list empty, which hides the control.
   * A briefing that renders without labelling beats one that does not render.
   */
  useEffect(() => {
    let active = true;
    try {
      getBridge()
        .projects.list()
        .then((declared) => {
          if (active) setDeclaredProjects(declared);
        })
        .catch(() => undefined);
    } catch {
      // No bridge (plain browser / static export) — no labelling, no crash.
    }
    return () => {
      active = false;
    };
  }, []);

  /**
   * Labels already on this briefing, so re-opening it shows what was chosen.
   *
   * Keyed on `briefingId` rather than run once: Home can swap the briefing under
   * this component (a refresh mints a new id), and labels are per briefing.
   */
  useEffect(() => {
    if (briefingId === null) return;
    let active = true;

    try {
      getBridge()
        .claim.projects(briefingId)
        .then((tags) => {
          if (!active) return;
          setClaimProjects(
            new Map(
              tags.flatMap((tag) =>
                tag.projectId === null ? [] : [[tag.claimId, tag.projectId] as const],
              ),
            ),
          );
        })
        .catch(() => undefined);
    } catch {
      // Unreachable in practice — a briefingId implies a working bridge.
    }

    return () => {
      active = false;
    };
  }, [briefingId]);

  /**
   * Auto-detection (migration 011): file the rows whose SOURCE TEXT names
   * exactly one declared project, and leave every other row blank.
   *
   * Runs once the stream has ended, not per chunk: the claim set is stable by
   * then, so this is one round trip for the whole briefing instead of one per
   * bullet. Deliberately after `claim.projects` has populated the map — the
   * main process skips any row already filed, and re-running is harmless.
   *
   * Best-effort throughout: detection failing leaves every dropdown exactly as
   * the user left it, which is the same state as declaring no projects.
   */
  useEffect(() => {
    if (done === null || briefingId === null || declaredProjects.length === 0) return;
    const claimIds = claims.map((c) => claimIdOf(c));
    if (claimIds.length === 0) return;

    let active = true;
    try {
      getBridge()
        .claim.detectProjects(briefingId, claimIds)
        .then((tags) => {
          if (!active) return;
          setClaimProjects(
            new Map(
              tags.flatMap((tag) =>
                tag.projectId === null ? [] : [[tag.claimId, tag.projectId] as const],
              ),
            ),
          );
        })
        .catch(() => undefined);
    } catch {
      // No bridge — nothing to detect against.
    }

    return () => {
      active = false;
    };
    // `claims` is intentionally read but not depended on: it grows chunk by
    // chunk, and re-running detection on every arrival would fire a round trip
    // per bullet. `done` flipping is the signal that the set is final.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, briefingId, declaredProjects.length]);

  /**
   * Label one claim, or clear it with `''` (the "No project" option's value).
   *
   * Optimistic: the dropdown moves immediately and rolls back if the write
   * fails, because a select that visibly lags a click reads as broken. The
   * rollback restores the PREVIOUS value rather than clearing, so a failed
   * re-label does not look like a successful un-label.
   */
  const labelClaim = useCallback(
    (claimId: string, projectId: string): void => {
      if (briefingId === null) return;
      setLabelError(null);

      const previous = claimProjects.get(claimId);
      setClaimProjects((current) => {
        const next = new Map(current);
        if (projectId === '') next.delete(claimId);
        else next.set(claimId, projectId);
        return next;
      });

      const rollback = (reason: string): void => {
        setLabelError(reason);
        setClaimProjects((current) => {
          const next = new Map(current);
          if (previous === undefined) next.delete(claimId);
          else next.set(claimId, previous);
          return next;
        });
      };

      try {
        getBridge()
          .claim.setProject(briefingId, claimId, projectId === '' ? null : projectId)
          .then((result) => {
            if (!result.ok) rollback(result.reason ?? 'could not save this project');
          })
          .catch((cause: unknown) => rollback(describe(cause)));
      } catch (cause) {
        rollback(describe(cause));
      }
    },
    [briefingId, claimProjects],
  );

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
   * The user manually declaring a "Waiting on you" item dealt with. Main-side
   * this closes the row AND appends a `resolution` delta to its thread (see
   * `ipc/briefing.ts`), so the obligation is off every future briefing too, not
   * just this view. Here we drop the pinned card immediately, and remember the
   * item's artifact id so a streamed bullet for the same obligation cannot
   * resurface in this view before the next request.
   */
  const resolvePendingItem = useCallback(
    (pendingId: string): void => {
      setResolveError(null);
      const artifactId = pending.find((item) => item.pendingId === pendingId)?.citationArtifactId;
      try {
        getBridge()
          .briefing.resolvePending(pendingId)
          .then((result) => {
            if (result.ok) {
              setPending((current) => current.filter((item) => item.pendingId !== pendingId));
              if (artifactId != null && artifactId !== '') {
                setResolvedArtifactIds((ids) => new Set(ids).add(artifactId));
              }
            } else {
              setResolveError(result.reason ?? 'could not resolve this item');
            }
          })
          .catch((cause: unknown) => setResolveError(describe(cause)));
      } catch (cause) {
        setResolveError(describe(cause));
      }
    },
    [pending],
  );

  /**
   * Drill-down panel + feedback for a claim, rendered only while it is open.
   *
   * `resolveAction` is `PendingSection`'s "Mark resolved" button, threaded
   * through rather than rendered by the caller directly: it needs to land
   * INSIDE `FeedbackControls`' row (same line as Relevant/Not relevant/Wrong),
   * and only this function has the `FeedbackControls` element to put it in.
   * `bulletsForChunks` (streamed claims, no pending item behind them) calls
   * this with no second argument, so nothing extra renders there.
   */
  const renderDetail = useCallback(
    (claimId: string, resolveAction?: ReactNode): ReactNode => {
      const detail: ReactNode[] = [];
      // `unmountOnExit` keeps `DrillDownPanel` unmounted while closed, so its
      // `claim:drilldown` fetch only fires when the user actually opens it —
      // same as the previous conditional mount, now with a slide animation.
      detail.push(
        <Collapse key="drilldown" in={openClaimId === claimId} unmountOnExit>
          <DrillDownPanel claimId={claimId} onClose={() => setOpenClaimId(null)} />
        </Collapse>,
      );
      if (briefingId !== null) {
        const verdict = claimVerdicts[claimId];
        // The project label sits on the same row as the verdict buttons and the
        // resolve action, per this function's contract above. Rendered only when
        // projects exist: an empty dropdown is a dead control, and the place to
        // declare a project is onboarding, not here.
        const projectLabel =
          declaredProjects.length === 0 ? null : (
            <TextField
              key="project"
              select
              size="small"
              variant="standard"
              label="Project"
              value={claimProjects.get(claimId) ?? ''}
              aria-label="Project for this item"
              onChange={(e) => labelClaim(claimId, e.target.value)}
              sx={{ minWidth: 150, ml: 'auto' }}
            >
              {/* Explicitly selectable, not just an empty initial state: clearing
                  a label the user set has to be reachable from the same control. */}
              <MenuItem value="">
                <em>No project</em>
              </MenuItem>
              {declaredProjects.map((project) => (
                <MenuItem key={project.projectId} value={project.projectId}>
                  {project.name}
                </MenuItem>
              ))}
            </TextField>
          );

        detail.push(
          <FeedbackControls
            key="feedback"
            briefingId={briefingId}
            claimId={claimId}
            {...(verdict === undefined ? {} : { initialVerdict: verdict })}
          >
            {resolveAction}
            {projectLabel}
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
    [briefingId, openClaimId, claimVerdicts, declaredProjects, claimProjects, labelClaim],
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

  // Artifact ids already backed by a real `pending_items` row (painted by
  // `PendingSection` itself, with the "Mark resolved" control). Excluded here so
  // a claim that just got promoted via the refetch above does not also render as
  // a plain, button-less bullet.
  const pendingArtifactIds = new Set(
    pending.flatMap((item) => (item.citationArtifactId !== null ? [item.citationArtifactId] : [])),
  );
  // A claim whose obligation the user just resolved in this view is gone for
  // good here — it is not re-backed by an open pending item, so the check above
  // would otherwise let the streamed "Waiting on you" bullet reappear.
  const isLive = (chunk: ClaimChunk): boolean => !resolvedArtifactIds.has(claimIdOf(chunk));
  const waitingOnYouClaims = claims.filter(
    (chunk) =>
      sectionOf(chunk) === 'Waiting on you' &&
      !pendingArtifactIds.has(claimIdOf(chunk)) &&
      isLive(chunk),
  );

  /**
   * Does one artifact pass the project filter?
   *
   * `''` shows everything; {@link UNFILED_FILTER} shows only rows carrying no
   * label; anything else is a `projectId`.
   *
   * Applied to EVERY section of the panel, obligations included, by explicit
   * user decision. The risk that motivated exempting them still exists — a
   * filter left on can hide something that is genuinely waiting on you — so it
   * is answered by disclosure instead of by exemption: `filteredOutCount`
   * counts across all three lists and is stated next to the control, with a
   * one-click way out. AC-3's cap exemption for obligations is untouched; that
   * is about the display cap, not about this filter.
   */
  const artifactPassesFilter = (artifactId: string | null): boolean => {
    if (projectFilter === '') return true;
    const filed = artifactId === null ? undefined : claimProjects.get(artifactId);
    return projectFilter === UNFILED_FILTER ? filed === undefined : filed === projectFilter;
  };

  const matchesFilter = (chunk: ClaimChunk): boolean => artifactPassesFilter(claimIdOf(chunk));

  // P2: every non-obligation claim, in canonical section order. Sorted rather
  // than concatenated per section so one flat list still reads in the order the
  // four-section layout would have shown.
  const changedClaims = CHANGED_SECTIONS.flatMap((section) =>
    claims.filter((chunk) => sectionOf(chunk) === section && isLive(chunk)),
  );

  // Each section filtered independently, so the counts each heading reports
  // stay true to what is under it.
  const changedClaims = allChangedClaims.filter(matchesFilter);
  const waitingOnYouClaims = allWaitingOnYouClaims.filter(matchesFilter);
  const filteredPending = pending.filter((item) =>
    artifactPassesFilter(item.citationArtifactId),
  );

  /** Everything the filter is hiding, across all three lists. Disclosed, never silent. */
  const filteredOutCount =
    allChangedClaims.length -
    changedClaims.length +
    (allWaitingOnYouClaims.length - waitingOnYouClaims.length) +
    (pending.length - filteredPending.length);

  const visibleChanged = showAllChanged ? changedClaims : changedClaims.slice(0, maxChangedItems);
  const hiddenChangedCount = changedClaims.length - visibleChanged.length;

  return (
    <Box component="section" aria-label="Briefing" sx={{ color: 'text.primary' }}>
      <Typography component="h2" sx={{ fontSize: '1.35rem', fontWeight: 650, mb: 0.5 }}>
        What you missed
      </Typography>
      {/*
        R-6: set the expectation before the output disappoints — but truthfully.
        This once promised a learning loop the design deliberately does not have
        (X-2 excludes learned ranking; `ranker.ts` forbids feedback-derived
        values in scoring; FR-7 feeds the offline eval only). The replacement
        keeps R-6's job while describing what the ranker actually uses.
      */}
      <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 2 }}>
        Ranked by the projects you declared — nothing is learned from what you click. Early
        briefings will be rough; flagging a wrong item helps us fix the model offline.
      </Typography>

      {/*
        Panel-level filter: it governs every section below, so it sits above all
        of them rather than inside one. Only offered once there is something to
        filter BY — an empty dropdown is a dead control, and projects are
        declared during onboarding, not here.
      */}
      {declaredProjects.length > 0 ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            flexWrap: 'wrap',
            mb: 2,
            pb: 2,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <TextField
            select
            size="small"
            variant="standard"
            label="Filter by project"
            value={projectFilter}
            aria-label="Filter this briefing by project"
            onChange={(e) => setProjectFilter(e.target.value)}
            sx={{ minWidth: 190 }}
          >
            <MenuItem value="">All projects</MenuItem>
            <MenuItem value={UNFILED_FILTER}>
              <em>Not filed</em>
            </MenuItem>
            {declaredProjects.map((project) => (
              <MenuItem key={project.projectId} value={project.projectId}>
                {project.name}
              </MenuItem>
            ))}
          </TextField>

          {/*
            Every section's heading reports its FILTERED count, so the hidden
            remainder has to be stated outright — otherwise a filter left on
            reads as "nothing changed" and, now that obligations are filtered
            too, as "nothing needs you". That false reassurance is the one thing
            this panel must never produce.
          */}
          {filteredOutCount > 0 ? (
            <Typography role="status" sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>
              {filteredOutCount} item{filteredOutCount === 1 ? '' : 's'} hidden by this filter,
              including anything waiting on you.{' '}
              <Box
                component="button"
                type="button"
                onClick={() => setProjectFilter('')}
                sx={{
                  background: 'none',
                  border: 0,
                  p: 0,
                  font: 'inherit',
                  color: 'primary.main',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                Show all
              </Box>
            </Typography>
          ) : null}
        </Box>
      ) : null}

      {error !== null ? (
        <Typography role="alert" sx={{ color: 'error.main', mb: 1 }}>
          Briefing unavailable: {error}
        </Typography>
      ) : null}

      {/*
        The "Simplified briefing" banner was removed by P0: under
        deterministic-first, rendering from SQLite with model prose folded in
        per delta is simply how every briefing is built, not a degradation. The
        honest disclosures that remain describe real gaps — the OI-1
        still-processing count in the footer, the low-confidence flag on
        individual obligations.
      */}

      {/*
        The streaming region. `aria-live="polite"` is what makes a briefing that
        arrives a sentence at a time usable without sight: new bullets are
        announced as they land, at the next natural pause. `aria-busy`
        suppresses that chatter until the stream ends — announcing a
        half-written briefing is worse than announcing it late.
      */}
      <div aria-live="polite" aria-busy={done === null} data-testid="briefing-stream">
        {resolveError !== null ? (
          <Typography role="alert" sx={{ color: 'error.main', mb: 1 }}>
            Could not mark resolved: {resolveError}
          </Typography>
        ) : null}
        {labelError !== null ? (
          <Typography role="alert" sx={{ color: 'error.main', mb: 1 }}>
            Could not save the project: {labelError}
          </Typography>
        ) : null}
        <PendingSection
          items={filteredPending}
          loading={pendingLoading}
          onCitationClick={toggleDrilldown}
          renderDetail={renderDetail}
          onResolve={resolvePendingItem}
        >
          {waitingOnYouClaims.length > 0 ? (
            <Box component="ul" sx={CHANGED_LIST_SX}>
              {bulletsForChunks(waitingOnYouClaims)}
            </Box>
          ) : null}
        </PendingSection>

        {/*
          P2/P4: ONE "changed" list, not three sections. The generator still
          emits four sections and they are still what gets persisted — this is a
          presentation grouping only, ordered by `CHANGED_SECTIONS`. (Grouping
          this list by channel/project — D-2 in the redesign plan — needs a
          `channelName` on the `Citation` IPC payload, which is a later
          follow-up; today's `Citation` carries only `source`.)

          The heading is a COUNT, so the reader learns the size of the job first.
        */}
        <Box component="section" aria-label="Changed while you were out" sx={{ mt: 3 }}>
          <Typography component="h3" sx={SECTION_HEADING_SX}>
            {changedClaims.length === 0
              ? 'Nothing else changed'
              : `${changedClaims.length} thing${changedClaims.length === 1 ? '' : 's'} changed`}
            <SectionInfoIcon meaning={CHANGED_GROUP_MEANING} />
          </Typography>

          {visibleChanged.length > 0 ? (
            <Box component="ul" sx={CHANGED_LIST_SX}>
              {bulletsForChunks(visibleChanged)}
            </Box>
          ) : (
            <Typography sx={{ color: 'text.secondary' }}>
              {done === null ? 'Still writing…' : 'Nothing here.'}
            </Typography>
          )}

          {/*
            A-4: the overflow is COLLAPSED, never dropped, and the count is
            always visible. Obligations above have no equivalent control because
            they are never capped at all.
          */}
          {hiddenChangedCount > 0 ? (
            <Box sx={{ mt: 1.5 }}>
              <Button size="small" onClick={() => setShowAllChanged(true)}>
                Show {hiddenChangedCount} more
              </Button>
            </Box>
          ) : null}
        </Box>
      </div>

      <Box
        component="footer"
        sx={{ mt: 3, pt: 2, borderTop: 1, borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        {/* OI-1: a briefing generated while threads are still ingesting is
            incomplete, and the user needs to know that before acting on it — or
            on its silence. Hidden when the backlog is drained. */}
        {done !== null && done.threadsStillProcessing > 0 ? (
          <Typography role="status" sx={{ color: 'warning.main', fontSize: '0.85rem' }}>
            {done.threadsStillProcessing} threads still processing — this briefing may be
            incomplete.
          </Typography>
        ) : null}

        {briefingId !== null ? <CaughtUpButton briefingId={briefingId} /> : null}
      </Box>
    </Box>
  );
}

export default BriefingView;
