'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../lib/bridge';
import type { SourceHealth } from '../types/bridge';

/**
 * Source-health status strip (Task 1.7).
 *
 * Subscribes to the main process's `health:sources` push and renders one row per
 * connector: status, when it last synced, and how far behind live it is.
 *
 * Rate limiting is given its own visual treatment on purpose (R-5). Folding it
 * into a generic "degraded" is what leaves a user staring at a briefing that
 * stopped updating with no idea whether the app is broken or the provider is
 * simply holding it off — the two need completely different reactions.
 *
 * Rendered as a `.card` on the home dashboard, alongside the briefing-trigger
 * and status-summary cards — see `app/page.tsx`.
 */

/** Presentation per status. `tone` is the dot/badge colour, `label` the wording. */
const PRESENTATION: Record<
  SourceHealth['status'],
  { label: string; tone: string; detail: string }
> = {
  ok: { label: 'Connected', tone: '#1a7f37', detail: 'Syncing normally.' },
  degraded: {
    label: 'Degraded',
    tone: '#9a6700',
    detail: 'Recent polls failed; retrying with backoff.',
  },
  'rate-limited': {
    label: 'Rate limited',
    tone: '#bc4c00',
    detail: 'The provider is throttling us — updates are delayed, not lost.',
  },
  disconnected: {
    label: 'Not connected',
    tone: '#cf222e',
    detail: 'Reconnect this source to resume ingestion.',
  },
};

/** `2m behind` / `just now` / `unknown` — lag is the number that matters (NFR-2/AC-8). */
function formatLag(lagMs: number | null): string {
  if (lagMs === null) return 'lag unknown';
  if (lagMs < 60_000) return 'up to date';
  const minutes = Math.round(lagMs / 60_000);
  if (minutes < 60) return `${minutes}m behind`;
  return `${Math.round(minutes / 60)}h behind`;
}

/**
 * Last sync time, derived from lag rather than received directly.
 *
 * `health:sources` carries `lagMs`, not `lastSyncAt`, so this is the honest
 * wording: "data as of …". Claiming a precise poll timestamp we were not sent
 * would be worse than being vague.
 */
function formatAsOf(lagMs: number | null): string {
  if (lagMs === null) return 'never synced';
  return `data as of ${new Date(Date.now() - lagMs).toLocaleTimeString()}`;
}

export function SourceHealthPanel(): ReactNode {
  const [health, setHealth] = useState<SourceHealth[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Outside Electron there is no bridge at all; say so instead of throwing
    // out of the effect and blanking the whole tree.
    if (!hasBridge()) {
      setError('Source health is only available inside the Context Restorer desktop app.');
      return;
    }

    try {
      // MUST be called on teardown: React re-runs effects, and each run adds an
      // `ipcRenderer` listener. Without this, every remount doubles the pushes.
      const unsubscribe = getBridge().health.onSources(setHealth);
      return unsubscribe;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
  }, []);

  if (error !== null) {
    return (
      <section className="card" aria-label="Source health">
        <p role="alert">{error}</p>
      </section>
    );
  }

  return (
    <section className="card" aria-label="Source health">
      <h2 className="section-heading section-heading--flush">Sources</h2>
      {health.length === 0 ? (
        <p className="source-health__empty">Waiting for the first health report…</p>
      ) : (
        <ul className="source-health__list">
          {health.map((entry) => {
            const view = PRESENTATION[entry.status];
            const throttled = entry.status === 'rate-limited';
            return (
              <li
                key={entry.source}
                className={`source-health__row${throttled ? ' source-health__row--throttled' : ''}`}
              >
                <span
                  aria-hidden="true"
                  className={`source-health__dot source-health__dot--${entry.status}`}
                />
                <strong className="source-health__source-name">{entry.source}</strong>
                <span className={`source-health__label--${entry.status}`}>
                  {view.label}
                  {throttled ? ' ⏳' : ''}
                </span>
                <span className="source-health__lag">{formatLag(entry.lagMs)}</span>
                <span className="source-health__meta">
                  {formatAsOf(entry.lagMs)}
                </span>
                {entry.retryAfter !== undefined ? (
                  <span className="source-health__retry">
                    retry at {new Date(entry.retryAfter).toLocaleTimeString()}
                  </span>
                ) : null}
                <span className="source-health__meta">{view.detail}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default SourceHealthPanel;
