import { createHash } from 'node:crypto';

/**
 * SEC-7 — PII must never reach a log sink in raw form.
 *
 * This is deliberately a *narrow* filter, not a general PII classifier:
 * three explicit rules, each cheap enough to run on every log line.
 *
 *   1. Email-shaped substrings are replaced by a stable sha256 digest.
 *   2. Keys on the drop-list (`messageBody`, `text`, `payload_json`) are removed
 *      outright — free-text bodies are unclassifiable, so they are never logged.
 *   3. `person_id` / `personId` values are replaced by a stable sha256 digest,
 *      so log lines remain correlatable without carrying the identifier itself.
 *
 * Everything else passes through byte-for-byte unchanged. A broader heuristic
 * would produce false positives on ids, model names and file paths, which makes
 * logs useless — the drop-list exists precisely so the risky fields never need
 * to be guessed at.
 */

/** Hashing matches the codebase convention in `@cr/core`'s `ids.ts`. */
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Deliberately loose email shape: local@domain.tld. It over-matches slightly
 * (a stray `a@b.co` inside a URL is redacted too) which is the correct failure
 * direction for a redaction filter.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Keys whose values are free text and therefore never safe to log. */
const DROP_KEYS: ReadonlySet<string> = new Set(['messageBody', 'text', 'payload_json']);

/** Keys holding a person identifier — hashed, not dropped, to keep correlation. */
const PERSON_KEYS: ReadonlySet<string> = new Set(['person_id', 'personId']);

/**
 * Stable digest for an email address. Lower-cased first so that
 * `Bob@Example.com` and `bob@example.com` collapse to the same token, and
 * domain-separated so an email digest can never collide with a person digest.
 */
export const hashEmail = (email: string): string => sha256(`email|${email.toLowerCase()}`);

/** Stable digest for a person id. Deterministic across calls and processes. */
export const hashPersonId = (personId: string): string => sha256(`person|${personId}`);

/** Replace every email-shaped substring in `value` with its stable digest. */
const redactEmails = (value: string): string => value.replace(EMAIL_RE, (m) => hashEmail(m));

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Applies the email rule to strings and recurses through arrays/objects. */
function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return redactEmails(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (isPlainObject(value)) return scrubObject(value);
  return value;
}

function scrubObject(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    // Rule 2 wins over everything else: the key never appears in the output.
    if (DROP_KEYS.has(key)) continue;

    // Rule 3: hash the id regardless of its shape (numeric ids included).
    if (PERSON_KEYS.has(key)) {
      out[key] = value === null || value === undefined ? value : hashPersonId(String(value));
      continue;
    }

    // Rule 1 (recursively, so a nested body can't smuggle an address through).
    out[key] = scrubValue(value);
  }

  return out;
}

/**
 * Returns a copy of `fields` safe to hand to a log sink. The input object is
 * never mutated.
 */
export function safeLog(fields: Record<string, unknown>): Record<string, unknown> {
  return scrubObject(fields);
}
