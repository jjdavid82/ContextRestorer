/**
 * `claim:drilldown` main-process handler — the **provenance path** (FR-6).
 *
 * The renderer opens `DrillDownPanel` and asks "where did this claim come from?".
 * The honest answer is the raw, already-redacted source events behind it, each
 * with a link back out to Slack/Gmail. That is what this module returns. Nothing
 * here summarises, re-ranks or re-words anything: a verification surface that
 * paraphrases is not a verification surface.
 *
 * ## The identifier is an ARTIFACT id, not a `briefing_claims.claim_id`
 *
 * This is the single most important thing to know before editing this file.
 *
 * The `briefing:chunk` payload (`ClaimChunk` in `apps/ui/types/bridge.d.ts`,
 * `BriefingChunk` in `src/preload.cts`) carries **no claim row id**. The claim's
 * database id is simply not on the wire today. Task 3.6 therefore made the UI's
 * `claimIdOf()` (in `apps/ui/components/BriefingView.tsx`) return
 * `chunk.citation.artifactId` — the only stable handle the renderer actually
 * has — and that is the value the preload forwards as `{ claimId }`.
 *
 * So: **the string arriving on this channel is an `artifacts.artifact_id`.** That
 * is an interim, deliberately-documented design choice, not a bug to be "fixed"
 * here by guessing at some other identifier. This handler resolves it as an
 * artifact id and says so in its own naming (see {@link ArtifactReader}).
 *
 * When the chunk payload eventually grows a real `claimId`, the change is
 * bounded: `claimIdOf()` in the renderer, and {@link resolveEvents} here, which
 * is why the artifact lookup lives in one function rather than inline. The wire
 * field stays `claimId` either way — it is echoed back verbatim in
 * {@link Drilldown.claimId} so the renderer can correlate a late resolve with
 * the panel that asked for it.
 *
 * ## No "not found" variant exists on the wire
 *
 * `Drilldown` is `{ claimId, events }` and nothing else — there is no `ok`, no
 * `reason`, and no top-level `deepLink` (links are **per event**, as
 * `DrilldownEvent.externalUrl`). An unknown id therefore resolves to
 * `{ claimId, events: [] }` rather than rejecting: `DrillDownPanel` already
 * renders an empty list as "No source events are recorded for this claim", which
 * is both true and readable, whereas a rejected `invoke` reaches the renderer as
 * an opaque `Error invoking remote method …` string with a main-process stack
 * pasted into it. Distinguishing "unknown artifact" from "known artifact, no
 * events" is a job for the main-process log, which is what this module writes
 * to, not for a UI that can do nothing differently with the distinction.
 *
 * ## Secrets
 *
 * Events are redacted at ingest time, inside the connector normalizers, before
 * they are ever persisted (SEC-4). This module re-reads what the `events` table
 * already holds and projects it *down*: `eventId`, `source`, `occurredAt`,
 * author and body text. `sourceEventId`, `ingestedAt`, `redactionCount` and any
 * connector-specific payload keys are deliberately NOT forwarded — the panel has
 * no use for them, and every field that does not cross the bridge is a field
 * that cannot leak through a renderer-side bug.
 */
import { ipcMain } from 'electron';
import type { Artifact, Event, Person, SourceId } from '@cr/core';
import type { Drilldown, DrilldownEvent } from '../preload.cjs';

export type { Drilldown, DrilldownEvent };

/** Invoke channel serving claim provenance. */
export const DRILLDOWN_CHANNEL = 'claim:drilldown';

/**
 * Maximum events returned for one drill-down.
 *
 * A long-running Slack channel thread can hold thousands of messages; every one
 * of them would be structured-cloned across the context bridge and rendered into
 * the DOM inside a panel the user opened to glance at provenance. The cap keeps
 * the **most recent** window of the conversation (still in chronological order)
 * on the reasoning that a briefing claim is about what changed lately, and the
 * per-event deep link is the escape hatch to the full history.
 */
export const MAX_DRILLDOWN_EVENTS = 200;

/**
 * Maximum characters of body text per event.
 *
 * Same bound-the-payload reasoning. Truncation is marked with an ellipsis so the
 * user can see that there is more, and the deep link goes to the untruncated
 * original.
 */
export const MAX_EVENT_TEXT_CHARS = 2_000;

/** Marker appended to a body clipped at {@link MAX_EVENT_TEXT_CHARS}. */
const TRUNCATION_MARKER = '…';

/**
 * The slice of `GraphRepo` this module reads.
 *
 * Structural, so the real repo satisfies it with no adapter and a test can pass
 * a hand-rolled reader. Named `artifacts`, not `claims`, because the id on this
 * channel really is an artifact id — see the module header. `getPerson` is here
 * only to turn an actor id into a display name when one has been resolved.
 */
export interface ArtifactReader {
  getArtifact(id: string): Artifact | undefined;
  getPerson(id: string): Person | undefined;
}

/** The slice of `EventsRepo` this module reads. Read-only: provenance never writes. */
export interface ThreadEventReader {
  /** All events on one conversation, oldest first — the ordering is the repo's. */
  listByThread(threadKey: string): Event[];
}

/** Everything the drill-down handler needs. Note the absence of any model client. */
export interface ClaimHandlerDeps {
  /** Artifact + person source; `GraphRepo` in production. */
  artifacts: ArtifactReader;
  /** Raw event log; `EventsRepo` in production. */
  events: ThreadEventReader;
  /** Override for {@link MAX_DRILLDOWN_EVENTS}; tests use it to keep fixtures small. */
  maxEvents?: number;
}

/* -------------------------------------------------------------------------- */
/* External deep links                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Slack channel ids and Gmail message ids as they appear in a `sourceEventId`.
 * Anything outside this alphabet is not an id we recognise, and is not something
 * this module will paste into a URL.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Slack message timestamps are `seconds.micros`, e.g. `1712345678.001200`. */
const SLACK_TS = /^\d+(?:\.\d+)?$/;

/**
 * Best-effort Slack deep link for one message.
 *
 * WHAT IS ACHIEVABLE WITH THE DATA WE HAVE, AND WHAT IS NOT:
 *
 * The canonical Slack permalink is
 * `https://<workspace>.slack.com/archives/<channelId>/p<ts-without-dot>`. We
 * **cannot** build it: nothing in this app stores a workspace domain or team id.
 * `config/default.json`'s `oauth.slack` holds a client id and nothing else, the
 * `artifacts` row carries only the thread key, and `SlackClient` never calls
 * `team.info` or `chat.getPermalink`. Guessing a subdomain would produce a
 * plausible-looking URL that 404s for every user whose workspace is not the one
 * we guessed — worse than no link, because it looks authoritative.
 *
 * What IS available is Slack's documented, workspace-agnostic redirect
 * endpoint: `https://slack.com/app_redirect?channel=<id>&message_ts=<ts>`. It
 * resolves in the user's own signed-in Slack client.
 *
 * Its honest limitations:
 *  - It resolves against whichever workspace the user's Slack session is in. A
 *    user signed into several workspaces may land in the wrong one, or on a
 *    "channel not found" page.
 *  - It requires a live Slack session; signed out, it lands on a sign-in page.
 *  - It is a redirect, not a permalink: it cannot be archived or shared as a
 *    stable reference to this message.
 *
 * The right fix is to persist `team_id`/`team.domain` at connect time (from the
 * OAuth `access` response, which returns both) and build the real
 * `/archives/...` permalink. That is a connector-layer change, out of scope
 * here, and it is why this function is deliberately small and replaceable.
 *
 * @param sourceEventId - Slack's `${channelId}:${ts}` — see `slackSourceEventId`.
 * @returns The redirect URL, or `undefined` when the id is not the shape we know.
 * `DrillDownPanel` renders a missing link as "no deep link available", which is
 * the truthful outcome and the reason this returns `undefined` rather than a URL
 * built out of hope.
 */
export function slackDeepLink(sourceEventId: string): string | undefined {
  const separator = sourceEventId.indexOf(':');
  if (separator <= 0) return undefined;

  const channelId = sourceEventId.slice(0, separator);
  const ts = sourceEventId.slice(separator + 1);
  if (!SAFE_ID.test(channelId) || !SLACK_TS.test(ts)) return undefined;

  // Encoded anyway, despite the checks above: the checks are the trust boundary,
  // the encoding is the belt-and-braces that survives someone relaxing them.
  return (
    'https://slack.com/app_redirect' +
    `?channel=${encodeURIComponent(channelId)}` +
    `&message_ts=${encodeURIComponent(ts)}`
  );
}

/**
 * Best-effort Gmail deep link for one message.
 *
 * `https://mail.google.com/mail/u/0/#all/<messageId>` opens the message in the
 * Gmail web client. `#all/` rather than `#inbox/` on purpose: the thread may
 * have been archived, and `#all` (All Mail) finds it either way, whereas
 * `#inbox/<id>` silently shows nothing for an archived thread.
 *
 * Its honest limitations:
 *  - `u/0` is the FIRST account signed into the browser, not necessarily the
 *    mailbox we ingested. Gmail exposes no account-agnostic per-message URL, and
 *    the app does not store the mailbox address to build a `?authuser=` variant
 *    (SEC-3 keeps only a salted hash of addresses). A user signed into several
 *    Google accounts may land on "conversation not found".
 *  - It targets the web client; a desktop mail client user gets a browser tab.
 *
 * @param sourceEventId - Gmail's message id, verbatim from `users.messages.get`.
 */
export function gmailDeepLink(sourceEventId: string): string | undefined {
  if (!SAFE_ID.test(sourceEventId)) return undefined;
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(sourceEventId)}`;
}

/**
 * The external link for one event, or `undefined` when none can be built
 * honestly. Dispatches on the event's own source rather than the artifact's, so
 * a mixed-source thread (not possible today, but cheap to be right about) links
 * each event correctly.
 */
export function deepLinkFor(source: SourceId, sourceEventId: string): string | undefined {
  if (sourceEventId === '') return undefined;
  switch (source) {
    case 'slack':
      return slackDeepLink(sourceEventId);
    case 'gmail':
      return gmailDeepLink(sourceEventId);
    default:
      // Unreachable while `SourceId` is `'slack' | 'gmail'`; a third connector
      // gets no link until someone writes one, rather than a wrong one for free.
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Readable body text for an event.
 *
 * `Event.payload` is connector-shaped and opaque to the domain, but every
 * normalizer folds the redacted body in under `text` (see
 * `IngestionPipeline.ingest`). A payload without a string `text` yields `''`
 * rather than `JSON.stringify(payload)`: dumping the raw payload into the panel
 * would put arbitrary connector fields — anything a future normalizer decides to
 * stash — in front of the user, which is exactly the leak this projection exists
 * to prevent.
 */
export function eventText(payload: Record<string, unknown>): string {
  const text: unknown = payload['text'];
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_EVENT_TEXT_CHARS) return text;
  return text.slice(0, MAX_EVENT_TEXT_CHARS) + TRUNCATION_MARKER;
}

/**
 * Display name for an actor.
 *
 * Falls back to the raw `actorId` (a Slack user id, or a Gmail address) when no
 * `people` row has been resolved yet, and to `'unknown'` for an unattributed
 * event. Showing the raw id beats showing nothing: `U024BE7LH` is at least
 * something the user can match against the thread they open.
 */
export function authorFor(artifacts: ArtifactReader, actorId: string): string {
  if (actorId === '') return 'unknown';

  try {
    const displayName = artifacts.getPerson(actorId)?.displayName;
    if (displayName !== undefined && displayName !== '') return displayName;
  } catch (error) {
    // A person lookup is a nicety; losing it must not lose the whole event.
    console.error('[claim] person lookup failed', actorId, error);
  }

  return actorId;
}

/**
 * Project one stored `Event` onto the renderer's `DrilldownEvent`.
 *
 * Whitelist, not passthrough: only the five fields the panel paints cross the
 * bridge. See the module header on secrets.
 */
export function toDrilldownEvent(event: Event, artifacts: ArtifactReader): DrilldownEvent {
  const externalUrl = deepLinkFor(event.source, event.sourceEventId);

  return {
    eventId: event.eventId,
    source: event.source,
    occurredAt: event.occurredAt,
    author: authorFor(artifacts, event.actorId),
    text: eventText(event.payload),
    // `exactOptionalPropertyTypes`: an absent link is an absent KEY, not
    // `externalUrl: undefined` — the renderer branches on `!== undefined`.
    ...(externalUrl !== undefined ? { externalUrl } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Re-validate the renderer-supplied argument.
 *
 * The preload checks too, but a compromised renderer controls what it sends, so
 * the preload's check is a convenience gate and this one is the trust boundary.
 *
 * @returns The identifier, or `null` when the argument is unusable.
 */
export function parseDrilldownArg(arg: unknown): string | null {
  const claimId: unknown = (arg as { claimId?: unknown } | null)?.claimId;
  if (typeof claimId !== 'string' || claimId === '') return null;
  return claimId;
}

/**
 * The source events behind `claimId`, oldest first.
 *
 * Two lookups, both prepared-statement reads:
 *   1. `claimId` → artifact (it IS an artifact id — module header).
 *   2. `artifact.externalRef` → thread events. `externalRef` is set to the
 *      event's `threadKey` by `artifactFor()` in `@cr/ingest`'s pipeline, which
 *      is precisely the key `EventsRepo.listByThread` indexes on.
 *
 * Ordering is `EventsRepo`'s own — `ORDER BY occurred_at ASC, event_id ASC`,
 * i.e. chronological with a total tie-break — and is deliberately NOT re-sorted
 * here: provenance is a transcript, and a transcript that reorders itself
 * between two reads is not evidence of anything.
 *
 * Returns `[]` for an unknown artifact, an artifact whose thread has been purged
 * by retention, or a read failure. See the module header on why that is not a
 * rejection.
 */
export function resolveEvents(claimId: string, deps: ClaimHandlerDeps): Event[] {
  const artifact = deps.artifacts.getArtifact(claimId);
  if (artifact === undefined) {
    // Not an error path in the user's world: an id can outlive its artifact
    // (retention sweep), and a stale renderer can hold one across a purge.
    console.info('[claim] drilldown for unknown artifact id', claimId);
    return [];
  }

  const events = deps.events.listByThread(artifact.externalRef);

  const cap = deps.maxEvents ?? MAX_DRILLDOWN_EVENTS;
  // `slice(-cap)` keeps the tail — the most recent events — while preserving the
  // repo's chronological order within that window.
  return events.length > cap ? events.slice(-cap) : events;
}

/**
 * The whole of `claim:drilldown`: validate, resolve, project.
 *
 * Synchronous by construction. The `Promise` the renderer sees is manufactured
 * by `ipcMain.handle`, not by anything in here waiting on a model — there is no
 * model client in {@link ClaimHandlerDeps} to wait on.
 *
 * Never throws: a failed provenance read degrades to an empty transcript, which
 * the panel renders, rather than to a rejected invoke, which it can only print.
 */
export function drilldown(arg: unknown, deps: ClaimHandlerDeps): Drilldown {
  const claimId = parseDrilldownArg(arg);
  // Echoes '' back for a malformed request: the renderer asked about nothing, and
  // gets nothing, in the shape it expects.
  if (claimId === null) return { claimId: '', events: [] };

  try {
    return {
      claimId,
      events: resolveEvents(claimId, deps).map((event) => toDrilldownEvent(event, deps.artifacts)),
    };
  } catch (error) {
    console.error('[claim] drilldown failed', claimId, error);
    return { claimId, events: [] };
  }
}

/**
 * Register the drill-down channel.
 *
 * Safe to call before any window exists — the handler needs no `BrowserWindow`.
 * The callback is a thin wrapper over {@link drilldown}, which is where the
 * tests aim.
 */
export function registerClaimHandlers(deps: ClaimHandlerDeps): void {
  ipcMain.handle(DRILLDOWN_CHANNEL, (_event, arg: unknown): Drilldown => drilldown(arg, deps));
}
