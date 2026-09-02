'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge } from '../../lib/bridge';
import type { SelectedSlackChannel, SlackChannel } from '../../types/bridge';

/**
 * Slack channel selector (closes Task 1.7's gap).
 *
 * Without a selection, `VaultBackedSlackClient` has no channel to poll and
 * every Slack cycle fails loudly by design — connecting Slack via OAuth is not
 * by itself enough to start ingesting anything. This panel is where that
 * selection is made.
 *
 * The available list is fetched LIVE from Slack (`slack:listAvailable`) every
 * time the panel loads, never cached: channel membership changes on Slack's
 * side, and a stale list would let the user "select" a channel the connected
 * token can no longer see. `not_connected` is rendered as its own message
 * rather than an empty list, since those mean different things — one is "you
 * haven't connected Slack", the other is "there is genuinely nothing to poll".
 *
 * Styled via the shared tokens/control classes in `globals.css`
 * (`.card`, `.field-row`, `.btn`), matching the rest of this settings screen.
 */
export default function SlackChannelSettings(): ReactNode {
  const [available, setAvailable] = useState<SlackChannel[]>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [notConnected, setNotConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoadError(null);
    setNotConnected(false);
    try {
      const [listResult, selected] = await Promise.all([
        getBridge().slack.listAvailable(),
        getBridge().slack.getSelected(),
      ]);

      setSelectedIds(new Set(selected.map((c: SelectedSlackChannel) => c.channelId)));

      if (!listResult.ok) {
        if (listResult.reason === 'not_connected') {
          setNotConnected(true);
        } else {
          setLoadError(listResult.reason ?? 'could not load Slack channels');
        }
        setAvailable([]);
        return;
      }
      setAvailable(listResult.channels ?? []);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback((channelId: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  }, []);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    setSaveError(null);
    try {
      const channels = available
        .filter((c) => selectedIds.has(c.id))
        .map((c) => ({ channelId: c.id, name: c.name }));
      const result = await getBridge().slack.setSelected(channels);
      if (!result.ok) setSaveError(result.reason ?? 'the selection was rejected');
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [available, selectedIds]);

  return (
    <section className="card">
      <h2>Slack channels</h2>
      <p>
        <small>
          Pick which channels Context Restorer should read. Nothing is polled until at least one
          channel is selected here, even after Slack is connected.
        </small>
      </p>

      {notConnected ? (
        <p>Connect Slack first, then come back to choose channels.</p>
      ) : loadError !== null ? (
        <p role="alert">Could not load channels: {loadError}</p>
      ) : available.length === 0 ? (
        <p>No public channels are visible to the connected account.</p>
      ) : (
        <ul className="list-reset">
          {available.map((channel) => (
            <li key={channel.id} className="field-row">
              <label>
                <input
                  type="checkbox"
                  disabled={!channel.isMember}
                  checked={selectedIds.has(channel.id)}
                  onChange={() => toggle(channel.id)}
                />{' '}
                #{channel.name}
                {/* A token can SEE a public channel via conversations.list without
                    having joined it, and conversations.history then fails for
                    every poll cycle. Disabled rather than hidden, so the user
                    understands why it is missing instead of assuming a bug. */}
                {!channel.isMember ? (
                  <>
                    {' '}
                    <small>— join this channel in Slack first</small>
                  </>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      )}

      {saveError !== null ? <p role="alert">Could not save: {saveError}</p> : null}

      {!notConnected && available.length > 0 ? (
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save selection'}
        </button>
      ) : null}
    </section>
  );
}
