'use client';

import Alert from '@mui/material/Alert';
import { useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../lib/bridge';
import { formatEta } from '../lib/pipelineFormat';
import type { PipelineStatus } from '../types/bridge';

/**
 * "Still reading your backlog" — the first-run contract (F2).
 *
 * The problem this exists for: Layer 1 costs roughly 21 seconds per backfilled
 * message on the shipped model, and `WatermarkRepo`'s `DUE_SQL` holds a whole
 * thread out of synthesis until every event on it is extracted. So a user who
 * has just connected a real mailbox is hours away from a briefing worth reading
 * — while the home page requests one immediately and paints whatever it gets,
 * which is nothing. Nothing on screen distinguishes "we are still reading your
 * mail" from "this product does not work".
 *
 * Two deliberate choices:
 *
 *   - **It renders nothing when there is no backlog.** This is a transient
 *     first-run and post-reconnect state, not a permanent status widget; the
 *     nav rail already carries the always-on version.
 *   - **The ETA is omitted when it cannot be measured.** `extractionEtaMs` is
 *     `null` until some Layer-1 calls have completed, which is exactly the
 *     moment a new user is looking at this. A count with no promise attached is
 *     more honest than an invented number, and this component says the count.
 */
export function WarmingNotice(): ReactNode {
  const [status, setStatus] = useState<PipelineStatus | null>(null);

  useEffect(() => {
    if (!hasBridge()) return undefined;
    // Same subscribe/unsubscribe contract as every other pushed channel: a
    // React effect that re-subscribes without disposing stacks listeners.
    return getBridge().pipeline.onStatus(setStatus);
  }, []);

  if (status === null || status.extractionBacklog <= 0) return null;

  const messages = `${status.extractionBacklog} message${status.extractionBacklog === 1 ? '' : 's'}`;

  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      Still reading {messages} from your sources
      {/* `formatEta` already returns a hedged phrase ("~12 min", "under a
          minute") — no "about" in front of it. */}
      {status.extractionEtaMs === null ? '' : ` — ${formatEta(status.extractionEtaMs)} to go`}.
      Newest messages are read first, so recent conversations show up before older ones. Your
      briefing fills in as they land; nothing is lost while you wait.
    </Alert>
  );
}

export default WarmingNotice;
