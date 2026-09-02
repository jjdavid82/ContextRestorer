/**
 * `app://` custom protocol handler.
 *
 * The renderer is loaded from `app://local/index.html` rather than `file://` so that the
 * UI runs in a normal, opaque web origin (cookies/storage partitioning, no implicit
 * file-system read access from the page). Every request is resolved against a single
 * `uiRoot` directory and any path that escapes that root is rejected with a 403 — the
 * renderer displays untrusted ingested content (email/Slack text), so a traversal here
 * would be a straight local-file-disclosure primitive.
 *
 * `resolveUiPath` is deliberately free of Electron imports so it can be unit tested
 * under plain Node/vitest without launching an Electron process.
 */
import { protocol, net } from 'electron';
import { randomBytes } from 'node:crypto';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The scheme served to the renderer. Hostname is fixed to `local`. */
export const APP_SCHEME = 'app';

/**
 * Internal-only header carrying the per-response script nonce from this
 * handler to `csp.ts`'s `onHeadersReceived` listener, the only other place
 * that runs between this handler returning and the response reaching the
 * renderer. `cspResponseFor` reads it to build `script-src` and strips it
 * before the response leaves — it must never be visible to the page itself.
 */
export const SCRIPT_NONCE_HEADER = 'x-app-script-nonce';

/**
 * Resolve an `app://` URL path to an absolute file path inside `uiRoot`.
 *
 * @param uiRoot Absolute path to the directory containing the built UI.
 * @param urlPath The `pathname` of the incoming request (may be percent-encoded).
 * @returns The absolute on-disk path, or `null` if the request escapes `uiRoot`.
 *
 * Exported for unit test.
 */
export function resolveUiPath(uiRoot: string, urlPath: string): string | null {
  // Strip trailing separators so the `startsWith(root + sep)` containment check below
  // cannot be defeated (or accidentally broken) by a caller passing `C:\app\ui\`.
  const root = normalize(uiRoot).replace(/[\\/]+$/, '');
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  } catch {
    // Malformed percent-encoding — treat as hostile rather than guessing.
    return null;
  }
  // NUL bytes truncate paths in some syscalls; never let one reach the filesystem.
  if (rel.includes('\0')) return null;
  const abs = normalize(join(root, rel));
  if (!abs.startsWith(root + sep)) return null; // traversal blocked
  return abs;
}

/**
 * Declare `app://` as a standard, secure scheme that supports the Fetch API.
 *
 * MUST be called at module/startup time, i.e. *before* `app.whenReady()` resolves;
 * Electron ignores privilege registration afterwards.
 */
export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Give every inline `<script>` tag (one with no `src`) a fresh nonce attribute,
 * so it can be allow-listed per-response in the CSP `script-src` directive
 * instead of falling back to `'unsafe-inline'`. Next's static export embeds the
 * React Flight hydration payload as inline scripts — without this, they are
 * simply dead under a strict CSP and the page never finishes mounting.
 *
 * The lookahead is bounded to the current tag: `[^>]*` cannot cross the `>`
 * that ends it, so a `<script src="…">` tag is correctly left untouched.
 *
 * Exported for unit test; pure string transform, no Electron imports.
 */
export function injectScriptNonce(html: string, nonce: string): string {
  return html.replace(/<script(?![^>]*\ssrc=)/g, `<script nonce="${nonce}"`);
}

/**
 * Install the `app://` request handler. Call after `app.whenReady()`.
 *
 * @param uiRoot Absolute path to the directory containing the built UI bundle.
 */
export function registerAppProtocol(uiRoot: string): void {
  protocol.handle(APP_SCHEME, async (req) => {
    const abs = resolveUiPath(uiRoot, new URL(req.url).pathname);
    if (!abs) return new Response('forbidden', { status: 403 });

    const response = await net.fetch(pathToFileURL(abs).toString());
    if (!abs.endsWith('.html')) return response;

    const nonce = randomBytes(16).toString('base64');
    const body = injectScriptNonce(await response.text(), nonce);
    const headers = new Headers(response.headers);
    // The body just changed length; a stale Content-Length would truncate it.
    headers.delete('content-length');
    headers.set(SCRIPT_NONCE_HEADER, nonce);
    return new Response(body, { status: response.status, headers });
  });
}
