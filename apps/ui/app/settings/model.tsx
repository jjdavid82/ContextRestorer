'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge } from '../../lib/bridge';
import type { ModelInfo } from '../../types/bridge';

/**
 * Chat-model picker (Settings page).
 *
 * Exists because a machine with no GPU and little free RAM can take MINUTES to
 * produce a single token from a 14B-class model — the model shipped in
 * `config/default.json` is not a safe fit for every machine this app runs on,
 * and until this panel existed there was no way to change it short of
 * hand-editing that file.
 *
 * Only ever offers a model `available` already lists — i.e. one Ollama
 * reports as actually installed on this machine — never a hardcoded name that
 * might not exist here and would fail the startup preflight gate if selected.
 *
 * Saving does NOT switch the running app over live: `main.ts` captures
 * `config.model.chat` once, at startup, into `BriefingGenerator` and every
 * other consumer, so the new choice only takes effect on the next launch.
 * That is said explicitly below the control, not left to be discovered.
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

  // The current effective model might be an override for something the user
  // has since removed from Ollama (`ollama rm`) — included so the <select>
  // never silently jumps to a different value than what is actually saved.
  const options =
    info === null
      ? []
      : info.available.includes(info.chat)
        ? info.available
        : [info.chat, ...info.available];

  return (
    <section className="card">
      <h2>Chat model</h2>
      <p>
        <small>
          The local model that writes your briefings. A smaller model answers faster but with
          rougher prose; a larger one is slower but more capable. Changing this takes effect the
          next time you start the app, not immediately.
        </small>
      </p>

      {loadError !== null ? (
        <p role="alert">Could not load model settings: {loadError}</p>
      ) : info === null ? (
        <p>Loading…</p>
      ) : options.length === 0 ? (
        <p role="alert">
          No models found — is Ollama running? Currently configured: <code>{info.chat}</code>.
        </p>
      ) : (
        <>
          <label>
            Model:{' '}
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {options.map((model) => (
                <option key={model} value={model}>
                  {model}
                  {model === info.defaultChat ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <div>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || selected === info.chat}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}

      {saved ? <p role="status">Saved — restart the app to use it.</p> : null}
      {saveError !== null ? <p role="alert">Could not save: {saveError}</p> : null}
    </section>
  );
}
