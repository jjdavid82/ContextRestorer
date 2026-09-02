import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BriefingView,
  SIMPLIFIED_BRIEFING_LABEL,
  SIMPLIFIED_BRIEFING_REMEDY,
} from '../components/BriefingView';
import { LOW_CONFIDENCE_FLAG_THRESHOLD } from '../components/ClaimBullet';
import type {
  BriefingDone,
  Citation,
  ClaimChunk,
  ContextRestorerBridge,
  DrillDown,
  FeedbackInput,
  PendingItemView,
} from '../types/bridge';

/**
 * Component tests for the briefing UI (Task 3.6).
 *
 * The bridge is hand-mocked rather than auto-mocked: the point of these tests is
 * that the renderer speaks the *exact* shape declared in `types/bridge.d.ts`
 * (which mirrors the preload), so the mock is typed as `ContextRestorerBridge`
 * and a drift in either direction fails to compile.
 *
 * The chunk/done listener registries are real arrays with real unsubscribe
 * semantics. That matters: the "remount does not duplicate claims" test is only
 * meaningful if a *leaked* listener would actually still fire.
 */

const BRIEFING_ID = 'brief-1';

/** Listener registries, exposed so tests can emit and inspect leak state. */
interface MockBridge {
  bridge: ContextRestorerBridge;
  emitChunk: (chunk: ClaimChunk) => void;
  emitDone: (done: BriefingDone) => void;
  chunkListenerCount: () => number;
  unsubscribeChunk: ReturnType<typeof vi.fn>;
  unsubscribeDone: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  pending: ReturnType<typeof vi.fn>;
  resolvePending: ReturnType<typeof vi.fn>;
  caughtUp: ReturnType<typeof vi.fn>;
  drilldown: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  claimVerdicts: ReturnType<typeof vi.fn>;
  /** Task 4.6: the only sanctioned egress for FR-6 deep links. */
  openExternal: ReturnType<typeof vi.fn>;
}

function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    eventId: 'evt-1',
    artifactId: 'art-1',
    source: 'slack',
    ...overrides,
  };
}

function chunk(overrides: Partial<ClaimChunk> = {}): ClaimChunk {
  return {
    briefingId: BRIEFING_ID,
    section: 'What moved',
    claim: 'Auth refactor shipped to staging.',
    citation: citation(),
    ...overrides,
  };
}

function doneEvent(overrides: Partial<BriefingDone> = {}): BriefingDone {
  return {
    briefingId: BRIEFING_ID,
    mode: 'llm',
    threadsStillProcessing: 0,
    timings: { firstTokenMs: 900, totalMs: 4200 },
    ...overrides,
  };
}

function installBridge(
  options: {
    pending?: PendingItemView[];
    drilldown?: DrillDown;
    resolvePendingResult?: { ok: boolean; reason?: string };
    claimVerdicts?: Record<string, FeedbackInput['verdict']>;
  } = {},
): MockBridge {
  const chunkListeners: Array<(c: ClaimChunk) => void> = [];
  const doneListeners: Array<(d: BriefingDone) => void> = [];

  // Spies wrap the real removal so a test can assert teardown happened AND the
  // registry genuinely shrank.
  const unsubscribeChunk = vi.fn();
  const unsubscribeDone = vi.fn();

  const request = vi.fn(async () => ({ briefingId: BRIEFING_ID }));
  const pending = vi.fn(async () => options.pending ?? []);
  const resolvePending = vi.fn(async () => options.resolvePendingResult ?? { ok: true });
  const caughtUp = vi.fn(async () => ({ ok: true }));
  const drilldown = vi.fn(
    async (claimId: string): Promise<DrillDown> =>
      options.drilldown ?? { claimId, events: [] },
  );
  const submit = vi.fn(async () => ({ ok: true }));
  const claimVerdicts = vi.fn(async (ids: string[]) => {
    const known = options.claimVerdicts ?? {};
    const result: Record<string, FeedbackInput['verdict']> = {};
    for (const id of ids) {
      const verdict = known[id];
      if (verdict !== undefined) result[id] = verdict;
    }
    return result;
  });
  const openExternal = vi.fn(async () => ({ ok: true }));

  const bridge: ContextRestorerBridge = {
    onboarding: { status: vi.fn(async () => ({ sourcesConnected: [], projectsDeclared: [], ollamaReady: true })) },
    oauth: { connect: vi.fn(async () => ({ ok: true })), revoke: vi.fn(async () => ({ ok: true })) },
    projects: { suggest: vi.fn(async () => ({ candidates: [] })), declare: vi.fn(async () => ({ ok: true })) },
    briefing: {
      request,
      pending,
      resolvePending,
      caughtUp,
      // NFR-10 time-to-re-entry view (Task 3.7). Present only to satisfy the
      // bridge contract: nothing in the briefing view reads it today.
      metrics: vi.fn(async () => []),
      onChunk: (cb) => {
        chunkListeners.push(cb);
        return () => {
          unsubscribeChunk();
          const at = chunkListeners.indexOf(cb);
          if (at >= 0) chunkListeners.splice(at, 1);
        };
      },
      onDone: (cb) => {
        doneListeners.push(cb);
        return () => {
          unsubscribeDone();
          const at = doneListeners.indexOf(cb);
          if (at >= 0) doneListeners.splice(at, 1);
        };
      },
    },
    claim: { drilldown },
    shell: { openExternal },
    feedback: { submit, claimVerdicts },
    health: { onSources: () => () => undefined },
    // `pipeline:status` — present only to satisfy the bridge contract; nothing
    // in the briefing view reads it, same reasoning as `debug.metrics` below.
    pipeline: { onStatus: () => () => undefined },
    // Task 4.4's diagnostics channel. Present only to satisfy the bridge
    // contract: nothing in the briefing view reads it — it belongs to the
    // settings page's metrics panel.
    debug: {
      metrics: vi.fn(async () => ({
        available: true,
        layers: [],
        outcomes: [],
        briefingLatency: { count: 0, p50Ms: null, p95Ms: null },
        reEntry: { count: 0, p50Ms: null, p95Ms: null },
        gateDrops: [],
        redactedClaims: 0,
        redactionCount: 0,
        redactionKinds: [],
        triggers: { total: 0, byReason: [], byOutcome: [] },
        tracesRead: 0,
        unparseableTraceLines: 0,
      })),
    },
    // FR-3 recurring briefings. Present only to satisfy the bridge contract:
    // nothing in the briefing view touches these channels.
    schedule: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => ({ ok: true })),
      setEnabled: vi.fn(async () => ({ ok: true })),
    },
    // Slack channel selector. Present only to satisfy the bridge contract:
    // nothing in the briefing view touches these channels.
    slack: {
      listAvailable: vi.fn(async () => ({ ok: true, channels: [] })),
      getSelected: vi.fn(async () => []),
      setSelected: vi.fn(async () => ({ ok: true })),
    },
    // Chat-model picker. Present only to satisfy the bridge contract: nothing
    // in the briefing view touches these channels — it belongs to Settings.
    model: {
      get: vi.fn(async () => ({ chat: 'qwen2.5:3b', defaultChat: 'qwen2.5:3b', available: [] })),
      setChat: vi.fn(async () => ({ ok: true })),
    },
  };

  window.contextRestorer = bridge;

  return {
    bridge,
    emitChunk: (c) => {
      for (const listener of [...chunkListeners]) listener(c);
    },
    emitDone: (d) => {
      for (const listener of [...doneListeners]) listener(d);
    },
    chunkListenerCount: () => chunkListeners.length,
    unsubscribeChunk,
    unsubscribeDone,
    request,
    pending,
    resolvePending,
    caughtUp,
    drilldown,
    submit,
    claimVerdicts,
    openExternal,
  };
}

/** Waits for the mount effect's request→pending chain to settle. */
async function renderBriefing(mock: MockBridge): Promise<void> {
  render(<BriefingView />);
  await waitFor(() => expect(mock.pending).toHaveBeenCalledWith(BRIEFING_ID));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  // @ts-expect-error — the global is declared as always-present; tests own it.
  delete window.contextRestorer;
});

/* -------------------------------------------------------------------------- */
/* 1. Pending first, then streamed claims                                     */
/* -------------------------------------------------------------------------- */

describe('BriefingView — pending then stream', () => {
  it('requests a briefing, then paints pending items from that briefing id', async () => {
    const mock = installBridge({
      pending: [
        {
          pendingId: 'p1',
          description: 'Sign off on the two SRE reqs.',
          confidence: 0.9,
          citationArtifactId: 'art-p1',
        },
      ],
    });

    render(<BriefingView />);

    await waitFor(() => expect(mock.request).toHaveBeenCalledTimes(1));
    // The pending fetch must use the id the request handed back, not a guess.
    await waitFor(() => expect(mock.pending).toHaveBeenCalledWith(BRIEFING_ID));
    expect(await screen.findByText('Sign off on the two SRE reqs.')).toBeTruthy();
  });

  it('appends streamed claims beneath the pending section as chunks arrive', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    expect(screen.queryByText('Auth refactor shipped to staging.')).toBeNull();

    mock.emitChunk(chunk());

    expect(await screen.findByText('Auth refactor shipped to staging.')).toBeTruthy();
  });

  it('subscribes before requesting, so a chunk emitted immediately is not dropped', async () => {
    const mock = installBridge();
    render(<BriefingView />);

    // Fires while `briefing.request` is still in flight.
    mock.emitChunk(chunk({ claim: 'Very early claim.' }));

    expect(await screen.findByText('Very early claim.')).toBeTruthy();
  });

  it('marking a pending item resolved calls the bridge and removes it from the list', async () => {
    const mock = installBridge({
      pending: [
        {
          pendingId: 'p1',
          description: 'Sign off on the two SRE reqs.',
          confidence: 0.9,
          citationArtifactId: 'art-p1',
        },
      ],
    });
    await renderBriefing(mock);

    await screen.findByText('Sign off on the two SRE reqs.');
    fireEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));

    expect(mock.resolvePending).toHaveBeenCalledWith('p1');
    await waitFor(() =>
      expect(screen.queryByText('Sign off on the two SRE reqs.')).toBeNull(),
    );
  });

  it('keeps a pending item and surfaces the reason when resolving it fails', async () => {
    const mock = installBridge({
      pending: [
        {
          pendingId: 'p1',
          description: 'Sign off on the two SRE reqs.',
          confidence: 0.9,
          citationArtifactId: 'art-p1',
        },
      ],
      resolvePendingResult: { ok: false, reason: 'internal_error' },
    });
    await renderBriefing(mock);

    await screen.findByText('Sign off on the two SRE reqs.');
    fireEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('internal_error');
    expect(screen.getByText('Sign off on the two SRE reqs.')).toBeTruthy();
  });

  it('seeds the pressed verdict from one already on file, surviving a restart', async () => {
    const mock = installBridge({
      pending: [
        {
          pendingId: 'p1',
          description: 'Sign off on the two SRE reqs.',
          confidence: 0.9,
          citationArtifactId: 'art-p1',
        },
      ],
      // Simulates feedback given in an EARLIER run of the app (or a prior
      // briefing that surfaced the same still-open item) — nothing is clicked
      // in this test.
      claimVerdicts: { 'art-p1': 'relevant' },
    });
    await renderBriefing(mock);

    await screen.findByText('Sign off on the two SRE reqs.');
    expect(mock.claimVerdicts).toHaveBeenCalledWith(['art-p1']);

    const relevant = await screen.findByRole('button', { name: 'Relevant' });
    await waitFor(() => expect(relevant.getAttribute('aria-pressed')).toBe('true'));
  });

  it('places "Mark resolved" on the same row as the feedback buttons', async () => {
    const mock = installBridge({
      pending: [
        {
          pendingId: 'p1',
          description: 'Sign off on the two SRE reqs.',
          confidence: 0.9,
          citationArtifactId: 'art-p1',
        },
      ],
    });
    await renderBriefing(mock);

    await screen.findByText('Sign off on the two SRE reqs.');
    const resolveButton = screen.getByRole('button', { name: 'Mark resolved' });
    const feedbackRow = screen.getByRole('group', { name: 'Feedback on this claim' });
    expect(feedbackRow.contains(resolveButton)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Fixed section order                                                     */
/* -------------------------------------------------------------------------- */

describe('BriefingView — section order', () => {
  it('renders the four sections in canonical order regardless of arrival order', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    // Deliberately backwards, plus an unknown section that must be folded in.
    mock.emitChunk(chunk({ section: 'Worth knowing', claim: 'Lin gave notice.' }));
    mock.emitChunk(chunk({ section: 'Quietly resolved', claim: 'Vendor thread wrapped.' }));
    mock.emitChunk(chunk({ section: 'What moved', claim: 'Acme escalation resolved.' }));
    mock.emitChunk(chunk({ section: 'Waiting on you', claim: 'Review PR #2847.' }));

    await screen.findByText('Review PR #2847.');

    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      'Waiting on you',
      'What moved',
      'Quietly resolved',
      'Worth knowing',
    ]);

    // Each claim landed under its own heading, not merely somewhere on the page.
    const whatMoved = screen.getByRole('region', { name: 'What moved' });
    expect(within(whatMoved).getByText('Acme escalation resolved.')).toBeTruthy();
  });

  it('files a claim with an unrecognised section under "Worth knowing"', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    mock.emitChunk(chunk({ section: 'Hallucinated Heading', claim: 'Unfiled but cited.' }));

    await screen.findByText('Unfiled but cited.');
    const worthKnowing = screen.getByRole('region', { name: 'Worth knowing' });
    expect(within(worthKnowing).getByText('Unfiled but cited.')).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. OI-1 footer                                                             */
/* -------------------------------------------------------------------------- */

describe('BriefingView — still-processing footer (OI-1)', () => {
  it('shows "N threads still processing" when the backlog is non-empty', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    mock.emitDone(doneEvent({ threadsStillProcessing: 3 }));

    expect(await screen.findByText(/3 threads still processing/)).toBeTruthy();
  });

  it('omits the notice entirely when nothing is still processing', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    mock.emitDone(doneEvent({ threadsStillProcessing: 0 }));

    await waitFor(() =>
      expect(screen.getByTestId('briefing-stream').getAttribute('aria-busy')).toBe('false'),
    );
    expect(screen.queryByText(/threads still processing/)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 3b. Template-mode banner (§7.8, Task 4.3)                                  */
/* -------------------------------------------------------------------------- */

describe('BriefingView — simplified-briefing banner (§7.8 fallback)', () => {
  it('announces the fallback and its remedy when mode is "template"', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    // Nothing before `briefing:done` — the mode is not known until then, and a
    // banner that flickered in mid-stream would be a guess.
    expect(screen.queryByTestId('simplified-briefing-banner')).toBeNull();

    mock.emitDone(doneEvent({ mode: 'template' }));

    const banner = await screen.findByTestId('simplified-briefing-banner');
    expect(banner.textContent).toContain(SIMPLIFIED_BRIEFING_LABEL);
    expect(banner.textContent).toContain('local model unavailable');
    // The user is told what to DO about it, not merely that something is off.
    expect(banner.textContent).toContain(SIMPLIFIED_BRIEFING_REMEDY);
  });

  it('does not render the banner for a normal LLM briefing', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    mock.emitDone(doneEvent({ mode: 'llm' }));

    await waitFor(() =>
      expect(screen.getByTestId('briefing-stream').getAttribute('aria-busy')).toBe('false'),
    );
    expect(screen.queryByTestId('simplified-briefing-banner')).toBeNull();
    expect(screen.queryByText(new RegExp(SIMPLIFIED_BRIEFING_LABEL, 'i'))).toBeNull();
  });

  it('conveys the fallback in text, not by colour alone (NFR-9)', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    mock.emitDone(doneEvent({ mode: 'template' }));
    const banner = await screen.findByTestId('simplified-briefing-banner');

    // Announced to assistive tech, and readable with every style stripped.
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent?.trim().length ?? 0).toBeGreaterThan(20);
    expect(within(banner).getByText(SIMPLIFIED_BRIEFING_LABEL).tagName).toBe('STRONG');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Confidence flag                                                         */
/* -------------------------------------------------------------------------- */

describe('ClaimBullet — low-confidence flag', () => {
  it('flags a pending item whose confidence is below the threshold', async () => {
    const mock = installBridge({
      pending: [
        {
          pendingId: 'p-low',
          description: 'Maybe you owe Marcus a review.',
          confidence: LOW_CONFIDENCE_FLAG_THRESHOLD - 0.1,
          citationArtifactId: 'art-low',
        },
      ],
    });
    await renderBriefing(mock);

    await screen.findByText('Maybe you owe Marcus a review.');
    expect(screen.getByText(/low confidence/i)).toBeTruthy();
  });

  it('does not flag a confident item', async () => {
    const mock = installBridge({
      pending: [
        {
          pendingId: 'p-high',
          description: 'Approve the SRE reqs.',
          confidence: 0.95,
          citationArtifactId: 'art-high',
        },
      ],
    });
    await renderBriefing(mock);

    await screen.findByText('Approve the SRE reqs.');
    expect(screen.queryByText(/low confidence/i)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Drill-down (FR-6)                                                       */
/* -------------------------------------------------------------------------- */

describe('DrillDown — provenance (FR-6)', () => {
  it('fetches and renders source events plus the external deep link when a chip is clicked', async () => {
    const mock = installBridge({
      drilldown: {
        claimId: 'art-1',
        events: [
          {
            eventId: 'evt-1',
            source: 'slack',
            occurredAt: Date.parse('2026-03-07T15:00:00Z'),
            author: 'Marcus',
            text: 'Can you take a look at the adapter layer?',
            externalUrl: 'https://slack.example/archives/C1/p1',
          },
        ],
      },
    });
    await renderBriefing(mock);

    mock.emitChunk(chunk());
    const chip = await screen.findByRole('button', { name: 'sources' });

    fireEvent.click(chip);

    await waitFor(() => expect(mock.drilldown).toHaveBeenCalledWith('art-1'));
    expect(await screen.findByText('Can you take a look at the adapter layer?')).toBeTruthy();
    expect(screen.getByText('Marcus')).toBeTruthy();

    const link = screen.getByRole('link', { name: /open in slack/i });
    expect(link.getAttribute('href')).toBe('https://slack.example/archives/C1/p1');
  });

  it('opens the deep link through shell:openExternal instead of navigating (Task 4.6)', async () => {
    // The Electron shell now cancels every navigation that is not `app://` and
    // denies every `window.open`, so a deep link that relied on the anchor's
    // default action would be silently dead. The anchor stays (keyboard access,
    // link semantics); the click is routed over IPC.
    const mock = installBridge({
      drilldown: {
        claimId: 'art-1',
        events: [
          {
            eventId: 'evt-1',
            source: 'slack',
            occurredAt: Date.parse('2026-03-07T15:00:00Z'),
            author: 'Marcus',
            text: 'Can you take a look at the adapter layer?',
            externalUrl: 'https://slack.example/archives/C1/p1',
          },
        ],
      },
    });
    await renderBriefing(mock);

    mock.emitChunk(chunk());
    fireEvent.click(await screen.findByRole('button', { name: 'sources' }));
    const link = await screen.findByRole('link', { name: /open in slack/i });

    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(link, clickEvent);

    expect(mock.openExternal).toHaveBeenCalledWith('https://slack.example/archives/C1/p1');
    // The default action is suppressed, so the window never tries to navigate.
    expect(clickEvent.defaultPrevented).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Feedback (FR-7)                                                         */
/* -------------------------------------------------------------------------- */

describe('FeedbackControls — verdicts (FR-7)', () => {
  it('submits a claim-level verdict exactly once per click', async () => {
    const mock = installBridge();
    await renderBriefing(mock);
    mock.emitChunk(chunk());

    const relevant = await screen.findByRole('button', { name: 'Relevant' });
    fireEvent.click(relevant);

    // Exactly once: a handler bound on both the button and a wrapping row (or a
    // submit-typed button inside a form) would double-weight the verdict.
    await waitFor(() => expect(mock.submit).toHaveBeenCalledTimes(1));
    expect(mock.submit).toHaveBeenCalledWith({
      briefingId: BRIEFING_ID,
      claimId: 'art-1',
      verdict: 'relevant',
    });
    // The clicked button itself reads as active — no separate "recorded" note.
    await waitFor(() => expect(relevant.getAttribute('aria-pressed')).toBe('true'));

    // Changing one's mind must still work: the pressed state does not disable
    // the other verdicts.
    const notRelevant = screen.getByRole('button', { name: 'Not relevant' });
    fireEvent.click(notRelevant);

    await waitFor(() => expect(mock.submit).toHaveBeenCalledTimes(2));
    expect(mock.submit).toHaveBeenLastCalledWith({
      briefingId: BRIEFING_ID,
      claimId: 'art-1',
      verdict: 'irrelevant',
    });
    await waitFor(() => expect(notRelevant.getAttribute('aria-pressed')).toBe('true'));
    expect(relevant.getAttribute('aria-pressed')).toBe('false');
  });

  it('submits briefing-level "missed" feedback with no claimId', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    const missed = await screen.findByRole('button', { name: /missed something/i });
    fireEvent.click(missed);

    await waitFor(() => expect(mock.submit).toHaveBeenCalledTimes(1));
    const input = mock.submit.mock.calls[0]?.[0] as FeedbackInput;
    expect(input).toEqual({ briefingId: BRIEFING_ID, verdict: 'missed' });
    // Not merely undefined — the key must be absent from the wire payload.
    expect(Object.hasOwn(input, 'claimId')).toBe(false);
  });

  it('offers the three claim verdicts, and only those, on a claim', async () => {
    const mock = installBridge();
    await renderBriefing(mock);
    mock.emitChunk(chunk());

    await screen.findByRole('button', { name: 'Relevant' });
    expect(screen.getByRole('button', { name: 'Not relevant' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Wrong' })).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Caught up                                                               */
/* -------------------------------------------------------------------------- */

describe('CaughtUpButton', () => {
  it('calls briefing.caughtUp and visibly confirms afterwards', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    const button = await screen.findByRole('button', { name: /i'm caught up/i });
    fireEvent.click(button);

    await waitFor(() => expect(mock.caughtUp).toHaveBeenCalledWith(BRIEFING_ID));

    const confirmed = await screen.findByRole('button', { name: /marked as caught up/i });
    expect((confirmed as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/next briefing will start from here/i)).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* 8. Accessibility (NFR-9)                                                   */
/* -------------------------------------------------------------------------- */

describe('BriefingView — accessibility (NFR-9)', () => {
  it('uses real heading elements for the briefing and its sections', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    const title = screen.getByRole('heading', { level: 2 });
    expect(title.tagName).toBe('H2');
    expect(title.textContent).toBe('What you missed');

    const sections = screen.getAllByRole('heading', { level: 3 });
    expect(sections).toHaveLength(4);
    for (const heading of sections) expect(heading.tagName).toBe('H3');
  });

  it('announces streamed claims through an aria-live="polite" region', async () => {
    const mock = installBridge();
    await renderBriefing(mock);

    const live = screen.getByTestId('briefing-stream');
    expect(live.getAttribute('aria-live')).toBe('polite');
    // Busy while streaming, so assistive tech is not read a half-written briefing.
    expect(live.getAttribute('aria-busy')).toBe('true');

    mock.emitChunk(chunk({ claim: 'Streamed into the live region.' }));
    const claim = await screen.findByText('Streamed into the live region.');
    expect(live.contains(claim)).toBe(true);
  });

  it('makes citation chips and drill-down triggers keyboard-reachable buttons', async () => {
    const mock = installBridge();
    await renderBriefing(mock);
    mock.emitChunk(chunk());

    const chip = await screen.findByRole('button', { name: 'sources' });
    // A <span onClick> would satisfy neither of these.
    expect(chip.tagName).toBe('BUTTON');
    expect((chip as HTMLButtonElement).type).toBe('button');

    // Keyboard activation, not just mouse: focus it and press Enter the way a
    // keyboard user would. Native buttons translate that into a click.
    chip.focus();
    expect(document.activeElement).toBe(chip);
    fireEvent.click(chip); // what Enter dispatches on a native button
    await waitFor(() => expect(mock.drilldown).toHaveBeenCalledTimes(1));
  });

  it('ships a :focus-visible outline rule, which inline styles cannot express', () => {
    // This used to render `<BriefingView />` and query a scoped `<style>` tag
    // it emitted — but this test never mounts `RootLayout`, so `globals.css`
    // was never loaded into jsdom for it, even before that tag moved into the
    // stylesheet. The rule now lives in `globals.css` itself, so it's the CSS
    // source, not the rendered DOM, that answers "does this rule ship" —
    // same guarantee, correct mechanism.
    const cssPath = join(dirname(fileURLToPath(import.meta.url)), '../app/globals.css');
    const css = readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.cr-interactive:focus-visible');
    expect(css).toContain('outline');
  });
});

/* -------------------------------------------------------------------------- */
/* 9. Subscription teardown                                                   */
/* -------------------------------------------------------------------------- */

describe('BriefingView — subscription lifecycle', () => {
  it('unsubscribes from onChunk and onDone on unmount', async () => {
    const mock = installBridge();
    const view = render(<BriefingView />);
    await waitFor(() => expect(mock.pending).toHaveBeenCalled());
    expect(mock.chunkListenerCount()).toBe(1);

    view.unmount();

    expect(mock.unsubscribeChunk).toHaveBeenCalledTimes(1);
    expect(mock.unsubscribeDone).toHaveBeenCalledTimes(1);
    expect(mock.chunkListenerCount()).toBe(0);
  });

  it('does not replay or duplicate claims across a remount', async () => {
    const mock = installBridge();
    const first = render(<BriefingView />);
    await waitFor(() => expect(mock.pending).toHaveBeenCalled());

    mock.emitChunk(chunk({ claim: 'Only once, please.' }));
    await screen.findByText('Only once, please.');

    first.unmount();

    render(<BriefingView />);
    await waitFor(() => expect(mock.pending).toHaveBeenCalledTimes(2));

    // The remounted view starts empty — the old claim is not replayed…
    expect(screen.queryByText('Only once, please.')).toBeNull();

    // …and the leaked-listener failure mode is gone: one emit, one bullet.
    mock.emitChunk(chunk({ claim: 'Only once, please.' }));
    await screen.findByText('Only once, please.');
    expect(screen.getAllByText('Only once, please.')).toHaveLength(1);
  });
});
