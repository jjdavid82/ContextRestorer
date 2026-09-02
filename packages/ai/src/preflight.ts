/**
 * Startup preflight for the local Ollama instance.
 *
 * This module only *reports* state. The caller decides whether to fail loudly
 * or fall back to template mode at briefing time.
 */

import { guardedFetchUrl } from './ollama.js';

/** Outcome of a preflight probe. Exactly one branch is returned. */
export type PreflightResult =
  | { ok: true }
  | { ok: false; reason: 'unreachable'; message: string }
  | { ok: false; reason: 'model_missing'; remedy: string }
  | { ok: false; reason: 'embed_model_missing'; remedy: string };

/** Subset of Ollama's `/api/tags` response that we rely on. */
interface TagsEnvelope {
  models?: Array<{ name?: string; model?: string }>;
}

/**
 * Canonicalises a model reference by making the implicit `:latest` tag
 * explicit, which is exactly what `ollama pull` does.
 *
 * This is not fuzzy matching: it only resolves the one alias Ollama itself
 * defines. `qwen2.5` becomes `qwen2.5:latest` and therefore still does NOT
 * match an installed `qwen2.5:14b`. Without this, a config value of
 * `nomic-embed-text` would never match the installed `nomic-embed-text:latest`
 * and preflight would fail against a perfectly healthy instance.
 */
function canonicalModel(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

/**
 * Probes `GET {baseUrl}/api/tags` and verifies both required models are pulled.
 *
 * Never rejects: any unexpected failure resolves to an `unreachable` result.
 *
 * @param baseUrl - Local Ollama base URL, e.g. `http://localhost:11434`.
 * @param chatModel - Required chat model, in full `name:tag` form.
 * @param embedModel - Required embedding model, in full `name:tag` form.
 */
export async function preflight(
  baseUrl: string,
  chatModel: string,
  embedModel: string,
): Promise<PreflightResult> {
  try {
    const res = await guardedFetchUrl(`${baseUrl.replace(/\/+$/, '')}/api/tags`);
    if (!res.ok) {
      return {
        ok: false,
        reason: 'unreachable',
        message: `Ollama at ${baseUrl} responded ${res.status} to /api/tags`,
      };
    }

    const body = (await res.json()) as TagsEnvelope;
    const installed = new Set<string>();
    for (const entry of body.models ?? []) {
      // Exact-match only (after `:latest` canonicalisation): a wrong tag must
      // never silently pass preflight.
      if (typeof entry?.name === 'string') installed.add(canonicalModel(entry.name));
      if (typeof entry?.model === 'string') installed.add(canonicalModel(entry.model));
    }

    if (!installed.has(canonicalModel(chatModel))) {
      return { ok: false, reason: 'model_missing', remedy: `ollama pull ${chatModel}` };
    }
    if (!installed.has(canonicalModel(embedModel))) {
      return { ok: false, reason: 'embed_model_missing', remedy: `ollama pull ${embedModel}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: 'unreachable',
      message: `Ollama at ${baseUrl} is unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Every chat/embed model Ollama currently reports as installed (`GET /api/tags`).
 *
 * Backs the model-picker in Settings (`model:get`): the UI must only ever offer
 * a model the user has actually pulled, never a hardcoded list that might not
 * exist on this machine and would fail {@link preflight} if selected.
 *
 * Never throws — an unreachable Ollama reports as an empty list, same as "ask
 * again once it's running" rather than a rejected settings load.
 */
export async function listInstalledModels(baseUrl: string): Promise<string[]> {
  try {
    const res = await guardedFetchUrl(`${baseUrl.replace(/\/+$/, '')}/api/tags`);
    if (!res.ok) return [];

    const body = (await res.json()) as TagsEnvelope;
    const names = new Set<string>();
    for (const entry of body.models ?? []) {
      if (typeof entry?.model === 'string') names.add(entry.model);
      else if (typeof entry?.name === 'string') names.add(entry.name);
    }
    return [...names].sort();
  } catch {
    return [];
  }
}
