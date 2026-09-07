'use client';

import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import { useState, type ReactNode } from 'react';

import { PageToolbar } from '../../components/PageToolbar';
import BriefingWindowSettings from './briefingWindow';
import SlackChannelSettings from './channels';
import LocalMetricsPanel from './metrics';
import ModelSettings from './model';
import ScheduleSettings from './schedule';

/**
 * Settings, as the Option 3 two-pane screen: a section list on the left, the
 * selected panel on the right. Before the redesign every panel stacked down one
 * long scroll inside `schedule.tsx`; each is now its own component
 * (`schedule` / `channels` / `model` / `briefingWindow` / `metrics`), rendered
 * one at a time here.
 *
 * State-switched rather than sub-routed (`/settings/[section]`): the panels are
 * cheap, the app has no client router under the `app://` static export, and a
 * real navigation per section would drop the panel's fetched state on every
 * click.
 */

interface PanelDef {
  id: string;
  label: string;
  render: () => ReactNode;
}

const SCHEDULE_PANEL: PanelDef = {
  id: 'schedule',
  label: 'Briefing schedule',
  render: () => <ScheduleSettings />,
};

const PANELS: readonly PanelDef[] = [
  SCHEDULE_PANEL,
  { id: 'channels', label: 'Slack channels', render: () => <SlackChannelSettings /> },
  { id: 'model', label: 'Chat model', render: () => <ModelSettings /> },
  { id: 'window', label: 'Briefing window', render: () => <BriefingWindowSettings /> },
  { id: 'diagnostics', label: 'Diagnostics', render: () => <LocalMetricsPanel /> },
];

export default function SettingsPage(): ReactNode {
  const [active, setActive] = useState<string>(SCHEDULE_PANEL.id);
  const current = PANELS.find((p) => p.id === active) ?? SCHEDULE_PANEL;

  return (
    <>
      <PageToolbar title="Settings" />
      <Box
        sx={{
          maxWidth: 940,
          mx: 'auto',
          width: '100%',
          p: 3,
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          gap: 3,
          alignItems: 'flex-start',
        }}
      >
        <List
          component="nav"
          aria-label="Settings sections"
          sx={{
            p: 0,
            flex: { sm: '0 0 200px' },
            position: { sm: 'sticky' },
            top: { sm: 88 },
          }}
        >
          {PANELS.map((panel) => (
            <ListItemButton
              key={panel.id}
              selected={panel.id === active}
              onClick={() => setActive(panel.id)}
              sx={{ borderRadius: 1, py: 0.75 }}
            >
              <ListItemText
                primary={panel.label}
                slotProps={{ primary: { sx: { fontSize: 14 } } }}
              />
            </ListItemButton>
          ))}
        </List>

        <Box sx={{ flex: 1, minWidth: 0 }}>{current.render()}</Box>
      </Box>
    </>
  );
}
