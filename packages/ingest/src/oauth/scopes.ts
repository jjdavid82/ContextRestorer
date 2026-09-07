/**
 * Exact, minimal OAuth scopes per T-2. Provider clients (Tasks 1.3/1.4) MUST import
 * these constants rather than inlining scope strings, so that any scope creep shows up
 * as a diff to this one file instead of hiding in a request builder somewhere.
 */

/**
 * Slack: read-only channel/DM history, the user directory needed to attribute
 * messages, and `channels:read` (channel discovery for the channel selector —
 * `conversations.list` is not authorized by `channels:history` alone; added
 * 2026-08-28 by explicit user decision, see requirements FR-1).
 *
 * `groups:read`/`groups:history` extend that same read-only pairing to PRIVATE
 * channels (Slack's scope vocabulary calls them "groups"), added 2026-09-07 by
 * explicit user decision — see requirements FR-1. This is a user token, so the
 * reach is bounded by the user's own membership: `conversations.list` returns
 * only private channels they have already joined, and nothing becomes visible
 * to the app that is not already visible to them in Slack.
 *
 * Group DMs (`mpim:*`) are deliberately NOT included — a separate scope pair
 * for a different conversation type, and no part of the app asks for it yet.
 */
export const SLACK_SCOPES =
  'channels:history,channels:read,groups:history,groups:read,im:history,users:read';

/** Gmail: read-only. Never `gmail.modify`, never `mail.google.com`. */
export const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
