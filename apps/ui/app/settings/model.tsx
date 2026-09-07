'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../../lib/bridge';
import type { ModelInfo } from '../../types/bridge';
import { PanelHeading } from './PanelHeading';

/**
 * Chat-model picker (settings panel).
 *
 * A machine with no GPU and little free RAM can take minutes to produce a
 * single token from a 14B-class model — the model in `config/default.json` is
 * not a safe fit for every machine, and until this existed there was no way to
 * change it short of hand-editing that file.
 *
 * Only ever offers a model `available` already lists — one Ollama reports as
 * actually installed — never a hardcoded name that might not exist here.
 *
 * Saving does NOT switch the running app live: `main.ts` captures
 * `config.model.chat` once, at startup (OI-2). The new choice takes effect on
 * the next launch, and that is said explicitly below the control.
 */

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function ModelSettings(): ReactNode {
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [selected, setSelected] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const next = await getBridge().model.get();
      setInfo(next);
      setSelected(next.chat);
    } catch (cause) {
      setLoadError(describe(cause));
    }
  }, []);

  useEffect(() => {
    if (!hasBridge()) {
      setLoadError('The chat-model picker is only available inside the Context Restorer desktop app.');
      return;
    }
    void refresh();
  }, [refresh]);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      const result = await getBridge().model.setChat(selected);
      if (result.ok) {
        setSaved(true);
        await refresh();
      } else {
        setSaveError(result.reason ?? 'the model was rejected');
      }
    } catch (cause) {
      setSaveError(describe(cause));
    } finally {
      setBusy(false);
    }
  }, [refresh, selected]);

  // The current effective model might be an override for something since removed
  // from Ollama (`ollama rm`) — included so the picker never silently jumps.
  const options =
    info === null
      ? []
      : info.available.includes(info.chat)
        ? info.available
        : [info.chat, ...info.available];

  return (
    <Box>
      <PanelHeading
        title="Chat model"
        lead="The local model that writes your briefings. A smaller model answers faster but with rougher prose. Changing this takes effect the next time you start the app, not immediately."
      />

      {loadError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main' }}>
          Could not load model settings: {loadError}
        </Typography>
      ) : info === null ? (
        <Typography sx={{ color: 'text.secondary' }}>Loading…</Typography>
      ) : options.length === 0 ? (
        <Typography role="alert" sx={{ color: 'error.main' }}>
          No models found — is Ollama running? Currently configured:{' '}
          <Box component="code">{info.chat}</Box>.
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 360 }}>
          <TextField
            select
            size="small"
            label="Model"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            {options.map((model) => (
              <MenuItem key={model} value={model}>
                {model}
                {model === info.defaultChat ? ' (default)' : ''}
              </MenuItem>
            ))}
          </TextField>
          <Box>
            <Button
              variant="contained"
              disabled={busy || selected === info.chat}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </Box>
        </Box>
      )}

      {saved ? (
        <Typography role="status" sx={{ color: 'success.main', mt: 2 }}>
          Saved — restart the app to use it.
        </Typography>
      ) : null}
      {saveError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main', mt: 2 }}>
          Could not save: {saveError}
        </Typography>
      ) : null}
    </Box>
  );
}
