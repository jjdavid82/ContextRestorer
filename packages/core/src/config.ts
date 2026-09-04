import { existsSync, readFileSync } from 'node:fs';

/**
 * OAuth *client registration* for one provider — the public app identity, not a
 * user credential. User tokens never come near this file: they live encrypted in
 * the `TokenVault` (SEC-2).
 *
 * Every field is optional because the repo ships with no registered OAuth app. A
 * missing `clientId` is a legitimate, expected state: `oauth:connect` reports
 * `not_configured` rather than starting a flow that could only fail.
 *
 * `clientSecret` is present because both providers' installed-app token exchange
 * still requires it (Google explicitly documents it as non-secret for desktop
 * clients; Slack has no public-client mode at all). It is NOT required for the
 * authorize leg — PKCE covers that.
 */
export interface OAuthClientConfig {
  clientId?: string;
  clientSecret?: string;
}

export interface AppConfig {
  model: { chat: string; embed: string; ollamaBaseUrl: string };
  promptVersions: { layer1: string; layer2: string; layer3: string };
  debounce: Record<'slack' | 'gmail', { quietWindowMs: number; hardCapMs: number }>;
  polling: Record<'slack' | 'gmail', { intervalMs: number; maxBackoffMs: number }>;
  retrieval: { topK: number; budgetMs: number };
  ranking: { wStakes: number; wPendingOnMe: number; wSelfParticipation: number; wRecency: number };
  budgets: { retrievalMs: number; assemblyMs: number; generationMs: number; citationMs: number };
  retention: { rawEventDays: number };
  onboarding: { minDeclaredProjects: number };
  /**
   * Briefing presentation (A-4). `maxChangedItems` caps the "things changed"
   * list; obligations are deliberately NOT capped — see `assertValid`.
   */
  briefing: { maxChangedItems: number };
  /**
   * OPTIONAL. Absent in the shipped config; populated only once a real Slack /
   * Google OAuth app exists. `assertValid` deliberately does not check it — an
   * unconfigured source must degrade to "not connected", never to a startup abort.
   */
  oauth?: Partial<Record<'slack' | 'gmail', OAuthClientConfig>>;
}

/** True for a plain JSON object, never an array — `merge` recurses into objects only. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `override` onto `base`, recursing into nested plain objects and
 * replacing (not concatenating) arrays and scalars outright.
 */
function merge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override ?? base) as T;

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = merge((base as Record<string, unknown>)[key], value);
  }
  return result as T;
}

/**
 * Load `config/default.json`, then merge in `<path>.local.json` if present —
 * e.g. `default.json` → `default.local.json`.
 *
 * The tracked config file ships with no OAuth app registered (see
 * `OAuthClientConfig`'s own doc comment). A real client id/secret is a local
 * dev convenience, not something that belongs in version control, so it lives
 * in a sibling file this repo's `.gitignore` excludes — read here, merged in,
 * and never committed. Untracked-and-missing is the common case (`existsSync`
 * guards it) and is not an error: `assertValid` already treats an absent
 * `oauth` block as legitimate.
 */
export function loadConfig(path = 'config/default.json'): AppConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as AppConfig;

  const localPath = path.replace(/\.json$/, '.local.json');
  const merged = existsSync(localPath)
    ? merge(cfg, JSON.parse(readFileSync(localPath, 'utf8')))
    : cfg;

  assertValid(merged);
  return merged;
}

function assertValid(c: AppConfig): void {
  if (!c.model?.chat) throw new Error('config: model.chat is required');
  if (
    c.model.ollamaBaseUrl !== 'http://localhost:11434' &&
    c.model.ollamaBaseUrl !== 'http://127.0.0.1:11434'
  ) {
    // SEC-6: the config file must not be a way to point inference at a remote endpoint.
    throw new Error(`config: ollamaBaseUrl must be localhost (got ${c.model.ollamaBaseUrl})`);
  }
  for (const s of ['slack', 'gmail'] as const) {
    const d = c.debounce?.[s];
    if (!d) throw new Error(`config: debounce.${s} is required`);
    if (d.hardCapMs <= d.quietWindowMs) {
      throw new Error(`config: debounce.${s}.hardCapMs must exceed quietWindowMs`);
    }
  }
  // Guarded like `debounce` above: a config file with no `onboarding` key at all
  // must fail with a config error, not an unguarded TypeError from the deref.
  if (!c.onboarding) throw new Error('config: onboarding is required');
  // OI-3 fixes this at >= 3 (mandatory declaration, to avoid a flat, unranked
  // first briefing). It was relaxed to "any non-negative integer" while nothing
  // in the pipeline created the `belongs_to` edge `wStakes` reads, which made
  // the requirement gate onboarding on a signal with no effect. A-2 supplies
  // that write path, so the shipped value is 3 again; the validator stays
  // permissive so an advanced user can lower it locally (NFR-7).
  if (!Number.isInteger(c.onboarding.minDeclaredProjects) || c.onboarding.minDeclaredProjects < 0) {
    throw new Error('config: onboarding.minDeclaredProjects must be a non-negative integer');
  }

  if (!c.briefing) throw new Error('config: briefing is required');
  // A-4: the cap applies ONLY to the "things changed" list. Obligations are
  // never capped — AC-3 targets >= 90% recall, and an obligation hidden by a
  // display cap is a recall miss the user cannot see. A cap of 0 would empty
  // the changed list entirely, which is a misconfiguration rather than a
  // preference, so the floor is 1.
  if (!Number.isInteger(c.briefing.maxChangedItems) || c.briefing.maxChangedItems < 1) {
    throw new Error('config: briefing.maxChangedItems must be a positive integer');
  }
}
