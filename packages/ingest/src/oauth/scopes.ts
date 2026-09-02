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
 */
export const SLACK_SCOPES = 'channels:history,channels:read,im:history,users:read';

/** Gmail: read-only. Never `gmail.modify`, never `mail.google.com`. */
export const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';
