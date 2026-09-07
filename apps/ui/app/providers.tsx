'use client';

import DefaultPropsProvider from '@mui/material/DefaultPropsProvider';
import type { ReactNode } from 'react';

/**
 * Runtime component defaults for the renderer.
 *
 * Pigment CSS resolves the theme at BUILD time — every `.Mui*` rule and the
 * `--mui-*` palette variables are already in the static stylesheet imported by
 * `layout.tsx`, so the app renders correctly before this hydrates and there is
 * NO runtime `<ThemeProvider>` (it would SSR a `<style>` element with the CSS
 * variables, which the shell CSP's `style-src-elem 'self'` blocks).
 *
 * `DefaultPropsProvider` is the pure-Pigment replacement for
 * `theme.components.*.defaultProps`: a lightweight context that only supplies
 * default props, touches no styling engine, and injects nothing. It is what
 * MUI's Pigment migration guide prescribes when Emotion is absent.
 *
 * Keep this list to genuine app-wide defaults; one-off props belong on the
 * component.
 */
const defaults = {
  // Flat, border-defined surfaces (the pre-redesign look). Elevation 0 also
  // means Paper never computes an elevation shadow.
  MuiPaper: { elevation: 0 },
  MuiCard: { variant: 'outlined' as const },
  MuiAppBar: { elevation: 0, color: 'default' as const },
  MuiButton: { disableElevation: true },
  // The app has never had a ripple and the flat design does not want one.
  MuiButtonBase: { disableRipple: true },
};

export function Providers({ children }: { children: ReactNode }): ReactNode {
  return <DefaultPropsProvider value={defaults}>{children}</DefaultPropsProvider>;
}

export default Providers;
