import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The authorization-code callback parsed off the loopback redirect. */
export interface LoopbackResult {
  code: string;
  state: string;
}

export interface LoopbackServer {
  /** OS-assigned ephemeral port. Use it to build `http://127.0.0.1:<port>/callback`. */
  port: number;
  /** The bound address as reported by the OS — always the loopback literal `127.0.0.1`. */
  host: string;
  /** Resolves once (and only once) with the callback params, then the server is closed. */
  result: Promise<LoopbackResult>;
}

/** Loopback-only. Binding to 0.0.0.0 would expose the code catcher to the LAN. */
const LOOPBACK_HOST = '127.0.0.1';

/** Two minutes is enough for a human to complete a consent screen. */
const DEFAULT_TIMEOUT_MS = 120_000;

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:2rem"><h1>${title}</h1><p>${body}</p></body>`;

/**
 * Starts a single-shot HTTP server on `127.0.0.1` (an OS-assigned ephemeral port by
 * default, or a caller-supplied fixed one) that catches exactly one OAuth redirect
 * and then shuts itself down.
 *
 * The returned promise settles as soon as the socket is actually listening, so the
 * caller can embed the real port in `redirect_uri` before opening the browser.
 *
 * `result` rejects — and the server still closes — when the callback's `state` does not
 * match `expectedState` (CSRF), when the provider returns an `error` param, or when no
 * callback arrives inside `timeoutMs`.
 */
export function startLoopbackServer(
  expectedState: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  /**
   * Bind to this exact port instead of an OS-assigned ephemeral one. Some
   * providers (Slack) match `redirect_uri` against an exactly pre-registered
   * value, including the port — an ephemeral port can never match. Google's
   * installed-app flow explicitly allows any loopback port, so it never needs
   * this. Defaults to `0` (ephemeral), unchanged from before this parameter existed.
   */
  port = 0,
): Promise<LoopbackServer> {
  let resolveResult!: (value: LoopbackResult) => void;
  let rejectResult!: (reason: Error) => void;
  const result = new Promise<LoopbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const server = createServer();

  /**
   * Closes the server exactly once and settles `result` only after the listener has
   * actually released the port, so a subsequent `startLoopbackServer` can bind freely.
   */
  const finish = (settle: () => void, force: boolean): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    // On the timeout path a half-open client socket could otherwise keep `close` pending.
    if (force) server.closeAllConnections();
    server.close(() => settle());
  };

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    // Stray probes (favicon, port scanners) must not consume the single shot.
    if (state === null && error === null) {
      res.writeHead(404, { connection: 'close' });
      res.end();
      return;
    }

    // `Connection: close` lets `server.close()` complete as soon as this response flushes.
    const respond = (status: number, html: string): void => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        connection: 'close',
      });
      res.end(html);
    };

    // CSRF check first: a mismatched state means this request is not ours, so nothing
    // about it — not even a present `code` — may be trusted or exchanged.
    if (state !== expectedState) {
      respond(400, page('Sign-in failed', 'state mismatch'));
      finish(() => rejectResult(new Error('OAuth callback rejected: state mismatch')), false);
      return;
    }

    if (error !== null) {
      respond(400, page('Sign-in failed', 'The provider returned an error.'));
      finish(() => rejectResult(new Error(`OAuth callback returned error: ${error}`)), false);
      return;
    }

    if (code === null || code === '') {
      respond(400, page('Sign-in failed', 'Missing authorization code.'));
      finish(() => rejectResult(new Error('OAuth callback missing authorization code')), false);
      return;
    }

    respond(200, page('Connected', 'You can close this tab and return to Context Restorer.'));
    finish(() => resolveResult({ code, state }), false);
  });

  return new Promise<LoopbackServer>((resolveServer, rejectServer) => {
    server.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      rejectResult(err);
      rejectServer(err);
    });

    server.listen(port, LOOPBACK_HOST, () => {
      const address = server.address() as AddressInfo | null;
      if (address === null || typeof address === 'string') {
        finish(() => rejectResult(new Error('loopback server failed to bind')), true);
        rejectServer(new Error('loopback server failed to bind'));
        return;
      }

      timer = setTimeout(() => {
        finish(
          () => rejectResult(new Error(`OAuth callback timed out after ${timeoutMs}ms`)),
          true,
        );
      }, timeoutMs);
      // Never hold the process open just for the consent window.
      timer.unref();

      resolveServer({ port: address.port, host: address.address, result });
    });
  });
}
