import { DETECTORS, OUTPUT_DETECTORS, type Detector, type RedactionKind } from './detectors.js';

/**
 * SEC-4 / SEC-5 — the redaction pass itself.
 *
 * `redact()` is on the ingestion critical path: every event body passes through
 * it before anything is written to SQLite, so a secret that reaches this
 * function must not reach the database. `redactOutput()` is the mirror pass run
 * by the citation gate on generated text.
 *
 * Both are pure, synchronous and allocation-light: a single `String.replace`
 * per rule over the working text, no I/O, no async.
 */

/** Outcome of a redaction pass. `text` is always safe to persist or display. */
export interface RedactionResult {
  /** The input with every detected secret replaced by `[REDACTED:<kind>]`. */
  text: string;
  /** Total number of replacements made. `0` means the input was untouched. */
  count: number;
  /** Distinct kinds detected, in detector order. Safe to log and to show a user. */
  kinds: string[];
}

/** Mutable accumulator threaded through the detector loop. */
interface Tally {
  count: number;
  kinds: Set<RedactionKind>;
}

/**
 * Apply one detector to `text`. Matches whose `replace` returns `null` are left
 * untouched and are not counted — that is how already-redacted placeholders
 * survive a second pass unchanged (idempotency).
 */
function applyDetector(text: string, detector: Detector, tally: Tally): string {
  // `String.replace` with a global regexp resets `lastIndex` itself, but the
  // rule table is module-level shared state, so be explicit about it.
  detector.pattern.lastIndex = 0;

  return text.replace(detector.pattern, (...args: unknown[]): string => {
    const match = String(args[0]);
    // Trailing two arguments are `offset` and the whole string; everything
    // between the match and those is a capture group.
    const groups = args
      .slice(1, -2)
      .map((group) => (typeof group === 'string' ? group : undefined));

    const replacement = detector.replace(match, groups);
    if (replacement === null) return match;

    tally.count += 1;
    tally.kinds.add(detector.kind);
    return replacement;
  });
}

/** Run a rule table over `input`, in order, feeding each rule the previous output. */
function run(input: string, detectors: readonly Detector[]): RedactionResult {
  const tally: Tally = { count: 0, kinds: new Set<RedactionKind>() };

  let text = input;
  for (const detector of detectors) {
    text = applyDetector(text, detector, tally);
  }

  return { text, count: tally.count, kinds: [...tally.kinds] };
}

/**
 * SEC-4 — input-side scan. Called on every ingested event body before it is
 * persisted; secrets are replaced by typed placeholders so the model can still
 * reason about the fact that a credential was shared without ever seeing it.
 *
 * Idempotent: `redact(redact(x).text).text === redact(x).text`.
 */
export function redact(input: string): RedactionResult {
  return run(input, DETECTORS);
}

/**
 * SEC-5 — output-side scan, used by the citation gate. Same detector set as
 * `redact()` plus PII (email addresses and phone numbers), because generated
 * text can surface contact details that were legitimately stored on the input
 * side.
 *
 * PII here means CONTACT IDENTIFIERS, not people. Display names are explicitly
 * NOT redacted: "Priya asked for the migration plan" is the substance of a
 * briefing, and a redactor that eats names produces a product nobody can read.
 *
 * Pure and deterministic — same input, same output, every time. The briefing
 * generator relies on that: it runs the citation gate twice per claim (once for
 * the streaming path, once for the persistence path), and identical redaction on
 * both is what keeps the rendered claim and the stored claim byte-identical.
 *
 * Idempotent: `redactOutput(redactOutput(x).text).text === redactOutput(x).text`.
 */
export function redactOutput(input: string): RedactionResult {
  return run(input, OUTPUT_DETECTORS);
}
