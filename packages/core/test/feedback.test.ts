import { describe, it, expect } from 'vitest';
import { FEEDBACK_CLAIM_KEY_SEP, feedbackClaimKey, parseFeedbackClaimKey } from '../src/feedback.js';

describe('feedbackClaimKey', () => {
  it('round-trips an artifact id and a sentence', () => {
    const key = feedbackClaimKey('art-1', 'The launch slipped to March.');
    expect(key).toBe(`art-1${FEEDBACK_CLAIM_KEY_SEP}The launch slipped to March.`);
    expect(parseFeedbackClaimKey(key)).toEqual({
      artifactId: 'art-1',
      claimText: 'The launch slipped to March.',
    });
  });

  it('keeps a separator that appears later in the sentence with the text', () => {
    // Only the FIRST separator splits — nothing legitimately produces U+001F in
    // claim text, but the split must still be total if one slipped through.
    const weird = `a${FEEDBACK_CLAIM_KEY_SEP}b`;
    const key = feedbackClaimKey('art-1', weird);
    expect(parseFeedbackClaimKey(key)).toEqual({ artifactId: 'art-1', claimText: weird });
  });

  it('returns null for a value with no separator or a nullish input', () => {
    expect(parseFeedbackClaimKey('art-1')).toBeNull();
    expect(parseFeedbackClaimKey(null)).toBeNull();
    expect(parseFeedbackClaimKey(undefined)).toBeNull();
  });
});
