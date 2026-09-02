/**
 * `shell:openExternal` — the ONLY way a URL leaves this app for the system
 * browser (Task 4.6).
 *
 * Why a channel at all: Task 4.6 locks the renderer down so that neither
 * `will-navigate` nor `window.open` can take untrusted content anywhere (see
 * `security/csp.ts`). That lockdown also catches the app's own FR-6 source deep
 * links, which are plain anchors. Rather than re-open a hole in the lockdown for
 * "links that look legitimate" — indistinguishable, at the event, from a link
 * that untrusted content injected — the deep links are routed here explicitly.
 *
 * Why an allowlist inside the handler: a compromised renderer can call every
 * channel the preload exposes, so an unvalidated `openExternal` would be an
 * exfiltration primitive (`https://attacker/?stolen=…` opened in the user's
 * browser, cookies and all). Only the hosts this app actually generates deep
 * links for are permitted, and only over `https:`.
 *
 * When a new source is added, `deepLinkFor` in `ipc/claim.ts` gains a host — and
 * {@link ALLOWED_LINK_HOSTS} must gain it too, or the new link will be refused.
 * Failing closed is the intended direction: a dead "open in …" link is a visible
 * bug, whereas an open redirect is invisible until it is used.
 */
import { ipcMain, shell } from 'electron';

/** The channel name. Must match `preload.cts`'s allowlist exactly. */
export const OPEN_EXTERNAL_CHANNEL = 'shell:openExternal';

/**
 * Hosts the app is permitted to hand to the system browser.
 *
 * Exactly the hosts `deepLinkFor` produces: `slack.com/app_redirect` and
 * `mail.google.com/mail/...`. Subdomains of these are accepted (Slack workspace
 * archive links are `<workspace>.slack.com`), nothing else is.
 */
export const ALLOWED_LINK_HOSTS: readonly string[] = ['slack.com', 'mail.google.com'];

/** Result shape returned to the renderer; mirrors the preload's `OkResult`. */
export interface OpenExternalResult {
  ok: boolean;
  /** Machine-readable cause when `ok` is false: `invalid_url` or `open_failed`. */
  reason?: string;
}

/**
 * Narrow the renderer-supplied argument to a URL string.
 *
 * Re-validated here rather than trusted from the preload, per the IPC rules in
 * `preload.cts`: a compromised renderer controls what it sends.
 *
 * @returns The URL, or `null` when the argument is not `{ url: string }`.
 */
export function parseOpenExternalArg(arg: unknown): string | null {
  if (arg === null || typeof arg !== 'object') return null;
  const url = (arg as { url?: unknown }).url;
  if (typeof url !== 'string' || url.length === 0) return null;
  return url;
}

/**
 * Whether `url` may be opened in the system browser.
 *
 * Requires `https:` (so `file:`, `javascript:`, `data:` and Windows shell
 * schemes are all refused) and a host on {@link ALLOWED_LINK_HOSTS} matched on
 * label boundaries — `notslack.com` and `slack.com.evil.test` must not pass.
 * Embedded credentials are refused too: `https://mail.google.com@evil.test/`
 * parses with host `evil.test`, but a URL carrying userinfo has no legitimate
 * use here and its presence is itself a spoofing signal.
 */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_LINK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Injectable seam so the handler is testable without Electron's `shell`. */
export interface ExternalLinkDeps {
  openExternal(url: string): Promise<void>;
}

/**
 * Validate and open one URL.
 *
 * Never throws: the renderer gets `{ ok: false, reason }` so a refused link can
 * be reported in the UI instead of surfacing as an unhandled rejection.
 */
export async function openExternalLink(
  arg: unknown,
  deps: ExternalLinkDeps,
): Promise<OpenExternalResult> {
  const url = parseOpenExternalArg(arg);
  if (url === null || !isAllowedExternalUrl(url)) {
    // Logged with the URL, since this is either a bug in a deep-link builder or
    // an attempt to abuse the channel — both are worth seeing.
    console.warn('[security] refused shell.openExternal for', url);
    return { ok: false, reason: 'invalid_url' };
  }

  try {
    await deps.openExternal(url);
    return { ok: true };
  } catch (error) {
    console.error('[shell] openExternal failed', error);
    return { ok: false, reason: 'open_failed' };
  }
}

/** Register `shell:openExternal` against Electron's real `shell`. */
export function registerExternalHandlers(): void {
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, arg: unknown) =>
    openExternalLink(arg, { openExternal: (url) => shell.openExternal(url) }),
  );
}
