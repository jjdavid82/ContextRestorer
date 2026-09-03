'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { StepIndicator } from '../../components/StepIndicator';
import { getBridge } from '../../lib/bridge';
import type { OnboardingStatus, ProjectCandidate, SourceId } from '../../types/bridge';

/**
 * First-run onboarding (Task 3.1, OI-3).
 *
 * Four steps, in the order the plan mandates:
 *
 *   connect sources → initial sync → declare 3–5 projects → done
 *
 * The order is not cosmetic. Suggestions are mined from *ingested* events, so a
 * user who reaches the declare step before any sync has happened would be shown
 * an empty list and conclude the feature is broken. Sync therefore gets a step
 * of its own with visible progress, and the declare step always offers free-text
 * entry alongside the suggestions — the documented fallback for the (expected,
 * on a fresh install) case where there is not yet enough evidence to suggest
 * anything.
 *
 * Styled via the shared design tokens and control classes in `globals.css`
 * (`.btn`, `.field-row`, `.status-chip`, `.chip-list`, `StepIndicator`) — no
 * CSS framework, no new dependencies, no change to the step machine below.
 */

/**
 * Suggested project count — a hint only, not enforced (OI-3 relaxed).
 *
 * The mandatory 3-project floor was dropped: declared-project stakes have no
 * ranking effect yet (nothing in the pipeline creates the `belongs_to` graph
 * edge the ranker's `wStakes` term reads), so requiring names gated
 * onboarding on a signal that does nothing. `config.onboarding.minDeclaredProjects`
 * is now `0`, and `projects:declare` accepts an empty declaration.
 */
const SUGGESTED_MIN_PROJECTS = 3;

/** Soft upper bound used only in the hint text; declaring more is allowed. */
const SUGGESTED_MAX_PROJECTS = 5;

/** The sources onboarding asks the user to connect, in display order. */
const SOURCES: readonly SourceId[] = ['slack', 'gmail'];

type Step = 'connect' | 'sync' | 'declare' | 'done';

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function OnboardingPage(): ReactNode {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('connect');

  const [candidates, setCandidates] = useState<ProjectCandidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [customName, setCustomName] = useState('');

  const [busy, setBusy] = useState(false);
  const [declareError, setDeclareError] = useState<string | null>(null);

  /** Re-read `onboarding:status`. Returns the fresh status, or `null` on failure. */
  const refreshStatus = useCallback(async (): Promise<OnboardingStatus | null> => {
    try {
      const next = await getBridge().onboarding.status();
      setStatus(next);
      setBridgeError(null);
      return next;
    } catch (cause) {
      setBridgeError(describe(cause));
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refreshStatus().then((next) => {
      // Already onboarded: land on the summary instead of walking a returning
      // user back through a flow they have completed.
      if (active && next !== null && next.projectsDeclared.length > 0) setStep('done');
    });
    return () => {
      active = false;
    };
  }, [refreshStatus]);

  // The "initial sync" step. `projects:suggest` is the only observable the
  // renderer has for it — the poller runs in the main process — so the step
  // resolves when suggestions come back, empty list included.
  useEffect(() => {
    if (step !== 'sync') return undefined;

    let active = true;
    (async (): Promise<void> => {
      try {
        const suggestions = await getBridge().projects.suggest();
        if (!active) return;
        setCandidates(suggestions.candidates);
      } catch (cause) {
        // A failed suggestion fetch must not trap the user: free text still works.
        if (active) setBridgeError(describe(cause));
      } finally {
        if (active) setStep('declare');
      }
    })();

    return () => {
      active = false;
    };
  }, [step]);

  const toggle = useCallback((name: string): void => {
    setSelected((current) =>
      current.includes(name) ? current.filter((n) => n !== name) : [...current, name],
    );
  }, []);

  const addCustom = useCallback((): void => {
    const name = customName.trim();
    if (name === '') return;
    setSelected((current) => (current.includes(name) ? current : [...current, name]));
    setCustomName('');
  }, [customName]);

  const declare = useCallback(async (): Promise<void> => {
    setBusy(true);
    setDeclareError(null);
    try {
      const result = await getBridge().projects.declare(selected);
      if (!result.ok) {
        setDeclareError(result.reason ?? 'declaration was rejected');
        return;
      }
      await refreshStatus();
      setStep('done');
    } catch (cause) {
      setDeclareError(describe(cause));
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, selected]);

  // Set as soon as a connect attempt starts, cleared once it settles. The main
  // process copies the sign-in URL to the clipboard right as it opens the
  // system browser (`ipc/oauth.ts`) — this is what tells the user that
  // happened, since a provider whose active session lives in a different
  // browser needs to paste the link there instead of using the one Electron
  // opened automatically.
  const [linkCopiedFor, setLinkCopiedFor] = useState<SourceId | null>(null);

  const connect = useCallback(
    async (source: SourceId): Promise<void> => {
      setBusy(true);
      setLinkCopiedFor(source);
      try {
        const result = await getBridge().oauth.connect(source);
        if (!result.ok) setBridgeError(`${source}: ${result.reason ?? 'connect failed'}`);
        await refreshStatus();
      } catch (cause) {
        setBridgeError(describe(cause));
      } finally {
        setBusy(false);
        setLinkCopiedFor(null);
      }
    },
    [refreshStatus],
  );

  const connected = status?.sourcesConnected ?? [];

  return (
    <main className="stack-main">
      <h1 className="page-title">Set up Context Restorer</h1>
      <StepIndicator
        current={step === 'connect' ? 1 : step === 'sync' ? 2 : step === 'declare' ? 3 : 4}
        total={4}
        labels={['Connect sources', 'First sync', 'Declare projects', 'Done']}
      />

      {bridgeError !== null ? <p role="alert">Something went wrong: {bridgeError}</p> : null}

      {step === 'connect' ? (
        <section className="card">
          <h2>1. Connect your sources</h2>
          <p>
            Context Restorer reads your Slack and Gmail activity locally. Nothing leaves this
            machine.
          </p>
          <ul className="list-reset">
            {SOURCES.map((source) => (
              <li key={source} className="mb-sm">
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={busy}
                  onClick={() => void connect(source)}
                >
                  Connect {source}
                </button>{' '}
                <span
                  className={`status-chip ${
                    connected.includes(source) ? 'status-chip--connected' : 'status-chip--pending'
                  }`}
                >
                  {connected.includes(source) ? 'connected' : 'not connected'}
                </span>
                {linkCopiedFor === source ? (
                  <p>
                    Sign-in link copied to your clipboard. If it opened in the wrong browser or
                    account, paste it into the browser where you&apos;re already signed in.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn--primary" onClick={() => setStep('sync')}>
            {/* Not gated on a connected source: a user can proceed and declare
                projects by hand, then connect later. Blocking here would strand
                anyone whose OAuth app is not configured yet (`not_configured`). */}
            Continue
          </button>
        </section>
      ) : null}

      {step === 'sync' ? (
        <section className="card">
          <h2>2. First sync</h2>
          {/* Visible progress, deliberately minimal — a real percentage would be a
              number we cannot honestly compute yet. */}
          <p role="status" aria-live="polite">
            Reading your recent activity…
          </p>
        </section>
      ) : null}

      {step === 'declare' ? (
        <section className="card">
          <h2>3. Declare your projects (optional)</h2>
          <p>
            Optionally pick {SUGGESTED_MIN_PROJECTS}–{SUGGESTED_MAX_PROJECTS} things you are
            working on, or skip this step. You can edit any name, type your own, or come back
            later.
          </p>

          {candidates.length > 0 ? (
            <ul className="list-reset">
              {candidates.map((candidate) => (
                <li key={`${candidate.source}:${candidate.name}`} className="field-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(candidate.name)}
                      onChange={() => toggle(candidate.name)}
                    />{' '}
                    {candidate.name}{' '}
                    <small>({candidate.reason ?? `${candidate.evidenceCount} messages`})</small>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              No suggestions yet — that just means there is not enough synced activity to guess
              from. Type your projects below.
            </p>
          )}

          <div className="form-field">
            <label className="form-field__label" htmlFor="custom-project-name">
              Add a project
            </label>
            <input
              id="custom-project-name"
              type="text"
              value={customName}
              placeholder="e.g. Q3 migration"
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustom();
                }
              }}
            />{' '}
            <button
              type="button"
              className="btn btn--secondary"
              onClick={addCustom}
              disabled={customName.trim() === ''}
            >
              Add
            </button>
          </div>

          <h3>Selected ({selected.length})</h3>
          {selected.length === 0 ? (
            <p>Nothing selected yet.</p>
          ) : (
            <ul className="chip-list list-reset">
              {selected.map((name) => (
                <li key={name} className="chip-list__item">
                  {name}{' '}
                  <button
                    type="button"
                    className="chip-list__remove"
                    onClick={() => toggle(name)}
                    aria-label={`Remove ${name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          {declareError !== null ? <p role="alert">Could not save: {declareError}</p> : null}

          <button
            type="button"
            className="btn btn--primary"
            disabled={busy}
            onClick={() => void declare()}
          >
            {busy ? 'Saving…' : selected.length === 0 ? 'Skip for now' : 'Save projects'}
          </button>
        </section>
      ) : null}

      {step === 'done' ? (
        <section className="card">
          <h2>You are set up</h2>
          <p>
            Declared projects:{' '}
            {status !== null && status.projectsDeclared.length > 0
              ? status.projectsDeclared.join(', ')
              : 'none yet'}
          </p>
          {/* R-6: the first briefing is the worst briefing. Say so up front —
              but without promising a learning loop X-2 excludes. See the matching
              comment in `components/BriefingView.tsx`; both copies claimed
              feedback "sharpens" the ranking, and neither does. */}
          <p>
            <small>
              The first few briefings will be rough. Ranking uses the projects you declare
              here — nothing is learned from what you click, so declaring the right projects
              is what improves them.
            </small>
          </p>
          {/* Root-relative, not `next/link`: the bundle is served over the custom
              `app://` protocol, whose handler resolves a directory-style URL to a
              directory (which cannot be fetched) — naming `index.html` explicitly
              is the one form guaranteed to resolve. Root-relative rather than `../`
              because `app://` is a fixed-host "standard" scheme, so a root-relative
              URL resolves correctly regardless of this page's own route depth. */}
          <p>
            <a href="/index.html" className="btn btn--primary">
              Go to your briefing
            </a>
          </p>
          <button type="button" className="btn btn--secondary" onClick={() => setStep('declare')}>
            Edit projects
          </button>
        </section>
      ) : null}
    </main>
  );
}
