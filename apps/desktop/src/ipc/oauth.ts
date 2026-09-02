/**
 * `oauth:connect` / `oauth:revoke` main-process handlers (Task 1.7).
 *
 * The authorization-code + PKCE flow for an installed app, end to end:
 *
 *   1. mint a PKCE verifier/challenge and a CSRF `state` (`@cr/ingest`),
 *   2. bind a single-shot loopback catcher on `127.0.0.1:<ephemeral>`,
 *   3. copy the authorize URL to the clipboard and open the SYSTEM browser at it
 *      — never an embedded `BrowserWindow`, which would let us read the user's
 *      provider password and is rejected outright by Google (SEC-1). The copy
 *      is so a user whose provider session lives in a different browser can
 *      paste the link there instead; the loopback catcher from step 2 answers
 *      to whichever browser the redirect actually comes back from,
 *   4. await the redirect, exchange the code for tokens over TLS,
 *   5. hand the tokens to the `TokenVault`, which encrypts them at rest (SEC-2).
 *
 * Two invariants are load-bearing here:
 *
 * - **No credentials, no flow.** The repo ships without a registered OAuth app.
 *   When `config.oauth.<source>.clientId` is missing we return
 *   `{ ok: false, reason: 'not_configured' }` *before* touching the network or
 *   the browser. Faking success would make the source-health panel lie.
 * - **Nothing throws out of an `ipcMain.handle` callback.** A rejected handler
 *   surfaces in the renderer as an opaque `Error invoking remote method …`
 *   string with the main-process stack pasted into it. Every failure is caught
 *   and mapped to a `reason` the UI can render.
 *
 * Scopes come verbatim from `@cr/ingest`'s `SLACK_SCOPES`/`GMAIL_SCOPES` (T-2):
 * the authorize URL is exactly the place scope creep would sneak in, so the
 * constants are used as-is and never concatenated with anything.
 */
import { clipboard, ipcMain, shell } from 'electron';
import type { AppConfig } from '@cr/core';
import {
  createChallenge,
  createState,
  startLoopbackServer,
  GMAIL_SCOPES,
  SLACK_SCOPES,
  type OAuthTokens,
  type TokenVault,
} from '@cr/ingest';
import type { OkResult, Source } from '../preload.cjs';

/** Per-provider endpoints and the exact scope string this app may ask for. */
export interface ProviderSpec {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /**
   * Extra authorize-leg params. Google needs `access_type=offline` +
   * `prompt=consent` or it withholds the refresh token on every grant after the
   * first, which would silently turn a long-lived connection into a one-hour one.
   */
  extraAuthParams: Readonly<Record<string, string>>;
  /**
   * Slack puts a *user* token under `authed_user`, not at the top level, and
   * takes its scope request as `user_scope`. Everything else is standard OAuth 2.
   */
  slackUserToken: boolean;
}

export const PROVIDERS: Readonly<Record<Source, ProviderSpec>> = {
  slack: {
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scope: SLACK_SCOPES,
    extraAuthParams: {},
    slackUserToken: true,
  },
  gmail: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: GMAIL_SCOPES,
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    slackUserToken: false,
  },
};

/** Path the loopback catcher listens on; any path works, this one is legible in logs. */
const CALLBACK_PATH = '/callback';

/**
 * Fixed loopback port for Slack's OAuth redirect only.
 *
 * Slack matches `redirect_uri` against an EXACTLY pre-registered value in the
 * Slack app's own "Redirect URLs" config, port included — an OS-assigned
 * ephemeral port can never match a value fixed at app-registration time.
 * Google's installed-app flow explicitly permits any loopback port, so Gmail
 * keeps using an ephemeral one (see `startLoopbackServer`'s default).
 *
 * Whoever registers the Slack app must set its Redirect URL to
 * `http://127.0.0.1:53682/callback` (or whatever this constant is changed to)
 * — the two must always match.
 */
const SLACK_REDIRECT_PORT = 53682;

/** Fallback token lifetime when the provider returns no `expires_in` (Slack user tokens). */
const DEFAULT_EXPIRY_MS = 12 * 60 * 60 * 1000;

export interface OauthHandlerDeps {
  vault: TokenVault;
  /** Read for `config.oauth.<source>.clientId` / `clientSecret`. */
  config: AppConfig;
}

/** Narrow the renderer-supplied argument. The preload's check is a convenience, not trust. */
export function parseSource(arg: unknown): Source | null {
  const source: unknown = (arg as { source?: unknown } | null)?.source;
  return source === 'slack' || source === 'gmail' ? source : null;
}

/** The raw JSON both providers return from their token endpoints. */
export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  ok?: boolean;
  authed_user?: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
}

/**
 * Flatten a token response into the vault's shape.
 *
 * `refreshToken` falls back to `previousRefreshToken`, then to `''`, rather
 * than jumping straight to `''` when the response carries none: Google's
 * refresh-grant response deliberately omits `refresh_token` (it does not
 * rotate), so a refresh call that used `toTokens` without this fallback would
 * overwrite a good refresh token with an empty one on every renewal — the
 * connection would then survive exactly one refresh before requiring the user
 * to reconnect. On the ORIGINAL authorization-code exchange there is no
 * previous token to fall back to, so callers simply omit the argument and the
 * old behaviour (`''` when the provider issues none, e.g. an unrotated Slack
 * user token) is unchanged.
 */
export function toTokens(
  body: TokenResponse,
  spec: ProviderSpec,
  now: number,
  previousRefreshToken?: string,
): OAuthTokens | null {
  const grant = spec.slackUserToken && body.authed_user !== undefined ? body.authed_user : body;
  const accessToken = grant.access_token ?? body.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') return null;

  const expiresInSec = grant.expires_in ?? body.expires_in;
  return {
    accessToken,
    refreshToken: grant.refresh_token ?? body.refresh_token ?? previousRefreshToken ?? '',
    expiresAt:
      typeof expiresInSec === 'number' && Number.isFinite(expiresInSec)
        ? now + expiresInSec * 1000
        : now + DEFAULT_EXPIRY_MS,
    scope: grant.scope ?? body.scope ?? spec.scope,
  };
}

/**
 * Build the authorize URL.
 *
 * Slack takes the *user* scopes under `user_scope`: this app reads the signed-in
 * human's own channel and DM history, which a bot token cannot see. `scope` is
 * left empty so no bot identity is created as a side effect.
 */
export function authorizeUrl(
  spec: ProviderSpec,
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const url = new URL(spec.authorizeUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set(spec.slackUserToken ? 'user_scope' : 'scope', spec.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  for (const [key, value] of Object.entries(spec.extraAuthParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Exchange the authorization code for tokens.
 *
 * POST + `application/x-www-form-urlencoded`, which is what RFC 6749 §4.1.3
 * mandates and what both providers accept. The verifier travels here and ONLY
 * here — it never enters the browser leg, which is the entire point of PKCE.
 */
async function exchangeCode(
  spec: ProviderSpec,
  clientId: string,
  clientSecret: string | undefined,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const form = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  // Omitted entirely when unset rather than sent empty: an empty `client_secret`
  // is a 400 at Google, whereas an absent one is a valid public-client request.
  if (clientSecret !== undefined && clientSecret !== '') {
    form.set('client_secret', clientSecret);
  }

  const response = await fetch(spec.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
  });

  const body = (await response.json()) as TokenResponse;
  // Slack answers 200 with `{ ok: false, error }`; Google answers 4xx with `error`.
  if (!response.ok || body.ok === false || typeof body.error === 'string') {
    throw new Error(`token exchange rejected: ${body.error ?? `HTTP ${response.status}`}`);
  }
  return body;
}

/**
 * Exchange a stored refresh token for a new access token.
 *
 * Same shape as {@link exchangeCode} (POST, form-encoded, same error handling)
 * with `grant_type: 'refresh_token'` in place of the authorization-code dance
 * — there is no PKCE verifier or redirect URI on this leg, since it never
 * touches a browser.
 */
async function refreshWithToken(
  spec: ProviderSpec,
  clientId: string,
  clientSecret: string | undefined,
  refreshToken: string,
): Promise<TokenResponse> {
  const form = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (clientSecret !== undefined && clientSecret !== '') {
    form.set('client_secret', clientSecret);
  }

  const response = await fetch(spec.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: form.toString(),
  });

  const body = (await response.json()) as TokenResponse;
  if (!response.ok || body.ok === false || typeof body.error === 'string') {
    throw new Error(`token refresh rejected: ${body.error ?? `HTTP ${response.status}`}`);
  }
  return body;
}

/**
 * Refresh a little before the access token's actual deadline, not at it — a
 * request that started 500ms before expiry and reached the provider 600ms
 * later must not fail an otherwise-healthy poll cycle over a race.
 */
const REFRESH_SKEW_MS = 60_000;

/**
 * Read `source`'s stored tokens, transparently refreshing first if the access
 * token is at or near expiry.
 *
 * This is the fix for a real gap: `connect()` requests `access_type=offline`
 * specifically so Google issues a refresh token (see `PROVIDERS.gmail`'s own
 * comment), but nothing previously exchanged it for a new access token once
 * the old one expired — every Gmail connection quietly went stale after
 * Google's ~1-hour access-token lifetime, and polling failed with a 401 that
 * `health.ts` correctly, but confusingly, surfaces as "disconnected". Every
 * `SourceClient`'s access-token supplier should call this instead of reading
 * the vault directly.
 *
 * Failure modes are deliberately non-fatal here: a source that was never
 * connected returns `undefined` (unchanged from before); a source with no
 * refresh token (an unrotated Slack user token, or one somehow still absent)
 * is returned as-is, since there is nothing to refresh it WITH; and a refresh
 * attempt that itself fails (network error, revoked grant) falls back to the
 * stale stored tokens rather than throwing — the caller's own request will
 * then fail on the stale token exactly as it does today, which is a state the
 * health strip already knows how to report, rather than a new failure mode
 * this function would have to invent a reason string for.
 */
export async function ensureFreshTokens(
  source: Source,
  deps: OauthHandlerDeps,
): Promise<OAuthTokens | undefined> {
  const stored = await deps.vault.load(source);
  if (stored === undefined) return undefined;
  if (Date.now() < stored.expiresAt - REFRESH_SKEW_MS) return stored;
  if (stored.refreshToken === '') return stored;

  const client = deps.config.oauth?.[source];
  if (client?.clientId === undefined || client.clientId === '') return stored;

  try {
    const body = await refreshWithToken(
      PROVIDERS[source],
      client.clientId,
      client.clientSecret,
      stored.refreshToken,
    );
    const refreshed = toTokens(body, PROVIDERS[source], Date.now(), stored.refreshToken);
    if (refreshed === null) return stored;

    await deps.vault.store(source, refreshed);
    return refreshed;
  } catch (error) {
    console.error(`[oauth] ${source} token refresh failed`, reasonFor(error));
    return stored;
  }
}

/** Map a thrown failure onto the `reason` the renderer will display. */
export function reasonFor(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('state mismatch')) return 'state_mismatch';
  if (message.includes('timed out')) return 'timeout';
  if (message.includes('token exchange')) return 'exchange_failed';
  if (message.includes('keychain')) return 'vault_error';
  return 'internal_error';
}

/**
 * Run one full connect flow.
 *
 * Extracted from the handler so the handler itself is nothing but a try/catch —
 * there is exactly one place an escaping rejection could be introduced, and it
 * is guarded.
 */
export async function connect(source: Source, deps: OauthHandlerDeps): Promise<OkResult> {
  const spec = PROVIDERS[source];
  const client = deps.config.oauth?.[source];
  const clientId = client?.clientId;

  // The documented "no OAuth app registered yet" path. Nothing has happened yet:
  // no port bound, no browser opened, no request made.
  if (clientId === undefined || clientId === '') {
    return { ok: false, reason: 'not_configured' };
  }

  const pkce = createChallenge();
  const state = createState();

  // Bound before the browser opens, so `redirect_uri` can carry the real port.
  // Slack gets a FIXED port (must match its app's registered Redirect URL
  // exactly); Google's installed-app flow permits any loopback port, so Gmail
  // keeps the default ephemeral one.
  const server = await startLoopbackServer(
    state,
    undefined,
    source === 'slack' ? SLACK_REDIRECT_PORT : undefined,
  );
  const redirectUri = `http://${server.host}:${server.port}${CALLBACK_PATH}`;

  try {
    const url = authorizeUrl(spec, clientId, redirectUri, pkce.challenge, state);
    // The system browser Electron opens below is not necessarily the one signed
    // into the right account (e.g. the user runs Gmail in a different browser
    // than their OS default). The loopback catcher above is already listening on
    // `redirectUri` regardless of which browser eventually hits it, so copying
    // the URL alongside opening it lets the user paste it into that browser
    // instead — best-effort, must never abort the flow if the clipboard is
    // unavailable for some reason.
    try {
      clipboard.writeText(url);
    } catch (clipboardError) {
      console.warn(`[oauth] ${source} could not copy authorize URL to clipboard`, clipboardError);
    }
    await shell.openExternal(url);
    // Rejects on state mismatch, provider error, or the two-minute timeout; the
    // loopback server closes itself on every one of those paths.
    const { code } = await server.result;
    const body = await exchangeCode(
      spec,
      clientId,
      client?.clientSecret,
      code,
      pkce.verifier,
      redirectUri,
    );

    const tokens = toTokens(body, spec, Date.now());
    if (tokens === null) throw new Error('token exchange returned no access token');

    await deps.vault.store(source, tokens);
    return { ok: true };
  } catch (error) {
    // Never log `error` verbatim at higher fidelity than this: the message can
    // carry the authorization code or the token body.
    console.error(`[oauth] ${source} connect failed`, reasonFor(error));
    return { ok: false, reason: reasonFor(error) };
  }
}

/**
 * Register the two OAuth channels.
 *
 * Safe to call before any window exists — neither handler needs a `BrowserWindow`.
 *
 * @param deps Vault to persist into, and the config carrying the client ids.
 */
export function registerOauthHandlers(deps: OauthHandlerDeps): void {
  ipcMain.handle('oauth:connect', async (_event, arg: unknown): Promise<OkResult> => {
    const source = parseSource(arg);
    if (source === null) return { ok: false, reason: 'invalid_source' };
    return connect(source, deps);
  });

  ipcMain.handle('oauth:revoke', async (_event, arg: unknown): Promise<OkResult> => {
    const source = parseSource(arg);
    if (source === null) return { ok: false, reason: 'invalid_source' };

    try {
      // SEC-3: purges the entry, and deletes the vault file outright when it was
      // the last one. The source's `SourceClient` reads the vault on every poll,
      // so the next cycle fails auth and health flips to `disconnected` on its
      // own — see the note in `main.ts` about `Poller` having no per-source pause.
      await deps.vault.revoke(source);
      return { ok: true };
    } catch (error) {
      console.error(`[oauth] ${source} revoke failed`, reasonFor(error));
      return { ok: false, reason: reasonFor(error) };
    }
  });
}
