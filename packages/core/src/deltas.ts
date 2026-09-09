/**
 * Shared vocabulary for the `state_deltas` chain, used by both the Electron
 * main process (which appends a delta when the user marks an obligation done)
 * and `@cr/ai`'s Layer 3 (which must not narrate that delta back at them).
 *
 * These live in `@cr/core` for the same reason `text.ts` does: two packages
 * have to agree on one value. `apps/desktop`'s `briefing:resolvePending`
 * handler writes a `resolution` delta stamped with {@link MANUAL_RESOLVE_MODEL}
 * / {@link MANUAL_RESOLVE_PROMPT_VERSION}; Layer 3's briefing read filters those
 * exact deltas out via {@link isUserActionDelta}. If the sentinel and the
 * filter drifted apart, a manually-resolved obligation would silently start
 * reappearing in the briefing narrative again — the bug this pairing exists to
 * prevent.
 */

import type { StateDelta } from './types.js';

/**
 * `state_deltas.model` for a delta a person authored by clicking, not a model.
 *
 * `state_deltas.model` is `TEXT NOT NULL`, so a user action still needs a
 * value there; this sentinel is one that cannot be mistaken for a real model
 * name in the AI-call audit or a latency dashboard.
 */
export const MANUAL_RESOLVE_MODEL = 'none:user-action';

/** `state_deltas.prompt_version` for the "Mark resolved" delta. There is no
 *  prompt — there is a UI action version. */
export const MANUAL_RESOLVE_PROMPT_VERSION = 'user-resolve.v1';

/**
 * True when a delta was written by a user action ("Mark resolved") rather than
 * synthesized by Layer 2.
 *
 * Such a delta exists only to move its thread's supersedes-chain tip past an
 * obligation so the obligation stops being restated as a live request. It is
 * never briefing *content*: the user performed the action, so narrating "you
 * marked this done" back to them on every briefing until it ages out of the
 * lookback window is pure noise. Layer 3 drops these before ranking; the
 * superseding effect on `current_state_deltas` is unaffected because the row
 * itself stays on disk.
 *
 * Keyed on `model` alone: every user-authored delta carries
 * {@link MANUAL_RESOLVE_MODEL}, and none of them should ever reach a briefing.
 * A Layer 2 `resolution` delta (a real reply closed the thread) carries a genuine
 * model name, returns `false` here, and keeps flowing through "Quietly resolved".
 */
export function isUserActionDelta(delta: Pick<StateDelta, 'model'>): boolean {
  return delta.model === MANUAL_RESOLVE_MODEL;
}
