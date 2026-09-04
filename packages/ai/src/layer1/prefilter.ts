/**
 * Layer 1 — the deterministic pre-filter (P3, F-1).
 *
 * ### The problem this exists to shrink
 *
 * Layer 1 is one LLM call per event. The 2026-09-03 benchmark measured **~29s
 * per call** on `qwen2.5:7b` (24 calls in 710s), which puts a 3,000-event
 * corpus at roughly a day of local inference — the bench report's own note that
 * extracting a full corpus "would be weeks" on 14b, restated at the smaller
 * model. That cost is why the benchmark extracted 24 of 3,000 events, and why
 * every quality number in the eval was measured against a pipeline whose first
 * stage was mostly skipped.
 *
 * ### Why this particular filter is safe
 *
 * It invents no new judgement. Both connectors ALREADY classify structural
 * noise at ingest, deterministically and conservatively:
 *
 * - Slack (`isSlackNoiseCandidate`): messages with a `bot_id`, and the
 *   join/leave/topic/purpose/name/archive subtypes.
 * - Gmail (`normalizeGmail`): promotional/spam labels, a `List-Unsubscribe`
 *   header, or a `no-reply@`-shaped sender.
 *
 * That flag has been written into `payload.isNoiseCandidate` on every ingested
 * event since the connectors were built — and **never read by anything**. Layer
 * 1's own prompt already offers `noise` as one of its four classes and
 * describes it as "social chatter, acknowledgements, automation, or nothing of
 * substance", which is the same set. So this does not replace a model judgement
 * with a heuristic; it declines to spend 29 seconds asking a model to confirm a
 * label the connector already derived from structure.
 *
 * ### What it deliberately does NOT do
 *
 * - **It does not delete anything.** The event row is untouched and the
 *   `extractions` row is still written, so the event is still replayable, still
 *   counted, and still visible to the eval harness as a negative.
 * - **It does not skip anything ambiguous.** Only the connector's own flag and
 *   a genuinely empty body qualify. A short human message is not noise; a
 *   message the connector did not flag is not noise.
 * - **It does not touch Layer 2 or 3.** A filtered event contributes no chunk,
 *   exactly as a model-classified `noise` event contributes none today.
 */

import type { Event } from '@cr/core';

/** Why an event was pre-filtered. Recorded so the decision is auditable. */
export type PrefilterReason =
  /** The connector flagged it at ingest: bot, system notice, bulk mail. */
  | 'connector_noise'
  /** No body text at all — nothing to classify and nothing to embed. */
  | 'empty_body';

/**
 * The connector's ingest-time noise flag, read back off the payload.
 *
 * Tolerant of absence and of a non-boolean value: the flag is written only when
 * true (`...(isNoiseCandidate ? { isNoiseCandidate: true } : {})`), so "absent"
 * is the overwhelmingly common case and must read as "not noise".
 */
export function connectorFlaggedNoise(event: Event): boolean {
  return event.payload['isNoiseCandidate'] === true;
}

/**
 * The reason to skip the model for this event, or `undefined` to extract it.
 *
 * Order matters only for reporting: an empty-bodied bot message is reported as
 * `connector_noise`, the more specific fact.
 */
export function prefilterReason(event: Event): PrefilterReason | undefined {
  if (connectorFlaggedNoise(event)) return 'connector_noise';

  const text = event.payload['text'];
  if (typeof text !== 'string' || text.trim() === '') return 'empty_body';

  return undefined;
}
