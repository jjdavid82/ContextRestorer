/**
 * Transport failure attribution for the Ollama client.
 *
 * Companion to `ollama.egress.test.ts`, which covers the SEC-6 redirect gate.
 * This file covers the other half of the transport: what an operator is told
 * when a request fails.
 */
import { describe, it, expect } from 'vitest';

import { capForEmbedding, EMBED_MAX_CHARS, describeFetchFailure } from '../src/ollama.js';

// ---------------------------------------------------------------------------
// Transport failure attribution
// ---------------------------------------------------------------------------

/**
 * Node's `fetch` reports every transport failure as `TypeError: fetch failed`
 * and hides the reason on `cause`. Two eval runs lost half their fixtures to
 * that message, and a batch-size change was made on a hypothesis about which
 * limit had been hit — because nothing in the logs said.
 */
describe('describeFetchFailure', () => {
  it('unwraps the cause chain and names the underlying code', () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), {
      code: 'UND_ERR_HEADERS_TIMEOUT',
    });
    const wrapper = new Error('fetch failed', { cause });

    const message = describeFetchFailure(wrapper, "generateJson 'layer1_extraction'", 300_412);

    // The code is the actionable part: it distinguishes "the model took too
    // long" from "Ollama is not running".
    expect(message).toContain('UND_ERR_HEADERS_TIMEOUT');
    expect(message).toContain('fetch failed');
    expect(message).toContain("generateJson 'layer1_extraction'");
  });

  it('reports the elapsed time, which distinguishes a timeout from a refusal', () => {
    const slow = describeFetchFailure(new Error('fetch failed'), 'embed', 300_412);
    const instant = describeFetchFailure(new Error('fetch failed'), 'embed', 11);

    expect(slow).toContain('300.4s');
    expect(instant).toContain('0.0s');
  });

  it('handles an error with no cause', () => {
    expect(describeFetchFailure(new Error('boom'), 'embed', 5)).toContain('boom');
  });

  it('handles a non-Error rejection', () => {
    expect(describeFetchFailure('just a string', 'embed', 5)).toContain('just a string');
  });

  it('does not spin on a self-referential cause chain', () => {
    const loop = new Error('outer');
    (loop as { cause?: unknown }).cause = loop;

    // Bounded depth: a malformed chain must fail loudly, not hang.
    const message = describeFetchFailure(loop, 'embed', 5);
    expect(message.split('<-').length).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Embedding input ceiling
// ---------------------------------------------------------------------------

/**
 * `nomic-embed-text` rejects an over-long input outright (`500 the input length
 * exceeds the context length`) instead of truncating it. Because Layer 1 writes
 * the `extractions` row only after the embedding succeeds, one oversized
 * message left its event unextracted and every later sweep retried and failed
 * on it identically — ingestion wedged on a single long email.
 */
describe('capForEmbedding', () => {
  it('leaves a text within the ceiling exactly as it was', () => {
    const text = 'a'.repeat(EMBED_MAX_CHARS - 1);
    expect(capForEmbedding(text)).toBe(text);
  });

  it('bounds a text past the ceiling', () => {
    expect(capForEmbedding('a'.repeat(50_000)).length).toBeLessThanOrEqual(EMBED_MAX_CHARS);
  });

  it('prefers a word boundary when one is near the cut', () => {
    // Spaces every 10 chars, so the last one sits well inside the final 10%.
    const text = '123456789 '.repeat(5000).slice(0, 50_000);
    const capped = capForEmbedding(text);

    expect(capped.endsWith(' ')).toBe(false);
    expect(capped.length).toBeLessThanOrEqual(EMBED_MAX_CHARS);
    // A boundary was actually used rather than a hard slice mid-token.
    expect(capped.length).toBeGreaterThan(EMBED_MAX_CHARS * 0.9);
  });

  it('falls back to a hard cut when no boundary is near the limit', () => {
    // One unbroken run — a URL or minified JSON. Honouring a distant space
    // would throw away a tenth of the budget for nothing.
    const text = `${'x'.repeat(20)} ${'y'.repeat(50_000)}`;
    expect(capForEmbedding(text)).toHaveLength(EMBED_MAX_CHARS);
  });
});
