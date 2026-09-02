/**
 * Unit tests for the pure glue inside `ipc/oauth.ts` (Task 1.7).
 *
 * Scope on purpose: the argument narrowing, the authorize-URL builder, the token
 * flattener and the failure→reason mapping. The OAuth *primitives* they sit on
 * (PKCE, `state`, the loopback catcher) already have their own tests in
 * `packages/ingest`; re-mocking `fetch` + a listening socket + `safeStorage` here
 * would only re-test those, so `exchangeCode` is left to the integration layer.
 *
 * `connect()`'s `not_configured` branch IS covered, because it is the one path
 * that returns before any network, browser or port is touched — and it is the
 * documented default state of a fresh checkout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@cr/core';
import { GMAIL_SCOPES, SLACK_SCOPES, type TokenVault } from '@cr/ingest';

// `oauth.ts` imports `ipcMain`/`shell` at module scope; neither exists outside a
// running Electron process. Same defensive pattern as `tray.test.ts`/`health.test.ts`.
const openExternal = vi.fn(async () => undefined);
const writeText = vi.fn();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal },
  clipboard: { writeText },
}));

const { PROVIDERS, authorizeUrl, connect, ensureFreshTokens, parseSource, reasonFor, toTokens } =
  await import('../src/ipc/oauth.js');

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal `AppConfig` — only `oauth` is read by anything under test. */
function configWith(oauth: AppConfig['oauth']): AppConfig {
  return { oauth } as AppConfig;
}

/** A vault that fails the test if the code under test ever reaches it. */
const unreachableVault = {
  store: vi.fn(() => Promise.reject(new Error('vault must not be touched'))),
  revoke: vi.fn(() => Promise.reject(new Error('vault must not be touched'))),
} as unknown as TokenVault;

describe('parseSource', () => {
  it('accepts the two supported sources', () => {
    expect(parseSource({ source: 'slack' })).toBe('slack');
    expect(parseSource({ source: 'gmail' })).toBe('gmail');
  });

  it('returns null for an unknown or misspelled source', () => {
    expect(parseSource({ source: 'slak' })).toBeNull();
    expect(parseSource({ source: 'jira' })).toBeNull();
    expect(parseSource({ source: 'SLACK' })).toBeNull();
  });

  it('returns null rather than throwing for a missing or non-object argument', () => {
    expect(parseSource(undefined)).toBeNull();
    expect(parseSource(null)).toBeNull();
    expect(parseSource({})).toBeNull();
    expect(parseSource('slack')).toBeNull();
    expect(parseSource(42)).toBeNull();
  });

  it('returns null for a non-string source, including a lookalike object', () => {
    expect(parseSource({ source: { toString: () => 'slack' } })).toBeNull();
    expect(parseSource({ source: ['slack'] })).toBeNull();
  });
});

describe('authorizeUrl (T-2: no scope creep)', () => {
  const call = (source: 'slack' | 'gmail'): URL =>
    new URL(
      authorizeUrl(
        PROVIDERS[source],
        'client-abc',
        'http://127.0.0.1:53123/callback',
        'challenge-xyz',
        'state-123',
      ),
    );

  it('requests EXACTLY the Slack scopes from @cr/ingest, under user_scope', () => {
    const url = call('slack');
    expect(url.searchParams.get('user_scope')).toBe(SLACK_SCOPES);
    expect(url.searchParams.get('user_scope')).toBe(
      'channels:history,channels:read,im:history,users:read',
    );
    // A bot identity must not be created as a side effect of connecting.
    expect(url.searchParams.get('scope')).toBeNull();
  });

  it('requests EXACTLY the read-only Gmail scope from @cr/ingest', () => {
    const url = call('gmail');
    expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPES);
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    expect(url.searchParams.get('user_scope')).toBeNull();
    // Regression guard: never a write/modify/full-mailbox scope.
    expect(url.search).not.toMatch(/gmail\.(modify|compose|send)|mail\.google\.com/);
  });

  it('carries the PKCE challenge with S256 and never the verifier', () => {
    const url = call('gmail');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.search).not.toContain('code_verifier');
  });

  it('sends the client id, redirect uri, state and an authorization-code request', () => {
    const url = call('slack');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53123/callback');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
  });

  it('adds offline access + forced consent for Google only, so refresh tokens keep coming', () => {
    expect(call('gmail').searchParams.get('access_type')).toBe('offline');
    expect(call('gmail').searchParams.get('prompt')).toBe('consent');
    expect(call('slack').searchParams.get('access_type')).toBeNull();
  });
});

describe('toTokens', () => {
  const now = 1_700_000_000_000;

  it('reads a Slack user token out of authed_user, not the top level', () => {
    const tokens = toTokens(
      {
        ok: true,
        access_token: 'xoxb-bot-token',
        authed_user: { access_token: 'xoxp-user-token', scope: SLACK_SCOPES },
      },
      PROVIDERS.slack,
      now,
    );
    expect(tokens?.accessToken).toBe('xoxp-user-token');
    expect(tokens?.scope).toBe(SLACK_SCOPES);
  });

  it('falls back to a 12h expiry when the provider sends no expires_in', () => {
    const tokens = toTokens({ access_token: 'a' }, PROVIDERS.gmail, now);
    expect(tokens?.expiresAt).toBe(now + 12 * 60 * 60 * 1000);
  });

  it('converts expires_in seconds into an absolute ms deadline', () => {
    const tokens = toTokens({ access_token: 'a', expires_in: 3600 }, PROVIDERS.gmail, now);
    expect(tokens?.expiresAt).toBe(now + 3_600_000);
  });

  it("represents 'no refresh token' as '' rather than undefined", () => {
    expect(toTokens({ access_token: 'a' }, PROVIDERS.gmail, now)?.refreshToken).toBe('');
    expect(
      toTokens({ access_token: 'a', refresh_token: 'r' }, PROVIDERS.gmail, now)?.refreshToken,
    ).toBe('r');
  });

  it('falls back to previousRefreshToken when the response carries none — the refresh-grant case', () => {
    // Google's refresh-grant response omits `refresh_token` (it does not rotate).
    // Without this fallback, refreshing would overwrite the good refresh token
    // with '' and the connection would survive exactly one renewal.
    expect(
      toTokens({ access_token: 'a' }, PROVIDERS.gmail, now, 'old-refresh-token')?.refreshToken,
    ).toBe('old-refresh-token');
  });

  it('prefers a refresh token the response DOES carry over the previous one', () => {
    expect(
      toTokens(
        { access_token: 'a', refresh_token: 'new-refresh-token' },
        PROVIDERS.gmail,
        now,
        'old-refresh-token',
      )?.refreshToken,
    ).toBe('new-refresh-token');
  });

  it('defaults the scope to the spec when the provider echoes none', () => {
    expect(toTokens({ access_token: 'a' }, PROVIDERS.gmail, now)?.scope).toBe(GMAIL_SCOPES);
  });

  it('returns null for a response with no usable access token', () => {
    expect(toTokens({}, PROVIDERS.gmail, now)).toBeNull();
    expect(toTokens({ access_token: '' }, PROVIDERS.gmail, now)).toBeNull();
    expect(toTokens({ error: 'invalid_grant' }, PROVIDERS.slack, now)).toBeNull();
  });
});

describe('reasonFor', () => {
  it('maps a CSRF failure to state_mismatch', () => {
    expect(reasonFor(new Error('state mismatch on callback'))).toBe('state_mismatch');
  });

  it('maps the loopback wait expiring to timeout', () => {
    expect(reasonFor(new Error('oauth callback timed out after 120000ms'))).toBe('timeout');
  });

  it('maps a rejected code exchange to exchange_failed', () => {
    expect(reasonFor(new Error('token exchange rejected: invalid_grant'))).toBe('exchange_failed');
  });

  it('maps an encrypted-store failure to vault_error', () => {
    expect(reasonFor(new Error('keychain unavailable'))).toBe('vault_error');
  });

  it('falls back to internal_error for anything unrecognized, including non-Errors', () => {
    expect(reasonFor(new Error('ECONNRESET'))).toBe('internal_error');
    expect(reasonFor('some string')).toBe('internal_error');
    expect(reasonFor(undefined)).toBe('internal_error');
  });

  it('never leaks the underlying message to the renderer', () => {
    // The message can contain the authorization code; only the mapped token escapes.
    expect(reasonFor(new Error('token exchange rejected: code=4/0AY0e-secret'))).toBe(
      'exchange_failed',
    );
  });
});

describe('connect: the not_configured gate', () => {
  it('reports not_configured when no clientId is registered', async () => {
    const result = await connect('slack', {
      vault: unreachableVault,
      config: configWith(undefined),
    });
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('treats an empty clientId the same as a missing one', async () => {
    const result = await connect('gmail', {
      vault: unreachableVault,
      config: configWith({ gmail: { clientId: '' } }),
    });
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('opens no browser and binds no port on the not_configured path', async () => {
    openExternal.mockClear();
    await connect('slack', { vault: unreachableVault, config: configWith({ gmail: {} }) });
    expect(openExternal).not.toHaveBeenCalled();
    expect(unreachableVault.store).not.toHaveBeenCalled();
  });
});

describe('ensureFreshTokens', () => {
  const NOW = 1_800_000_000_000;
  const CLIENT = { clientId: 'client-abc', clientSecret: 'secret-xyz' };

  /** A vault double whose `load` answers with `stored`; records `store` calls. */
  function vaultWith(stored: Awaited<ReturnType<TokenVault['load']>>) {
    return {
      load: vi.fn(async () => stored),
      store: vi.fn(async () => undefined),
      revoke: vi.fn(async () => undefined),
    } as unknown as TokenVault;
  }

  it('returns undefined, and never touches fetch, when the source was never connected', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const vault = vaultWith(undefined);

    await expect(
      ensureFreshTokens('gmail', { vault, config: configWith({ gmail: CLIENT }) }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the stored tokens unchanged, and never touches fetch, while still fresh', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const stored = {
      accessToken: 'still-good',
      refreshToken: 'r1',
      expiresAt: NOW + 10 * 60_000,
      scope: GMAIL_SCOPES,
    };
    const vault = vaultWith(stored);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await expect(
      ensureFreshTokens('gmail', { vault, config: configWith({ gmail: CLIENT }) }),
    ).resolves.toEqual(stored);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('returns the stored tokens unchanged when there is no refresh token to refresh with', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // An unrotated Slack user token: expired-looking by the clock, but there is
    // nothing to exchange, so the stale value is handed back as-is.
    const stored = {
      accessToken: 'stale-but-only-thing-we-have',
      refreshToken: '',
      expiresAt: 0,
      scope: SLACK_SCOPES,
    };
    const vault = vaultWith(stored);

    await expect(
      ensureFreshTokens('slack', { vault, config: configWith({ slack: CLIENT }) }),
    ).resolves.toEqual(stored);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns the stored tokens unchanged when no OAuth client is configured for the refresh leg', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const stored = { accessToken: 'stale', refreshToken: 'r1', expiresAt: 0, scope: GMAIL_SCOPES };
    const vault = vaultWith(stored);

    await expect(
      ensureFreshTokens('gmail', { vault, config: configWith({ gmail: { clientId: '' } }) }),
    ).resolves.toEqual(stored);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token, preserves the refresh token Google omits, and persists the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ access_token: 'new-access-token', expires_in: 3600 })),
    );
    const stored = {
      accessToken: 'expired',
      refreshToken: 'the-one-refresh-token',
      expiresAt: 0,
      scope: GMAIL_SCOPES,
    };
    const vault = vaultWith(stored);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const result = await ensureFreshTokens('gmail', { vault, config: configWith({ gmail: CLIENT }) });

    expect(result?.accessToken).toBe('new-access-token');
    // The refresh-grant response above carries no `refresh_token` — this MUST
    // still be the original one, not '', or the connection survives exactly
    // one refresh before requiring the user to reconnect.
    expect(result?.refreshToken).toBe('the-one-refresh-token');
    expect(result?.expiresAt).toBe(NOW + 3_600_000);
    expect(vault.store).toHaveBeenCalledWith('gmail', result);
    vi.useRealTimers();
  });

  it('falls back to the stale tokens, without throwing, when the refresh call itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'invalid_grant' })),
    );
    const stored = { accessToken: 'stale', refreshToken: 'revoked', expiresAt: 0, scope: GMAIL_SCOPES };
    const vault = vaultWith(stored);

    await expect(
      ensureFreshTokens('gmail', { vault, config: configWith({ gmail: CLIENT }) }),
    ).resolves.toEqual(stored);
    expect(vault.store).not.toHaveBeenCalled();
  });
});
