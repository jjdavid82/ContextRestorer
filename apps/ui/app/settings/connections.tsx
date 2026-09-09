'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../../lib/bridge';
import type { OnboardingStatus, SourceId } from '../../types/bridge';
import { PanelHeading } from './PanelHeading';

/**
 * Source connection manager (settings panel).
 *
 * Onboarding is where Slack and Gmail are first connected, but it is a one-way
 * flow: once projects are declared it lands on its summary step and never
 * returns to the connect screen. A user whose token was revoked, who connected
 * the wrong Google account, or who simply skipped a source at setup had no way
 * back. This panel is that way back — it drives the same `oauth:connect` /
 * `oauth:revoke` channels the wizard uses.
 *
 * Connection state is read from `onboarding:status` (its `sourcesConnected` list
 * is exactly "which sources hold a usable, non-revoked credential") and
 * re-fetched after every action rather than tracked locally, so the chip cannot
 * drift from what the vault actually holds.
 */

/** Sources the app can ingest from, in display order — mirrors onboarding. */
const SOURCES: readonly SourceId[] = ['slack', 'gmail'];

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function ConnectionsSettings(): ReactNode {
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busySource, setBusySource] = useState<SourceId | null>(null);
  const [linkCopiedFor, setLinkCopiedFor] = useState<SourceId | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      setStatus(await getBridge().onboarding.status());
    } catch (cause) {
      setLoadError(describe(cause));
    }
  }, []);

  useEffect(() => {
    if (!hasBridge()) {
      setLoadError('Connecting a source is only available inside the Context Restorer desktop app.');
      return;
    }
    void refresh();
  }, [refresh]);

  const connect = useCallback(
    async (source: SourceId): Promise<void> => {
      setBusySource(source);
      setActionError(null);
      // The main process copies the sign-in URL to the clipboard as it opens the
      // system browser (`ipc/oauth.ts`); surface that the same way onboarding
      // does, for the user whose provider session lives in another browser.
      setLinkCopiedFor(source);
      try {
        const result = await getBridge().oauth.connect(source);
        if (!result.ok) setActionError(`${source}: ${result.reason ?? 'connect failed'}`);
        await refresh();
      } catch (cause) {
        setActionError(describe(cause));
      } finally {
        setBusySource(null);
        setLinkCopiedFor(null);
      }
    },
    [refresh],
  );

  const disconnect = useCallback(
    async (source: SourceId): Promise<void> => {
      setBusySource(source);
      setActionError(null);
      try {
        const result = await getBridge().oauth.revoke(source);
        if (!result.ok) setActionError(`${source}: ${result.reason ?? 'disconnect failed'}`);
        await refresh();
      } catch (cause) {
        setActionError(describe(cause));
      } finally {
        setBusySource(null);
      }
    },
    [refresh],
  );

  const connected = status?.sourcesConnected ?? [];

  return (
    <Box>
      <PanelHeading
        title="Connections"
        lead="Connect, reconnect, or disconnect Slack and Gmail. Context Restorer reads their activity locally — nothing leaves this machine except the sign-in itself."
      />

      {loadError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main' }}>
          Could not load connection status: {loadError}
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{
            listStyle: 'none',
            p: 0,
            m: 0,
            '& > li': { py: 1.5, borderTop: 1, borderColor: 'divider' },
            '& > li:first-of-type': { borderTop: 0 },
          }}
        >
          {SOURCES.map((source) => {
            const isConnected = connected.includes(source);
            const busy = busySource === source;
            return (
              <Box component="li" key={source}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                  <Typography sx={{ textTransform: 'capitalize', fontWeight: 600, minWidth: 56 }}>
                    {source}
                  </Typography>
                  <Chip
                    size="small"
                    variant="outlined"
                    color={isConnected ? 'success' : 'default'}
                    label={isConnected ? 'connected' : 'not connected'}
                  />
                  <Box sx={{ display: 'flex', gap: 1, ml: 'auto' }}>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={busy}
                      onClick={() => void connect(source)}
                    >
                      {isConnected ? 'Reconnect' : 'Connect'}
                    </Button>
                    {isConnected ? (
                      <Button
                        size="small"
                        variant="text"
                        color="error"
                        disabled={busy}
                        onClick={() => void disconnect(source)}
                      >
                        Disconnect
                      </Button>
                    ) : null}
                  </Box>
                </Box>
                {linkCopiedFor === source ? (
                  <Typography sx={{ fontSize: '0.85rem', color: 'text.secondary', mt: 0.75 }}>
                    Sign-in link copied to your clipboard. If it opened in the wrong browser or
                    account, paste it into the browser where you&apos;re already signed in.
                  </Typography>
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}

      {actionError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main', mt: 2 }}>
          {actionError}
        </Typography>
      ) : null}
    </Box>
  );
}
