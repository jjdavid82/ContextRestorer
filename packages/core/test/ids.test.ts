import { describe, it, expect } from 'vitest';
import { eventId, deltaId } from '../src/ids.js';

describe('eventId', () => {
  it('is deterministic for the same source event', () => {
    expect(eventId('slack', 'C123:1699999999.0001'))
      .toBe(eventId('slack', 'C123:1699999999.0001'));
  });

  it('differs across sources with the same native id', () => {
    expect(eventId('slack', 'abc')).not.toBe(eventId('gmail', 'abc'));
  });

  it('is a 64-char lowercase hex digest', () => {
    expect(eventId('slack', 'abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('deltaId', () => {
  it('is unique per thread+version', () => {
    expect(deltaId('C123:1699', 1)).not.toBe(deltaId('C123:1699', 2));
  });
});
