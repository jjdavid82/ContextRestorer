/**
 * The "Brief me on what I missed" lookback start — shared between the Home
 * page (which only ever READS it, at the moment the button is clicked) and
 * the Settings page (which owns the control that edits it).
 *
 * There is no separate "To" — the window always runs through "now", computed
 * fresh at request time, never stored. A saved end time would go stale the
 * moment the user closed the app, and "how far back" is the only question
 * this control actually answers.
 *
 * Persisted in `localStorage`, not `sessionStorage`: this is a preference
 * ("how far back do I usually want to look"), not per-session UI state, so it
 * must survive a full app restart the same way the model picker and the
 * recurrence schedule do.
 */

/** Default lookback when nothing has been saved yet — the common case, not a cap. */
export const DEFAULT_BRIEFING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Lookback for a user who has never tapped "I'm caught up" (F-2).
 *
 * Deliberately much shorter than {@link DEFAULT_BRIEFING_WINDOW_MS}: that value
 * is the *manual override's* default, chosen when the only way to answer "how
 * far back?" was a date the user typed once and never revisited, so it had to be
 * generous. The resume path re-answers that question on every press, and the
 * honest first-run answer is "roughly a day" — not "everything in the last
 * month," which on a first run is a briefing nobody reads.
 */
export const FIRST_RUN_BRIEFING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A half-open `[windowStart, windowEnd)` in epoch ms. */
export interface ResolvedWindow {
  windowStart: number;
  windowEnd: number;
}

/**
 * The window "Brief me on what I missed" should actually use (F-2).
 *
 * Precedence, highest first:
 *
 *   1. `override` — a start the user explicitly set in Settings. Still honoured,
 *      because "show me further back than where I left off" is a real request.
 *   2. `resumeFrom` — `window_end` of the furthest-forward briefing they
 *      acknowledged, from `briefing:resumePoint`.
 *   3. {@link FIRST_RUN_BRIEFING_WINDOW_MS} before now.
 *
 * A `resumeFrom` at or after `now` (clock skew, or a briefing whose window ended
 * in the future) falls through to the first-run default rather than producing an
 * empty or inverted window.
 *
 * `windowEnd` is always "now", computed by the caller and passed in, so this
 * function stays pure and testable.
 */
export function resolveBriefingWindow(input: {
  now: number;
  resumeFrom: number | null;
  override?: number | undefined;
}): ResolvedWindow {
  const { now, resumeFrom, override } = input;

  if (override !== undefined && Number.isFinite(override) && override < now) {
    return { windowStart: override, windowEnd: now };
  }

  if (resumeFrom !== null && Number.isFinite(resumeFrom) && resumeFrom < now) {
    return { windowStart: resumeFrom, windowEnd: now };
  }

  return { windowStart: now - FIRST_RUN_BRIEFING_WINDOW_MS, windowEnd: now };
}

const STORAGE_KEY = 'cr:briefing-window-start';

/**
 * `Date` -> the local-time string `<input type="datetime-local">` expects
 * ("YYYY-MM-DDTHH:mm"). `toISOString()` is UTC and would silently shift the
 * displayed value across a timezone offset, so this builds the string from
 * the `Date`'s local getters instead.
 */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** "Now" back to `DEFAULT_BRIEFING_WINDOW_MS` ago — computed fresh, never cached. */
export function defaultBriefingWindowStart(): string {
  return toLocalInputValue(new Date(Date.now() - DEFAULT_BRIEFING_WINDOW_MS));
}

/**
 * The saved override, or `null` when the user has never set one (F-2).
 *
 * Distinct from {@link readBriefingWindowStart}, which substitutes a default and
 * therefore cannot tell "the user asked for 30 days" apart from "the user has
 * never touched this." That distinction is the whole precedence rule in
 * {@link resolveBriefingWindow}: only a real, explicit override outranks the
 * resume point.
 */
export function readSavedBriefingWindowStart(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw !== null && raw !== '' ? raw : null;
  } catch {
    return null;
  }
}

/** Forget the override, returning the button to the resume-point default. */
export function clearBriefingWindowStart(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort, same as the writer.
  }
}

/** The saved start, or the default when nothing was saved, storage is disabled, or it is malformed. */
export function readBriefingWindowStart(): string {
  // Same guard `lib/bridge.ts`'s `hasBridge()` uses: this can run during the
  // static export build, where there is no `window` (and no `localStorage`).
  if (typeof window === 'undefined') return defaultBriefingWindowStart();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw !== null && raw !== '' ? raw : defaultBriefingWindowStart();
  } catch {
    return defaultBriefingWindowStart();
  }
}

/** Best-effort: a disabled or full store just means the next read falls back to the default. */
export function writeBriefingWindowStart(value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Ignored — see doc comment above.
  }
}

/**
 * Validate the start-picker string into a window running through now, or
 * `null` with a reason. `<input type="datetime-local">` reports local time
 * with no timezone designator, which `new Date(...)` parses as local time
 * too — the same convention `toLocalInputValue` writes in, so the round trip
 * is exact.
 */
export function parseWindowStart(
  startInput: string,
): { window: { windowStart: number; windowEnd: number } } | { error: string } {
  const windowStart = new Date(startInput).getTime();
  const windowEnd = Date.now();
  if (!Number.isFinite(windowStart)) {
    return { error: 'pick a start date/time first' };
  }
  if (windowStart >= windowEnd) {
    return { error: 'the start must be before now' };
  }
  return { window: { windowStart, windowEnd } };
}
