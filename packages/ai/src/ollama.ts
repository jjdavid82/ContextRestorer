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

// `undici` is a DIRECT dependency here only so we can hand a custom `Agent` to
// Node's built-in `fetch` as its `dispatcher` (see `dispatcher` below). Node's
// `fetch` IS undici, bundled inside Node, and a dispatcher from a different
// undici build than that one is not reliably honoured — it can throw, or be
// quietly ignored so the request silently falls back to the 300s default this
// exists to defeat. So this dep's major must stay in step with the undici that
// the supported Node ships: `engines.node` is `>=24.0 <25` (Node 24 → undici
// 7) and `package.json` pins `undici` to `^7`. If the Node major moves, re-pin
// `undici` to match and re-run `packages/ai` against a real Ollama — the tests
// here mock `fetch`, so an ignored dispatcher passes CI unnoticed.
import { Agent } from 'undici';

/** Hosts that are permitted as inference targets. Deliberately minimal. */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Transport ceiling for a single Ollama request, in milliseconds.
 *
 * **Why this exists at all.** Node's `fetch` is undici, whose `headersTimeout`
 * defaults to 300s. Ollama does not send response headers for a non-streaming
 * `/api/generate` until the *whole* generation is finished, so that default is
 * not a header timeout in practice — it is a hard 5-minute cap on generation.
 * `config.budgets.generationMs` ships at 360000 (6 minutes), which meant the
 * configured budget was unreachable by construction: the transport killed the
 * request at 300s and reported `UND_ERR_HEADERS_TIMEOUT`, a full minute before
 * the budget it was supposed to honour.
 *
 * That is not a hypothetical. On a machine running `qwen2.5:14b` on CPU (no
 * GPU), every Layer 1 extraction died at ~305s. Because the ingestion pipeline
 * awaits Layer 1 (`enqueueExtraction` -> `runExtractionSweep`) and the poller
 * awaits the pipeline, the failure surfaced as neither a model error nor a
 * timeout: the poll cycle simply never recorded a success, so `lastSyncAt`
 * stayed null and the source strip read **"Not connected"** for a source whose
 * OAuth was perfectly healthy.
 *
 * **Why a constant and not the config budget.** `generateJson` takes no
 * `AbortSignal` (unlike `generateStream`), so for the JSON path this value IS
 * the effective budget — there is no app-level cancellation underneath it to
 * defer to. It is therefore set comfortably ABOVE the largest shipped budget so
 * that a caller that does have its own bound is always the thing that cancels,
 * and this only ever catches a genuinely wedged endpoint. Raise it if a slower
 * model is adopted; do not lower it below `budgets.generationMs`.
 *
 * `bodyTimeout` gets the same value: for `generateStream` it governs the gap
 * BETWEEN chunks rather than the total, so a generous value costs nothing while
 * still bounding a stalled stream.
 */
const TRANSPORT_TIMEOUT_MS = 900_000;

/**
 * Shared dispatcher carrying {@link TRANSPORT_TIMEOUT_MS}.
 *
 * Module-level and reused: an `Agent` owns a connection pool, so building one
 * per request would discard keep-alive between calls and pay a fresh handshake
 * on every generation.
 */
const dispatcher = new Agent({
  headersTimeout: TRANSPORT_TIMEOUT_MS,
  bodyTimeout: TRANSPORT_TIMEOUT_MS,
});

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
 * Render a `fetch` rejection as something an operator can act on.
 *
 * Node's `fetch` reports every transport failure as the same
 * `TypeError: fetch failed` and puts the actual reason one level down, on
 * `cause` — an undici error carrying a `code` such as `UND_ERR_HEADERS_TIMEOUT`
 * or `ECONNREFUSED`. This unwraps that chain and reports the elapsed time
 * alongside it, because "failed after 300.4s" and "failed after 0.01s" are
 * completely different faults wearing the same message.
 *
 * That opacity was not academic. Two eval runs lost half their fixtures to
 * bare `fetch failed` lines, and `MAX_BATCH_EVENTS` was then lowered from 8 to
 * 4 on a *hypothesis* about which limit had been hit — because nothing in the
 * logs said. This is what turns that guess into a fact.
 *
 * Exported for testing: the shape of this string is the whole point of it.
 */
export function describeFetchFailure(error: unknown, label: string, elapsedMs: number): string {
  const parts: string[] = [];
  let current: unknown = error;

  // Bounded: a malformed or self-referential cause chain must not spin here.
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const code = (current as { code?: unknown }).code;
    parts.push(typeof code === 'string' ? `${current.message} (${code})` : current.message);
    current = current.cause;
  }

  const seconds = (elapsedMs / 1000).toFixed(1);
  return `ollama: ${label} failed after ${seconds}s — ${parts.join(' <- ')}`;
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
export async function guardedFetchUrl(
  url: string,
  init?: RequestInit,
  /** What the caller was doing, for the error message. E.g. `generateJson layer1_extraction`. */
  label = 'request',
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    assertLocal(current);
    const startedAt = performance.now();
    let res: Response;
    try {
      // `dispatcher` is an undici option that the standard `RequestInit` type
      // does not describe, hence the cast — it is honoured by Node's built-in
      // `fetch`, which is undici. See {@link TRANSPORT_TIMEOUT_MS}: without it
      // every request inherits undici's 300s `headersTimeout`, which for a
      // non-streaming Ollama generation is a silent cap on generation time.
      res = await fetch(current, {
        ...init,
        redirect: 'manual',
        dispatcher,
      } as RequestInit);
    } catch (error) {
      // `fetch` rejects with a bare `TypeError: fetch failed` and hides the real
      // reason on `.cause` — an undici error carrying a `code` such as
      // `UND_ERR_HEADERS_TIMEOUT` or `ECONNREFUSED`. That opacity is not
      // academic: it cost two eval runs half their fixtures, reported only as
      // "fetch failed", and left a batch-size change tuned by guesswork because
      // nothing said WHICH limit had been hit or after how long.
      throw new Error(describeFetchFailure(error, label, performance.now() - startedAt), {
        cause: error,
      });
    }
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
 * Character ceiling on a single embedding input.
 *
 * `nomic-embed-text` has a 2048-token context and, unlike a chat model, does
 * NOT truncate an over-long input — it rejects the whole request with
 * `500 {"error":"the input length exceeds the context length"}`. Layer 1
 * embedded `eventText(event)` unbounded, so one long email was enough to fail
 * its thread's extraction; because the `extractions` row is deliberately
 * written only AFTER the embedding succeeds, that event stayed unextracted and
 * every later sweep retried it and failed identically. A single oversized
 * message could therefore wedge ingestion indefinitely.
 *
 * The bound is in characters because we have no tokenizer here, which makes the
 * chars-per-token ratio the whole question. Measured against this model at 2048
 * tokens: Spanish prose failed at ~6.2k characters (~3.0 chars/token) and
 * English runs looser still. Denser inputs — code, URLs, base64, CJK — go the
 * other way and can approach 1 char/token, so a ceiling picked at the prose
 * ratio would only move the failure to the inputs most likely to appear in a
 * work inbox. 2600 is ~1.25 chars/token — under the 2048-token limit even for
 * near-worst-case dense input, not just for prose.
 *
 * That is deliberately conservative and it is NOT the only guard: {@link
 * createOllamaClient}'s `embed` retries a `500 … context length` once at half
 * the length, so a pathological input (solid base64, CJK) that still overshoots
 * this cap degrades to a shorter embedding instead of failing the event's
 * extraction — which, because the `extractions` row is written only after the
 * embedding succeeds, used to wedge the event's whole thread indefinitely.
 *
 * What truncation costs: only retrieval reach over the tail of a very long
 * message. `Chunk.text` keeps the full text, so citations still quote the whole
 * message and nothing shown to the user is abridged — the embedding simply
 * indexes the opening. That is a real limitation, and the honest fix is
 * splitting long events across several chunks; the schema is one chunk per
 * event (`chunkId(event.eventId, 0)`), so that is a contract change, not a
 * constant change.
 */
export const EMBED_MAX_CHARS = 2600;

/** Substrings in an Ollama 500 body that mean "input was too long for the model". */
const CONTEXT_LENGTH_ERROR = /context length|too (?:large|long)|exceeds/i;

/**
 * Bound `text` to {@link EMBED_MAX_CHARS}, cutting at a whitespace boundary
 * when one is close enough to the limit to be worth preferring.
 *
 * Exported for testing: the boundary behaviour is the part worth pinning.
 */
export function capForEmbedding(text: string): string {
  if (text.length <= EMBED_MAX_CHARS) return text;
  const head = text.slice(0, EMBED_MAX_CHARS);
  const lastBreak = head.lastIndexOf(' ');
  // Only honour the word boundary if it is in the last 10% — otherwise a text
  // with no spaces near the cut (a URL, minified JSON) would lose a tenth of
  // its budget to nothing.
  return lastBreak > EMBED_MAX_CHARS * 0.9 ? head.slice(0, lastBreak) : head;
}

type GuardedFetch = (path: string, init: RequestInit, label: string) => Promise<Response>;

/**
 * Embed one string, with a single halve-and-retry on a length rejection.
 *
 * {@link EMBED_MAX_CHARS} is a static char cap for a token limit, so a
 * pathologically dense input (solid base64, CJK) can still overshoot it. Rather
 * than let that fail the caller — for Layer 1 that means the event's
 * `extractions` row is never written and its thread never synthesizes — a
 * `500` whose body names a length problem is retried once at half the length.
 * Any other non-2xx, or a second failure, throws with the body attached: an
 * over-long input and a dead model are both `500` and only the body tells them
 * apart.
 */
async function embedOne(
  guardedFetch: GuardedFetch,
  embedModel: string,
  text: string,
): Promise<number[]> {
  let prompt = capForEmbedding(text);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await guardedFetch(
      '/api/embeddings',
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model: embedModel, prompt }) },
      `embed (${embedModel})`,
    );

    if (res.ok) {
      const body = (await res.json()) as OllamaEmbeddingsEnvelope;
      if (!Array.isArray(body.embedding)) {
        throw new Error('ollama: /api/embeddings response missing `embedding` array');
      }
      return body.embedding;
    }

    const detail = await res.text().catch(() => '');
    const retryable =
      attempt === 0 && res.status === 500 && CONTEXT_LENGTH_ERROR.test(detail) && prompt.length > 1;
    if (!retryable) {
      throw new Error(
        `ollama: /api/embeddings returned ${res.status}` +
          (detail === '' ? '' : ` — ${detail.slice(0, 200)}`),
      );
    }
    prompt = prompt.slice(0, Math.floor(prompt.length / 2));
  }

  // Unreachable: the loop either returns an embedding or throws.
  throw new Error('ollama: /api/embeddings retry exhausted');
}

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
  const guardedFetch = (path: string, init: RequestInit, label: string): Promise<Response> =>
    guardedFetchUrl(`${root}${path}`, init, label);

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
      }, `generateJson '${o.schemaName}' (${chatModel}, non-streaming)`);
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
        }, `generateStream (${chatModel})`);

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
        out.push(await embedOne(guardedFetch, embedModel, text));
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
