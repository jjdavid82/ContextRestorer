'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../../lib/bridge';
import type { DeclaredProject, SelectedSlackChannel, SlackChannel } from '../../types/bridge';
import { PanelHeading } from './PanelHeading';

/**
 * Slack channel selector (closes Task 1.7's gap).
 *
 * Without a selection, `VaultBackedSlackClient` has no channel to poll and every
 * Slack cycle fails loudly by design — connecting Slack via OAuth is not by
 * itself enough to start ingesting. This panel is where that selection is made.
 *
 * The available list is fetched LIVE from Slack every time the panel loads,
 * never cached: channel membership changes on Slack's side, and a stale list
 * would let the user "select" a channel the connected token can no longer see.
 * `not_connected` is its own message, not an empty list — "you haven't connected
 * Slack" and "there is genuinely nothing to poll" are different states.
 *
 * Tagging a channel with a project (FR-8 / A-2) gives its threads stakes weight
 * in the ranker and rebuilds `belongs_to` edges for threads already ingested.
 * Nothing is inferred — an untagged channel earns no stakes, exactly as every
 * channel behaved before this control (X-2).
 */
export default function SlackChannelSettings(): ReactNode {
  const [available, setAvailable] = useState<SlackChannel[]>([]);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [projects, setProjects] = useState<DeclaredProject[]>([]);
  /** `channelId -> projectId`; a channel absent from the map is untagged. */
  const [tags, setTags] = useState<ReadonlyMap<string, string>>(new Map());
  const [notConnected, setNotConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoadError(null);
    setNotConnected(false);
    try {
      const [listResult, selected, declared] = await Promise.all([
        getBridge().slack.listAvailable(),
        getBridge().slack.getSelected(),
        // Best-effort: with no projects the tag control renders its own
        // "declare one first" hint rather than blocking channel selection.
        getBridge().projects.list().catch(() => [] as DeclaredProject[]),
      ]);

      setSelectedIds(new Set(selected.map((c: SelectedSlackChannel) => c.channelId)));
      setProjects(declared);
      setTags(
        new Map(
          selected.flatMap((c: SelectedSlackChannel) =>
            c.projectId === null ? [] : [[c.channelId, c.projectId] as const],
          ),
        ),
      );

      if (!listResult.ok) {
        if (listResult.reason === 'not_connected') setNotConnected(true);
        else setLoadError(listResult.reason ?? 'could not load Slack channels');
        setAvailable([]);
        return;
      }
      setAvailable(listResult.channels ?? []);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    if (!hasBridge()) {
      setLoadError('Channel selection is only available inside the Context Restorer desktop app.');
      return;
    }
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

  const setTag = useCallback((channelId: string, projectId: string): void => {
    setTags((prev) => {
      const next = new Map(prev);
      if (projectId === '') next.delete(channelId);
      else next.set(channelId, projectId);
      return next;
    });
  }, []);

  const save = useCallback(async (): Promise<void> => {
    setBusy(true);
    setSaveError(null);
    try {
      // `projectId` is sent EXPLICITLY (never omitted) because this control is
      // the thing that edits it — omitting means "leave the tag alone", which
      // would make clearing a tag impossible from here. `null` is the cleared
      // state.
      const channels = available
        .filter((c) => selectedIds.has(c.id))
        .map((c) => ({ channelId: c.id, name: c.name, projectId: tags.get(c.id) ?? null }));
      const result = await getBridge().slack.setSelected(channels);
      if (!result.ok) setSaveError(result.reason ?? 'the selection was rejected');
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [available, selectedIds, tags]);

  return (
    <Box>
      <PanelHeading
        title="Slack channels"
        lead="Pick which channels Context Restorer reads — nothing is polled until at least one is selected, even after Slack is connected. Tag a channel with a project to prioritise its threads; untagged channels are still read, they just carry no extra weight."
      />

      {notConnected ? (
        <Typography sx={{ color: 'text.secondary' }}>
          Connect Slack first, then come back to choose channels.
        </Typography>
      ) : loadError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main' }}>
          Could not load channels: {loadError}
        </Typography>
      ) : available.length === 0 ? (
        <Typography sx={{ color: 'text.secondary' }}>
          No public channels are visible to the connected account.
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{
            listStyle: 'none',
            p: 0,
            m: 0,
            '& > li': { py: 1, borderTop: 1, borderColor: 'divider' },
            '& > li:first-of-type': { borderTop: 0 },
          }}
        >
          {available.map((channel) => (
            <Box
              component="li"
              key={channel.id}
              sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}
            >
              <FormControlLabel
                sx={{ m: 0 }}
                control={
                  <Checkbox
                    size="small"
                    disabled={!channel.isMember}
                    checked={selectedIds.has(channel.id)}
                    onChange={() => toggle(channel.id)}
                  />
                }
                label={
                  <Box component="span" sx={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '0.9rem' }}>
                    #{channel.name}
                    {/* A token can SEE a public channel without having joined it,
                        and history then fails every poll. Disabled, not hidden,
                        so the user understands why it is unavailable. */}
                    {!channel.isMember ? (
                      <Box component="span" sx={{ ml: 1, fontFamily: 'inherit', fontSize: '0.8rem', color: 'text.secondary' }}>
                        — join this channel in Slack first
                      </Box>
                    ) : null}
                  </Box>
                }
              />

              {selectedIds.has(channel.id) ? (
                projects.length === 0 ? (
                  <Typography sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
                    Declare a project to prioritise this channel.
                  </Typography>
                ) : (
                  <TextField
                    select
                    size="small"
                    label="Project"
                    value={tags.get(channel.id) ?? ''}
                    aria-label={`Project for #${channel.name}`}
                    onChange={(e) => setTag(channel.id, e.target.value)}
                    sx={{ minWidth: 180, ml: 'auto' }}
                  >
                    <MenuItem value="">— none —</MenuItem>
                    {projects.map((project) => (
                      <MenuItem key={project.projectId} value={project.projectId}>
                        {project.name}
                      </MenuItem>
                    ))}
                  </TextField>
                )
              ) : null}
            </Box>
          ))}
        </Box>
      )}

      {saveError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main', mt: 2 }}>
          Could not save: {saveError}
        </Typography>
      ) : null}

      {!notConnected && available.length > 0 ? (
        <Button variant="contained" sx={{ mt: 2 }} disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save selection'}
        </Button>
      ) : null}
    </Box>
  );
}
