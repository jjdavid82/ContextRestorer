'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { PageToolbar } from '../../components/PageToolbar';
import { getBridge, hasBridge } from '../../lib/bridge';
import type { OnboardingStatus, ProjectCandidate, SourceId } from '../../types/bridge';

/**
 * First-run onboarding (Task 3.1, OI-3).
 *
 * Four steps, in the order the plan mandates:
 *
 *   connect sources → initial sync → declare 3–5 projects → done
 *
 * The order is not cosmetic. Suggestions are mined from *ingested* events, so a
 * user who reaches the declare step before any sync has run would see an empty
 * list and conclude the feature is broken. Sync therefore gets its own step
 * with visible progress, and the declare step always offers free-text entry
 * alongside the suggestions — the documented fallback for the (expected, on a
 * fresh install) case where there is not yet enough evidence to suggest
 * anything.
 *
 * The step machine below is unchanged from before the MUI redesign — only the
 * markup is MUI now (`Stepper`, per-step `Card`).
 */

/**
 * Suggested project count — a hint only, not enforced (OI-3 relaxed).
 *
 * The mandatory 3-project floor was dropped: declared-project stakes have no
 * ranking effect yet (nothing creates the `belongs_to` edge the ranker's
 * `wStakes` term reads). `config.onboarding.minDeclaredProjects` is now `0` and
 * `projects:declare` accepts an empty declaration.
 */
const SUGGESTED_MIN_PROJECTS = 3;

/** Soft upper bound used only in the hint text; declaring more is allowed. */
const SUGGESTED_MAX_PROJECTS = 5;

/** The sources onboarding asks the user to connect, in display order. */
const SOURCES: readonly SourceId[] = ['slack', 'gmail'];

type Step = 'connect' | 'sync' | 'declare' | 'done';

const STEP_LABELS: Record<Step, string> = {
  connect: 'Connect sources',
  sync: 'First sync',
  declare: 'Declare projects',
  done: 'Done',
};
const STEP_ORDER: readonly Step[] = ['connect', 'sync', 'declare', 'done'];

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const CARD_SX = { maxWidth: 560, mx: 'auto' } as const;

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
    if (!hasBridge()) {
      setBridgeError('Setup runs inside the Context Restorer desktop app.');
      return;
    }
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
  // process copies the sign-in URL to the clipboard as it opens the system
  // browser (`ipc/oauth.ts`) — this is what tells the user that happened, since
  // a provider whose active session lives in a different browser needs the link
  // pasted there instead.
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
  const activeStepIndex = STEP_ORDER.indexOf(step);

  return (
    <>
      <PageToolbar title="Set up Context Restorer" />
      <Box sx={{ maxWidth: 640, mx: 'auto', width: '100%', p: 3 }}>
        <Stepper
          activeStep={activeStepIndex}
          alternativeLabel
          role="group"
          aria-label={`Setup progress, step ${activeStepIndex + 1} of ${STEP_ORDER.length}`}
          sx={{ mb: 4 }}
        >
          {STEP_ORDER.map((s) => (
            // MUI `Step` sets no `aria-current`; the old `StepIndicator` did, and
            // it is how a screen reader locates "you are here" in the trail.
            <Step key={s} {...(s === step ? { 'aria-current': 'step' as const } : {})}>
              <StepLabel>{STEP_LABELS[s]}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {bridgeError !== null ? (
          <Typography role="alert" sx={{ color: 'error.main', mb: 2 }}>
            Something went wrong: {bridgeError}
          </Typography>
        ) : null}

        {step === 'connect' ? (
          <Card sx={CARD_SX}>
            <CardContent>
              <Typography component="h2" sx={{ fontSize: '1.15rem', fontWeight: 650, mb: 1 }}>
                1. Connect your sources
              </Typography>
              <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem', mb: 2 }}>
                Context Restorer reads your Slack and Gmail activity locally. Nothing leaves this
                machine.
              </Typography>

              <Box
                component="ul"
                sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}
              >
                {SOURCES.map((source) => (
                  <Box component="li" key={source}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                      <Button
                        variant="outlined"
                        disabled={busy}
                        onClick={() => void connect(source)}
                        sx={{ textTransform: 'capitalize' }}
                      >
                        Connect {source}
                      </Button>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={connected.includes(source) ? 'success' : 'default'}
                        label={connected.includes(source) ? 'connected' : 'not connected'}
                      />
                    </Box>
                    {linkCopiedFor === source ? (
                      <Typography sx={{ fontSize: '0.85rem', color: 'text.secondary', mt: 0.5 }}>
                        Sign-in link copied to your clipboard. If it opened in the wrong browser or
                        account, paste it into the browser where you&apos;re already signed in.
                      </Typography>
                    ) : null}
                  </Box>
                ))}
              </Box>

              <Button
                variant="contained"
                sx={{ mt: 2.5 }}
                onClick={() => setStep('sync')}
              >
                {/* Not gated on a connected source: a user can proceed and declare
                    projects by hand, then connect later. Blocking here would
                    strand anyone whose OAuth app is not configured yet. */}
                Continue
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {step === 'sync' ? (
          <Card sx={CARD_SX}>
            <CardContent>
              <Typography component="h2" sx={{ fontSize: '1.15rem', fontWeight: 650, mb: 1.5 }}>
                2. First sync
              </Typography>
              {/* Visible progress, deliberately minimal — a real percentage would
                  be a number we cannot honestly compute yet. */}
              <Box role="status" aria-live="polite" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <CircularProgress size={18} />
                <Typography>Reading your recent activity…</Typography>
              </Box>
            </CardContent>
          </Card>
        ) : null}

        {step === 'declare' ? (
          <Card sx={CARD_SX}>
            <CardContent>
              <Typography component="h2" sx={{ fontSize: '1.15rem', fontWeight: 650, mb: 1 }}>
                3. Declare your projects (optional)
              </Typography>
              <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem', mb: 2 }}>
                Optionally pick {SUGGESTED_MIN_PROJECTS}–{SUGGESTED_MAX_PROJECTS} things you are
                working on, or skip this step. You can edit any name, type your own, or come back
                later.
              </Typography>

              {candidates.length > 0 ? (
                <Box
                  component="ul"
                  sx={{ listStyle: 'none', p: 0, m: 0, display: 'flex', flexDirection: 'column' }}
                >
                  {candidates.map((candidate) => (
                    <Box component="li" key={`${candidate.source}:${candidate.name}`}>
                      <FormControlLabel
                        sx={{ m: 0 }}
                        control={
                          <Checkbox
                            size="small"
                            checked={selected.includes(candidate.name)}
                            onChange={() => toggle(candidate.name)}
                          />
                        }
                        label={
                          <Box component="span">
                            {candidate.name}{' '}
                            <Box component="span" sx={{ color: 'text.secondary', fontSize: '0.82rem' }}>
                              ({candidate.reason ?? `${candidate.evidenceCount} messages`})
                            </Box>
                          </Box>
                        }
                      />
                    </Box>
                  ))}
                </Box>
              ) : (
                <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem' }}>
                  No suggestions yet — that just means there is not enough synced activity to guess
                  from. Type your projects below.
                </Typography>
              )}

              <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
                <TextField
                  id="custom-project-name"
                  size="small"
                  label="Add a project"
                  placeholder="e.g. Q3 migration"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCustom();
                    }
                  }}
                  sx={{ flex: 1 }}
                />
                <Button variant="outlined" onClick={addCustom} disabled={customName.trim() === ''}>
                  Add
                </Button>
              </Box>

              <Typography component="h3" sx={{ fontSize: '0.9rem', fontWeight: 650, mt: 2.5, mb: 1 }}>
                Selected ({selected.length})
              </Typography>
              {selected.length === 0 ? (
                <Typography sx={{ color: 'text.secondary', fontSize: '0.9rem' }}>
                  Nothing selected yet.
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                  {selected.map((name) => (
                    <Chip
                      key={name}
                      label={name}
                      variant="outlined"
                      color="primary"
                      onDelete={() => toggle(name)}
                    />
                  ))}
                </Box>
              )}

              {declareError !== null ? (
                <Typography role="alert" sx={{ color: 'error.main', mt: 1.5 }}>
                  Could not save: {declareError}
                </Typography>
              ) : null}

              <Box sx={{ display: 'flex', gap: 1, mt: 2.5 }}>
                <Button variant="outlined" onClick={() => setStep('sync')}>
                  Back
                </Button>
                <Button variant="contained" disabled={busy} onClick={() => void declare()}>
                  {busy ? 'Saving…' : selected.length === 0 ? 'Skip for now' : 'Save projects'}
                </Button>
              </Box>
            </CardContent>
          </Card>
        ) : null}

        {step === 'done' ? (
          <Card sx={CARD_SX}>
            <CardContent>
              <Typography component="h2" sx={{ fontSize: '1.15rem', fontWeight: 650, mb: 1 }}>
                You are set up
              </Typography>
              <Typography sx={{ mb: 1.5 }}>
                Declared projects:{' '}
                {status !== null && status.projectsDeclared.length > 0
                  ? status.projectsDeclared.join(', ')
                  : 'none yet'}
              </Typography>
              {/* R-6: the first briefing is the worst briefing. Say so up front —
                  but without promising a learning loop X-2 excludes. */}
              <Typography sx={{ color: 'text.secondary', fontSize: '0.85rem', mb: 2 }}>
                The first few briefings will be rough. Ranking uses the projects you declare here —
                nothing is learned from what you click, so declaring the right projects is what
                improves them.
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {/* Root-relative with the filename spelled out: the bundle is
                    served over the `app://` fixed-host scheme, whose handler
                    cannot fetch a directory-style URL. */}
                <Button variant="contained" component="a" href="/index.html">
                  Go to your briefing
                </Button>
                <Button variant="outlined" onClick={() => setStep('declare')}>
                  Edit projects
                </Button>
              </Box>
            </CardContent>
          </Card>
        ) : null}
      </Box>
    </>
  );
}
