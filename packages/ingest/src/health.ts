/**
 * Source health vocabulary (Task 1.5).
 *
 * The poller owns the only writer of these values; the UI's "sources" panel and
 * the briefing's staleness banner are the readers. Keeping the shape in its own
 * module means the renderer can import the types without pulling in the
 * scheduler (and therefore `node:timers`) behind it.
 */

/**
 * Where a connector currently stands.
 *
 * - `never_synced` — no poll has succeeded yet in this process. Distinct from
 *   `ok` with zero events: we genuinely do not know how stale the data is.
 * - `ok` — the last poll succeeded and the next one is on the normal interval.
 * - `backoff` — the last poll failed; we are waiting out an exponential backoff.
 * - `rate_limited` — the provider asked us to slow down (HTTP 429 / Slack
 *   `ratelimited`); we are waiting out the advertised delay.
 * - `auth_error` — the credential is bad (401/403, `invalid_auth`, …). Polling
 *   continues at backoff pace because a token refresh can fix it without a
 *   restart, but the UI must surface a "reconnect" affordance.
 */
export type SourceStatus = 'ok' | 'backoff' | 'rate_limited' | 'auth_error' | 'never_synced';

/** A point-in-time snapshot for one connector. */
export interface SourceHealth {
  status: SourceStatus;
  /** Epoch ms when the last successful poll cycle completed, else `null`. */
  lastSyncAt: number | null;
  /**
   * How stale the ingested data is, in ms: `now - newestIngestedEvent.occurredAt`.
   *
   * NFR-2/AC-8: this is deliberately NOT `now - lastSyncAt`. A poll that
   * succeeds every 60s while draining a two-hour backlog has a tiny "time since
   * poll" and a two-hour lag; only the latter tells the user whether the
   * briefing they are reading reflects reality. `null` until at least one event
   * has been observed.
   */
  lagMs: number | null;
  /** Events produced by the most recent SUCCESSFUL poll cycle. */
  newEventCount: number;
}
