/**
 * The single, mandatory assembly point for any prompt that carries untrusted
 * text (threat T-1).
 *
 * IMPORTANT — this contract is intentionally used by ALL THREE layers, not just
 * the final narrative step:
 *
 *   - Layer 1 (per-artifact extraction),
 *   - Layer 2 (cross-artifact synthesis),
 *   - Layer 3 (briefing generation).
 *
 * T-1 must hold everywhere untrusted content reaches the model. An injected
 * instruction that is obeyed during Layer 1 extraction poisons the structured
 * facts that Layers 2 and 3 then treat as trusted, so fencing only at the
 * generation step would defend the last mile of a road already lost. Layers 1
 * and 2 are implemented by later tasks; they must call this function rather
 * than string-concatenating their own prompts.
 *
 * The enforcement is structural: {@link PromptParts.wrappedContent} is typed as
 * `WrappedContent`, a branded type that only `wrap.ts` can construct. Passing a
 * raw `string` is a compile error, so a future layer cannot accidentally — or
 * expediently — skip the fencing step.
 */

import { UNTRUSTED_SYSTEM_RULE, type WrappedContent } from './wrap.js';

/** Inputs to {@link assemblePrompt}. */
export interface PromptParts {
  /** Task-specific system prompt. `UNTRUSTED_SYSTEM_RULE` is appended for you. */
  system: string;
  /**
   * The untrusted payload, already fenced by `wrapUntrusted`.
   *
   * This is the enforcement point for T-1: it is NOT a `string`, and the only
   * way to obtain a value of this type is to call `wrapUntrusted` /
   * `wrapUntrustedWithNonce`.
   */
  wrappedContent: WrappedContent;
  /**
   * Trusted, developer-authored instructions placed AFTER the fenced block so
   * the model reads the real task last. Never put user or artifact text here.
   */
  instructions?: string;
}

/** A system/user prompt pair ready to hand to the model client. */
export interface AssembledPrompt {
  /** System prompt, with the untrusted-content rule appended. */
  system: string;
  /** User prompt: the fenced block, optionally followed by instructions. */
  prompt: string;
}

/**
 * Combines a system prompt, fenced untrusted content and trusted instructions.
 *
 * `UNTRUSTED_SYSTEM_RULE` is appended unconditionally, so the rule that gives
 * the delimiters their meaning can never be omitted by a caller.
 */
export function assemblePrompt(parts: PromptParts): AssembledPrompt {
  return {
    system: `${parts.system}\n\n${UNTRUSTED_SYSTEM_RULE}`,
    prompt: `${parts.wrappedContent.text}${parts.instructions ? `\n\n${parts.instructions}` : ''}`,
  };
}
