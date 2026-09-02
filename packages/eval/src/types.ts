/**
 * Eval fixture schema and hand-rolled validator.
 *
 * Shape follows design doc §10 ("Evaluation Harness"), which is the source of truth:
 *
 * ```json
 * { "id": "eng-mgr-vacation-01",
 *   "persona": "eng_manager",
 *   "window": { "start": "...", "end": "..." },
 *   "events": [ /* synthetic Slack + Gmail events *\/ ],
 *   "ground_truth": {
 *     "pending_items": [ { "description": "...", "citation": "..." } ],
 *     "acceptable_briefings": [ "..." ] },
 *   "failure_mode_tags": ["missed_pending_item"] }
 * ```
 *
 * Two additions to that literal shape, both required by the Task 2.7 spec:
 *   - `description` (top level): a human-readable statement of what the fixture is testing.
 *   - `ground_truth.expect_no_pending`: the explicit negative label, so "no pending items"
 *     is an assertion rather than an omission. See {@link validateFixture}.
 *
 * This module is deliberately dependency-free — a hand-rolled validator is cheaper than a
 * schema library for a handful of fixtures, and `packages/eval` needs no shared types yet.
 * Phase 5 (Task 5.1) builds the actual harness on top of these types.
 */

/** Ingestion sources in POC scope (D-2). */
export type EvalSource = 'slack' | 'gmail';

/**
 * The full failure-mode taxonomy from design §10 / §7.5.
 *
 * All eight exist from day one so tags are never retrofitted onto old fixtures.
 */
export const FAILURE_MODE_TAGS = [
  'missed_pending_item',
  'false_pending_item',
  'fabricated_claim',
  'wrong_citation',
  'poor_ranking',
  'bad_style',
  'refusal',
  'prompt_injection_misbehavior',
] as const;

export type FailureModeTag = (typeof FAILURE_MODE_TAGS)[number];

/**
 * The subset of the taxonomy that the committed fixture set must always cover — one
 * fixture minimum per tag, per Task 2.7.
 *
 * All eight tags have fixtures as of Task 5.2, but this list is deliberately still the
 * five: it is a floor on what may never be deleted, not a description of current coverage.
 * `poor_ranking`, `bad_style` and `refusal` are scored by eyeball review rather than by the
 * numeric metrics, so losing their last fixture is a smaller regression than losing the last
 * example of a metric-bearing category. Current per-tag counts live in
 * `fixtures/README.md`.
 */
export const REQUIRED_FAILURE_MODE_TAGS = [
  'missed_pending_item',
  'false_pending_item',
  'fabricated_claim',
  'wrong_citation',
  'prompt_injection_misbehavior',
] as const satisfies readonly FailureModeTag[];

/**
 * A single synthetic message in a fixture scenario.
 *
 * This is the *normalized* Event shape (post-§6.3 normalizer), not a raw Slack/Gmail API
 * payload: fixtures are hand-authored and must stay readable enough that a human can check
 * the ground truth by eye. The harness maps these onto the `events` table (§4.2) when it
 * seeds a temp database. Timestamps are ISO 8601 strings rather than epoch ms for the same
 * readability reason; the harness converts.
 */
export interface EvalEvent {
  /** Stable synthetic id, unique within the fixture. */
  event_id: string;
  source: EvalSource;
  /** slack: `channel:thread_ts` · gmail: `threadId` (§4.2). */
  thread_key: string;
  /** The artifact a ground-truth citation would point at (§4.2 `artifacts.artifact_id`). */
  artifact_id: string;
  /** Display name of the sender. Fully synthetic — no real people. */
  actor: string;
  /** True when the sender is the briefing's owner (`people.is_self`). */
  actor_is_self?: boolean;
  /** ISO 8601 UTC instant the message was sent. */
  occurred_at: string;
  /** Slack channel name or Gmail subject line, for human readability. */
  context_label?: string;
  /** Message body, already redacted, as Layer 1 would see it. */
  text: string;
}

/** One ground-truth pending item: what a correct system must surface, and from where. */
export interface EvalPendingItem {
  /** What the user is on the hook for, in plain language. Matched fuzzily by the harness. */
  description: string;
  /** `artifact_id` of the message that supports it. Matched **strictly** by the harness. */
  citation: string;
}

/** The labeled correct answer for a fixture. */
export interface EvalGroundTruth {
  /** Pending items a correct system must surface. Omit (or leave empty) with `expect_no_pending`. */
  pending_items?: EvalPendingItem[];
  /**
   * Explicit negative label: this scenario legitimately has nothing waiting on the user.
   * Required when `pending_items` is absent, so a missing label can never be mistaken for
   * a deliberate one.
   */
  expect_no_pending?: boolean;
  /** Human-acceptable briefing texts (design §10). Free-form; used for eyeball review. */
  acceptable_briefings?: string[];
  /** Claims the source content actually supports — a fabricated claim is anything beyond these. */
  supported_claims?: string[];
  /** Plausible-sounding claims the content does **not** support. Emitting one is a failure. */
  unsupported_claims?: string[];
  /** Prose explanation of why this is the correct answer, for the human labeler/reviewer. */
  notes?: string;
}

/**
 * One labeled eval example. One JSON file per fixture in `packages/eval/fixtures/`.
 *
 * The index signature is intentional: fixtures may carry scenario-specific fields (e.g.
 * injection-defense metadata) without a schema change, and unknown keys are ignored rather
 * than rejected by {@link validateFixture}.
 */
export interface EvalFixture {
  /** Matches the filename stem, e.g. `eng-mgr-vacation-01`. */
  id: string;
  /** One line: what failure this fixture is designed to catch. */
  description: string;
  /** e.g. `eng_manager`, `pm` (design §10, Task 5.2 persona axis). */
  persona: string;
  /** The briefing window the events fall inside. ISO 8601. */
  window: { start: string; end: string };
  events: EvalEvent[];
  ground_truth: EvalGroundTruth;
  /** At least one entry, drawn from {@link FAILURE_MODE_TAGS}. */
  failure_mode_tags: FailureModeTag[];
  [key: string]: unknown;
}

/** Result of {@link validateFixture}. `errors` is empty iff `valid` is true. */
export interface FixtureValidationResult {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate an unknown parsed JSON value against the fixture schema.
 *
 * Enforced rules (Task 2.7):
 *  - `id`, `description`, `persona` are non-empty strings; `window.start`/`window.end` are
 *    non-empty strings; `events` is a non-empty array of well-formed events.
 *  - `failure_mode_tags` is a string array with length >= 1, every entry a known tag.
 *  - **Exactly one** ground-truth stance: either `ground_truth.pending_items` has >= 1 entry,
 *    or `ground_truth.expect_no_pending === true`. Never neither (an unlabeled fixture is
 *    worthless to the harness) and never both (contradictory).
 *  - Every pending-item `citation` resolves to an `artifact_id` present in `events`, so a
 *    fixture cannot ship a citation that points nowhere — the same integrity property §4.2
 *    enforces with a foreign key at runtime.
 *
 * All errors are collected rather than thrown on the first failure, so a bad fixture reports
 * everything wrong with it in one pass.
 */
export function validateFixture(fixture: unknown): FixtureValidationResult {
  const errors: string[] = [];

  if (!isRecord(fixture)) {
    return { valid: false, errors: ['fixture must be a JSON object'] };
  }

  if (!isNonEmptyString(fixture['id'])) {
    errors.push('id: must be a non-empty string');
  }
  if (!isNonEmptyString(fixture['description'])) {
    errors.push('description: must be a non-empty string');
  }
  if (!isNonEmptyString(fixture['persona'])) {
    errors.push('persona: must be a non-empty string');
  }

  const window = fixture['window'];
  if (!isRecord(window)) {
    errors.push('window: must be an object with start and end');
  } else {
    if (!isNonEmptyString(window['start'])) errors.push('window.start: must be a non-empty string');
    if (!isNonEmptyString(window['end'])) errors.push('window.end: must be a non-empty string');
  }

  // ---- events -------------------------------------------------------------
  const artifactIds = new Set<string>();
  const events = fixture['events'];
  if (!Array.isArray(events)) {
    errors.push('events: must be an array');
  } else if (events.length === 0) {
    errors.push('events: must contain at least one event');
  } else {
    events.forEach((event, index) => {
      if (!isRecord(event)) {
        errors.push(`events[${index}]: must be an object`);
        return;
      }
      for (const field of ['event_id', 'thread_key', 'artifact_id', 'actor', 'occurred_at', 'text']) {
        if (!isNonEmptyString(event[field])) {
          errors.push(`events[${index}].${field}: must be a non-empty string`);
        }
      }
      if (event['source'] !== 'slack' && event['source'] !== 'gmail') {
        errors.push(`events[${index}].source: must be 'slack' or 'gmail'`);
      }
      const artifactId = event['artifact_id'];
      if (typeof artifactId === 'string') artifactIds.add(artifactId);
    });
  }

  // ---- failure_mode_tags --------------------------------------------------
  const tags = fixture['failure_mode_tags'];
  if (!Array.isArray(tags)) {
    errors.push('failure_mode_tags: must be an array');
  } else if (tags.length === 0) {
    errors.push('failure_mode_tags: must contain at least one tag');
  } else {
    tags.forEach((tag, index) => {
      if (typeof tag !== 'string') {
        errors.push(`failure_mode_tags[${index}]: must be a string`);
        return;
      }
      if (!(FAILURE_MODE_TAGS as readonly string[]).includes(tag)) {
        errors.push(
          `failure_mode_tags[${index}]: unknown tag '${tag}' (expected one of: ${FAILURE_MODE_TAGS.join(', ')})`,
        );
      }
    });
  }

  // ---- ground_truth -------------------------------------------------------
  const groundTruth = fixture['ground_truth'];
  if (!isRecord(groundTruth)) {
    errors.push('ground_truth: must be an object');
    return { valid: false, errors };
  }

  const pendingItems = groundTruth['pending_items'];
  const expectNoPending = groundTruth['expect_no_pending'];
  let pendingCount = 0;

  if (pendingItems !== undefined) {
    if (!Array.isArray(pendingItems)) {
      errors.push('ground_truth.pending_items: must be an array when present');
    } else {
      pendingCount = pendingItems.length;
      pendingItems.forEach((item, index) => {
        if (!isRecord(item)) {
          errors.push(`ground_truth.pending_items[${index}]: must be an object`);
          return;
        }
        if (!isNonEmptyString(item['description'])) {
          errors.push(`ground_truth.pending_items[${index}].description: must be a non-empty string`);
        }
        const citation = item['citation'];
        if (!isNonEmptyString(citation)) {
          errors.push(`ground_truth.pending_items[${index}].citation: must be a non-empty string`);
        } else if (artifactIds.size > 0 && !artifactIds.has(citation)) {
          errors.push(
            `ground_truth.pending_items[${index}].citation: '${citation}' does not match any events[].artifact_id`,
          );
        }
      });
    }
  }

  if (expectNoPending !== undefined && typeof expectNoPending !== 'boolean') {
    errors.push('ground_truth.expect_no_pending: must be a boolean when present');
  }

  if (pendingCount === 0 && expectNoPending !== true) {
    errors.push(
      'ground_truth: must declare either at least one pending_items entry or expect_no_pending: true — an unlabeled fixture cannot be scored',
    );
  }
  if (pendingCount > 0 && expectNoPending === true) {
    errors.push(
      'ground_truth: expect_no_pending: true contradicts a non-empty pending_items — pick one',
    );
  }

  for (const field of ['acceptable_briefings', 'supported_claims', 'unsupported_claims'] as const) {
    const value = groundTruth[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
      errors.push(`ground_truth.${field}: must be an array of non-empty strings when present`);
    }
  }

  return { valid: errors.length === 0, errors };
}
