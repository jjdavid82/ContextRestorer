/**
 * Renderer egress lockdown (Task 4.6): Content-Security-Policy + navigation.
 *
 * The window this protects renders UNTRUSTED ingested content — Slack messages,
 * email bodies, and model output derived from both. Everything in this module
 * exists to make that content inert with respect to the network:
 *
 *  1. {@link buildContentSecurityPolicy} — `connect-src 'none'` is the load-bearing
 *     directive. It is what stops a `fetch()`/`XHR`/`WebSocket`/`sendBeacon`
 *     shaped payload smuggled into a briefing claim from phoning home with
 *     whatever it can read out of the DOM. `default-src 'self'` closes the
 *     remaining fetch destinations (frames, fonts, media, workers) and
 *     `img-src 'self' data:` means a markdown image URL pointing at
 *     `https://attacker/pixel?stolen=...` simply does not load.
 *  2. {@link shouldBlockNavigation} — the same content must not be able to
 *     *navigate* the window off `app://`, which would both leak the referrer and
 *     put attacker-controlled markup inside a window holding a preload bridge.
 *  3. {@link handleWindowOpen} — `window.open()` is denied unconditionally. The
 *     handler cannot tell "the user clicked our own source deep link" from
 *     "rendered content called `window.open`", so it does not try: the app's own
 *     deep links go out through the `shell:openExternal` IPC channel instead
 *     (see `ipc/external.ts`), which is a surface the renderer can only reach
 *     through the preload allowlist.
 *
 * Everything except {@link applyCsp}/{@link registerContentSecurityPolicy} and
 * {@link installNavigationLockdown} is a pure function, so the policy decisions
 * are unit-testable without launching Electron.
 */
import { session, type HeadersReceivedResponse, type Session, type WebContents } from 'electron';
import { APP_SCHEME, SCRIPT_NONCE_HEADER } from '../protocol.js';

/**
 * Build the policy served with an `app://` response.
 *
 * Every directive but `script-src` is a frozen literal, asserted verbatim in
 * `test/csp.test.ts` so a directive cannot be quietly loosened without the
 * test noticing. `script-src` is the one exception: `protocol.ts` gives each
 * HTML response's inline hydration scripts a fresh nonce (see
 * `injectScriptNonce`), and that nonce — not `'unsafe-inline'` — is what
 * `script-src` allow-lists here. A response with no nonce (any non-HTML
 * resource) gets the bare `'self'` form.
 *
 * There is deliberately no `'unsafe-inline'` anywhere and no host in
 * `connect-src`.
 */
export function buildContentSecurityPolicy(nonce: string | undefined): string {
  const scriptSrc = nonce === undefined ? "script-src 'self'" : `script-src 'self' 'nonce-${nonce}'`;
  return `default-src 'self'; connect-src 'none'; img-src 'self' data:; ${scriptSrc}`;
}

/** The response header name, spelled canonically. */
export const CSP_HEADER = 'Content-Security-Policy';

/** `app:`, as a URL protocol. Derived from the protocol module's single source. */
const APP_PROTOCOL = `${APP_SCHEME}:`;

/**
 * True when `url` is one of the app's own pages.
 *
 * Parsed rather than prefix-matched so that scheme casing (`APP://`) and
 * embedded credentials cannot dress a foreign URL up as a local one.
 *
 * An unparseable URL is NOT an app URL. Note the two callers take that answer in
 * opposite directions, both fail-safe: header injection leaves a URL it cannot
 * parse untouched (it is not ours to police), while navigation refuses to go
 * anywhere it cannot prove is ours.
 */
export function isAppUrl(url: string): boolean {
  try {
    return new URL(url).protocol === APP_PROTOCOL;
  } catch {
    return false;
  }
}

/**
 * Compute the `onHeadersReceived` response for one intercepted response.
 *
 * Pure, so the boundary condition (`app://` gets the policy, everything else is
 * returned byte-identical) is testable without a session.
 *
 * Any CSP the response already carried is dropped rather than merged: browsers
 * intersect multiple policies, so a stale or malformed one could not weaken
 * ours, but it makes a violation report impossible to attribute. The `app://`
 * handler in `protocol.ts` sets no headers of its own today, so in practice this
 * is future-proofing.
 *
 * @param url - The URL the response is for.
 * @param responseHeaders - Headers as Electron reported them; may be absent.
 */
export function cspResponseFor(
  url: string,
  responseHeaders: Record<string, string[]> | undefined,
): HeadersReceivedResponse {
  if (!isAppUrl(url)) {
    // Not ours: hand the headers back exactly as they arrived. Returning `{}`
    // here would also work, but passing them through keeps this function's
    // contract "the response Electron should use", which is what the test reads.
    return responseHeaders === undefined ? {} : { responseHeaders };
  }

  let nonce: string | undefined;
  const headers: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(responseHeaders ?? {})) {
    if (/^content-security-policy(-report-only)?$/i.test(name)) continue;
    // Internal signalling from `protocol.ts` only — must never reach the page.
    if (name.toLowerCase() === SCRIPT_NONCE_HEADER) {
      nonce = value[0];
      continue;
    }
    headers[name] = value;
  }
  headers[CSP_HEADER] = [buildContentSecurityPolicy(nonce)];
  return { responseHeaders: headers };
}

/**
 * Install the CSP injector on `target`.
 *
 * Registered WITHOUT a `WebRequestFilter` on purpose. Electron allows only one
 * `onHeadersReceived` listener per session, so a filtered registration would
 * silently claim that single slot for `app://` only and any later feature
 * needing header inspection would find it taken (or would replace this one and
 * remove the CSP). Scoping therefore happens inside the listener, in
 * {@link cspResponseFor}.
 *
 * @param target - Usually `session.defaultSession`; parameterized for tests.
 */
export function applyCsp(target: Session): void {
  target.webRequest.onHeadersReceived((details, callback) => {
    callback(cspResponseFor(details.url, details.responseHeaders));
  });
}

/**
 * Install the CSP injector on the default session.
 *
 * Call after `app.whenReady()` and BEFORE the first window loads a URL —
 * `defaultSession` does not exist earlier, and a response that has already been
 * delivered cannot be retro-fitted with a policy.
 */
export function registerContentSecurityPolicy(): void {
  applyCsp(session.defaultSession);
}

/**
 * Whether an attempted in-window navigation must be cancelled.
 *
 * Blocks everything that is not one of the app's own `app://` pages. There is no
 * "…but open it externally" branch here by design: `will-navigate` fires for
 * script- and markup-driven navigations too, so treating a blocked navigation as
 * a request to launch the system browser would hand untrusted content the exact
 * exfiltration channel (`https://attacker/?stolen=...` in a URL) that
 * `connect-src 'none'` was added to remove.
 */
export function shouldBlockNavigation(url: string): boolean {
  return !isAppUrl(url);
}

/**
 * The `setWindowOpenHandler` decision: always deny.
 *
 * Unconditional, and takes `url` only so callers can log it. Electron must never
 * open a `BrowserWindow` for content this app did not author, and a new window
 * is not how the app's own deep links leave — those go through
 * `shell:openExternal`.
 */
export function handleWindowOpen(_url: string): { action: 'deny' } {
  return { action: 'deny' };
}

/**
 * Wire {@link shouldBlockNavigation} and {@link handleWindowOpen} onto a live
 * `webContents`.
 *
 * @param contents - The window's `webContents`.
 */
export function installNavigationLockdown(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (shouldBlockNavigation(url)) {
      console.warn('[security] blocked navigation to', url);
      event.preventDefault();
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    console.warn('[security] denied window.open for', url);
    return handleWindowOpen(url);
  });
}
