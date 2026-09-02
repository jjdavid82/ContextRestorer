/**
 * Task 4.6 — renderer egress lockdown: CSP, navigation, `window.open`, and the
 * one sanctioned way out (`shell:openExternal`).
 *
 * `security/csp.ts` and `ipc/external.ts` both import `electron` at module
 * scope, which outside a running Electron process resolves to a CJS shim that
 * default-exports the path to the binary — so the named imports must be mocked
 * before the modules are loaded. Same pattern as `tray.test.ts` /
 * `oauth.test.ts`, including the top-level `await import` after the mock.
 *
 * `csp.ts` also imports `protocol.js` (for the single `app` scheme constant),
 * which pulls in `protocol`/`net`; both are stubbed below but never called.
 *
 * The CSP itself is asserted as an exact string. That is deliberate: the point
 * of the policy is what it FORBIDS, and a substring-only assertion would keep
 * passing if `connect-src 'none'` were quietly widened to `connect-src https:`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

/** Captures the listener `applyCsp` registers. */
const onHeadersReceived = vi.fn();
const openExternal = vi.fn(async () => undefined);
const ipcHandle = vi.fn();

vi.mock('electron', () => ({
  session: { defaultSession: { webRequest: { onHeadersReceived } } },
  ipcMain: { handle: ipcHandle },
  shell: { openExternal },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  net: { fetch: vi.fn() },
}));

const {
  CSP_HEADER,
  applyCsp,
  buildContentSecurityPolicy,
  cspResponseFor,
  handleWindowOpen,
  installNavigationLockdown,
  isAppUrl,
  registerContentSecurityPolicy,
  shouldBlockNavigation,
} = await import('../src/security/csp.js');

const { SCRIPT_NONCE_HEADER } = await import('../src/protocol.js');

const {
  isAllowedExternalUrl,
  openExternalLink,
  parseOpenExternalArg,
  OPEN_EXTERNAL_CHANNEL,
} = await import('../src/ipc/external.js');

type HeadersResponse = { responseHeaders?: Record<string, string | string[]> };

/** The listener signature Electron passes to `onHeadersReceived`. */
type Listener = (
  details: { url: string; responseHeaders?: Record<string, string[]> },
  callback: (response: HeadersResponse) => void,
) => void;

beforeEach(() => {
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */
/* 1. The policy string                                                       */
/* -------------------------------------------------------------------------- */

describe('buildContentSecurityPolicy', () => {
  it('is exactly the four required directives with no nonce', () => {
    expect(buildContentSecurityPolicy(undefined)).toBe(
      "default-src 'self'; connect-src 'none'; img-src 'self' data:; script-src 'self'",
    );
  });

  it('allow-lists exactly one nonce in script-src, alongside self', () => {
    expect(buildContentSecurityPolicy('abc123')).toBe(
      "default-src 'self'; connect-src 'none'; img-src 'self' data:; script-src 'self' 'nonce-abc123'",
    );
  });

  it("forbids ALL network connections: connect-src is 'none', nothing broader", () => {
    // The single most important assertion in this file. `connect-src 'none'` is
    // what stops a beacon smuggled into a briefing claim from phoning home with
    // whatever it can read out of the DOM.
    const policy = buildContentSecurityPolicy(undefined);
    expect(policy).toContain("connect-src 'none'");
    expect(policy).not.toMatch(/connect-src[^;]*(\*|https?:|'self'|data:|ws)/);
  });

  it('allows no unsafe-inline/unsafe-eval script, and no remote images, with or without a nonce', () => {
    for (const policy of [buildContentSecurityPolicy(undefined), buildContentSecurityPolicy('n')]) {
      expect(policy).not.toContain('unsafe-inline');
      expect(policy).not.toContain('unsafe-eval');
      expect(policy).toContain("script-src 'self'");
      // `data:` images only (inline SVG/PNG); an `https://attacker/pixel` cannot load.
      expect(policy).toContain("img-src 'self' data:");
      expect(policy).not.toMatch(/img-src[^;]*https?:/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Header injection and its scope boundary                                 */
/* -------------------------------------------------------------------------- */

describe('registered onHeadersReceived listener', () => {
  /** Registers the listener and returns it, as Electron would have received it. */
  function registeredListener(): Listener {
    registerContentSecurityPolicy();
    expect(onHeadersReceived).toHaveBeenCalledTimes(1);
    // Registered with NO url filter: Electron allows one listener per session,
    // so scoping happens inside the listener instead of claiming that slot for
    // `app://` alone.
    expect(onHeadersReceived.mock.calls[0]).toHaveLength(1);
    return onHeadersReceived.mock.calls[0]![0] as Listener;
  }

  it('injects the CSP for an app:// response', () => {
    const listener = registeredListener();
    const callback = vi.fn();

    listener(
      { url: 'app://local/index.html', responseHeaders: { 'content-type': ['text/html'] } },
      callback,
    );

    const [response] = callback.mock.calls[0] as [HeadersResponse];
    expect(response.responseHeaders?.[CSP_HEADER]).toEqual([buildContentSecurityPolicy(undefined)]);
    expect(String(response.responseHeaders?.[CSP_HEADER])).toContain("connect-src 'none'");
    // Existing headers survive.
    expect(response.responseHeaders?.['content-type']).toEqual(['text/html']);
  });

  it('injects the CSP even when the response carried no headers at all', () => {
    const listener = registeredListener();
    const callback = vi.fn();

    listener({ url: 'app://local/assets/app.js' }, callback);

    const [response] = callback.mock.calls[0] as [HeadersResponse];
    expect(response.responseHeaders).toEqual({ [CSP_HEADER]: [buildContentSecurityPolicy(undefined)] });
  });

  it('folds a script nonce from protocol.ts into script-src and strips the signalling header', () => {
    // Production path for every HTML document: `protocol.ts` hands the nonce it
    // used to inject inline-script attributes across via this header.
    const listener = registeredListener();
    const callback = vi.fn();

    listener(
      {
        url: 'app://local/index.html',
        responseHeaders: { 'content-type': ['text/html'], [SCRIPT_NONCE_HEADER]: ['abc123'] },
      },
      callback,
    );

    const [response] = callback.mock.calls[0] as [HeadersResponse];
    expect(response.responseHeaders?.[CSP_HEADER]).toEqual([buildContentSecurityPolicy('abc123')]);
    expect(response.responseHeaders?.[SCRIPT_NONCE_HEADER]).toBeUndefined();
  });

  it('leaves a non-app:// response untouched', () => {
    const listener = registeredListener();
    const callback = vi.fn();
    const headers = { 'content-type': ['application/json'] };

    listener({ url: 'devtools://devtools/bundled/inspector.html', responseHeaders: headers }, callback);

    const [response] = callback.mock.calls[0] as [HeadersResponse];
    expect(response.responseHeaders).toEqual(headers);
    expect(response.responseHeaders?.[CSP_HEADER]).toBeUndefined();
  });

  it('always answers the callback exactly once, so no response is left hanging', () => {
    const listener = registeredListener();
    for (const url of ['app://local/index.html', 'https://example.test/x', 'not a url']) {
      const callback = vi.fn();
      listener({ url }, callback);
      expect(callback).toHaveBeenCalledTimes(1);
    }
  });

  it('registers on the session it is handed by applyCsp', () => {
    const webRequest = { onHeadersReceived: vi.fn() };
    // Structural stand-in for `Session`; only `webRequest` is touched.
    applyCsp({ webRequest } as unknown as Parameters<typeof applyCsp>[0]);
    expect(webRequest.onHeadersReceived).toHaveBeenCalledTimes(1);
  });
});

describe('cspResponseFor', () => {
  it('replaces a pre-existing CSP rather than appending a second one', () => {
    const response = cspResponseFor('app://local/index.html', {
      'content-security-policy': ["default-src *"],
      'Content-Security-Policy-Report-Only': ['default-src *'],
      etag: ['"abc"'],
    });

    expect(Object.keys(response.responseHeaders ?? {})).toEqual(['etag', CSP_HEADER]);
    expect(response.responseHeaders?.[CSP_HEADER]).toEqual([buildContentSecurityPolicy(undefined)]);
  });

  it('returns an empty response for an unparseable URL with no headers', () => {
    expect(cspResponseFor('%%not-a-url', undefined)).toEqual({});
  });
});

describe('isAppUrl', () => {
  it('accepts the app scheme regardless of case, rejects everything else', () => {
    expect(isAppUrl('app://local/index.html')).toBe(true);
    expect(isAppUrl('APP://local/index.html')).toBe(true);
    expect(isAppUrl('https://app.example.test/')).toBe(false);
    expect(isAppUrl('file:///C:/Windows/System32/drivers/etc/hosts')).toBe(false);
    expect(isAppUrl('javascript:alert(1)')).toBe(false);
    expect(isAppUrl('nonsense')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Navigation lockdown                                                     */
/* -------------------------------------------------------------------------- */

describe('shouldBlockNavigation', () => {
  it('allows the app\'s own pages', () => {
    expect(shouldBlockNavigation('app://local/index.html')).toBe(false);
    expect(shouldBlockNavigation('app://local/settings.html')).toBe(false);
  });

  it('blocks every off-app destination, including deep links and local files', () => {
    for (const url of [
      'https://slack.com/app_redirect?channel=C1',
      'http://attacker.test/?stolen=secret',
      'file:///C:/Users/me/.ssh/id_rsa',
      'data:text/html,<script>fetch("https://attacker.test")</script>',
      'javascript:fetch("https://attacker.test")',
      'about:blank',
      '',
      'not a url',
    ]) {
      expect(shouldBlockNavigation(url)).toBe(true);
    }
  });

  it('is not fooled by an app-lookalike host', () => {
    expect(shouldBlockNavigation('https://app.attacker.test/local/index.html')).toBe(true);
    expect(shouldBlockNavigation('https://attacker.test/#app://local')).toBe(true);
  });
});

describe('handleWindowOpen', () => {
  it('denies every requested URL, including the app\'s own and its real deep links', () => {
    for (const url of [
      'app://local/index.html',
      'https://slack.com/app_redirect?channel=C1&message_ts=1',
      'https://mail.google.com/mail/u/0/#all/abc',
      'https://attacker.test/',
      '',
    ]) {
      expect(handleWindowOpen(url)).toEqual({ action: 'deny' });
    }
  });
});

describe('installNavigationLockdown', () => {
  /** Minimal `webContents` double capturing both registrations. */
  function fakeContents() {
    const listeners = new Map<string, (...args: never[]) => void>();
    return {
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener);
      }),
      setWindowOpenHandler: vi.fn(),
      listeners,
    };
  }

  it('cancels a non-app navigation and leaves an app navigation alone', () => {
    const contents = fakeContents();
    installNavigationLockdown(contents as unknown as Parameters<typeof installNavigationLockdown>[0]);

    const willNavigate = contents.listeners.get('will-navigate') as unknown as (
      event: { preventDefault: () => void },
      url: string,
    ) => void;
    expect(willNavigate).toBeTypeOf('function');

    const blocked = { preventDefault: vi.fn() };
    willNavigate(blocked, 'https://attacker.test/?stolen=secret');
    expect(blocked.preventDefault).toHaveBeenCalledTimes(1);

    const allowed = { preventDefault: vi.fn() };
    willNavigate(allowed, 'app://local/index.html');
    expect(allowed.preventDefault).not.toHaveBeenCalled();
  });

  it('installs a window-open handler that denies unconditionally', () => {
    const contents = fakeContents();
    installNavigationLockdown(contents as unknown as Parameters<typeof installNavigationLockdown>[0]);

    const handler = contents.setWindowOpenHandler.mock.calls[0]![0] as (details: {
      url: string;
    }) => { action: 'deny' };
    expect(handler({ url: 'https://slack.com/app_redirect?channel=C1' })).toEqual({
      action: 'deny',
    });
    expect(handler({ url: 'app://local/index.html' })).toEqual({ action: 'deny' });
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The one sanctioned exit: shell:openExternal                             */
/* -------------------------------------------------------------------------- */

describe('shell:openExternal (the deep-link escape hatch)', () => {
  it('accepts only https URLs on the deep-link hosts the app actually generates', () => {
    expect(isAllowedExternalUrl('https://slack.com/app_redirect?channel=C1&message_ts=1')).toBe(
      true,
    );
    expect(isAllowedExternalUrl('https://acme.slack.com/archives/C1/p1')).toBe(true);
    expect(isAllowedExternalUrl('https://mail.google.com/mail/u/0/#all/abc')).toBe(true);
  });

  it('refuses anything that is not one of those hosts, over any other scheme', () => {
    for (const url of [
      'https://attacker.test/?stolen=secret',
      'https://slack.com.attacker.test/',
      'https://notslack.com/',
      'https://mail.google.com@attacker.test/',
      'http://slack.com/app_redirect', // not https
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-msdt:/id',
      '',
    ]) {
      expect(isAllowedExternalUrl(url)).toBe(false);
    }
  });

  it('opens an allowed URL exactly once', async () => {
    const url = 'https://slack.com/app_redirect?channel=C1&message_ts=1';
    const result = await openExternalLink({ url }, { openExternal });

    expect(result).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it('never reaches the OS for a refused URL', async () => {
    const result = await openExternalLink({ url: 'https://attacker.test/?stolen=x' }, {
      openExternal,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_url' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a malformed argument rather than throwing at the renderer', async () => {
    for (const arg of [undefined, null, {}, 'https://slack.com/', { url: 42 }, { url: '' }]) {
      expect(parseOpenExternalArg(arg)).toBeNull();
      await expect(openExternalLink(arg, { openExternal })).resolves.toEqual({
        ok: false,
        reason: 'invalid_url',
      });
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('reports an OS failure instead of rejecting', async () => {
    const failing = { openExternal: vi.fn(async () => Promise.reject(new Error('no browser'))) };
    await expect(
      openExternalLink({ url: 'https://mail.google.com/mail/u/0/#all/abc' }, failing),
    ).resolves.toEqual({ ok: false, reason: 'open_failed' });
  });

  it('is registered on the channel the preload allowlist names', () => {
    expect(OPEN_EXTERNAL_CHANNEL).toBe('shell:openExternal');
  });
});
