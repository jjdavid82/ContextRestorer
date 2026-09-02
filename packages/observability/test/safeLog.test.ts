import { describe, it, expect } from 'vitest';
import { safeLog } from '../src/safeLog.js';

describe('SEC-7 safeLog', () => {
  it('replaces email-shaped values with a stable hash and never emits the raw address', () => {
    const out = safeLog({ from: 'bob@example.com', note: 'ping bob@example.com about Q3' });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('bob@example.com');
    expect(out['from']).not.toBe('bob@example.com');

    // Stable: the same address hashes identically across fields and calls.
    const again = safeLog({ from: 'bob@example.com' });
    expect(out['from']).toBe(again['from']);
    expect(out['note']).toContain(String(out['from']));

    // Distinct addresses do not collapse together.
    const other = safeLog({ from: 'alice@example.com' });
    expect(other['from']).not.toBe(out['from']);
  });

  it('drops messageBody, text and payload_json keys entirely', () => {
    const out = safeLog({
      messageBody: 'confidential thread content',
      text: 'more free text',
      payload_json: '{"secret":true}',
      traceId: 't-1',
    });

    expect(Object.keys(out)).toEqual(['traceId']);
    expect('messageBody' in out).toBe(false);
    expect('text' in out).toBe(false);
    expect('payload_json' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('confidential');
  });

  it('hashes person_id / personId identically across separate calls', () => {
    const first = safeLog({ person_id: 'p-42', personId: 'p-42' });
    const second = safeLog({ person_id: 'p-42', personId: 'p-42' });

    expect(first['person_id']).not.toBe('p-42');
    expect(first['person_id']).toBe(second['person_id']);
    expect(first['personId']).toBe(second['personId']);
    expect(first['person_id']).toBe(first['personId']);
    expect(safeLog({ person_id: 'p-43' })['person_id']).not.toBe(first['person_id']);
  });

  it('passes a clean object through completely unchanged', () => {
    const input = {
      traceId: 'trace-1',
      layer: 2,
      model: 'llama3.1:8b',
      latencyMs: 1234,
      ok: true,
      tags: ['a', 'b'],
      nested: { stage: 'retrieval' },
    };

    expect(safeLog(input)).toEqual(input);
  });

  it('does not mutate the input object', () => {
    const input = { from: 'bob@example.com', messageBody: 'x' };
    safeLog(input);

    expect(input.from).toBe('bob@example.com');
    expect(input.messageBody).toBe('x');
  });
});
