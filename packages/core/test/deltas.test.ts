import { describe, it, expect } from 'vitest';
import {
  MANUAL_RESOLVE_MODEL,
  MANUAL_RESOLVE_PROMPT_VERSION,
  isUserActionDelta,
} from '../src/deltas.js';

describe('isUserActionDelta', () => {
  it('is true for a delta stamped with the manual-resolve sentinel', () => {
    expect(isUserActionDelta({ model: MANUAL_RESOLVE_MODEL })).toBe(true);
  });

  it('is false for a Layer 2 resolution delta (a real reply closed the thread)', () => {
    expect(isUserActionDelta({ model: 'qwen2.5:14b' })).toBe(false);
  });

  it('is false for any other model name', () => {
    expect(isUserActionDelta({ model: 'none:deterministic-template' })).toBe(false);
  });
});

describe('manual-resolve sentinels', () => {
  it('name no real model and no real prompt', () => {
    expect(MANUAL_RESOLVE_MODEL.startsWith('none:')).toBe(true);
    expect(MANUAL_RESOLVE_PROMPT_VERSION).toBe('user-resolve.v1');
  });
});
