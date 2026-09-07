'use client';

import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { RailStatus } from './RailStatus';

/**
 * The persistent application frame (Option 3 redesign).
 *
 * A permanent left navigation rail — app identity, the three destinations, and
 * an always-visible source/pipeline status block at the foot — plus a `<main>`
 * region for the routed page. Before the redesign the nav was a top bar and the
 * status strips were cards on the home dashboard; moving status into the rail
 * makes it ambient rather than something you navigate to.
 *
 * Client component: `usePathname` drives the active-nav highlight. Links stay
 * plain `<a href="/…/index.html">` — the bundle is served over the custom
 * `app://` fixed-host scheme whose handler cannot resolve a directory-style URL
 * or a `next/link` client transition (same reasoning as the old `layout.tsx`).
 */

const RAIL_WIDTH = 244;

interface NavDest {
  label: string;
  href: string;
  /** Route(s) `usePathname` reports for this destination, with and without the trailing slash. */
  match: readonly string[];
  icon: ReactNode;
}

const HomeIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M3 11l9-8 9 8" />
    <path d="M5 10v10h14V10" />
  </svg>
);
const SetupIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </svg>
);
const SettingsIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H10a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V10a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

const DESTINATIONS: readonly NavDest[] = [
  { label: 'Home', href: '/index.html', match: ['/'], icon: HomeIcon },
  { label: 'Setup', href: '/onboarding/index.html', match: ['/onboarding', '/onboarding/'], icon: SetupIcon },
  { label: 'Settings', href: '/settings/index.html', match: ['/settings', '/settings/'], icon: SettingsIcon },
];

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const pathname = usePathname();

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <Drawer
        variant="permanent"
        sx={{
          width: RAIL_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: RAIL_WIDTH,
            boxSizing: 'border-box',
            bgcolor: 'background.default',
            display: 'flex',
            flexDirection: 'column',
            gap: 0.5,
            p: 1.5,
          },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.2, px: 1, py: 0.5, pb: 1.5 }}>
          <Box
            aria-hidden="true"
            sx={{
              width: 26,
              height: 26,
              borderRadius: 1,
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 700,
              fontSize: 14,
              flex: 'none',
            }}
          >
            C
          </Box>
          <Typography sx={{ fontWeight: 650, fontSize: 14.5, letterSpacing: '-0.01em' }}>
            Context&nbsp;Restorer
          </Typography>
        </Box>

        <List
          component="nav"
          aria-label="Main"
          sx={{ p: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}
        >
          {DESTINATIONS.map((dest) => {
            const active = dest.match.includes(pathname);
            return (
              <ListItemButton
                key={dest.href}
                component="a"
                href={dest.href}
                selected={active}
                {...(active ? { 'aria-current': 'page' as const } : {})}
                sx={{ borderRadius: 1, py: 1, px: 1.25, gap: 1.4, color: 'text.secondary' }}
              >
                <ListItemIcon sx={{ minWidth: 0, color: 'inherit' }}>{dest.icon}</ListItemIcon>
                {/* The active item's bold weight is in globals.css keyed off
                    `.Mui-selected` — a conditional value in `sx` can't be
                    statically extracted by Pigment. */}
                <ListItemText primary={dest.label} slotProps={{ primary: { sx: { fontSize: 14 } } }} />
              </ListItemButton>
            );
          })}
        </List>

        <Box sx={{ flex: 1 }} />
        <RailStatus />
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </Box>
    </Box>
  );
}

export default AppShell;
