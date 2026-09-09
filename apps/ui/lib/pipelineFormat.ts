/**
 * Pure formatters for the pipeline status strip (F2).
 *
 * These live in `lib/` rather than in `RailStatus.tsx` because they are plain
 * string functions with no React or MUI in them, and more than one component
 * needs them — `WarmingNotice` importing them from the `RailStatus` module
 * would drag that whole component (MUI `Box`/`IconButton`/`Typography`, the SVG
 * icon, the health-dot maps) in as a dependency just for one helper.
 */

/** How far a source's ingestion lags real time, as the roughest honest unit. */
export function formatLag(lagMs: number | null): string {
  if (lagMs === null) return 'lag unknown';
  if (lagMs < 60_000) return 'up to date';
  const minutes = Math.round(lagMs / 60_000);
  return minutes < 60 ? `${minutes}m behind` : `${Math.round(minutes / 60)}h behind`;
}

/**
 * A duration as the roughest honest unit (F2).
 *
 * Rounded hard on purpose. The ETA is an order-of-magnitude answer to "is this
 * minutes or hours" — the only question a waiting user actually has — and
 * quoting it to the minute past the first hour would dress a rough estimate up
 * as a schedule.
 *
 * Returns a self-contained phrase: the `~` already signals approximation, so a
 * caller must NOT wrap the result in "about …" (that produced "about ~12 min").
 * The sub-minute case is spelled out ("under a minute") rather than "~0 min".
 */
export function formatEta(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `~${minutes} min`;
  const hours = ms / 3_600_000;
  if (hours < 10) return `~${Math.round(hours * 2) / 2} h`;
  return `~${Math.round(hours)} h`;
}
