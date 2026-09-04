/**
 * Transport failure attribution for the Ollama client.
 *
 * Companion to `ollama.egress.test.ts`, which covers the SEC-6 redirect gate.
 * This file covers the other half of the transport: what an operator is told
 * when a request fails.
 */
import { describe, it, expect } from 'vitest';

import { describeFetchFailure } from '../src/ollama.js';

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
