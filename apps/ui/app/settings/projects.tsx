'use client';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { getBridge, hasBridge } from '../../lib/bridge';
import type { DeclaredProject } from '../../types/bridge';
import { PanelHeading } from './PanelHeading';

/**
 * Declared-project manager (settings panel).
 *
 * Onboarding lets a user declare projects but never un-declare them — its "Edit
 * projects" step only ever adds. Declared projects drive briefing ranking
 * (`wStakes`, via the channel → project tags in the Slack channels panel), so a
 * wrong or stale one actively skews results. This panel is the add/remove
 * surface.
 *
 * Add reuses `projects:declare`, which is idempotent by name. Remove calls
 * `projects:remove`, which also drops the project's `belongs_to` stakes edges
 * and untags any channel that pointed at it (the channel stays selected). The
 * list is re-fetched after every change rather than mutated locally.
 */

/** Render an unknown thrown value as something a human can read. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default function ProjectSettings(): ReactNode {
  const [projects, setProjects] = useState<DeclaredProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  /** Id of the row whose Remove button has been armed but not confirmed. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      setProjects(await getBridge().projects.list());
    } catch (cause) {
      setLoadError(describe(cause));
    }
  }, []);

  useEffect(() => {
    if (!hasBridge()) {
      setLoadError('Managing projects is only available inside the Context Restorer desktop app.');
      return;
    }
    void refresh();
  }, [refresh]);

  const add = useCallback(async (): Promise<void> => {
    const name = newName.trim();
    if (name === '') return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await getBridge().projects.declare([name]);
      if (!result.ok) {
        setActionError(result.reason ?? 'the project was rejected');
        return;
      }
      setNewName('');
      await refresh();
    } catch (cause) {
      setActionError(describe(cause));
    } finally {
      setBusy(false);
    }
  }, [newName, refresh]);

  const remove = useCallback(
    async (projectId: string): Promise<void> => {
      setBusy(true);
      setActionError(null);
      try {
        const result = await getBridge().projects.remove(projectId);
        if (!result.ok) setActionError(result.reason ?? 'the project could not be removed');
        await refresh();
      } catch (cause) {
        setActionError(describe(cause));
      } finally {
        setBusy(false);
        setConfirmingId(null);
      }
    },
    [refresh],
  );

  return (
    <Box>
      <PanelHeading
        title="Projects"
        lead="The projects you're working on. Briefings rank what matters by these — tag a Slack channel with one in the Slack channels panel to give its threads weight. Removing a project untags any channel that used it; the channel stays selected."
      />

      {loadError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main' }}>
          Could not load projects: {loadError}
        </Typography>
      ) : projects === null ? (
        <Typography sx={{ color: 'text.secondary' }}>Loading…</Typography>
      ) : (
        <>
          {projects.length === 0 ? (
            <Typography sx={{ color: 'text.secondary' }}>
              No projects declared yet.
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
              {projects.map((project) => (
                <Box
                  component="li"
                  key={project.projectId}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}
                >
                  <Typography sx={{ flex: 1, minWidth: 0 }}>{project.name}</Typography>
                  {confirmingId === project.projectId ? (
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <Button
                        size="small"
                        variant="contained"
                        color="error"
                        disabled={busy}
                        onClick={() => void remove(project.projectId)}
                      >
                        Confirm remove
                      </Button>
                      <Button size="small" variant="text" onClick={() => setConfirmingId(null)}>
                        Cancel
                      </Button>
                    </Box>
                  ) : (
                    <Button
                      size="small"
                      variant="text"
                      color="error"
                      disabled={busy}
                      onClick={() => setConfirmingId(project.projectId)}
                    >
                      Remove
                    </Button>
                  )}
                </Box>
              ))}
            </Box>
          )}

          <Box sx={{ display: 'flex', gap: 1, mt: 2.5 }}>
            <TextField
              size="small"
              label="Add a project"
              placeholder="e.g. Q3 migration"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void add();
                }
              }}
              sx={{ flex: 1, maxWidth: 320 }}
            />
            <Button
              variant="outlined"
              disabled={busy || newName.trim() === ''}
              onClick={() => void add()}
            >
              Add
            </Button>
          </Box>
        </>
      )}

      {actionError !== null ? (
        <Typography role="alert" sx={{ color: 'error.main', mt: 2 }}>
          {actionError}
        </Typography>
      ) : null}
    </Box>
  );
}
