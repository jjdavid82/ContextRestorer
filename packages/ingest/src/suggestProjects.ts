/**
 * Assisted onboarding — project candidate suggestion (Task 3.1, OI-3).
 *
 * Onboarding asks the user to declare at least three projects. Asking that of a
 * blank text box is the fastest way to get three useless answers, so this module
 * mines the events already ingested and proposes the groups the user *actually*
 * spends their own keystrokes in. The output is a suggestion list, never a
 * decision: X-2 still holds — nothing here writes a project, and every candidate
 * is editable (or ignorable) in the UI.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CANDIDATE NAMES COME FROM
 * ---------------------------------------------------------------------------
 * A persisted `Event` (see `@cr/core`) is deliberately thin: `source`,
 * `threadKey`, `actorId`, `occurredAt` and an opaque connector-shaped `payload`.
 * There is no `channelName` column and no `label` column, so the "channel name /
 * label / subject" this function groups by has to be *derived*. The resolution
 * order below is layered so it uses the richest thing available today and lights
 * up automatically as the connectors start persisting more:
 *
 *   Slack
 *     1. `payload.channelName` / `payload.channel_name` — a human channel name,
 *        if a connector ever records one.
 *     2. `payload.channel`, when it is not an opaque Slack id.
 *     3. the channel segment of `threadKey`. `slackThreadKey()` builds
 *        `${channelId}:${thread_ts}`, so everything before the FIRST `:` is the
 *        channel. Today that is a raw id (`C08ABCDEF`) — see the opacity rule.
 *
 *   Gmail
 *     1. `payload.labelName` / `payload.label`.
 *     2. `payload.labelIds` / `payload.labels` — first non-system label
 *        (`normalizeGmail` already reads `labelIds` off the wire, so this is the
 *        field a follow-up task would persist).
 *     3. `payload.subject`, with `Re:` / `Fwd:` prefixes stripped — the
 *        "frequent thread subject" signal.
 *     Gmail's `threadKey` is deliberately NOT a fallback: it is an opaque
 *     RFC-822 thread id, which is not a project name a human can recognise.
 *
 * OPACITY RULE. A candidate whose only available name is an opaque provider id
 * (`C08ABCDEF`, a Gmail thread id) is dropped rather than shown. A checkbox
 * labelled `C08ABCDEF` cannot be evaluated by the user, and a project declared
 * under that name would be equally unreadable everywhere it later appears. The
 * documented empty-state — return `[]`, let the UI fall back to free text — is
 * the honest outcome, and the candidate appears for real the moment channel
 * metadata is ingested.
 *
 * ---------------------------------------------------------------------------
 * RANKING
 * ---------------------------------------------------------------------------
 * By the user's OWN participation volume: the number of events in the group with
 * `actorId === selfPersonId`. Volume of *other people's* traffic is a measure of
 * how noisy a channel is, not of how much the user has at stake in it — ranking
 * by it would put `#deploys` above the channel where the user argues about the
 * thing they own. Groups the user has never posted in score zero and are dropped
 * outright: there is no truthful `reason` to render for them.
 */

import type { Event } from '@cr/core';
import type { EventsRepo } from '@cr/store';

/** One suggested project, with the evidence that produced it. */
export interface ProjectCandidate {
  /** Display name, e.g. `#api-redesign` or `Q3 Migration`. Editable in the UI. */
  name: string;
  source: 'slack' | 'gmail';
  /**
   * Self-participation count — the same number quoted in `reason`, so the badge
   * the UI renders and the sentence beside it can never disagree.
   */
  evidenceCount: number;
  /** Human-readable justification, e.g. `you posted 23 times in #api-redesign`. */
  reason: string;
}

/** Hard cap on the returned list. A wall of checkboxes is not a choice (OI-3). */
const MAX_CANDIDATES = 12;

/**
 * Slack channels that exist in every workspace and belong to no project.
 * Matched case-insensitively, with or without the leading `#`.
 */
const GENERIC_SLACK_CHANNELS: ReadonlySet<string> = new Set(['general', 'random']);

/**
 * Gmail system labels. These are mailbox mechanics, not projects.
 * `CATEGORY_*` is matched by prefix so new Google categories are covered too.
 */
const GMAIL_SYSTEM_LABELS: ReadonlySet<string> = new Set([
  'INBOX',
  'SPAM',
  'TRASH',
  'SENT',
  'DRAFT',
  'DRAFTS',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'CHAT',
]);

/** Prefix form of the Gmail system-label rule (`CATEGORY_PROMOTIONS`, …). */
const GMAIL_CATEGORY_PREFIX = 'CATEGORY_';

/**
 * An opaque Slack conversation id: `C…` public channel, `G…` private group,
 * `D…` direct message, followed by uppercase alphanumerics. Slack channel *names*
 * are lowercase and may contain `-`/`_`, so they never match this.
 */
const OPAQUE_SLACK_ID = /^[CGD][A-Z0-9]{6,}$/;

/** Leading `Re:` / `Fwd:` / `Fw:` chains on a mail subject. */
const SUBJECT_PREFIX = /^\s*(?:re|fwd?|aw|sv)\s*(?:\[\d+\])?\s*:\s*/i;

/** Read `key` off an event payload, but only when it is a usable string. */
function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Read `key` off an event payload as an array of non-empty strings. */
function payloadStrings(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** True for `INBOX`, `SPAM`, `CATEGORY_PROMOTIONS`, … Case-insensitive. */
export function isGmailSystemLabel(label: string): boolean {
  const upper = label.trim().toUpperCase();
  return upper.startsWith(GMAIL_CATEGORY_PREFIX) || GMAIL_SYSTEM_LABELS.has(upper);
}

/** True for `#general` / `general` / `General`, and `#random` likewise. */
export function isGenericSlackChannel(channel: string): boolean {
  return GENERIC_SLACK_CHANNELS.has(channel.trim().replace(/^#+/, '').toLowerCase());
}

/** `Re: Fwd: Q3 migration` → `Q3 migration`. Repeated prefixes are all stripped. */
export function normalizeSubject(subject: string): string {
  let text = subject.trim();
  // Bounded: a pathological `Re: Re: Re: …` subject must not spin here.
  for (let i = 0; i < 8 && SUBJECT_PREFIX.test(text); i += 1) {
    text = text.replace(SUBJECT_PREFIX, '').trim();
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** The grouping an event contributes to: a stable key plus its display form. */
interface Grouping {
  /** Case-folded key used for grouping and exclusion checks. */
  key: string;
  /** What the user sees — `#channel` for Slack, the label/subject for Gmail. */
  display: string;
}

/** Slack: resolve a channel name, or `null` when only an opaque id exists. */
function slackGrouping(event: Event): Grouping | null {
  const explicit =
    payloadString(event.payload, 'channelName') ?? payloadString(event.payload, 'channel_name');

  const fromChannelField = payloadString(event.payload, 'channel');
  // `threadKey` is `${channelId}:${thread_ts}` — the channel is everything
  // before the first colon. `split(':')[0]` on a colon-less key yields the key
  // itself, which is the right degradation.
  const fromThreadKey = event.threadKey.split(':')[0]?.trim();

  const raw = explicit ?? fromChannelField ?? fromThreadKey ?? '';
  const name = raw.replace(/^#+/, '').trim();
  if (name === '') return null;
  // OPACITY RULE — a bare Slack id is not a name the user can act on.
  if (OPAQUE_SLACK_ID.test(name)) return null;

  return { key: name.toLowerCase(), display: `#${name}` };
}

/** Gmail: resolve a user label or a thread subject, or `null` when neither exists. */
function gmailGrouping(event: Event): Grouping | null {
  const explicitLabel =
    payloadString(event.payload, 'labelName') ?? payloadString(event.payload, 'label');
  if (explicitLabel !== undefined) {
    // Returned even when it is a system label; the caller's exclusion check
    // rejects it, so `INBOX` never silently falls through to the subject.
    return { key: explicitLabel.toLowerCase(), display: explicitLabel };
  }

  const labels = [
    ...payloadStrings(event.payload, 'labelIds'),
    ...payloadStrings(event.payload, 'labels'),
  ];
  if (labels.length > 0) {
    const userLabel = labels.find((label) => !isGmailSystemLabel(label));
    // All-system labels (`['INBOX','CATEGORY_UPDATES']`) mean "no project here";
    // falling through to the subject would resurrect exactly what was excluded.
    if (userLabel === undefined) return null;
    return { key: userLabel.toLowerCase(), display: userLabel };
  }

  const subject = payloadString(event.payload, 'subject');
  if (subject === undefined) return null;
  const normalized = normalizeSubject(subject);
  if (normalized === '') return null;

  return { key: normalized.toLowerCase(), display: normalized };
}

/** The (source, name) group an event belongs to, or `null` when unnameable. */
function groupingFor(event: Event): Grouping | null {
  const grouping = event.source === 'slack' ? slackGrouping(event) : gmailGrouping(event);
  if (grouping === null) return null;

  const excluded =
    event.source === 'slack'
      ? isGenericSlackChannel(grouping.key)
      : isGmailSystemLabel(grouping.key);

  return excluded ? null : grouping;
}

/** `you posted 23 times in #api-redesign` (and `1 time`, not `1 times`). */
function reasonFor(count: number, display: string): string {
  return `you posted ${count} ${count === 1 ? 'time' : 'times'} in ${display}`;
}

/** Mutable accumulator, one per `(source, key)` pair. */
interface Bucket {
  source: 'slack' | 'gmail';
  display: string;
  count: number;
}

/**
 * Suggest projects to declare, ranked by how much the user participates in them.
 *
 * Read-only: touches nothing but the `events` table, and writes nothing at all.
 *
 * @param events Repository over the ingested event log.
 * @param selfPersonId The `actorId` that identifies the user in ingested events.
 *   An empty id yields `[]` — with no way to tell the user's messages from
 *   everyone else's there is no ranking signal, and `actorId === ''` is exactly
 *   how an *unattributed* event is stored, so matching on it would rank bot
 *   traffic as the user's own work.
 * @returns At most {@link MAX_CANDIDATES} candidates, highest participation
 *   first, ties broken by name for a stable list. `[]` when nothing has been
 *   ingested yet — the caller falls back to free-text entry. Never throws for
 *   want of data.
 */
export function suggestProjects(events: EventsRepo, selfPersonId: string): ProjectCandidate[] {
  if (selfPersonId.trim() === '') return [];

  // `EventsRepo` exposes no "all events" read; the widest half-open window is
  // the whole history. Onboarding runs once, over a bounded first sync, so the
  // full scan is cheap and beats adding a read method for a single caller.
  const all = events.listWindow(0, Number.MAX_SAFE_INTEGER);
  if (all.length === 0) return [];

  const buckets = new Map<string, Bucket>();

  for (const event of all) {
    // Ranking is self-participation only, so non-self events cannot create a
    // bucket either: a group the user has never posted in scores 0 and would be
    // dropped below regardless.
    if (event.actorId !== selfPersonId) continue;

    const grouping = groupingFor(event);
    if (grouping === null) continue;

    const bucketKey = `${event.source} ${grouping.key}`;
    const existing = buckets.get(bucketKey);
    if (existing === undefined) {
      buckets.set(bucketKey, { source: event.source, display: grouping.display, count: 1 });
    } else {
      existing.count += 1;
    }
  }

  return [...buckets.values()]
    .sort((a, b) => (b.count - a.count) || (a.display < b.display ? -1 : a.display > b.display ? 1 : 0))
    .slice(0, MAX_CANDIDATES)
    .map((bucket) => ({
      name: bucket.display,
      source: bucket.source,
      evidenceCount: bucket.count,
      reason: reasonFor(bucket.count, bucket.display),
    }));
}
