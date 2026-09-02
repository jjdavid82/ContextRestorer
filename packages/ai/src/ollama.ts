/**
 * Local-only Ollama client.
 *
 * SEC-6: inference must never leave this machine. Every outbound request is
 * gated by {@link assertLocal}, which is invoked once in the factory (so a
 * mis-configured client fails at construction time, before any network I/O)
 * and again immediately before each `fetch` (so the invariant is local to each
 * method rather than relying on immutability of the stored base URL).
 *
 * Task 4.6 (egress allowlist) closes the redirect hole in that gate: validating
 * the URL we *ask* for proves nothing if the transport silently follows a `302`
 * to somewhere else. All three methods therefore go through one internal
 * `guardedFetch`, which issues every request with `redirect: 'manual'` and
 * re-runs {@link assertLocal} on the resolved `Location` **before** any request
 * reaches it — so a compromised or hijacked local endpoint cannot bounce a
 * prompt (or an embedding of it) out to a remote host.
 */

/** Hosts that are permitted as inference targets. Deliberately minimal. */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Fixed seed for every chat generation call, paired with `temperature: 0`.
 *
 * Task 5.1's eval harness found runs were not reproducible run-to-run with no
 * decoding parameters set — the same fixture measured 0% then 10.5% hallucination
 * across two identical invocations. AC-5 is a release gate; a number that moves
 * on a re-run without any code change cannot be trusted as that gate's evidence.
 */
const MODEL_SEED = 20260823;

/**
 * Throws unless `url` points at a loopback host.
 *
 * Exported for unit testing only; it is not part of the {@link OllamaClient}
 * public surface.
 *
 * @param url - Absolute URL to validate.
 * @throws Error tagged `SEC-6` when the host is not local, or when `url` is
 *   not a parseable absolute URL (an unparseable target cannot be proven
 *   local, so it is refused rather than trusted).
 */
export function assertLocal(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`SEC-6: outbound inference to '${url}' is forbidden; local only`);
  }
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(`SEC-6: outbound inference to '${hostname}' is forbidden; local only`);
  }
}

/**
 * Statuses that carry a `Location` and would move the request elsewhere.
 *
 * `303` is included even though Ollama never emits it: the point of the set is
 * "the transport would have gone somewhere we did not validate", and which
 * method the redirect rewrites to is irrelevant to that.
 */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Hard cap on manually-followed redirects.
 *
 * A local Ollama has no reason to redirect at all, so this exists only so that a
 * loopback redirect loop fails fast instead of spinning.
 */
const MAX_REDIRECTS = 3;

/**
 * Reads the `Location` header defensively.
 *
 * `Response.headers` is non-optional in the DOM types, but this client is
 * routinely handed hand-rolled test doubles (and Electron's `net` module has its
 * own response shapes), so a missing `headers` must read as "no redirect target"
 * rather than throwing a `TypeError` from inside the security gate.
 */
function readLocation(res: Response): string | null {
  const headers: Headers | undefined = res.headers;
  if (headers === undefined || typeof headers.get !== 'function') return null;
  return headers.get('location');
}

/**
 * Resolves a `Location` value against the URL it was returned from.
 *
 * Absolute, host-relative (`/x`) and protocol-relative (`//host/x`) forms all
 * collapse to one absolute URL here, so {@link assertLocal} only ever sees a
 * fully-resolved target — a protocol-relative `//evil.example.com/x` must not be
 * able to look "relative, therefore local".
 *
 * @throws Error tagged `SEC-6` when the target cannot be resolved at all: an
 *   unparseable redirect cannot be proven local, so it is refused.
 */
function resolveRedirect(from: string, location: string): string {
  try {
    return new URL(location, from).toString();
  } catch {
    throw new Error(`SEC-6: unresolvable redirect target '${location}' is forbidden; local only`);
  }
}

/**
 * Fetches `url` with the same redirect-validation guard {@link createOllamaClient}
 * uses internally: `redirect: 'manual'`, with every hop re-validated against
 * {@link assertLocal} before it is followed. Exported so other local-only
 * callers (e.g. {@link preflight}) get the same SEC-6 redirect closure instead
 * of a bare `fetch` that would silently follow a hijacked local endpoint off-machine.
 *
 * @throws Error tagged `SEC-6` if `url`, or any redirect target, is not loopback.
 */
export async function guardedFetchUrl(url: string, init?: RequestInit): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    assertLocal(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) return res;

    const location = readLocation(res);
    if (location === null || location === '') {
      throw new Error(`ollama: ${res.status} redirect from '${current}' carried no Location header`);
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`ollama: too many redirects (>${MAX_REDIRECTS}) starting at '${current}'`);
    }

    current = resolveRedirect(current, location);
    assertLocal(current);
  }
}

/** Result of a single constrained-JSON generation. */
export interface GenerateJsonResult<T> {
  /** Parsed model output, or `null` when the model emitted invalid JSON. */
  value: T | null;
  /** The model's raw `response` text, always populated for audit/debugging. */
  raw: string;
  /** Prompt tokens, when Ollama reported them. Omitted rather than faked. */
  tokensIn?: number;
  /** Completion tokens, when Ollama reported them. Omitted rather than faked. */
  tokensOut?: number;
  /** Wall-clock milliseconds spent on the request, including body read. */
  latencyMs: number;
}

/** Options for {@link OllamaClient.generateJson}. */
export interface GenerateJsonOptions {
  prompt: string;
  system: string;
  /** Name of the expected schema; used only for error attribution. */
  schemaName: string;
}

/** Options for {@link OllamaClient.generateStream}. */
export interface GenerateStreamOptions {
  prompt: string;
  system: string;
  signal?: AbortSignal;
}

/** Minimal local inference surface consumed by the rest of the app. */
export interface OllamaClient {
  generateJson<T>(o: GenerateJsonOptions): Promise<GenerateJsonResult<T>>;
  generateStream(o: GenerateStreamOptions): AsyncIterable<string>;
  embed(texts: string[]): Promise<number[][]>;
}

/** Subset of Ollama's `/api/generate` envelope that we rely on. */
interface OllamaGenerateEnvelope {
  response?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Subset of Ollama's `/api/embeddings` envelope that we rely on. */
interface OllamaEmbeddingsEnvelope {
  embedding?: number[];
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/**
 * Creates a client bound to a single local Ollama instance.
 *
 * @param baseUrl - e.g. `http://localhost:11434`. Validated immediately.
 * @param chatModel - Model used by `generateJson` / `generateStream`.
 * @param embedModel - Model used by `embed`.
 * @throws Error tagged `SEC-6` if `baseUrl` is not loopback.
 */
export function createOllamaClient(
  baseUrl: string,
  chatModel: string,
  embedModel: string,
): OllamaClient {
  // Fail at construction: a non-local client can never exist, even unused.
  assertLocal(baseUrl);

  const root = baseUrl.replace(/\/+$/, '');

  /**
   * The single outbound egress point for this client (SEC-6, Task 4.6).
   *
   * Re-validates the exact URL about to be fetched, then fetches it with
   * `redirect: 'manual'` so that no redirect is ever followed by the transport
   * on our behalf. A 3xx is resolved and re-validated here: if the target is not
   * loopback the call throws and NO request is issued to it, so an external host
   * never sees the prompt, the embedding input, or even a connection attempt.
   *
   * Every method funnels through this deliberately — three ad hoc `fetch` sites
   * would each need to remember the guard, and the one that forgot would be an
   * egress hole that no test of the other two could detect.
   */
  const guardedFetch = (path: string, init: RequestInit): Promise<Response> =>
    guardedFetchUrl(`${root}${path}`, init);

  return {
    async generateJson<T>(o: GenerateJsonOptions): Promise<GenerateJsonResult<T>> {
      const started = performance.now();
      const res = await guardedFetch('/api/generate', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          model: chatModel,
          system: o.system,
          prompt: o.prompt,
          format: 'json',
          stream: false,
          // Deterministic decoding: eval/bench runs (Task 5.1/5.3) need
          // reproducible output to compare across runs. A fixed seed with
          // temperature 0 is Ollama's documented way to get that.
          options: { temperature: 0, seed: MODEL_SEED },
        }),
      });
      const text = await res.text();
      const latencyMs = Math.round(performance.now() - started);

      if (!res.ok) {
        throw new Error(
          `ollama: /api/generate returned ${res.status} for schema '${o.schemaName}': ${text}`,
        );
      }

      let envelope: OllamaGenerateEnvelope;
      try {
        envelope = JSON.parse(text) as OllamaGenerateEnvelope;
      } catch {
        // Malformed envelope is still a schema failure, not a crash: the caller
        // records the outcome and moves on.
        return { value: null, raw: text, latencyMs };
      }

      const raw = envelope.response ?? '';
      let value: T | null = null;
      try {
        value = JSON.parse(raw) as T;
      } catch {
        value = null;
      }

      return {
        value,
        raw,
        latencyMs,
        ...(typeof envelope.prompt_eval_count === 'number'
          ? { tokensIn: envelope.prompt_eval_count }
          : {}),
        ...(typeof envelope.eval_count === 'number' ? { tokensOut: envelope.eval_count } : {}),
      };
    },

    generateStream(o: GenerateStreamOptions): AsyncIterable<string> {
      // Ollama streams newline-delimited JSON objects; yield each `response`.
      async function* iterate(): AsyncGenerator<string, void, undefined> {
        const res = await guardedFetch('/api/generate', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            model: chatModel,
            system: o.system,
            prompt: o.prompt,
            stream: true,
            options: { temperature: 0, seed: MODEL_SEED },
          }),
          ...(o.signal ? { signal: o.signal } : {}),
        });

        if (!res.ok) {
          throw new Error(`ollama: /api/generate returned ${res.status}`);
        }
        if (!res.body) {
          throw new Error('ollama: /api/generate returned no body for a streaming request');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) buffer += decoder.decode(value, { stream: true });

            let newline = buffer.indexOf('\n');
            while (newline !== -1) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              const chunk = chunkFromLine(line);
              if (chunk) yield chunk;
              newline = buffer.indexOf('\n');
            }
          }
          // Flush any trailing partial-but-complete object.
          const tail = (buffer + decoder.decode()).trim();
          const last = chunkFromLine(tail);
          if (last) yield last;
        } finally {
          reader.releaseLock();
        }
      }
      return iterate();
    },

    async embed(texts: string[]): Promise<number[][]> {
      // Chosen approach: one request per text against the legacy
      // `/api/embeddings` endpoint. It is supported by every Ollama version we
      // target, whereas batch `/api/embed` input is version-dependent. Results
      // are collected sequentially so ordering matches `texts` exactly.
      const out: number[][] = [];
      for (const text of texts) {
        const res = await guardedFetch('/api/embeddings', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ model: embedModel, prompt: text }),
        });
        if (!res.ok) {
          throw new Error(`ollama: /api/embeddings returned ${res.status}`);
        }
        const body = (await res.json()) as OllamaEmbeddingsEnvelope;
        if (!Array.isArray(body.embedding)) {
          throw new Error('ollama: /api/embeddings response missing `embedding` array');
        }
        out.push(body.embedding);
      }
      return out;
    },
  };
}

/** Parses one NDJSON line, returning its `response` text if it carries any. */
function chunkFromLine(line: string): string | undefined {
  if (!line) return undefined;
  let parsed: OllamaGenerateEnvelope;
  try {
    parsed = JSON.parse(line) as OllamaGenerateEnvelope;
  } catch {
    // Ignore malformed lines rather than aborting a partially useful stream.
    return undefined;
  }
  return typeof parsed.response === 'string' && parsed.response.length > 0
    ? parsed.response
    : undefined;
}
