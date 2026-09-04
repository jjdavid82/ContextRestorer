/**
 * NDJSON claim streaming (P4 part 2, F-8).
 *
 * The contract these pin: structure arrives as FIELDS, so there is no marker
 * shape for a model to imitate incorrectly — the class of bug `renderContext`
 * documents, where a label one token different from the instructed marker cost
 * every claim in a briefing.
 *
 * A line that cannot be read is DROPPED and counted, never guessed at.
 */
import { describe, it, expect, vi } from 'vitest';
import { ClaimLineBuffer, toStructuredClaim } from '../src/layer3/claimLines.js';

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const claim = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  section: 'What moved',
  claim: 'Alpha shipped to staging',
  artifact_ids: ['art-1'],
  ...over,
});

describe('toStructuredClaim', () => {
  it('reads the contract shape', () => {
    expect(toStructuredClaim(claim())).toEqual({
      section: 'What moved',
      text: 'Alpha shipped to staging',
      artifactIds: ['art-1'],
    });
  });

  it('accepts a single string where an array was specified', () => {
    // The shape a small model most commonly degrades to, and unambiguous.
    expect(toStructuredClaim(claim({ artifact_ids: 'art-1' }))).toMatchObject({
      artifactIds: ['art-1'],
    });
  });

  it('passes an UNCITED claim through to the gate rather than calling it malformed', () => {
    // `no_citation` is a claim-level event with its own counter, and AC-2's
    // accounting lives there. Reclassifying it as a parse failure would shrink
    // the number the citation guarantee is measured by.
    expect(toStructuredClaim(claim({ artifact_ids: [] }))).toMatchObject({ artifactIds: [] });
    const { artifact_ids: _omitted, ...withoutIds } = claim();
    expect(toStructuredClaim(withoutIds)).toMatchObject({ artifactIds: [] });
  });

  it('rejects anything without a section or a claim', () => {
    expect(toStructuredClaim(claim({ section: '' }))).toBe('malformed');
    expect(toStructuredClaim(claim({ claim: '   ' }))).toBe('malformed');
    const { section: _s, ...noSection } = claim();
    expect(toStructuredClaim(noSection)).toBe('malformed');
  });

  it('rejects a non-object, including an array', () => {
    for (const value of [null, 'a string', 42, ['an', 'array']]) {
      expect(toStructuredClaim(value)).toBe('malformed');
    }
  });

  it('rejects a non-array, non-string id field', () => {
    expect(toStructuredClaim(claim({ artifact_ids: 42 }))).toBe('malformed');
  });
});

describe('ClaimLineBuffer', () => {
  const collect = (): { claims: unknown[]; drops: string[]; buffer: ClaimLineBuffer } => {
    const claims: unknown[] = [];
    const drops: string[] = [];
    const buffer = new ClaimLineBuffer(
      (c) => claims.push(c),
      (r) => drops.push(r),
    );
    return { claims, drops, buffer };
  };

  it('emits one claim per completed line', () => {
    const { claims, buffer } = collect();
    buffer.push(line(claim()));
    buffer.push(line(claim({ claim: 'Beta shipped' })));

    expect(claims).toHaveLength(2);
  });

  it('waits for the newline before emitting', () => {
    const { claims, buffer } = collect();
    // A line split across tokens is the normal streaming case: nothing may be
    // emitted until it is whole, or a half-claim reaches the user.
    buffer.push('{"section":"What moved","claim":"Alpha shipped",');
    expect(claims).toHaveLength(0);

    buffer.push('"artifact_ids":["art-1"]}\n');
    expect(claims).toHaveLength(1);
  });

  it('emits several claims from one token', () => {
    const { claims, buffer } = collect();
    buffer.push(line(claim()) + line(claim({ claim: 'Beta shipped' })));

    expect(claims).toHaveLength(2);
  });

  it('counts an unparseable line instead of dropping it silently', () => {
    const { claims, drops, buffer } = collect();
    buffer.push('this is not json\n');

    expect(claims).toHaveLength(0);
    expect(drops).toEqual(['unparseable']);
  });

  it('counts a well-formed JSON line that is not a claim', () => {
    const { claims, drops, buffer } = collect();
    buffer.push(line({ note: 'here is your briefing' }));

    expect(claims).toHaveLength(0);
    expect(drops).toEqual(['malformed']);
  });

  it('ignores blank lines and stray code fences', () => {
    const { claims, drops, buffer } = collect();
    buffer.push('```json\n');
    buffer.push('\n');
    buffer.push(line(claim()));
    buffer.push('```\n');

    // Models wrap NDJSON in fences more or less at random; a fence is
    // punctuation, not content, and must not be counted as a lost claim.
    expect(claims).toHaveLength(1);
    expect(drops).toEqual([]);
  });

  it('end() flushes a trailing line with no newline', () => {
    const { claims, buffer } = collect();
    buffer.push(JSON.stringify(claim()));
    expect(claims).toHaveLength(0);

    buffer.end();
    expect(claims).toHaveLength(1);
  });

  it('end() is safe to call twice', () => {
    const { claims, buffer } = collect();
    buffer.push(line(claim()));
    buffer.end();
    buffer.end();

    expect(claims).toHaveLength(1);
  });

  it('defaults its drop handler, so a caller may ignore drops', () => {
    const onClaim = vi.fn();
    const buffer = new ClaimLineBuffer(onClaim);

    expect(() => buffer.push('not json\n')).not.toThrow();
    expect(onClaim).not.toHaveBeenCalled();
  });
});
