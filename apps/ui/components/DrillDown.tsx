'use client';

import { useEffect, useState, type ReactNode } from 'react';

import { getBridge } from '../lib/bridge';
import { ExternalLink } from './ExternalLink';
import type { DrillDown } from '../types/bridge';

/**
 * Drill-down provenance panel (Task 3.6, FR-6).
 *
 * Answers "where did this come from?" by calling `claim:drilldown` and showing
 * the raw source events behind a claim, each with its external deep link. This
 * is the trust mechanism for the whole product: a briefing the user cannot
 * verify is a briefing the user has to re-check by hand, which is the work the
 * app exists to remove.
 *
 * Exported as `DrillDownPanel` so the component name does not collide with the
 * `DrillDown` payload type from the bridge.
 */

export interface DrillDownPanelProps {
  /** Claim to fetch provenance for. Changing it refetches. */
  claimId: string;
  /** Renders a close control when provided. */
  onClose?: () => void;
}

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function DrillDownPanel({ claimId, onClose }: DrillDownPanelProps): ReactNode {
  const [drilldown, setDrilldown] = useState<DrillDown | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guards against a resolve landing after the panel closed or switched claims.
    let active = true;
    setDrilldown(null);
    setError(null);

    try {
      getBridge()
        .claim.drilldown(claimId)
        .then((result) => {
          if (active) setDrilldown(result);
        })
        .catch((cause: unknown) => {
          if (active) setError(describe(cause));
        });
    } catch (cause) {
      // `getBridge()` throws synchronously outside Electron.
      setError(describe(cause));
    }

    return () => {
      active = false;
    };
  }, [claimId]);

  return (
    <div aria-label="Sources behind this claim" className="drilldown">
      <h4 className="drilldown__heading">Where this came from</h4>

      {error !== null ? (
        <p role="alert" className="drilldown__error">
          Could not load sources: {error}
        </p>
      ) : drilldown === null ? (
        <p className="muted-note">Loading sources…</p>
      ) : drilldown.events.length === 0 ? (
        <p className="muted-note">
          No source events are recorded for this claim.
        </p>
      ) : (
        <ul className="drilldown__list">
          {drilldown.events.map((event) => (
            <li key={event.eventId} className="drilldown__item">
              <div className="drilldown__meta">
                <strong className="drilldown__author">{event.author}</strong>
                {' · '}
                {event.source}
                {' · '}
                {new Date(event.occurredAt).toLocaleString()}
              </div>
              <div>{event.text}</div>
              {event.externalUrl !== undefined ? (
                // FR-6: the escape hatch out of the briefing and into the real
                // thread. Still a real anchor (keyboard reachable, announced as
                // a link), but the click is routed through `shell:openExternal`
                // rather than navigating — see `ExternalLink` and Task 4.6.
                <ExternalLink
                  className="cr-interactive drilldown__link"
                  href={event.externalUrl}
                >
                  open in {event.source}
                </ExternalLink>
              ) : (
                <span className="drilldown__meta">
                  no deep link available
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {onClose !== undefined ? (
        <button
          type="button"
          className="cr-interactive drilldown__close"
          onClick={onClose}
        >
          Close sources
        </button>
      ) : null}
    </div>
  );
}

export default DrillDownPanel;
